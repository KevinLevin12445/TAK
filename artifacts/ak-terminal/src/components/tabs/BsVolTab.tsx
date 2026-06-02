/**
 * components/tabs/BsVolTab.tsx
 * Black-Scholes / Volatility panel — AK-INC TERMINAL
 * Surface se recalcula cada 5 s con el precio live.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import Plot from "react-plotly.js";
import {
  useGetGoldPrice,
  useGetGoldHistory,
  getGetGoldPriceQueryKey,
} from "@workspace/api-client-react";

// ─── Black-Scholes puro ───────────────────────────────────────────────────────

function normCdf(x: number): number {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5*t + a4)*t + a3)*t + a2)*t + a1) * t * Math.exp(-x*x/2);
  return 0.5 * (1 + sign * y);
}

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function bsPrice(
  S: number, K: number, T: number, r: number, sigma: number,
  type: "call" | "put"
): number {
  if (T <= 0 || sigma <= 0) return Math.max(type === "call" ? S - K : K - S, 0);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === "call") return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

export function bsGreeks(S: number, K: number, T: number, r: number, sigma: number) {
  if (T <= 0 || sigma <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const pdf1 = normPdf(d1);
  return {
    delta: normCdf(d1),
    gamma: pdf1 / (S * sigma * Math.sqrt(T)),
    vega:  S * pdf1 * Math.sqrt(T) / 100,
    theta: (-(S * pdf1 * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365,
  };
}

export function touchProb(S: number, barrier: number, T: number, sigma: number, r = 0): number {
  if (T <= 0 || sigma <= 0) return 0;
  const mu = r - 0.5 * sigma ** 2;
  const x  = (Math.log(barrier / S) - mu * T) / (sigma * Math.sqrt(T));
  const x2 = (Math.log(barrier / S) + mu * T) / (sigma * Math.sqrt(T));
  const prob = normCdf(-Math.abs(x)) +
    Math.exp(2 * mu * Math.log(barrier / S) / sigma ** 2) * normCdf(-Math.abs(x2));
  return Math.min(Math.max(prob, 0), 1);
}

export function stopAtProb(
  S: number, T: number, sigma: number,
  targetProb: number, direction: "long" | "short"
): number {
  let lo = direction === "long" ? S * 0.80 : S * 1.001;
  let hi = direction === "long" ? S * 0.9999 : S * 1.20;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p   = touchProb(S, mid, T, sigma);
    if (direction === "long") { if (p > targetProb) hi = mid; else lo = mid; }
    else                      { if (p > targetProb) lo = mid; else hi = mid; }
  }
  return (lo + hi) / 2;
}

export function historicalVol(returns: number[], window = 20): number {
  const r = returns.slice(-window);
  if (r.length < 2) return 0.15;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance * 252);
}

// ─── GVZ fetch ────────────────────────────────────────────────────────────────
async function fetchGvz(): Promise<number | null> {
  try {
    const res = await fetch("http://localhost:5001/data", {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (d?.gvz && d.gvz > 0) return d.gvz / 100;
    return null;
  } catch { return null; }
}

type SubTab = "METRICS" | "SURFACE" | "STOPS" | "GREEKS";

// ─── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ data, color = "#00ff41", height = 40 }: {
  data: number[]; color?: string; height?: number;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const w = 200;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${height - ((v - min) / range) * height}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ─── BS Surface 3D — Plotly surface plot actualizado en tiempo real ─────────────
function BsSurface({ spot, iv }: { spot: number; iv: number }) {
  const tenors  = [1, 3, 7, 14, 30, 60, 90, 120];
  const offsets = Array.from({ length: 15 }, (_, i) => -0.07 + i * 0.01);
  const r = 0.05;

  // Generar matriz Z (precios de calls)
  const z: number[][] = [];
  const x: number[] = [];
  const y: number[] = [];

  for (let i = 0; i < tenors.length; i++) {
    const T = tenors[i] / 365;
    z[i] = [];
    for (let j = 0; j < offsets.length; j++) {
      const K = spot * (1 + offsets[j]);
      const price = bsPrice(spot, K, T, r, iv, "call");
      z[i][j] = price;
      if (i === 0) {
        x[j] = offsets[j] * 100; // Moneyness en %
      }
    }
    y[i] = tenors[i]; // Días a vencimiento
  }

  const trace = {
    x: x,
    y: y,
    z: z,
    type: "surface" as const,
    colorscale: "Viridis" as const,
    showscale: true,
    colorbar: {
      title: "Call Price ($)",
      thickness: 15,
      len: 0.7,
    },
    hovertemplate: "Moneyness: %{x:.1f}%<br>Days: %{y}d<br>Price: $%{z:.2f}<extra></extra>",
  };

  const layout = {
    title: {
      text: `BS Surface 3D — Spot: $${spot.toFixed(2)} | IV: ${(iv * 100).toFixed(1)}%`,
      font: { size: 14, color: "#00ff41", family: "monospace" },
    },
    scene: {
      xaxis: {
        title: "Moneyness (%)",
        backgroundcolor: "rgb(20, 20, 20)",
        gridcolor: "rgb(40, 40, 40)",
        showbackground: true,
        color: "#00ff41",
      },
      yaxis: {
        title: "Days to Expiry",
        backgroundcolor: "rgb(20, 20, 20)",
        gridcolor: "rgb(40, 40, 40)",
        showbackground: true,
        color: "#00ff41",
      },
      zaxis: {
        title: "Call Price ($)",
        backgroundcolor: "rgb(20, 20, 20)",
        gridcolor: "rgb(40, 40, 40)",
        showbackground: true,
        color: "#00ff41",
      },
      camera: {
        eye: { x: 1.5, y: 1.5, z: 1.3 },
      },
    },
    paper_bgcolor: "rgb(10, 10, 10)",
    plot_bgcolor: "rgb(10, 10, 10)",
    font: { color: "#00ff41", family: "monospace" },
    margin: { l: 0, r: 0, b: 0, t: 40 },
    height: 600,
  };

  const config = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  };

  return (
    <div className="w-full border border-emerald-900/40 rounded bg-black/20 overflow-hidden">
      <Plot
        data={[trace]}
        layout={layout}
        config={config}
      />
    </div>
  );
}

// ─── Touch probability chart ──────────────────────────────────────────────────
function TouchChart({ spot, iv }: { spot: number; iv: number }) {
  const T = 30 / 365;
  const levels = [
    ...Array.from({ length: 6 }, (_, i) => spot * (0.94 + i * 0.01)),
    spot,
    ...Array.from({ length: 6 }, (_, i) => spot * (1.01 + i * 0.01)),
  ];
  return (
    <div className="space-y-0.5">
      {levels.map(level => {
        const isSpot = level === spot;
        const isLong = level < spot;
        const prob   = isSpot ? 100 : touchProb(spot, level, T, iv) * 100;
        const color  = isSpot ? "#ffd700" : isLong ? "#ff4444" : "#00ff41";
        return (
          <div key={level.toFixed(2)} className="flex items-center gap-2 text-[9px]">
            <div className="w-14 text-right font-mono tabular-nums" style={{ color }}>{level.toFixed(0)}</div>
            <div className="flex-1 bg-black/40 rounded h-1.5 overflow-hidden">
              <div
                className="h-1.5 rounded transition-all duration-500"
                style={{ width: `${Math.min(prob, 100)}%`, background: color, opacity: 0.75 }}
              />
            </div>
            <div className="w-9 text-right font-mono tabular-nums" style={{ color }}>
              {isSpot ? "SPOT" : `${prob.toFixed(1)}%`}
            </div>
            <div className="w-10 text-right font-mono text-emerald-900 tabular-nums">
              {isSpot ? "—" : Math.abs(level - spot).toFixed(0)}
            </div>
          </div>
        );
      })}
      <div className="text-[9px] text-emerald-900 mt-1 border-t border-emerald-900/20 pt-1">
        Prob. toque 30d · rojo = long stops · verde = short stops
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function BsVolTab() {
  // mismo refetchInterval que TopTicker → precio en sync
  const { data: priceData } = useGetGoldPrice({
    query: {
      queryKey: getGetGoldPriceQueryKey(),
      refetchInterval: 5000,
    },
  });
  const { data: histData } = useGetGoldHistory({ period: "1mo", interval: "1d" });

  const [subTab,  setSubTab]  = useState<SubTab>("METRICS");
  const [gvzLive, setGvzLive] = useState<number | null>(null);
  const [gvzAge,  setGvzAge]  = useState(0);
  const prevSpotRef           = useRef<number | null>(null);
  const [flash,   setFlash]   = useState<"up" | "down" | null>(null);
  const [timestamp, setTimestamp] = useState<string>("");

  // Update timestamp every second
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      setTimestamp(`${year}-${month}-${day} ${hours}:${minutes}:${seconds}`);
    };
    updateTime();
    const id = setInterval(updateTime, 1000);
    return () => clearInterval(id);
  }, []);

  const spot = priceData?.price ?? 0;

  // Flash de precio
  useEffect(() => {
  if (!spot) return undefined;
  const prev = prevSpotRef.current;
  if (prev !== null && prev !== spot) {
    setFlash(spot > prev ? "up" : "down");
    const t = setTimeout(() => setFlash(null), 600);
    prevSpotRef.current = spot;
    return () => clearTimeout(t);
  }
  prevSpotRef.current = spot;
  return undefined;
}, [spot]);


  // HV - CORREGIDO: Usar candles en lugar de prices
  const returns: number[] = [];
  if (histData && "candles" in histData && histData.candles && histData.candles.length > 1) {
    for (let i = 1; i < histData.candles.length; i++) {
      const prev = (histData.candles[i - 1] as any)?.close;
      const curr = (histData.candles[i] as any)?.close;
      if (prev && curr && prev > 0) returns.push(Math.log(curr / prev));
    }
  }
  const hv = returns.length > 2 ? historicalVol(returns) : 0.15;

  // GVZ polling
  const pollGvz = useCallback(async () => {
    const v = await fetchGvz();
    if (v !== null) { setGvzLive(v); setGvzAge(0); }
    else setGvzAge(a => a + 30);
  }, []);
  useEffect(() => {
    pollGvz();
    const id = setInterval(pollGvz, 30_000);
    return () => clearInterval(id);
  }, [pollGvz]);

  const iv        = gvzLive ?? hv * 1.10;
  const ivHvRatio = hv > 0 ? iv / hv : 1;
  const T30       = 30 / 365;
  const r         = 0.05;

  const sizingSignal =
    ivHvRatio >= 1.30 ? "REDUCE_SIZE" :
    ivHvRatio <= 0.85 ? "EXPAND_SIZE" : "NORMAL";
  const sigColor =
    sizingSignal === "REDUCE_SIZE" ? "#ff4444" :
    sizingSignal === "EXPAND_SIZE" ? "#ffd700" : "#00ff41";

  const greeks   = spot > 0 ? bsGreeks(spot, spot, T30, r, iv)            : { delta:0, gamma:0, theta:0, vega:0 };
  const atmCall  = spot > 0 ? bsPrice(spot, spot, T30, r, iv, "call")     : 0;
  const atmPut   = spot > 0 ? bsPrice(spot, spot, T30, r, iv, "put")      : 0;
  const expMove1d = spot * iv / Math.sqrt(252);
  const expMove30 = spot * iv * Math.sqrt(T30);

  const stopLong15  = spot > 0 ? stopAtProb(spot, T30, iv, 0.15, "long")  : 0;
  const stopLong25  = spot > 0 ? stopAtProb(spot, T30, iv, 0.25, "long")  : 0;
  const stopShort15 = spot > 0 ? stopAtProb(spot, T30, iv, 0.15, "short") : 0;
  const stopShort25 = spot > 0 ? stopAtProb(spot, T30, iv, 0.25, "short") : 0;

  // CORREGIDO: Extraer closes de candles
  const closePrices: number[] = [];
  if (histData && "candles" in histData && histData.candles) {
    for (const candle of histData.candles) {
      const close = (candle as any)?.close;
      if (close && typeof close === "number") {
        closePrices.push(close);
      }
    }
  }

  const flashBorder =
    flash === "up"   ? "border-emerald-400/60" :
    flash === "down" ? "border-red-500/60"     : "border-emerald-900/50";

  if (!spot) {
    return (
      <div className="flex items-center justify-center h-64 text-emerald-800 font-mono text-sm">
        ⟳ LOADING MARKET DATA...
      </div>
    );
  }

  return (
    <div className="font-mono text-xs text-emerald-400 space-y-3">

      {/* Header */}
      <div className={`border rounded p-3 bg-black/30 transition-colors duration-300 ${flashBorder}`}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[9px] text-emerald-800 tracking-widest">
            BLACK-SCHOLES ENGINE — IV/HV · STOPS DINÁMICOS · SURFACE
          </div>
          <div className="flex items-center gap-3">
            {gvzLive
              ? <span className="text-[9px] text-emerald-600">● GVZ LIVE {gvzAge > 0 ? `(${gvzAge}s)` : ""}</span>
              : <span className="text-[9px] text-yellow-700">◌ GVZ est. (HV×1.1)</span>
            }
            <div
              className="text-right font-bold tabular-nums text-lg transition-colors duration-200"
              style={{ color: flash === "up" ? "#00ff41" : flash === "down" ? "#ff4444" : "#ffd700" }}
            >
              ${spot.toFixed(2)}
              {flash && <span className="text-xs ml-1">{flash === "up" ? " ▲" : " ▼"}</span>}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-5 gap-2">
          {[
            ["IV (GVZ)",      `${(iv*100).toFixed(2)}%`,      "#ffd700"],
            ["HV 20d",        `${(hv*100).toFixed(2)}%`,      "#00ff41"],
            ["IV/HV ratio",   ivHvRatio.toFixed(4),           sigColor ],
            ["Exp move 1d",   `±${expMove1d.toFixed(2)}`,     "#00aaff"],
            ["Sizing signal", sizingSignal,                    sigColor ],
          ].map(([label, value, color]) => (
            <div key={label as string} className="border border-emerald-900/40 rounded p-2 bg-black/20">
              <div className="text-[9px] text-emerald-800 uppercase tracking-wider">{label}</div>
              <div className="text-sm font-bold mt-0.5 tabular-nums" style={{ color: color as string }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b border-emerald-900/40">
        {(["METRICS","SURFACE","STOPS","GREEKS"] as SubTab[]).map(t => (
          <button key={t} onClick={() => setSubTab(t)}
            className={`px-4 py-1.5 text-[10px] font-bold tracking-widest border-b-2 transition-colors ${
              subTab === t
                ? "border-emerald-400 text-emerald-300"
                : "border-transparent text-emerald-700 hover:text-emerald-500"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="space-y-2">
        {subTab === "METRICS" && (
          <div className="grid grid-cols-2 gap-2 text-[9px]">
            <div className="border border-emerald-900/40 rounded p-2 bg-black/20">
              <div className="text-emerald-800">ATM Call 30d</div>
              <div className="text-emerald-300 font-bold">${atmCall.toFixed(2)}</div>
            </div>
            <div className="border border-emerald-900/40 rounded p-2 bg-black/20">
              <div className="text-emerald-800">ATM Put 30d</div>
              <div className="text-emerald-300 font-bold">${atmPut.toFixed(2)}</div>
            </div>
            <div className="border border-emerald-900/40 rounded p-2 bg-black/20">
              <div className="text-emerald-800">Exp move 30d</div>
              <div className="text-emerald-300 font-bold">±${expMove30.toFixed(2)}</div>
            </div>
            <div className="border border-emerald-900/40 rounded p-2 bg-black/20">
              <div className="text-emerald-800">Greeks (ATM)</div>
              <div className="text-emerald-300 font-bold">
                Δ {greeks.delta.toFixed(2)} Γ {greeks.gamma.toFixed(4)}
              </div>
            </div>
          </div>
        )}

        {subTab === "SURFACE" && (
          <div className="flex gap-3 h-[600px]">
            {/* Surface 3D - 70% */}
            <div className="flex-1">
              <BsSurface spot={spot} iv={iv} />
            </div>
            
            {/* Panel de valores - 30% */}
            <div className="w-64 border border-emerald-900/40 rounded p-3 bg-black/20 overflow-y-auto space-y-2 text-[9px]">
              <div className="text-emerald-600 font-bold tracking-widest uppercase">LIVE VALUES</div>
              
              <div className="border-t border-emerald-900/20 pt-2 space-y-1">
                <div className="flex justify-between">
                  <span className="text-emerald-800">Timestamp</span>
                  <span className="text-yellow-400 font-mono text-[8px]">{timestamp}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">XAUUSD CFD</span>
                  <span className="text-emerald-300 font-mono font-bold">${spot.toFixed(2)}</span>
                </div>
              </div>
              
              <div className="border-t border-emerald-900/20 pt-2 space-y-1">
                <div className="flex justify-between">
                  <span className="text-emerald-800">IV (GVZ)</span>
                  <span className="text-yellow-400 font-mono font-bold">{(iv*100).toFixed(2)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">HV 20d</span>
                  <span className="text-emerald-300 font-mono">{(hv*100).toFixed(2)}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">IV/HV</span>
                  <span className="text-emerald-300 font-mono">{ivHvRatio.toFixed(4)}</span>
                </div>
              </div>
              
              <div className="border-t border-emerald-900/20 pt-2 space-y-1">
                <div className="text-emerald-600 font-bold">ATM 30d</div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">Call</span>
                  <span className="text-emerald-300 font-mono">${atmCall.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">Put</span>
                  <span className="text-emerald-300 font-mono">${atmPut.toFixed(2)}</span>
                </div>
              </div>
              
              <div className="border-t border-emerald-900/20 pt-2 space-y-1">
                <div className="text-emerald-600 font-bold">GREEKS (ATM)</div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">Delta</span>
                  <span className="text-emerald-300 font-mono">{greeks.delta.toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">Gamma</span>
                  <span className="text-emerald-300 font-mono">{greeks.gamma.toFixed(6)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">Vega</span>
                  <span className="text-emerald-300 font-mono">{greeks.vega.toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">Theta</span>
                  <span className="text-emerald-300 font-mono">{greeks.theta.toFixed(6)}</span>
                </div>
              </div>
              
              <div className="border-t border-emerald-900/20 pt-2 space-y-1">
                <div className="text-emerald-600 font-bold">EXPECTED MOVES</div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">1d Move</span>
                  <span className="text-emerald-300 font-mono">±${expMove1d.toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">30d Move</span>
                  <span className="text-emerald-300 font-mono">±${expMove30.toFixed(2)}</span>
                </div>
              </div>
              
              <div className="border-t border-emerald-900/20 pt-2 space-y-1">
                <div className="text-emerald-600 font-bold">SIZING SIGNAL</div>
                <div className="flex justify-between">
                  <span className="text-emerald-800">Signal</span>
                  <span className="font-mono font-bold" style={{ color: sigColor }}>{sizingSignal}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {subTab === "STOPS" && (
          <div className="space-y-2">
            <div className="border border-emerald-900/40 rounded p-2 bg-black/20 text-[9px]">
              <div className="text-emerald-800 mb-1">LONG STOPS (30d)</div>
              <div className="text-red-400">15% prob: ${stopLong15.toFixed(2)}</div>
              <div className="text-red-500">25% prob: ${stopLong25.toFixed(2)}</div>
            </div>
            <div className="border border-emerald-900/40 rounded p-2 bg-black/20 text-[9px]">
              <div className="text-emerald-800 mb-1">SHORT STOPS (30d)</div>
              <div className="text-emerald-400">15% prob: ${stopShort15.toFixed(2)}</div>
              <div className="text-emerald-500">25% prob: ${stopShort25.toFixed(2)}</div>
            </div>
            <TouchChart spot={spot} iv={iv} />
          </div>
        )}

        {subTab === "GREEKS" && (
          <div className="border border-emerald-900/40 rounded p-3 bg-black/20 text-[9px] space-y-1">
            <div className="flex justify-between">
              <span className="text-emerald-800">Delta (ATM 30d)</span>
              <span className="text-emerald-300 font-mono">{greeks.delta.toFixed(4)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-emerald-800">Gamma (ATM 30d)</span>
              <span className="text-emerald-300 font-mono">{greeks.gamma.toFixed(6)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-emerald-800">Vega (ATM 30d)</span>
              <span className="text-emerald-300 font-mono">{greeks.vega.toFixed(4)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-emerald-800">Theta (ATM 30d)</span>
              <span className="text-emerald-300 font-mono">{greeks.theta.toFixed(6)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Sparkline */}
      {closePrices.length > 0 && (
        <div className="border border-emerald-900/40 rounded p-2 bg-black/20">
          <div className="text-[9px] text-emerald-800 mb-1">PRICE HISTORY (1mo daily)</div>
          <Sparkline data={closePrices} />
        </div>
      )}
    </div>
  );
}
