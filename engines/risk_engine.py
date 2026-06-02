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

# --- Gestión de Riesgo Dinámica Corregida ---

def calculate_atr(ohlc: pd.DataFrame, window: int = 14) -> pd.Series:
    h, l, c = ohlc["High"], ohlc["Low"], ohlc["Close"]
    tr = pd.concat([
        (h - l),
        (h - c.shift()).abs(),
        (l - c.shift()).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(window=window).mean().rename("ATR")

def get_dynamic_levels(price: float, atr: float, side: str, atr_mult_sl: float = 1.5, atr_mult_tp: float = 1.5) -> dict:
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

def volatility_adjusted_size(capital: float, risk_per_trade: float, sl_dist: float, contract_size: float = 100.0) -> float:
    """
    Calcula el lotaje real de MT5 ajustado al riesgo monetario exacto.
    Para Oro (XAUUSD), contract_size estándar = 100.0 oz por lote.
    """
    if sl_dist <= 0:
        return 0.0
    risk_amount = capital * risk_per_trade
    # Fórmula institucional: Lotes = Riesgo en USD / (Distancia SL * Tamaño Contrato)
    size_lots = risk_amount / (sl_dist * contract_size)
    
    # Restricciones operativas de brokers de fondeo
    if size_lots < 0.01:
        return 0.01
    return float(round(size_lots, 2))

class RiskEngine:
    def __init__(self, confidence: float = 0.95):
        self.confidence = confidence
        self.metrics: dict = {}
        self.atr_window = 14
        self.atr_mult_sl = 1.5
        self.atr_mult_tp = 1.5  # Ratio 1:1 optimizado para Winrate
        self.risk_per_trade = 0.01  # 1% de riesgo por operación
        self.contract_size = 100.0  # Ajuste nativo para XAUUSD en MT5

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
        """Genera setup con niveles dinámicos y lotaje formateado para MT5."""
        atr_series = calculate_atr(ohlc, self.atr_window)
        if atr_series.empty or np.isnan(atr_series.iloc[-1]):
            return {}
        
        atr = atr_series.iloc[-1]
        levels = get_dynamic_levels(current_price, atr, side, self.atr_mult_sl, self.atr_mult_tp)
        sl_dist = abs(current_price - levels["SL"])
        
        # Corrección de tamaño para pasar unidades brutas a lotes MT5
        size_lots = volatility_adjusted_size(capital, self.risk_per_trade, sl_dist, self.contract_size)
        
        return {
            "side": side,
            "entry": current_price,
            "SL": levels["SL"],
            "TP": levels["TP"],
            "size_lots": size_lots,
            "risk_amount": capital * self.risk_per_trade,
            "atr": atr,
            "rr_ratio": self.atr_mult_tp / self.atr_mult_sl
        }