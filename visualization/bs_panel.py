"""
ARCHIVO NUEVO: visualization/bs_panel.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Panel visual de Black-Scholes para integrar como tab en app.py.

INSTRUCCIONES DE USO EN app.py:
  1. Busca donde defines los tabs principales, algo como:
       tab_chart, tab_signal, ..., tab_map = st.tabs([...])
  2. Agrega un tab nuevo:
       tab_chart, tab_signal, ..., tab_bs, tab_map = st.tabs([..., "BS/VOL", ...])
  3. Dentro del with tab_bs: bloque, llama:
       from visualization.bs_panel import render_bs_panel
       render_bs_panel()
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import streamlit as st
import numpy as np
import plotly.graph_objects as go
from engines.bs_engine import BSEngine, bs_price, touch_probability


def render_bs_panel():
    """Renderiza el panel completo de Black-Scholes en el TAK terminal."""

    st.markdown(
        '<div class="section-header">BLACK-SCHOLES ENGINE — IV/HV · STOPS DINÁMICOS · SURFACE</div>',
        unsafe_allow_html=True,
    )

    # ── Obtener spot y retornos del estado del TAK ────────────────────────────
    de = st.session_state.get("data_engine")
    loaded = st.session_state.get("loaded", False)

    if not loaded or de is None:
        st.markdown(
            '<div style="color:#ff4444;font-family:monospace;font-size:12px;">'
            "⚠ Engines no inicializados. Haz clic en INITIALIZE primero.</div>",
            unsafe_allow_html=True,
        )
        return

    from engines.data_engine import fetch_live_price
    live  = fetch_live_price()
    spot  = live.get("last_price", float("nan"))

    if spot != spot or spot <= 0:
        st.markdown(
            '<div style="color:#ff4444;font-family:monospace;font-size:12px;">'
            "⚠ Precio spot no disponible.</div>",
            unsafe_allow_html=True,
        )
        return

    returns = de.get_xau_returns()

    # ── Inicializar y correr BSEngine ─────────────────────────────────────────
    bs = BSEngine()
    bs.run(spot_price=spot, returns_series=returns)
    m  = bs.metrics

    # ── Fila de métricas principales ─────────────────────────────────────────
    col1, col2, col3, col4, col5 = st.columns(5)

    sig_color = {
        "REDUCE_SIZE" : "#ff4444",
        "NORMAL"      : "#00ff41",
        "EXPAND_SIZE" : "#ffd700",
    }.get(m["sizing_signal"], "#00ff41")

    metric_cards = [
        (col1, "IV (GVZ)",      f"{m['IV_pct']:.2f}%",        "#ffd700"),
        (col2, "HV 20d",        f"{m['HV_pct']:.2f}%",        "#00ff41"),
        (col3, "IV/HV ratio",   f"{m['IV_HV_ratio']:.4f}",    sig_color),
        (col4, "Exp move 1d",   f"±{m['exp_move_1d_1s']:.2f}","#00aaff"),
        (col5, "Sizing signal", m["sizing_signal"],            sig_color),
    ]
    for col, label, value, color in metric_cards:
        col.markdown(
            f'<div class="metric-card">'
            f'<div class="metric-label">{label}</div>'
            f'<div class="metric-value" style="font-size:18px;color:{color}">{value}</div>'
            f"</div>",
            unsafe_allow_html=True,
        )

    st.markdown("<hr>", unsafe_allow_html=True)

    # ── Dos columnas: stops y greeks ──────────────────────────────────────────
    left, right = st.columns(2)

    with left:
        st.markdown(
            '<div class="section-header">STOPS DINÁMICOS (prob. de toque)</div>',
            unsafe_allow_html=True,
        )

        stop_data = [
            ("Long  stop 15%", m["stop_long_15pct"],  spot - m["stop_long_15pct"]),
            ("Long  stop 25%", m["stop_long_25pct"],  spot - m["stop_long_25pct"]),
            ("Short stop 15%", m["stop_short_15pct"], m["stop_short_15pct"] - spot),
            ("Short stop 25%", m["stop_short_25pct"], m["stop_short_25pct"] - spot),
        ]
        rows = ""
        for label, level, dist in stop_data:
            color = "#00ff41" if "Long" in label else "#ff4444"
            rows += (
                f'<tr style="border-bottom:1px solid #0a200a;">'
                f'<td style="padding:5px 8px;color:#aaa;font-size:10px;">{label}</td>'
                f'<td style="padding:5px 8px;color:{color};font-size:13px;font-weight:bold;">{level:,.2f}</td>'
                f'<td style="padding:5px 8px;color:#666;font-size:10px;">dist: {dist:,.2f}</td>'
                f"</tr>"
            )
        st.markdown(
            f'<table style="width:100%;border-collapse:collapse;font-family:monospace;">'
            f"<thead><tr style='color:#007722;border-bottom:1px solid #00ff41;'>"
            f"<th style='padding:4px 8px;text-align:left;font-size:9px;'>NIVEL</th>"
            f"<th style='padding:4px 8px;text-align:left;font-size:9px;'>PRECIO</th>"
            f"<th style='padding:4px 8px;text-align:left;font-size:9px;'>DISTANCIA</th>"
            f"</tr></thead><tbody>{rows}</tbody></table>",
            unsafe_allow_html=True,
        )

        # ── ATM options ───────────────────────────────────────────────────────
        st.markdown(
            '<div class="section-header" style="margin-top:12px;">ATM OPTIONS (30d teórico)</div>',
            unsafe_allow_html=True,
        )
        oc1, oc2 = st.columns(2)
        oc1.markdown(
            f'<div class="metric-card"><div class="metric-label">ATM Call</div>'
            f'<div class="metric-value" style="color:#00ff41;font-size:16px;">'
            f'${m["atm_call_price"]:,.2f}</div></div>',
            unsafe_allow_html=True,
        )
        oc2.markdown(
            f'<div class="metric-card"><div class="metric-label">ATM Put</div>'
            f'<div class="metric-value" style="color:#ff4444;font-size:16px;">'
            f'${m["atm_put_price"]:,.2f}</div></div>',
            unsafe_allow_html=True,
        )

    with right:
        st.markdown(
            '<div class="section-header">GREEKS ATM CALL (30d)</div>',
            unsafe_allow_html=True,
        )
        greek_rows = [
            ("Delta",       m["delta"],       "sensibilidad al spot"),
            ("Gamma",       m["gamma"],       "curvatura del delta"),
            ("Theta/día",   m["theta_daily"], "decaimiento temporal"),
            ("Vega / 1%",   m["vega_1pct"],   "sensibilidad a vol"),
        ]
        ghtml = ""
        for name, val, desc in greek_rows:
            ghtml += (
                f'<tr style="border-bottom:1px solid #0a200a;">'
                f'<td style="padding:5px 8px;color:#00ff41;font-size:11px;">{name}</td>'
                f'<td style="padding:5px 8px;color:#ffd700;font-size:13px;">{val:.6f}</td>'
                f'<td style="padding:5px 8px;color:#555;font-size:9px;">{desc}</td>'
                f"</tr>"
            )
        st.markdown(
            f'<table style="width:100%;border-collapse:collapse;font-family:monospace;">'
            f"{ghtml}</table>",
            unsafe_allow_html=True,
        )

    st.markdown("<hr>", unsafe_allow_html=True)

    # ── Superficie de volatilidad (smile simplificado) ────────────────────────
    st.markdown(
        '<div class="section-header">SUPERFICIE BS — PRECIO DE OPCIÓN vs STRIKE vs VENCIMIENTO</div>',
        unsafe_allow_html=True,
    )

    iv_val = m["IV"]
    strikes = np.linspace(spot * 0.88, spot * 1.12, 30)
    tenors  = np.array([7, 14, 30, 60, 90]) / 365.0

    Z_call = np.zeros((len(tenors), len(strikes)))
    for i, T in enumerate(tenors):
        for j, K in enumerate(strikes):
            Z_call[i, j] = bs_price(spot, K, T, 0.05, iv_val, "call")

    fig = go.Figure(data=[
        go.Surface(
            x=strikes,
            y=[int(t * 365) for t in tenors],
            z=Z_call,
            colorscale=[[0, "#001100"], [0.3, "#005500"],
                        [0.6, "#00aa33"], [1.0, "#00ff41"]],
            showscale=False,
            opacity=0.9,
        )
    ])
    fig.update_layout(
        paper_bgcolor="#000000",
        plot_bgcolor="#000000",
        scene=dict(
            xaxis=dict(title="Strike", color="#00ff41",
                       gridcolor="#0a2a0a", backgroundcolor="#000"),
            yaxis=dict(title="Días", color="#00ff41",
                       gridcolor="#0a2a0a", backgroundcolor="#000"),
            zaxis=dict(title="Call Price $", color="#00ff41",
                       gridcolor="#0a2a0a", backgroundcolor="#000"),
            bgcolor="#000000",
        ),
        height=420,
        margin=dict(l=0, r=0, t=0, b=0),
        font=dict(color="#00ff41", family="monospace"),
    )
    st.plotly_chart(fig, use_container_width=True)

    # ── Curva de prob de toque ────────────────────────────────────────────────
    st.markdown(
        '<div class="section-header">PROBABILIDAD DE TOQUE vs NIVEL DE PRECIO (horizonte 30d)</div>',
        unsafe_allow_html=True,
    )

    barriers_long  = np.linspace(spot * 0.85, spot * 0.999, 60)
    barriers_short = np.linspace(spot * 1.001, spot * 1.15, 60)
    T30 = 30 / 365

    probs_long  = [touch_probability(spot, b, T30, iv_val) for b in barriers_long]
    probs_short = [touch_probability(spot, b, T30, iv_val) for b in barriers_short]

    fig2 = go.Figure()
    fig2.add_trace(go.Scatter(
        x=barriers_long, y=[p * 100 for p in probs_long],
        mode="lines", name="Long (downside)",
        line=dict(color="#ff4444", width=2),
    ))
    fig2.add_trace(go.Scatter(
        x=barriers_short, y=[p * 100 for p in probs_short],
        mode="lines", name="Short (upside)",
        line=dict(color="#00ff41", width=2),
    ))
    fig2.add_hline(y=15, line=dict(color="#ffd700", width=1, dash="dash"),
                   annotation_text="15% stop", annotation_font_color="#ffd700")
    fig2.add_hline(y=25, line=dict(color="#ff6600", width=1, dash="dash"),
                   annotation_text="25% stop", annotation_font_color="#ff6600")
    fig2.add_vline(x=spot, line=dict(color="#00ff41", width=1, dash="dot"))

    fig2.update_layout(
        paper_bgcolor="#000000", plot_bgcolor="#000000",
        xaxis=dict(color="#00ff41", gridcolor="#0a2a0a", title="Nivel de precio"),
        yaxis=dict(color="#00ff41", gridcolor="#0a2a0a", title="Prob. toque (%)"),
        legend=dict(bgcolor="#000", font=dict(color="#00ff41", size=10)),
        height=280, margin=dict(l=0, r=0, t=10, b=0),
        font=dict(color="#00ff41", family="monospace"),
    )
    st.plotly_chart(fig2, use_container_width=True)
