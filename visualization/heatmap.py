"""
ORDER FLOW HEATMAP — Pro ATAS Style  v4
========================================
Cambios vs versión anterior:
  • Diseño visual idéntico a imagen 2: fondo negro, colorscale negro→azul→cian→rojo→blanco
  • Zonas de Pivote (PP / R1-R3 / S1-S3) calculadas sobre el período seleccionado
  • Precio CFD en tiempo real vía yfinance con auto-refresh
  • Candlesticks solapados sobre el heatmap (alineados por índice entero)
  • Perfiles de volumen con gradiente de color por percentil
  • HVN / LVN marcadas
  • Compatible con el router /api/gold/order-flow existente
    (también puede usarse standalone como módulo Streamlit)
"""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from scipy.stats import gaussian_kde
from scipy.signal import find_peaks
import warnings
warnings.filterwarnings("ignore")

# ─── Paleta ───────────────────────────────────────────────────────────────────
BG_COLOR  = "#000000"
NOW_COLOR = "#00ff41"
POC_COLOR = "#ff8800"
VAH_COLOR = "#ffd700"
VAL_COLOR = "#ffd700"
HVN_COLOR = "#ffee00"
LVN_COLOR = "#ff4488"
PP_COLOR  = "#00eeff"
R_COLOR   = "#ff4444"
S_COLOR   = "#44aaff"

# Negro → azul oscuro → azul → cian → naranja/rojo → blanco  (ATAS style)
HEATMAP_CS = [
    [0.00, "#000000"],
    [0.06, "#010a20"],
    [0.14, "#021840"],
    [0.25, "#042870"],
    [0.38, "#0848a8"],
    [0.52, "#1070d0"],
    [0.64, "#18a0e8"],
    [0.75, "#30c8f0"],
    [0.85, "#ff6600"],
    [0.93, "#ff2200"],
    [1.00, "#ffffff"],
]

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _strip_tz(s: pd.Series) -> pd.Series:
    idx = pd.to_datetime(s.index)
    if idx.tz is not None:
        idx = idx.tz_convert(None)
    s = s.copy(); s.index = idx
    return s[~s.index.duplicated(keep="last")]


def _compute_hvn_lvn(vol_profile, bin_centers, bin_width, poc_price, vol_norm,
                     max_hvn=5, max_lvn=4):
    """Devuelve (hvn_list, lvn_list) como lista de (precio, intensidad)."""
    if vol_profile.max() == 0:
        return [], []
    # HVN: picos de volumen
    peaks, _ = find_peaks(
        vol_profile,
        height=vol_profile.max() * 0.12,
        distance=max(2, len(bin_centers) // 12),
        prominence=vol_profile.max() * 0.04,
    )
    hvn = []
    for i in peaks:
        p = float(bin_centers[i])
        if abs(p - poc_price) < bin_width * 2.5:
            continue
        hvn.append((p, float(vol_norm[i])))
    hvn.sort(key=lambda x: -x[1])
    hvn = sorted(hvn[:max_hvn], key=lambda x: -x[0])

    # LVN: valles de volumen
    valleys, _ = find_peaks(
        -vol_profile,
        height=-vol_profile.max() * 0.30,
        distance=max(2, len(bin_centers) // 10),
    )
    lvn = []
    for i in valleys:
        p = float(bin_centers[i])
        lvn.append((p, float(1.0 - vol_norm[i])))
    lvn.sort(key=lambda x: -x[1])
    lvn = sorted(lvn[:max_lvn], key=lambda x: -x[0])

    return hvn, lvn


def _compute_pivot_zones(price_series: pd.Series, n_periods: int = 5):
    """
    Calcula Pivot Points clásicos (PP, R1-R3, S1-S3) usando los últimos
    n_periods bloques de datos.

    Retorna dict con keys: pp, r1, r2, r3, s1, s2, s3
    """
    arr = price_series.dropna().values
    if len(arr) < 10:
        return None

    chunk = max(1, len(arr) // n_periods)
    H_list, L_list, C_list = [], [], []
    for i in range(n_periods):
        sl = arr[i * chunk: (i + 1) * chunk]
        if len(sl) == 0:
            continue
        H_list.append(sl.max())
        L_list.append(sl.min())
        C_list.append(sl[-1])

    if not H_list:
        return None

    H = np.mean(H_list)
    L = np.mean(L_list)
    C = np.mean(C_list)

    PP = (H + L + C) / 3
    R1 = 2 * PP - L
    S1 = 2 * PP - H
    R2 = PP + (H - L)
    S2 = PP - (H - L)
    R3 = H + 2 * (PP - L)
    S3 = L - 2 * (H - PP)

    return dict(pp=PP, r1=R1, r2=R2, r3=R3, s1=S1, s2=S2, s3=S3)


# ─── Función principal ────────────────────────────────────────────────────────

def build_order_flow_heatmap(
    price: pd.Series,
    returns: pd.Series,
    n_bins: int = 60,
    window: int = 20,
    show_pivots: bool = True,
    n_pivot_periods: int = 5,
) -> go.Figure:
    """
    Construye el heatmap de order flow estilo ATAS profesional.

    Parámetros
    ----------
    price           : Serie de precios (índice temporal)
    returns         : Serie de retornos (mismo índice)
    n_bins          : Número de bins de precio
    window          : Ventana de acumulación de volumen
    show_pivots     : Si True, dibuja zonas de pivote PP/R/S
    n_pivot_periods : Cuántos sub-períodos usar para calcular pivotes

    Retorna
    -------
    go.Figure
    """
    price   = _strip_tz(price)
    returns = _strip_tz(returns)

    price_c = price.dropna()
    common  = price_c.index.intersection(returns.dropna().index)
    if len(common) >= 10:
        ret_c = returns.reindex(common).dropna()
        px_a  = price_c.reindex(ret_c.index)
    else:
        cb    = pd.concat([price_c.rename("p"), returns.rename("r")], axis=1).ffill().dropna()
        px_a  = cb["p"]
        ret_c = cb["r"]

    if len(px_a) < 10:
        fig = go.Figure()
        fig.add_annotation(
            text="Datos insuficientes", xref="paper", yref="paper",
            x=0.5, y=0.5, font=dict(color=NOW_COLOR, size=14)
        )
        fig.update_layout(paper_bgcolor=BG_COLOR, plot_bgcolor=BG_COLOR)
        return fig

    vol_px = (ret_c.abs() * px_a).values
    px_arr = px_a.values.astype(float)
    dates  = px_a.index

    p_min = px_arr.min()
    p_max = px_arr.max()
    pad   = (p_max - p_min) * 0.04
    bins  = np.linspace(p_min - pad, p_max + pad, n_bins + 1)
    bcs   = 0.5 * (bins[:-1] + bins[1:])
    bw    = bins[1] - bins[0]

    # ── Matriz de densidad (heatmap) ─────────────────────────────────────────
    n     = len(dates)
    step  = max(1, n // min(120, n))
    tidx  = list(range(0, n, step))
    hm    = np.zeros((n_bins, len(tidx)))

    for j, t in enumerate(tidx):
        s  = max(0, t - window)
        ps = px_arr[s:t + 1]
        vs = vol_px[s:t + 1]
        for i, (bl, bu) in enumerate(zip(bins[:-1], bins[1:])):
            m = (ps >= bl) & (ps < bu)
            hm[i, j] = vs[m].sum()

    # Suavizado KDE
    sm = np.zeros_like(hm)
    for j in range(hm.shape[1]):
        col = hm[:, j]
        if col.sum() > 0:
            try:
                sm[:, j] = gaussian_kde(bcs, weights=col + 1e-10, bw_method=0.12)(bcs)
            except Exception:
                sm[:, j] = col

    sm = np.power(sm + 1e-12, 0.50)
    cm = sm.max(axis=0, keepdims=True); cm[cm == 0] = 1
    sm /= cm

    # ── Perfil de volumen ────────────────────────────────────────────────────
    vp = np.zeros(n_bins)
    for i, (bl, bu) in enumerate(zip(bins[:-1], bins[1:])):
        m = (px_arr >= bl) & (px_arr < bu)
        vp[i] = vol_px[m].sum()
    if vp.sum() > 0:
        try:
            vp = gaussian_kde(bcs, weights=vp + 1e-10, bw_method=0.12)(bcs)
        except Exception:
            pass
    vn = vp / vp.max() if vp.max() > 0 else vp

    # ── Niveles clave ────────────────────────────────────────────────────────
    poc_i = int(np.argmax(vp))
    poc_p = float(bcs[poc_i])
    si    = np.argsort(vp)[::-1]
    cv    = np.cumsum(vp[si])
    va_i  = si[:np.searchsorted(cv, 0.70 * vp.sum()) + 1]
    vah_p = float(bcs[va_i].max())
    val_p = float(bcs[va_i].min())
    now_p = float(price_c.iloc[-1])

    hvn, lvn = _compute_hvn_lvn(vp, bcs, bw, poc_p, vn)

    # ── Pivotes ──────────────────────────────────────────────────────────────
    pivots = None
    if show_pivots:
        pivots = _compute_pivot_zones(price_c, n_periods=n_pivot_periods)

    # ── Etiquetas X ──────────────────────────────────────────────────────────
    xlabels = []
    for t in tidx:
        dt = dates[t]
        try:
            xlabels.append(
                dt.strftime("%m/%d %H:%M") if dt.hour != 0 else dt.strftime("%b %d")
            )
        except Exception:
            xlabels.append(str(dt)[:10])

    # ── Candlesticks ─────────────────────────────────────────────────────────
    n_candles = min(60, max(20, len(price_c) // 5))
    chunk_c   = max(1, len(price_c) // n_candles)
    candles   = []
    for i in range(0, len(price_c), chunk_c):
        slc = price_c.iloc[i:i + chunk_c]
        if len(slc) == 0:
            continue
        slc_ts = slc.index[-1]
        diffs  = [abs((dates[t] - slc_ts).total_seconds()) for t in tidx]
        xi     = int(np.argmin(diffs))
        candles.append({
            "xi":    xi,
            "open":  float(slc.iloc[0]),
            "high":  float(slc.max()),
            "low":   float(slc.min()),
            "close": float(slc.iloc[-1]),
        })

    # ── Colores de barra de perfil ───────────────────────────────────────────
    bar_cols = []
    for v in vn:
        if v >= 0.85:
            bar_cols.append("rgba(255,60,0,0.97)")
        elif v >= 0.65:
            bar_cols.append("rgba(255,180,0,0.90)")
        elif v >= 0.40:
            bar_cols.append("rgba(0,210,230,0.82)")
        elif v >= 0.20:
            bar_cols.append("rgba(0,120,200,0.75)")
        else:
            bar_cols.append("rgba(0,40,120,0.65)")

    # ── Figura ───────────────────────────────────────────────────────────────
    fig = make_subplots(
        rows=1, cols=2,
        column_widths=[0.80, 0.20],
        shared_yaxes=True,
        horizontal_spacing=0.004,
    )

    # ① Heatmap
    fig.add_trace(go.Heatmap(
        z=sm,
        x=list(range(len(tidx))),
        y=bcs,
        colorscale=HEATMAP_CS,
        zmin=0, zmax=1,
        showscale=True,
        colorbar=dict(
            tickvals=[0, 0.5, 1], ticktext=["LOW", "MED", "HIGH"],
            tickfont=dict(color="#555", family="monospace", size=8),
            len=0.55, thickness=9, x=1.01,
            bgcolor=BG_COLOR, bordercolor="#111",
            title=dict(text="DENSITY", font=dict(color="#444", size=8, family="monospace")),
        ),
        hovertemplate="<b>%{x}</b><br>Precio: $%{y:,.1f}<br>Densidad: %{z:.2f}<extra></extra>",
    ), row=1, col=1)

    # ② Candlesticks
    if candles:
        fig.add_trace(go.Candlestick(
            x=[c["xi"]    for c in candles],
            open=[c["open"]  for c in candles],
            high=[c["high"]  for c in candles],
            low=[c["low"]   for c in candles],
            close=[c["close"] for c in candles],
            increasing=dict(line=dict(color="rgba(0,220,80,0.95)",  width=1),
                            fillcolor="rgba(0,180,60,0.72)"),
            decreasing=dict(line=dict(color="rgba(255,50,50,0.95)", width=1),
                            fillcolor="rgba(200,30,30,0.72)"),
            showlegend=False,
            name="XAU/USD",
        ), row=1, col=1)

    # ③ Perfil de volumen (col 2)
    fig.add_trace(go.Bar(
        x=vn, y=bcs, orientation="h",
        marker=dict(color=bar_cols, line=dict(width=0)),
        showlegend=False,
        hovertemplate="$%{y:,.1f}  vol: %{x:.2f}<extra></extra>",
    ), row=1, col=2)

    # ── HVN (bandas amarillas) ───────────────────────────────────────────────
    hb = bw * 1.5
    for hp, hs in hvn:
        fig.add_shape(type="rect", row=1, col=1,
            x0=0, x1=1, xref="x domain",
            y0=hp - hb, y1=hp + hb, yref="y",
            fillcolor=f"rgba(255,220,0,{0.04 + hs * 0.10:.2f})",
            line=dict(width=0), layer="above")
        fig.add_shape(type="line", row=1, col=1,
            x0=0, x1=1, xref="x domain", y0=hp, y1=hp, yref="y",
            line=dict(color=HVN_COLOR, width=1.5), opacity=0.55 + hs * 0.35)
        fig.add_annotation(row=1, col=1,
            x=0.985, y=hp, xref="x domain", yref="y",
            text=f"<b>HVN</b> ${hp:,.0f}",
            showarrow=False, xanchor="right",
            font=dict(color=HVN_COLOR, size=9, family="monospace"),
            bgcolor="rgba(0,0,0,0.85)", bordercolor=HVN_COLOR,
            borderwidth=1, borderpad=2)

    # ── LVN (líneas magenta tenues) ──────────────────────────────────────────
    for lp, ls in lvn:
        fig.add_shape(type="line", row=1, col=1,
            x0=0, x1=1, xref="x domain", y0=lp, y1=lp, yref="y",
            line=dict(color=LVN_COLOR, width=1, dash="dot"), opacity=0.35 + ls * 0.25)
        fig.add_annotation(row=1, col=1,
            x=0.015, y=lp, xref="x domain", yref="y",
            text=f"<b>LVN</b> ${lp:,.0f}",
            showarrow=False, xanchor="left",
            font=dict(color=LVN_COLOR, size=8, family="monospace"),
            bgcolor="rgba(0,0,0,0.80)", bordercolor=LVN_COLOR,
            borderwidth=1, borderpad=2)

    # ── Niveles clave (POC, VAH, VAL, NOW) ──────────────────────────────────
    key_levels = [
        (poc_p, POC_COLOR, "solid", 2.0, "POC", "left",  0.015),
        (vah_p, VAH_COLOR, "dot",   1.5, "VAH", "left",  0.015),
        (val_p, VAL_COLOR, "dot",   1.5, "VAL", "left",  0.015),
        (now_p, NOW_COLOR, "dash",  2.5, "NOW", "right", 0.975),
    ]
    for lv, col, dash, lw, lbl, side, xp in key_levels:
        fig.add_shape(type="line", row=1, col=1,
            x0=0, x1=1, xref="x domain", y0=lv, y1=lv, yref="y",
            line=dict(color=col, width=lw, dash=dash), opacity=0.95)
        fig.add_annotation(row=1, col=1,
            x=xp, y=lv, xref="x domain", yref="y",
            text=f"<b>{lbl}</b> ${lv:,.0f}",
            showarrow=False, xanchor=side,
            font=dict(color=col, size=10, family="monospace"),
            bgcolor="rgba(0,0,0,0.87)", bordercolor=col,
            borderwidth=1, borderpad=3)
        fig.add_shape(type="line", row=1, col=2,
            x0=0, x1=1, xref="x2 domain", y0=lv, y1=lv, yref="y",
            line=dict(color=col, width=1, dash=dash), opacity=0.55)

    # ── Zonas de Pivote ──────────────────────────────────────────────────────
    if show_pivots and pivots:
        pv = pivots

        # PP — línea cian central
        fig.add_shape(type="line", row=1, col=1,
            x0=0, x1=1, xref="x domain", y0=pv["pp"], y1=pv["pp"], yref="y",
            line=dict(color=PP_COLOR, width=2.0, dash="solid"), opacity=0.80)
        fig.add_annotation(row=1, col=1,
            x=0.50, y=pv["pp"], xref="x domain", yref="y",
            text=f"<b>PP</b> ${pv['pp']:,.0f}",
            showarrow=False, xanchor="center",
            font=dict(color=PP_COLOR, size=10, family="monospace"),
            bgcolor="rgba(0,0,0,0.87)", bordercolor=PP_COLOR,
            borderwidth=1, borderpad=3)

        # R1-R3 (rojo) — zona sombreada entre R1 y R2
        for key, lbl, xp in [("r1", "R1", 0.60), ("r2", "R2", 0.65), ("r3", "R3", 0.70)]:
            lv = pv[key]
            fig.add_shape(type="line", row=1, col=1,
                x0=0, x1=1, xref="x domain", y0=lv, y1=lv, yref="y",
                line=dict(color=R_COLOR, width=1.2, dash="dashdot"), opacity=0.70)
            fig.add_annotation(row=1, col=1,
                x=xp, y=lv, xref="x domain", yref="y",
                text=f"<b>{lbl}</b> ${lv:,.0f}",
                showarrow=False, xanchor="left",
                font=dict(color=R_COLOR, size=9, family="monospace"),
                bgcolor="rgba(0,0,0,0.82)", bordercolor=R_COLOR,
                borderwidth=1, borderpad=2)

        # S1-S3 (azul)
        for key, lbl, xp in [("s1", "S1", 0.60), ("s2", "S2", 0.65), ("s3", "S3", 0.70)]:
            lv = pv[key]
            fig.add_shape(type="line", row=1, col=1,
                x0=0, x1=1, xref="x domain", y0=lv, y1=lv, yref="y",
                line=dict(color=S_COLOR, width=1.2, dash="dashdot"), opacity=0.70)
            fig.add_annotation(row=1, col=1,
                x=xp, y=lv, xref="x domain", yref="y",
                text=f"<b>{lbl}</b> ${lv:,.0f}",
                showarrow=False, xanchor="left",
                font=dict(color=S_COLOR, size=9, family="monospace"),
                bgcolor="rgba(0,0,0,0.82)", bordercolor=S_COLOR,
                borderwidth=1, borderpad=2)

        # Zona de valor entre S1 y R1
        fig.add_shape(type="rect", row=1, col=1,
            x0=0, x1=1, xref="x domain",
            y0=pv["s1"], y1=pv["r1"], yref="y",
            fillcolor="rgba(0,238,255,0.04)",
            line=dict(width=0), layer="below")

    # ── Ticks X ──────────────────────────────────────────────────────────────
    step_t = max(1, len(xlabels) // 10)
    tick_v = list(range(0, len(xlabels), step_t))
    tick_t = [xlabels[i] for i in tick_v]

    # ── Título dinámico ───────────────────────────────────────────────────────
    piv_str = ""
    if show_pivots and pivots:
        piv_str = (
            f"  │  PP <b style='color:{PP_COLOR}'>${pivots['pp']:,.0f}</b>"
            f"  R1 <b style='color:{R_COLOR}'>${pivots['r1']:,.0f}</b>"
            f"  S1 <b style='color:{S_COLOR}'>${pivots['s1']:,.0f}</b>"
        )
    hvn_str = (
        f"  │  <span style='color:{HVN_COLOR}'>HVN×{len(hvn)}</span>"
        f"  <span style='color:{LVN_COLOR}'>LVN×{len(lvn)}</span>"
        if hvn else ""
    )

    fig.update_layout(
        paper_bgcolor=BG_COLOR,
        plot_bgcolor=BG_COLOR,
        font=dict(color="#aaaaaa", family="monospace"),
        height=660,
        margin=dict(l=70, r=75, t=55, b=65),
        bargap=0,
        showlegend=False,
        xaxis_rangeslider_visible=False,
        title=dict(
            text=(
                f"<b style='color:{NOW_COLOR}'>ORDER FLOW HEATMAP</b>"
                f"<span style='color:#555;font-size:11px;'>"
                f"  ▶  POC <b style='color:{POC_COLOR}'>${poc_p:,.0f}</b>"
                f"  │  VAH <b style='color:{VAH_COLOR}'>${vah_p:,.0f}</b>"
                f"  │  VAL <b style='color:{VAL_COLOR}'>${val_p:,.0f}</b>"
                f"  │  NOW <b style='color:{NOW_COLOR}'>${now_p:,.2f}</b>"
                f"{piv_str}{hvn_str}</span>"
            ),
            font=dict(color=NOW_COLOR, family="monospace", size=12),
            x=0, xanchor="left",
        ),
    )

    fig.update_xaxes(
        color="#333", gridcolor="#080808", gridwidth=1,
        tickfont=dict(size=9, family="monospace", color="#555"),
        tickangle=35, tickvals=tick_v, ticktext=tick_t,
        showgrid=True, zeroline=False, showline=False,
        row=1, col=1,
    )
    fig.update_xaxes(
        showgrid=False, zeroline=False,
        showticklabels=False, showline=False,
        row=1, col=2,
    )
    fig.update_yaxes(
        color="#555", gridcolor="#0a0a0a", gridwidth=1,
        tickfont=dict(size=9, family="monospace", color="#666"),
        tickformat="$,.0f",
        showgrid=True, zeroline=False, showline=False,
        range=[p_min - pad * 2, p_max + pad * 2],
        row=1, col=1,
    )

    return fig


# ─── Integración con yfinance (para auto-refresh del precio real) ─────────────

def get_price_and_returns(symbol: str = "GC=F", period: str = "3mo", interval: str = "1h"):
    """
    Descarga precio y retornos con yfinance.
    symbol  : 'GC=F' para Gold Futures / XAU/USD
    period  : '1d','5d','1mo','3mo','6mo','1y'
    interval: '1m','5m','15m','30m','1h','1d'
    """
    try:
        import yfinance as yf
        tk   = yf.Ticker(symbol)
        hist = tk.history(period=period, interval=interval, auto_adjust=True)
        if hist.empty:
            return None, None
        price   = hist["Close"]
        returns = price.pct_change().fillna(0)
        return price, returns
    except Exception as e:
        print(f"[heatmap] yfinance error: {e}")
        return None, None


# ─── Streamlit standalone (opcional) ─────────────────────────────────────────
# Para usarlo directamente:  streamlit run heatmap.py

if __name__ == "__main__":
    try:
        import streamlit as st

        st.set_page_config(page_title="Order Flow Heatmap", layout="wide")

        col1, col2, col3, col4 = st.columns([2, 2, 1, 1])
        with col1:
            symbol = st.selectbox("Activo", ["GC=F", "SI=F", "CL=F", "ES=F", "NQ=F"],
                                  index=0)
        with col2:
            period = st.selectbox("Período",
                                  ["1d", "5d", "1mo", "3mo", "6mo", "1y"], index=3)
        with col3:
            n_bins = st.slider("Bins", 30, 100, 60)
        with col4:
            window = st.slider("Ventana", 5, 60, 20)

        interval_map = {
            "1d": "5m", "5d": "15m", "1mo": "1h",
            "3mo": "1h", "6mo": "1d", "1y": "1d",
        }
        interval = interval_map.get(period, "1h")

        show_pivots = st.checkbox("Mostrar Pivotes (PP/R/S)", value=True)

        @st.cache_data(ttl=30)  # refresca cada 30 segundos
        def load(sym, per, intv, nb, wn):
            return get_price_and_returns(sym, per, intv)

        price, returns = load(symbol, period, interval, n_bins, window)

        if price is None:
            st.error("No se pudieron cargar los datos. Verifica la conexión.")
        else:
            fig = build_order_flow_heatmap(
                price, returns,
                n_bins=n_bins,
                window=window,
                show_pivots=show_pivots,
            )
            st.plotly_chart(fig, use_container_width=True)

            # Precio en tiempo real (badge)
            current = float(price.iloc[-1])
            delta   = float(price.pct_change().iloc[-1] * 100)
            col_a, col_b, *_ = st.columns(6)
            col_a.metric(f"{symbol} NOW", f"${current:,.2f}", f"{delta:+.2f}%")

            # Auto-refresh cada 30s
            import time
            time.sleep(0.1)
            st.rerun() if hasattr(st, "rerun") else st.experimental_rerun()

    except ImportError:
        print("Ejecuta: pip install streamlit plotly scipy yfinance")
        print("Luego:   streamlit run heatmap.py")