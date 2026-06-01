import numpy as np
import pandas as pd
from scipy import stats
from .insider_engine import InsiderEngine
import warnings
warnings.filterwarnings("ignore")


# ─── KALMAN FILTER ────────────────────────────────────────────────────────────
class KalmanFilter:
    def __init__(self, Q: float = 1e-4, R: float = 1e-2):
        self.Q = Q
        self.R = R

    def filter(self, observations: np.ndarray):
        n = len(observations)
        if n == 0:
            return np.array([]), np.array([]), np.array([])
        x_hat, P, K = np.zeros(n), np.zeros(n), np.zeros(n)
        x_hat[0], P[0] = observations[0], 1.0
        for t in range(1, n):
            x_pred = x_hat[t - 1]
            P_pred = P[t - 1] + self.Q
            K[t]   = P_pred / (P_pred + self.R)
            x_hat[t] = x_pred + K[t] * (observations[t] - x_pred)
            P[t]   = (1 - K[t]) * P_pred
        return x_hat, P, K

    def smooth_series(self, series: pd.Series) -> pd.Series:
        clean = series.dropna()
        if clean.empty:
            return pd.Series([], dtype=float, name="Kalman_Trend")
        smoothed, _, _ = self.filter(clean.values)
        return pd.Series(smoothed, index=clean.index, name="Kalman_Trend")

    def residual_noise(self, series: pd.Series) -> pd.Series:
        clean = series.dropna()
        if clean.empty:
            return pd.Series([], dtype=float, name="Kalman_Noise")
        smoothed, _, _ = self.filter(clean.values)
        noise = clean.values - smoothed
        return pd.Series(noise, index=clean.index, name="Kalman_Noise")


# ─── FEATURE HELPERS ──────────────────────────────────────────────────────────
def rolling_zscore(series: pd.Series, window: int = 20) -> pd.Series:
    return (
        (series - series.rolling(window).mean()) / series.rolling(window).std()
    ).rename(f"zscore_{window}")


def vwap_deviation(price: pd.Series, vwap: pd.Series) -> pd.Series:
    return ((price - vwap) / vwap).rename("VWAP_Dev")


def stochastic_volatility(returns: pd.Series) -> pd.Series:
    vol = returns.rolling(20).std() * np.sqrt(252)
    return vol.rename("StochVol")


# ─── FEATURE ENGINE ───────────────────────────────────────────────────────────
class FeatureEngine:
    def __init__(self, kalman_Q: float = 1e-4, kalman_R: float = 1e-2):
        self.kf              = KalmanFilter(Q=kalman_Q, R=kalman_R)
        self.features        : pd.DataFrame = pd.DataFrame()
        self.kalman_trend    : pd.Series     = pd.Series(dtype=float)
        self.kalman_noise    : pd.Series     = pd.Series(dtype=float)
        self.coint_result    : dict          = {}
        self.insider_engine  = InsiderEngine()

        # ── Black-Scholes engine (lazy import para no romper si scipy falta) ──
        self._bs_engine      = None
        self.iv_hv_ratio     : float         = float("nan")

    # ── Lazy accessor para BSEngine ───────────────────────────────────────────
    @property
    def bs_engine(self):
        if self._bs_engine is None:
            try:
                from engines.bs_engine import BSEngine
                self._bs_engine = BSEngine()
            except Exception:
                pass
        return self._bs_engine

    # ── Build principal ───────────────────────────────────────────────────────
    def build(self, prices: pd.DataFrame, returns: pd.DataFrame,
              vwap: pd.Series) -> pd.DataFrame:

        prices.index  = pd.to_datetime(prices.index,  utc=True)
        returns.index = pd.to_datetime(returns.index, utc=True)

        gold_price = prices["XAUUSD"]  if "XAUUSD" in prices.columns  else prices.iloc[:, 0]
        gold_ret   = returns["XAUUSD"] if "XAUUSD" in returns.columns else returns.iloc[:, 0]

        # ── Kalman trend + noise ───────────────────────────────────────────────
        self.kalman_trend = self.kf.smooth_series(gold_price)
        self.kalman_noise = self.kf.residual_noise(gold_price)

        # ── Features técnicas base ────────────────────────────────────────────
        feat_list = [
            rolling_zscore(gold_ret, window=20),
            rolling_zscore(gold_ret, window=60),
            vwap_deviation(gold_price, vwap)
                if not vwap.empty
                else pd.Series(0, index=gold_price.index, name="VWAP_Dev"),
            stochastic_volatility(gold_ret),
        ]

        # ── Insider score ─────────────────────────────────────────────────────
        self.insider_engine.run()
        insider_score = (
            self.insider_engine.score_series
            .reindex(gold_price.index)
            .ffill()
            .fillna(0)
        )
        feat_list.append(insider_score.rename("InsiderScore"))

        # ── Cointegración Gold / DXY ──────────────────────────────────────────
        if "DXY" in prices.columns:
            dxy    = prices["DXY"]
            slope, intercept, r, p, se = stats.linregress(dxy.values, gold_price.values)
            spread = gold_price - slope * dxy - intercept
            z_coint = (spread - spread.rolling(60).mean()) / spread.rolling(60).std()
            feat_list.append(z_coint.rename("Coint_ZScore"))
            self.coint_result = {
                "spread"   : spread,
                "zscore"   : z_coint,
                "beta"     : slope,
                "r_squared": r ** 2,
            }

        # ── Ensamblar features ────────────────────────────────────────────────
        self.features = pd.concat(feat_list, axis=1).dropna()

        # ── Black-Scholes: IV/HV ratio como feature adicional ─────────────────
        # Se ejecuta después del ensamble principal para no bloquear el pipeline
        # si GVZ no está disponible o scipy no está instalado.
        try:
            bs = self.bs_engine
            if bs is not None:
                from engines.data_engine import fetch_live_price
                live = fetch_live_price()
                spot = live.get("last_price", float("nan"))
                if spot == spot and spot > 0:          # check not NaN
                    bs.run(spot_price=spot, returns_series=gold_ret)
                    iv_hv = bs.iv_feature
                    self.iv_hv_ratio = iv_hv
                    if iv_hv == iv_hv:                 # check not NaN
                        self.features["iv_hv_ratio"] = iv_hv  # scalar broadcast → columna constante
        except Exception:
            pass   # degradación silenciosa — el resto del pipeline sigue intacto

        return self.features

    # ── Último vector de features ─────────────────────────────────────────────
    def get_latest(self) -> dict:
        if self.features.empty:
            return {}
        return self.features.iloc[-1].to_dict()