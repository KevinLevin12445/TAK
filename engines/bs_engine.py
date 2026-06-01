"""
engines/bs_engine.py
────────────────────
Black-Scholes + Implied Volatility engine para XAUUSD CFD.

Uso en TAK:
  from engines.bs_engine import BSEngine
  bs = BSEngine()
  bs.run(spot_price=2350.0)
  print(bs.metrics)          # dict con IV, HV, ratio, stop_levels, etc.
  print(bs.signal)           # "REDUCE_SIZE" | "NORMAL" | "EXPAND_SIZE"

Integración con feature_engine:
  Llama bs.iv_feature(spot, hv_20) para obtener el scalar IV/HV
  y agrégalo como columna extra en el DataFrame de features.
"""

import numpy as np
from scipy.stats import norm
from scipy.optimize import brentq
import warnings
warnings.filterwarnings("ignore")


# ─── BLACK-SCHOLES CORE ───────────────────────────────────────────────────────

def bs_price(S: float, K: float, T: float, r: float, sigma: float,
             option_type: str = "call") -> float:
    """
    Precio Black-Scholes de una opción europea.

    Parámetros
    ----------
    S     : precio spot del subyacente (XAUUSD)
    K     : strike
    T     : tiempo al vencimiento en años  (ej: 30/365)
    r     : tasa libre de riesgo anualizada (ej: 0.05)
    sigma : volatilidad anualizada          (ej: 0.15 = 15%)
    option_type : "call" o "put"

    Retorna el precio teórico de la opción en USD.
    """
    if T <= 0 or sigma <= 0:
        # Valor intrínseco
        intrinsic = max(S - K, 0) if option_type == "call" else max(K - S, 0)
        return float(intrinsic)

    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)

    if option_type == "call":
        price = S * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2)
    else:
        price = K * np.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)

    return float(price)


def bs_greeks(S: float, K: float, T: float, r: float,
              sigma: float, option_type: str = "call") -> dict:
    """
    Calcula Delta, Gamma, Theta, Vega y Rho.
    Útil para entender la sensibilidad de una posición de opciones sobre GC.
    """
    if T <= 0 or sigma <= 0:
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0,
                "vega": 0.0, "rho": 0.0}

    d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    pdf_d1 = norm.pdf(d1)

    delta = norm.cdf(d1) if option_type == "call" else norm.cdf(d1) - 1
    gamma = pdf_d1 / (S * sigma * np.sqrt(T))
    vega  = S * pdf_d1 * np.sqrt(T) / 100          # por 1% de cambio en vol
    theta_call = (-(S * pdf_d1 * sigma) / (2 * np.sqrt(T))
                  - r * K * np.exp(-r * T) * norm.cdf(d2)) / 365
    theta_put  = (-(S * pdf_d1 * sigma) / (2 * np.sqrt(T))
                  + r * K * np.exp(-r * T) * norm.cdf(-d2)) / 365
    theta = theta_call if option_type == "call" else theta_put
    rho = (K * T * np.exp(-r * T) * norm.cdf(d2) / 100
           if option_type == "call"
           else -K * T * np.exp(-r * T) * norm.cdf(-d2) / 100)

    return {"delta": delta, "gamma": gamma, "theta": theta,
            "vega": vega, "rho": rho}


def implied_vol(market_price: float, S: float, K: float, T: float,
                r: float, option_type: str = "call",
                tol: float = 1e-6) -> float:
    """
    Calcula la volatilidad implícita usando Brent method.
    Retorna NaN si no converge (precio fuera de arbitraje, T=0, etc).
    """
    if T <= 0 or market_price <= 0:
        return float("nan")

    intrinsic = max(S - K, 0) if option_type == "call" else max(K - S, 0)
    if market_price <= intrinsic:
        return float("nan")

    try:
        iv = brentq(
            lambda sigma: bs_price(S, K, T, r, sigma, option_type) - market_price,
            1e-6, 10.0, xtol=tol, maxiter=500
        )
        return float(iv)
    except (ValueError, RuntimeError):
        return float("nan")


def touch_probability(S: float, barrier: float, T: float,
                      sigma: float, r: float = 0.0) -> float:
    """
    Probabilidad de que el precio TOQUE el nivel `barrier` antes de T.
    Basado en la solución analítica de barrera simple (sin reflección).

    Úsala para calcular stops no arbitrarios:
      - Si quieres stop con P(toque) = 15%, calcula qué nivel da ese 15%.
      - Más conservador que poner stop "a ojo".

    Retorna probabilidad entre 0 y 1.
    """
    if T <= 0 or sigma <= 0:
        return 1.0 if abs(S - barrier) < 1e-6 else 0.0

    # Fórmula de barrera reflectante (bilateral, más conservadora)
    mu = r - 0.5 * sigma ** 2
    x  = (np.log(barrier / S) - mu * T) / (sigma * np.sqrt(T))
    x2 = (np.log(barrier / S) + mu * T) / (sigma * np.sqrt(T))

    prob = norm.cdf(-abs(x)) + np.exp(2 * mu * np.log(barrier / S) / sigma ** 2) * norm.cdf(-abs(x2))
    return float(np.clip(prob, 0.0, 1.0))


def stop_at_probability(S: float, T: float, sigma: float,
                        r: float = 0.0, target_prob: float = 0.15,
                        direction: str = "long") -> float:
    """
    Calcula el nivel de stop que corresponde a una probabilidad de toque dada.
    direction = "long"  → busca stop por DEBAJO de S
    direction = "short" → busca stop por ENCIMA de S

    Ejemplo:
      stop = stop_at_probability(S=2350, T=1/252, sigma=0.14,
                                 target_prob=0.15, direction="long")
      → nivel donde hay 15% de prob de toque en 1 día con vol=14%
    """
    if direction == "long":
        lo, hi = S * 0.80, S * 0.9999
    else:
        lo, hi = S * 1.0001, S * 1.20

    try:
        level = brentq(
            lambda barrier: touch_probability(S, barrier, T, sigma, r) - target_prob,
            lo, hi, xtol=0.01, maxiter=200
        )
        return float(level)
    except (ValueError, RuntimeError):
        # Fallback: ATR-based rough estimate
        daily_move = S * sigma / np.sqrt(252)
        return (S - 1.5 * daily_move) if direction == "long" else (S + 1.5 * daily_move)


# ─── BSENGINE CLASS ───────────────────────────────────────────────────────────

class BSEngine:
    """
    Motor principal que integra con el TAK.

    Flujo:
      1. bs.run(spot_price, hv_series)   ← llámalo después de cargar data_engine
      2. bs.metrics   → dict con todas las métricas
      3. bs.signal    → "REDUCE_SIZE" | "NORMAL" | "EXPAND_SIZE"
      4. bs.iv_feature → scalar para agregar al feature_engine
    """

    # Umbrales de ratio IV/HV para señales de sizing
    REDUCE_ABOVE  = 1.30   # IV > 130% de HV → mercado nervioso → reduce size
    EXPAND_BELOW  = 0.85   # IV < 85%  de HV → opciones baratas → puede expandir

    def __init__(self, risk_free_rate: float = 0.05):
        self.r       = risk_free_rate
        self.metrics: dict = {}
        self.signal:  str  = "NORMAL"
        self._iv_scalar: float = float("nan")

    # ── Volatilidad histórica anualizada ──────────────────────────────────────
    @staticmethod
    def historical_vol(returns_series, window: int = 20) -> float:
        """
        HV anualizada usando los últimos `window` retornos.
        Usa la misma convención que el risk_engine del TAK.
        """
        import pandas as pd
        if hasattr(returns_series, "dropna"):
            r = returns_series.dropna()
        else:
            r = pd.Series(returns_series).dropna()

        if len(r) < window:
            return float(r.std() * np.sqrt(252)) if len(r) > 1 else 0.15

        return float(r.iloc[-window:].std() * np.sqrt(252))

    # ── Volatilidad implícita del GVZ (proxy público) ─────────────────────────
    @staticmethod
    def fetch_gvz() -> float:
        """
        Intenta descargar el GVZ (CBOE Gold Vol Index) vía yfinance.
        GVZ ≈ IV implícita de opciones sobre GLD (30-day).
        Retorna la última lectura en formato decimal (ej: 0.148 = 14.8%).
        Si falla, retorna NaN.
        """
        try:
            import yfinance as yf
            gvz = yf.Ticker("^GVZ").history(period="5d")
            if gvz.empty:
                return float("nan")
            return float(gvz["Close"].iloc[-1]) / 100.0
        except Exception:
            return float("nan")

    # ── Run principal ─────────────────────────────────────────────────────────
    def run(self, spot_price: float, returns_series=None,
            hv_window: int = 20, T_days: int = 30) -> None:
        """
        Calcula todas las métricas del motor.

        Parámetros
        ----------
        spot_price     : precio spot actual de XAUUSD
        returns_series : pd.Series de retornos diarios del TAK (data_engine.get_xau_returns())
        hv_window      : ventana para HV (default 20 días)
        T_days         : horizonte en días para pricing de stops (default 30)
        """
        S  = spot_price
        T  = T_days / 365.0
        r  = self.r

        # ── 1. Volatilidad histórica ──────────────────────────────────────────
        if returns_series is not None:
            hv = self.historical_vol(returns_series, hv_window)
        else:
            hv = 0.15   # fallback conservador

        # ── 2. Volatilidad implícita (GVZ) ───────────────────────────────────
        iv = self.fetch_gvz()
        if np.isnan(iv):
            iv = hv * 1.10    # si GVZ no disponible, asume IV ligeramente > HV

        # ── 3. Ratio IV/HV ────────────────────────────────────────────────────
        iv_hv_ratio = iv / hv if hv > 0 else 1.0
        self._iv_scalar = iv_hv_ratio

        # ── 4. Stops dinámicos basados en probabilidad de toque ───────────────
        # Stop conservador (15% prob de toque en T días)
        stop_long_15  = stop_at_probability(S, T, iv, r, 0.15, "long")
        stop_short_15 = stop_at_probability(S, T, iv, r, 0.15, "short")

        # Stop agresivo (25% prob)
        stop_long_25  = stop_at_probability(S, T, iv, r, 0.25, "long")
        stop_short_25 = stop_at_probability(S, T, iv, r, 0.25, "short")

        # ── 5. Precio teórico ATM call y put (referencia) ─────────────────────
        atm_call = bs_price(S, S, T, r, iv, "call")
        atm_put  = bs_price(S, S, T, r, iv, "put")

        # ── 6. Greeks ATM ─────────────────────────────────────────────────────
        greeks = bs_greeks(S, S, T, r, iv, "call")

        # ── 7. Expected move (1 sigma, ~68% prob) ─────────────────────────────
        expected_move_1sig = S * iv * np.sqrt(T)
        expected_move_1d   = S * iv / np.sqrt(252)

        # ── 8. Señal de sizing ────────────────────────────────────────────────
        if iv_hv_ratio >= self.REDUCE_ABOVE:
            self.signal = "REDUCE_SIZE"
        elif iv_hv_ratio <= self.EXPAND_BELOW:
            self.signal = "EXPAND_SIZE"
        else:
            self.signal = "NORMAL"

        # ── 9. Construir dict de métricas ─────────────────────────────────────
        self.metrics = {
            # Volatilidades
            "IV"              : round(iv, 4),
            "HV_20"           : round(hv, 4),
            "IV_HV_ratio"     : round(iv_hv_ratio, 4),
            "IV_pct"          : round(iv * 100, 2),
            "HV_pct"          : round(hv * 100, 2),

            # Señal de sizing
            "sizing_signal"   : self.signal,

            # Stops dinámicos
            "stop_long_15pct" : round(stop_long_15, 2),
            "stop_long_25pct" : round(stop_long_25, 2),
            "stop_short_15pct": round(stop_short_15, 2),
            "stop_short_25pct": round(stop_short_25, 2),

            # Movimiento esperado
            "exp_move_30d_1s" : round(expected_move_1sig, 2),
            "exp_move_1d_1s"  : round(expected_move_1d, 2),

            # Precios teóricos ATM
            "atm_call_price"  : round(atm_call, 2),
            "atm_put_price"   : round(atm_put, 2),

            # Greeks ATM call
            "delta"           : round(greeks["delta"], 4),
            "gamma"           : round(greeks["gamma"], 6),
            "theta_daily"     : round(greeks["theta"], 4),
            "vega_1pct"       : round(greeks["vega"], 4),

            # Parámetros usados
            "spot"            : round(S, 2),
            "T_days"          : T_days,
            "risk_free_rate"  : r,
        }

    # ── Feature scalar para feature_engine ───────────────────────────────────
    @property
    def iv_feature(self) -> float:
        """
        Retorna el ratio IV/HV como scalar normalizado.
        Listo para agregar como columna al DataFrame de features del TAK.
        Valores: ~0.7 (vol barata) ... 1.0 (neutral) ... 1.5+ (vol cara)
        """
        return self._iv_scalar

    # ── Resumen en texto (para el comando /bs en el terminal) ─────────────────
    def summary(self) -> str:
        m = self.metrics
        if not m:
            return "[ERROR] — BSEngine no inicializado. Llama bs.run() primero."

        sig_icon = {
            "REDUCE_SIZE" : "⚠ REDUCE SIZE",
            "NORMAL"      : "✓ NORMAL",
            "EXPAND_SIZE" : "↑ EXPAND SIZE",
        }.get(m["sizing_signal"], "—")

        lines = [
            "═══════════════════════════════════════",
            "  BLACK-SCHOLES ENGINE — XAUUSD CFD",
            "═══════════════════════════════════════",
            f"  Spot           : {m['spot']:,.2f}",
            f"  IV  (GVZ)      : {m['IV_pct']:.2f}%",
            f"  HV  (20d)      : {m['HV_pct']:.2f}%",
            f"  IV/HV ratio    : {m['IV_HV_ratio']:.4f}  [{sig_icon}]",
            "───────────────────────────────────────",
            f"  Exp. move 1d   : ±{m['exp_move_1d_1s']:,.2f} USD (1σ)",
            f"  Exp. move 30d  : ±{m['exp_move_30d_1s']:,.2f} USD (1σ)",
            "───────────────────────────────────────",
            "  STOPS DINÁMICOS (prob. toque)",
            f"  Long  stop 15%  : {m['stop_long_15pct']:,.2f}",
            f"  Long  stop 25%  : {m['stop_long_25pct']:,.2f}",
            f"  Short stop 15%  : {m['stop_short_15pct']:,.2f}",
            f"  Short stop 25%  : {m['stop_short_25pct']:,.2f}",
            "───────────────────────────────────────",
            "  ATM OPTIONS (30d teórico)",
            f"  Call price     : {m['atm_call_price']:,.2f} USD",
            f"  Put  price     : {m['atm_put_price']:,.2f} USD",
            "───────────────────────────────────────",
            "  GREEKS (ATM call, 30d)",
            f"  Delta          : {m['delta']:.4f}",
            f"  Gamma          : {m['gamma']:.6f}",
            f"  Theta (daily)  : {m['theta_daily']:.4f}",
            f"  Vega (per 1%)  : {m['vega_1pct']:.4f}",
            "═══════════════════════════════════════",
        ]
        return "\n".join(lines)
