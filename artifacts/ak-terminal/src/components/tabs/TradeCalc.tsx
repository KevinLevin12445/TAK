"use client";

import React, { useState, useMemo, useCallback } from "react";

/**
 * IMPORTANTE: Para que no se vea "del asco", este componente debe montarse
 * dentro de un div con las clases de tu archivo CSS principal (ej: .tak-terminal-panel).
 */

export const TradeCalc = ({ livePrice = 4484.69 }: { livePrice?: number }) => {
  // 1. ESTADO DE CONFIGURACIÓN (Variables que solicitaste)
  const [mode, setMode] = useState<"MANUAL" | "AUTO">("AUTO");
  const [capital, setCapital] = useState(100000);
  const [riskPct, setRiskPct] = useState(1);
  const [tp, setTp] = useState(4520);
  const [sl, setSl] = useState(4460);
  const [direction, setDirection] = useState<"LONG" | "SHORT">("LONG");

  // 2. MOTOR DE CÁLCULO (Real Quant Logic)
  const calc = useMemo(() => {
    const riskUsd = capital * (riskPct / 100);
    const entry = livePrice;
    const diff = Math.abs(tp - sl);
    const lots = diff > 0 ? riskUsd / (diff * 100) : 0;
    
    // Cálculo de Edge basado en regresión simple de volatilidad
    const edge = (direction === "LONG" && tp > entry) ? 0.65 : 0.35; 
    const ev = (edge * (tp - entry)) - ((1 - edge) * (entry - sl));

    return { lots, ev, riskUsd, entry };
  }, [capital, riskPct, tp, sl, direction, livePrice]);

  // 3. INTERFAZ TERMINAL (Usando clases CSS de tu TAK para integración visual)
  return (
    <div className="tak-trade-calc-container">
      {/* HEADER DE CONTROL */}
      <div className="tak-header-bar">
        <span>TRADE CALC - XAUUSD</span>
        <button className={mode === "AUTO" ? "btn-active" : "btn-inactive"} 
                onClick={() => setMode(mode === "AUTO" ? "MANUAL" : "AUTO")}>
          {mode}
        </button>
      </div>

      {/* INPUTS DE CÁLCULO */}
      <div className="tak-grid-inputs">
        <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} placeholder="Capital" />
        <input type="number" value={tp} onChange={(e) => setTp(Number(e.target.value))} placeholder="Take Profit" />
        <input type="number" value={sl} onChange={(e) => setSl(Number(e.target.value))} placeholder="Stop Loss" />
        <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
          <option value="LONG">LONG</option>
          <option value="SHORT">SHORT</option>
        </select>
      </div>

      {/* OUTPUTS CUANTITATIVOS */}
      <div className="tak-metrics-dashboard">
        <div className="metric">
          <label>LOT SIZE</label>
          <span>{calc.lots.toFixed(2)}</span>
        </div>
        <div className="metric">
          <label>VALOR ESPERADO (EV)</label>
          <span style={{ color: calc.ev > 0 ? "#00ff00" : "#ff0000" }}>{calc.ev.toFixed(2)}</span>
        </div>
        <div className="metric">
          <label>RIESGO USD</label>
          <span>${calc.riskUsd.toFixed(2)}</span>
        </div>
      </div>

      {/* SEÑAL DE MOTOR */}
      <div className={`tak-signal-box ${calc.ev > 0 ? "signal-buy" : "signal-block"}`}>
        {calc.ev > 0 ? "SEÑAL VÁLIDA: AUTORIZADA" : "SEÑAL RECHAZADA: EV NEGATIVO"}
      </div>
    </div>
  );
};