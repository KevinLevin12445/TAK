
import numpy as np
import pandas as pd
from scipy import stats
from .insider_engine import InsiderEngine
import warnings
warnings.filterwarnings("ignore")

# --- KALMAN FILTER ---
class KalmanFilter:
    def __init__(self, Q: float = 1e-4, R: float = 1e-2):
        self.Q = Q
        self.R = R

    def filter(self, observations: np.ndarray):
        n = len(observations)
        if n == 0: return np.array([]), np.array([]), np.array([])
        x_hat, P, K = np.zeros(n), np.zeros(n), np.zeros(n)
        x_hat[0], P[0] = observations[0], 1.0
        for t in range(1, n):
            x_pred = x_hat[t - 1]
            P_pred = P[t - 1] + self.Q
            K[t] = P_pred / (P_pred + self.R)
            x_hat[t] = x_pred + K[t] * (observations[t] - x_pred)
            P[t] = (1 - K[t]) * P_pred
        return x_hat, P, K

    def smooth_series(self, series: pd.Series) -> pd.Series:
        clean = series.dropna()
        if clean.empty: return pd.Series([], dtype=float, name="Kalman_Trend")
        smoothed, _, _ = self.filter(clean.values)
        return pd.Series(smoothed, index=clean.index, name="Kalman_Trend")

# --- FUNCIONES DE FEATURES ---
def rolling_zscore(series: pd.Series, window: int = 20) -> pd.Series:
    return ((series - series.rolling(window).mean()) / series.rolling(window).std()).rename(f"zscore_{window}")

def vwap_deviation(price: pd.Series, vwap: pd.Series) -> pd.Series:
    return ((price - vwap) / vwap).rename("VWAP_Dev")

def stochastic_volatility(returns: pd.Series) -> pd.Series:
    vol = returns.rolling(20).std() * np.sqrt(252)
    return vol.rename("StochVol")

class FeatureEngine:
    def __init__(self, kalman_Q=1e-4, kalman_R=1e-2):
        self.kf = KalmanFilter(Q=kalman_Q, R=kalman_R)
        self.features: pd.DataFrame = pd.DataFrame()
        self.insider_engine = InsiderEngine()

    def build(self, prices: pd.DataFrame, returns: pd.DataFrame, vwap: pd.Series) -> pd.DataFrame:
        prices.index = pd.to_datetime(prices.index, utc=True)
        returns.index = pd.to_datetime(returns.index, utc=True)
        
        gold_price = prices["XAUUSD"] if "XAUUSD" in prices.columns else prices.iloc[:, 0]
        gold_ret = returns["XAUUSD"] if "XAUUSD" in returns.columns else returns.iloc[:, 0]

        # Features Técnicas
        feat_list = [
            rolling_zscore(gold_ret, window=20),
            rolling_zscore(gold_ret, window=60),
            vwap_deviation(gold_price, vwap) if not vwap.empty else pd.Series(0, index=gold_price.index),
            stochastic_volatility(gold_ret)
        ]

        # Integración de Insider Score
        # En un entorno real, cargaríamos datos históricos de SEC. Aquí simulamos la serie basada en el motor.
        self.insider_engine.run()
        insider_score_series = self.insider_engine.score_series.reindex(gold_price.index).ffill().fillna(0)
        feat_list.append(insider_score_series.rename("InsiderScore"))

        if "DXY" in prices.columns:
            dxy = prices["DXY"]
            slope, intercept, r, p, se = stats.linregress(dxy.values, gold_price.values)
            spread = gold_price - slope * dxy - intercept
            z_coint = (spread - spread.rolling(60).mean()) / spread.rolling(60).std()
            feat_list.append(z_coint.rename("Coint_ZScore"))

        self.features = pd.concat(feat_list, axis=1).dropna()
        return self.features

    def get_latest(self) -> dict:
        return self.features.iloc[-1].to_dict() if not self.features.empty else {}
