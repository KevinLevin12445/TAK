
import numpy as np
import pandas as pd
from scipy import stats
import warnings
warnings.filterwarnings("ignore")

# --- Métricas de Riesgo Estándar ---

def value_at_risk(returns: pd.Series, confidence: float = 0.95, method: str = "parametric") -> float:
    clean = returns.dropna()
    if len(clean) < 5:
        return np.nan
    if method == "historical":
        return float(-np.percentile(clean, (1 - confidence) * 100))
    mu = clean.mean()
    sigma = clean.std()
    z = stats.norm.ppf(confidence)
    return float(-(mu - z * sigma))

def expected_shortfall(returns: pd.Series, confidence: float = 0.95) -> float:
    clean = returns.dropna()
    if len(clean) < 5:
        return np.nan
    var = value_at_risk(clean, confidence=confidence, method="historical")
    losses = -clean
    tail = losses[losses > var]
    if len(tail) == 0:
        return var
    return float(tail.mean())

def max_drawdown(price: pd.Series) -> dict:
    clean = price.dropna()
    if len(clean) < 2:
        return {"max_dd": np.nan, "current_dd": np.nan, "peak": np.nan}
    rolling_max = clean.cummax()
    dd = (clean - rolling_max) / rolling_max
    max_dd = float(dd.min())
    current_dd = float(dd.iloc[-1])
    peak = float(rolling_max.iloc[-1])
    return {
        "max_dd": max_dd,
        "current_dd": current_dd,
        "peak": peak,
        "drawdown_series": dd,
    }

def kelly_criterion(returns: pd.Series) -> float:
    clean = returns.dropna()
    mu = clean.mean()
    sigma2 = clean.var()
    if sigma2 <= 0:
        return 0.0
    return float(mu / sigma2)

# --- Gestión de Riesgo Dinámica (Nuevas Funciones) ---

def calculate_atr(ohlc: pd.DataFrame, window: int = 14) -> pd.Series:
    h, l, c = ohlc["High"], ohlc["Low"], ohlc["Close"]
    tr = pd.concat([
        (h - l),
        (h - c.shift()).abs(),
        (l - c.shift()).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(window=window).mean().rename("ATR")

def get_dynamic_levels(price: float, atr: float, side: str, atr_mult_sl: float = 1.5, atr_mult_tp: float = 3.0) -> dict:
    """Calcula niveles de SL y TP basados en ATR."""
    if side == "LONG":
        sl = price - (atr_mult_sl * atr)
        tp = price + (atr_mult_tp * atr)
    elif side == "SHORT":
        sl = price + (atr_mult_sl * atr)
        tp = price - (atr_mult_tp * atr)
    else:
        sl, tp = price, price
    return {"SL": float(sl), "TP": float(tp)}

def volatility_adjusted_size(capital: float, risk_per_trade: float, price: float, sl_dist: float) -> float:
    """
    Calcula el tamaño de la posición ajustado por riesgo y distancia al SL.
    risk_per_trade: porcentaje de capital a arriesgar (ej. 0.01 para 1%).
    sl_dist: distancia absoluta del precio al SL.
    """
    if sl_dist <= 0:
        return 0.0
    risk_amount = capital * risk_per_trade
    # Tamaño en unidades del activo
    size = risk_amount / sl_dist
    return float(size)

class RiskEngine:
    def __init__(self, confidence: float = 0.95):
        self.confidence = confidence
        self.metrics: dict = {}
        self.atr_window = 14
        self.atr_mult_sl = 1.5
        self.atr_mult_tp = 1.5 # Reducido para aumentar winrate (Ratio 1:1)
        self.risk_per_trade = 0.01 # 1% por defecto

    def run(self, returns: pd.Series, price: pd.Series, ohlc: pd.DataFrame = None) -> dict:
        var_param = value_at_risk(returns, confidence=self.confidence, method="parametric")
        var_hist = value_at_risk(returns, confidence=self.confidence, method="historical")
        es = expected_shortfall(returns, confidence=self.confidence)
        dd = max_drawdown(price)
        kelly = kelly_criterion(returns)
        
        sigma_daily = float(returns.std())
        sigma_annual = sigma_daily * np.sqrt(252)
        mu_annual = float(returns.mean()) * 252
        sharpe = mu_annual / sigma_annual if sigma_annual > 0 else 0.0

        # Calcular ATR si hay OHLC disponible
        current_atr = np.nan
        if ohlc is not None and not ohlc.empty:
            atr_series = calculate_atr(ohlc, self.atr_window)
            current_atr = float(atr_series.iloc[-1]) if not atr_series.empty else np.nan

        self.metrics = {
            "VaR_95_param": var_param,
            "VaR_95_hist": var_hist,
            "ES_95": es,
            "max_drawdown": dd["max_dd"],
            "current_drawdown": dd["current_dd"],
            "kelly_fraction": kelly,
            "sharpe_ratio": sharpe,
            "vol_daily": sigma_daily,
            "vol_annual": sigma_annual,
            "current_atr": current_atr,
            "drawdown_series": dd.get("drawdown_series", pd.Series(dtype=float)),
        }
        return self.metrics

    def get_trade_setup(self, current_price: float, side: str, capital: float, ohlc: pd.DataFrame) -> dict:
        """Genera un setup completo de trade con SL, TP y tamaño de posición."""
        atr_series = calculate_atr(ohlc, self.atr_window)
        if atr_series.empty or np.isnan(atr_series.iloc[-1]):
            return {}
        
        atr = atr_series.iloc[-1]
        levels = get_dynamic_levels(current_price, atr, side, self.atr_mult_sl, self.atr_mult_tp)
        sl_dist = abs(current_price - levels["SL"])
        size = volatility_adjusted_size(capital, self.risk_per_trade, current_price, sl_dist)
        
        return {
            "side": side,
            "entry": current_price,
            "SL": levels["SL"],
            "TP": levels["TP"],
            "size_units": size,
            "risk_amount": capital * self.risk_per_trade,
            "atr": atr,
            "rr_ratio": self.atr_mult_tp / self.atr_mult_sl
        }
