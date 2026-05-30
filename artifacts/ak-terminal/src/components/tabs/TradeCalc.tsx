import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useGetGoldPrice, useGetGoldHistory } from "@workspace/api-client-react";

// ══════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════

type Mode      = "SCALP" | "INTRADAY" | "SWING";
type Direction = "LONG" | "SHORT";
type CalcMode  = "AUTO" | "MANUAL";
type Regime    = "TRENDING" | "RANGING" | "VOLATILE" | "LOW_VOL" | "SQUEEZE" | "EXHAUSTION";
type Tab       = "CALC" | "MONTECARLO" | "ZONES" | "RISK" | "EXPLANATION";
type Phase     = "ABSORPTION" | "DISTRIBUTION" | "CONTINUATION" | "EXHAUSTION" | "SQUEEZE" | "UNKNOWN";

interface BridgeData {
  signal: string;
  combined_score: number;
  current_score: number;
  option_flow_score: number;
  dark_pool_score: number;
  gamma_exposure: Array<{ strike: number; gex: number }>;
  dark_pool: Array<{ price: number; size: number; side: string }>;
  option_flow: Array<{ strike: number; type: string; premium: number; sentiment: string }>;
  source: string;
  meta?: { last_update: string; status: string; cycle?: number };
}

interface GARCHState { omega: number; alpha: number; beta: number; sigma2: number[] }
interface KalmanState { mu: number; P: number; Q: number; R: number }
interface OUParams   { theta: number; mu_ou: number; sigma_ou: number }

interface MCResult {
  pTP: number; pSL: number; pTP_paths: number[];
  expectedShortfall: number; var95: number;
  medianPath: number[]; percentile10: number[]; percentile90: number[];
  converged: boolean; nPaths: number;
}

interface Zone {
  price: number; label: string; pReaction: number;
  type: "SUPPORT" | "RESISTANCE"; strength: number; source: string;
}

// ══════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════

const MODE_CONFIG = {
  SCALP:    { atrSL: 1.0, atrTP: 1.8, minRR: 1.2, minConf: 55, mcPaths: 800  },
  INTRADAY: { atrSL: 1.8, atrTP: 3.2, minRR: 1.8, minConf: 50, mcPaths: 1000 },
  SWING:    { atrSL: 2.5, atrTP: 5.0, minRR: 2.5, minConf: 45, mcPaths: 1200 },
} as const;

const BRIDGE_URL     = "http://localhost:5001/data";
const BRIDGE_TIMEOUT = 3000;
const MC_STEPS       = 120; // pasos por path

// ══════════════════════════════════════════════════════════════════
// MATH UTILS
// ══════════════════════════════════════════════════════════════════

const clamp   = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// Box-Muller para normal estándar
function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Student-t con ν grados de libertad (fat tails)
function randStudentT(nu: number): number {
  const z = randn();
  const chi2 = Array.from({ length: nu }, () => randn() ** 2).reduce((a, b) => a + b, 0);
  return z / Math.sqrt(chi2 / nu);
}

function EMA(data: number[], p: number): number[] {
  if (data.length < p) return [];
  const k = 2 / (p + 1);
  const e = [data[0]];
  for (let i = 1; i < data.length; i++) e[i] = data[i] * k + e[i - 1] * (1 - k);
  return e;
}

function ATR(candles: any[], p = 14): number {
  if (!candles?.length) return 10;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = candles[i].high   ?? candles[i].h;
    const l  = candles[i].low    ?? candles[i].l;
    const pc = candles[i-1].close ?? candles[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < p) return 10;
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}

function RSI(closes: number[], p = 14): number {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l += Math.abs(d);
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++)
    if (closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

function zScore(closes: number[], p = 20): number {
  if (closes.length < p) return 0;
  const w = closes.slice(-p);
  const m = w.reduce((a, b) => a + b, 0) / p;
  const s = Math.sqrt(w.reduce((a, c) => a + (c - m) ** 2, 0) / p);
  return s === 0 ? 0 : (closes[closes.length - 1] - m) / s;
}

// ══════════════════════════════════════════════════════════════════
// GARCH(1,1)
// σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
// Parámetros típicos para commodities / oro
// ══════════════════════════════════════════════════════════════════
function fitGARCH(returns: number[]): GARCHState {
  if (returns.length < 20) {
    const s2 = returns.reduce((a, r) => a + r * r, 0) / Math.max(returns.length, 1);
    return { omega: s2 * 0.05, alpha: 0.10, beta: 0.85, sigma2: [s2] };
  }
  // Parámetros fijos calibrados para oro (GARCH(1,1) estándar)
  const omega = 2e-7;
  const alpha = 0.08;
  const beta  = 0.90;
  const sigma2: number[] = [];
  let s2 = returns.slice(0, 10).reduce((a, r) => a + r * r, 0) / 10;
  sigma2.push(s2);
  for (let i = 1; i < returns.length; i++) {
    s2 = omega + alpha * returns[i - 1] ** 2 + beta * s2;
    sigma2.push(Math.max(s2, 1e-10));
  }
  return { omega, alpha, beta, sigma2 };
}

function garchNextSigma2(g: GARCHState, lastReturn: number): number {
  const lastSig2 = g.sigma2.at(-1) ?? 1e-4;
  return Math.max(g.omega + g.alpha * lastReturn ** 2 + g.beta * lastSig2, 1e-10);
}

// ══════════════════════════════════════════════════════════════════
// KALMAN FILTER — estimación dinámica de μ
// Estado: [drift μ_t]
// Modelo: μ_t = μ_{t-1} + ruido_proceso
//         r_t = μ_t·dt + σ_t·ε
// ══════════════════════════════════════════════════════════════════
function kalmanFilter(returns: number[], sigmas: number[]): KalmanState {
  const Q = 1e-6;   // ruido proceso (drift cambia lentamente)
  const R = 1e-4;   // ruido observación
  let mu = returns.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  let P  = 1e-4;

  for (let i = 0; i < returns.length; i++) {
    // Predict
    const P_pred = P + Q;
    // Update
    const sigma_obs = sigmas[i] ?? Math.sqrt(R);
    const R_t = sigma_obs ** 2 + R;
    const K   = P_pred / (P_pred + R_t);
    mu = mu + K * (returns[i] - mu);
    P  = (1 - K) * P_pred;
  }
  return { mu, P, Q, R };
}

// ══════════════════════════════════════════════════════════════════
// ORNSTEIN-UHLENBECK — detección mean reversion
// dS = θ(μ_ou - S)dt + σ_ou·dW
// θ > 1.5 → mean reverting fuerte
// θ < 0.3 → trending / random walk
// ══════════════════════════════════════════════════════════════════
function estimateOU(closes: number[]): OUParams {
  if (closes.length < 20) return { theta: 0.5, mu_ou: closes.at(-1) ?? 0, sigma_ou: 10 };
  const n    = closes.length;
  const mean = closes.reduce((a, b) => a + b, 0) / n;
  // OLS para estimar θ: S_t - S_{t-1} = θ(μ - S_{t-1})·dt + ε
  let sumXX = 0, sumXY = 0;
  for (let i = 1; i < n; i++) {
    const x = closes[i - 1] - mean;
    const y = closes[i] - closes[i - 1];
    sumXX += x * x;
    sumXY += x * y;
  }
  const theta = sumXX > 0 ? clamp(-sumXY / sumXX, 0, 10) : 0.5;
  const residuals: number[] = [];
  for (let i = 1; i < n; i++)
    residuals.push(closes[i] - closes[i-1] - theta * (mean - closes[i-1]));
  const sigma_ou = Math.sqrt(residuals.reduce((a, r) => a + r*r, 0) / residuals.length);
  return { theta, mu_ou: mean, sigma_ou: Math.max(sigma_ou, 0.01) };
}

// ══════════════════════════════════════════════════════════════════
// MONTE CARLO ENGINE
// Combina GARCH + Kalman + OU + Student-t (fat tails, ν=5)
// ══════════════════════════════════════════════════════════════════
function runMonteCarlo(
  entry: number, sl: number, tp: number,
  garch: GARCHState, kalman: KalmanState, ou: OUParams,
  muBridge: number,   // señal del bridge si está disponible
  hasBridge: boolean,
  nPaths: number,
  regime: Regime
): MCResult {
  const nu = 5; // grados de libertad Student-t (fat tails realistas)
  const dt = 1 / MC_STEPS;

  // μ final: mezcla Kalman + bridge + OU
  const mu_kalman = kalman.mu;
  const mu_ou_pull = ou.theta * (ou.mu_ou - entry) * dt;
  let mu_final = mu_kalman * 0.6 + mu_ou_pull * 0.3 + (hasBridge ? muBridge * 0.1 : 0);

  // Ajuste por régimen
  const regime_vol_mult =
    regime === "VOLATILE"  ? 1.40 :
    regime === "SQUEEZE"   ? 1.55 :
    regime === "LOW_VOL"   ? 0.65 :
    regime === "RANGING"   ? 0.85 : 1.0;

  let lastSig2 = garch.sigma2.at(-1) ?? 1e-4;
  let lastRet  = 0;

  let hitTP = 0, hitSL = 0;
  const pTP_sample: number[] = [];
  const finalPrices: number[] = [];
  const allMedianPrices: number[][] = [];

  for (let p = 0; p < nPaths; p++) {
    let S    = entry;
    let sig2 = lastSig2;
    let ret  = lastRet;
    let done = false;
    const path: number[] = [S];

    for (let t = 0; t < MC_STEPS; t++) {
      // GARCH update
      sig2 = Math.max(garch.omega + garch.alpha * ret ** 2 + garch.beta * sig2, 1e-10);
      const sigma_t = Math.sqrt(sig2) * regime_vol_mult * S;

      // OU mean reversion component
      const ou_drift = ou.theta * (ou.mu_ou - S) * dt;

      // Drift total
      const drift = (mu_final + ou_drift / S) * S * dt;

      // Shock con fat tails (Student-t ν=5)
      const shock = sigma_t * randStudentT(nu) * Math.sqrt(dt);
      ret = (drift + shock) / Math.max(S, 1);
      S   = S + drift + shock;

      path.push(S);

      if (S >= tp) { hitTP++; pTP_sample.push(1); done = true; break; }
      if (S <= sl) { hitSL++; pTP_sample.push(0); done = true; break; }
    }

    if (!done) {
      pTP_sample.push(S > entry ? 1 : 0);
      if (S >= tp) hitTP++; else hitSL++;
    }

    finalPrices.push(S);
    if (p < 200) allMedianPrices.push(path); // guardar primeros 200 paths para visualización
  }

  // Percentiles para visualización
  const stepsData: { p10: number; p50: number; p90: number }[] = [];
  for (let t = 0; t <= MC_STEPS; t++) {
    const vals = allMedianPrices.map(path => path[Math.min(t, path.length - 1)]).sort((a, b) => a - b);
    const n = vals.length;
    stepsData.push({
      p10: vals[Math.floor(n * 0.10)] ?? entry,
      p50: vals[Math.floor(n * 0.50)] ?? entry,
      p90: vals[Math.floor(n * 0.90)] ?? entry,
    });
  }

  // Expected Shortfall (CVaR) — pérdida promedio en el peor 5% de casos
  const sortedLosses = finalPrices
    .filter(p => p < entry)
    .map(p => entry - p)
    .sort((a, b) => b - a);
  const es_n = Math.max(Math.floor(sortedLosses.length * 0.05), 1);
  const expectedShortfall = sortedLosses.slice(0, es_n).reduce((a, b) => a + b, 0) / es_n;

  // VaR 95%
  const sortedPnL = finalPrices.map(p => p - entry).sort((a, b) => a - b);
  const var95 = Math.abs(sortedPnL[Math.floor(sortedPnL.length * 0.05)] ?? 0);

  const total = hitTP + hitSL;
  const pTP_mc = total > 0 ? hitTP / total : 0.5;

  return {
    pTP:              clamp(pTP_mc, 0.05, 0.95),
    pSL:              clamp(1 - pTP_mc, 0.05, 0.95),
    pTP_paths:        pTP_sample,
    expectedShortfall,
    var95,
    medianPath:       stepsData.map(s => s.p50),
    percentile10:     stepsData.map(s => s.p10),
    percentile90:     stepsData.map(s => s.p90),
    converged:        nPaths >= 500,
    nPaths,
  };
}

// ══════════════════════════════════════════════════════════════════
// μ_ADJ desde bridge o técnicos
// ══════════════════════════════════════════════════════════════════
function calcMuBridge(
  dir: Direction, bridge: BridgeData | null,
  rsi: number, zSc: number, momentum: number, trendStr: number, bullish: boolean
): { mu: number; hasBridge: boolean } {
  if (bridge) {
    const raw =
      0.50 * clamp(bridge.combined_score,    -1, 1) +
      0.30 * clamp(bridge.option_flow_score, -1, 1) +
      0.20 * clamp(bridge.dark_pool_score,   -1, 1);
    return { mu: raw * (dir === "LONG" ? 1 : -1) * 0.0001, hasBridge: true };
  }
  // Fallback técnico — unidades de retorno por período
  let score = 0;
  score += bullish ? 0.15 : -0.15;
  score += clamp(trendStr * 0.08, -0.15, 0.15);
  score += clamp(momentum * 0.03, -0.10, 0.10);
  if (rsi < 35) score += 0.10; else if (rsi > 65) score -= 0.10;
  if (zSc < -1.5) score += 0.08; if (zSc > 1.5) score -= 0.08;
  const mu = clamp(score, -0.5, 0.5) * (dir === "LONG" ? 1 : -1) * 0.0001;
  return { mu, hasBridge: false };
}

// ══════════════════════════════════════════════════════════════════
// KELLY CRITERION
// f* = (p·b - q) / b   donde b = R:R, p = P(TP), q = P(SL)
// ══════════════════════════════════════════════════════════════════
function kelly(pTP: number, rr: number): number {
  const q = 1 - pTP;
  const f = (pTP * rr - q) / rr;
  return clamp(f, 0, 0.25); // máx 25% del capital (half-kelly en práctica)
}

// ══════════════════════════════════════════════════════════════════
// BRIER SCORE (calibración de probabilidades)
// Mide qué tan calibradas son las predicciones históricas
// ══════════════════════════════════════════════════════════════════
function brierScore(predictions: number[], outcomes: number[]): number {
  if (!predictions.length) return 0;
  const n = Math.min(predictions.length, outcomes.length);
  return predictions.slice(0, n).reduce((s, p, i) => s + (p - outcomes[i]) ** 2, 0) / n;
}

// ══════════════════════════════════════════════════════════════════
// ZONES
// ══════════════════════════════════════════════════════════════════
function calcZones(
  price: number, atr: number, ema20: number, ema50: number,
  sigma_daily: number,
  gexLevels: Array<{ strike: number; gex: number }>,
  dpLevels:  Array<{ price: number; size: number }>
): Zone[] {
  const zones: Zone[] = [];
  const addEMA = (val: number, label: string, str: number) => {
    const dist = Math.abs(price - val);
    if (dist / atr > 5) return;
    const decay = Math.exp(-dist / (sigma_daily * price + atr));
    zones.push({
      price: val, label, source: "TECHNICAL",
      pReaction: clamp(decay * str * 0.8 + 0.10, 0.15, 0.88),
      type: price > val ? "SUPPORT" : "RESISTANCE", strength: str,
    });
  };
  addEMA(ema20, "EMA 20", 0.60);
  addEMA(ema50, "EMA 50", 0.75);

  gexLevels.slice(0, 5).forEach(g => {
    const dist = Math.abs(price - g.strike);
    if (dist / atr > 8) return;
    const n = clamp(Math.abs(g.gex) / 300000, 0, 1);
    zones.push({
      price: g.strike,
      label: `GEX ${g.gex > 0 ? "+" : ""}${(g.gex / 1000).toFixed(0)}k`,
      source: "GEX",
      pReaction: clamp(n * 0.6 + Math.exp(-dist / (atr * 3)) * 0.4, 0.10, 0.92),
      type: g.strike > price ? "RESISTANCE" : "SUPPORT",
      strength: n,
    });
  });

  dpLevels.slice(0, 5).forEach(d => {
    const dist = Math.abs(price - d.price);
    if (dist / atr > 6) return;
    const n = clamp(d.size / 500000, 0, 1);
    zones.push({
      price: d.price, label: `DP ${(d.size / 1000).toFixed(0)}k`, source: "DARK_POOL",
      pReaction: clamp(n * 0.5 + Math.exp(-dist / (atr * 2)) * 0.5, 0.10, 0.90),
      type: d.price < price ? "SUPPORT" : "RESISTANCE",
      strength: n,
    });
  });

  return zones.sort((a, b) => b.pReaction - a.pReaction).slice(0, 8);
}

// ══════════════════════════════════════════════════════════════════
// PHASE DETECTION
// ══════════════════════════════════════════════════════════════════
function detectPhase(
  rsi: number, zSc: number, volExp: number, trendStr: number, ou: OUParams, price: number
): Phase {
  if (zSc < -1.5 && rsi < 40)                       return "ABSORPTION";
  if (zSc >  1.5 && rsi > 65)                       return "DISTRIBUTION";
  if ((rsi > 78 || rsi < 22) && volExp > 1.5)       return "EXHAUSTION";
  if (volExp < 0.6 && Math.abs(zSc) < 0.5)          return "SQUEEZE";
  if (ou.theta > 1.5 && Math.abs(price - ou.mu_ou) / ou.sigma_ou < 1)
                                                     return "ABSORPTION"; // OU mean reversion
  if (trendStr > 1.2)                                return "CONTINUATION";
  return "UNKNOWN";
}

// ══════════════════════════════════════════════════════════════════
// BRIDGE HOOK
// ══════════════════════════════════════════════════════════════════
function useBridge() {
  const [data,   setData]   = useState<BridgeData | null>(null);
  const [status, setStatus] = useState<"CONNECTING" | "LIVE" | "OFFLINE">("CONNECTING");
  const fetch_ = useCallback(async () => {
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT);
      const res  = await fetch(BRIDGE_URL, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error();
      setData(await res.json());
      setStatus("LIVE");
    } catch { setStatus("OFFLINE"); }
  }, []);
  useEffect(() => { fetch_(); const id = setInterval(fetch_, 15000); return () => clearInterval(id); }, [fetch_]);
  return { data, status, refetch: fetch_ };
}

// ══════════════════════════════════════════════════════════════════
// SPARKLINE COMPONENT
// ══════════════════════════════════════════════════════════════════
function Sparkline({ data, width = 200, height = 50, color = "#4ade80" }: {
  data: number[]; width?: number; height?: number; color?: string;
}) {
  if (!data.length) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// ══════════════════════════════════════════════════════════════════
// MC PATH VISUALIZER
// ══════════════════════════════════════════════════════════════════
function MCPathViz({
  median, p10, p90, sl, tp, entry, width = 340, height = 160,
}: {
  median: number[]; p10: number[]; p90: number[];
  sl: number; tp: number; entry: number;
  width?: number; height?: number;
}) {
  if (!median.length) return null;
  const allVals = [...median, ...p10, ...p90, sl, tp, entry];
  const min = Math.min(...allVals) * 0.9995;
  const max = Math.max(...allVals) * 1.0005;
  const range = max - min || 1;
  const n = median.length;

  const toSVG = (v: number, i: number) => ({
    x: (i / (n - 1)) * width,
    y: height - ((v - min) / range) * height,
  });

  const pathStr = (arr: number[]) =>
    arr.map((v, i) => { const { x, y } = toSVG(v, i); return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");

  const bandPts = [
    ...p10.map((v, i) => toSVG(v, i)),
    ...[...p90].reverse().map((v, i) => toSVG(v, n - 1 - i)),
  ];
  const bandStr = bandPts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ") + "Z";

  const tpY  = height - ((tp - min) / range) * height;
  const slY  = height - ((sl - min) / range) * height;
  const entY = height - ((entry - min) / range) * height;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="w-full">
      {/* Band P10-P90 */}
      <path d={bandStr} fill="rgba(74,222,128,0.06)" />
      {/* TP line */}
      <line x1={0} y1={tpY} x2={width} y2={tpY} stroke="#4ade80" strokeWidth="1" strokeDasharray="4,3" opacity="0.6" />
      <text x={width - 4} y={tpY - 3} fill="#4ade80" fontSize="9" textAnchor="end" opacity="0.8">TP</text>
      {/* SL line */}
      <line x1={0} y1={slY} x2={width} y2={slY} stroke="#f87171" strokeWidth="1" strokeDasharray="4,3" opacity="0.6" />
      <text x={width - 4} y={slY + 10} fill="#f87171" fontSize="9" textAnchor="end" opacity="0.8">SL</text>
      {/* Entry line */}
      <line x1={0} y1={entY} x2={width} y2={entY} stroke="#94a3b8" strokeWidth="0.8" opacity="0.4" />
      {/* P10 */}
      <path d={pathStr(p10)} fill="none" stroke="rgba(74,222,128,0.25)" strokeWidth="1" />
      {/* P90 */}
      <path d={pathStr(p90)} fill="none" stroke="rgba(74,222,128,0.25)" strokeWidth="1" />
      {/* Median */}
      <path d={pathStr(median)} fill="none" stroke="#4ade80" strokeWidth="2" />
    </svg>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════
export function TradeCalc() {
  const { data: priceData }   = useGetGoldPrice();
  const { data: historyData } = useGetGoldHistory({ interval: "15m", period: "7d" });
  const { data: bridge, status: bridgeStatus, refetch } = useBridge();

  const livePrice = priceData?.price ?? 4500;
  const candles   = historyData?.candles ?? [];
  const closes    = useMemo(() => candles.map((c: any) => c.close ?? c.c), [candles]);
  const returns_  = useMemo(() => logReturns(closes), [closes]);

  const [tab,       setTab]       = useState<Tab>("CALC");
  const [mode,      setMode]      = useState<Mode>("INTRADAY");
  const [calcMode,  setCalcMode]  = useState<CalcMode>("MANUAL");
  const [direction, setDirection] = useState<Direction>("LONG");
  const [capital,   setCapital]   = useState(1000);
  const [entry,     setEntry]     = useState(livePrice);
  const [sl,        setSL]        = useState(livePrice - 15);
  const [tp,        setTP]        = useState(livePrice + 30);
  const [mcResult,  setMcResult]  = useState<MCResult | null>(null);
  const [mcRunning, setMcRunning] = useState(false);
  const cfg = MODE_CONFIG[mode];

  // ── Indicators ──────────────────────────────────────────────────
  const ema20 = useMemo(() => EMA(closes, 20), [closes]);
  const ema50 = useMemo(() => EMA(closes, 50), [closes]);
  const atr14 = useMemo(() => ATR(candles, 14), [candles]);
  const atr50 = useMemo(() => ATR(candles, 50), [candles]);
  const rsi14 = useMemo(() => RSI(closes, 14), [closes]);
  const zSc   = useMemo(() => zScore(closes, 20), [closes]);

  const lastEMA20 = ema20.at(-1) ?? livePrice;
  const lastEMA50 = ema50.at(-1) ?? livePrice;
  const bullish   = lastEMA20 > lastEMA50;
  const trendStr  = Math.abs(lastEMA20 - lastEMA50) / atr14;
  const volExp    = atr50 > 0 ? atr14 / atr50 : 1;
  const momentum  = closes.length > 10 ? (closes.at(-1)! - closes.at(-10)!) / atr14 : 0;

  // ── Quant models ────────────────────────────────────────────────
  const garch  = useMemo(() => fitGARCH(returns_), [returns_]);
  const kalman = useMemo(() => kalmanFilter(returns_, garch.sigma2.map(Math.sqrt)), [returns_, garch]);
  const ou     = useMemo(() => estimateOU(closes.slice(-60)), [closes]);

  // ── Regime ──────────────────────────────────────────────────────
  const regime: Regime = (() => {
    if (volExp > 2.0)                          return "VOLATILE";
    if (volExp < 0.55 && Math.abs(zSc) < 0.4) return "SQUEEZE";
    if (atr14 < atr50 * 0.72)                 return "LOW_VOL";
    if (trendStr < 0.25)                       return "RANGING";
    if (rsi14 > 80 || rsi14 < 20)             return "EXHAUSTION";
    return "TRENDING";
  })();

  // ── AUTO mode ───────────────────────────────────────────────────
  useEffect(() => {
    if (calcMode !== "AUTO") return;
    const ae = livePrice;
    setEntry(ae);
    setSL(direction === "LONG" ? ae - atr14 * cfg.atrSL : ae + atr14 * cfg.atrSL);
    setTP(direction === "LONG" ? ae + atr14 * cfg.atrTP : ae - atr14 * cfg.atrTP);
  }, [calcMode, atr14, direction, cfg, livePrice]);

  // ── Core math ───────────────────────────────────────────────────
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  const rr     = slDist > 0 ? tpDist / slDist : 0;
  const counter = (direction === "LONG" && !bullish) || (direction === "SHORT" && bullish);

  const { mu: muBridge, hasBridge } = useMemo(
    () => calcMuBridge(direction, bridge, rsi14, zSc, momentum, trendStr, bullish),
    [direction, bridge, rsi14, zSc, momentum, trendStr, bullish]
  );

  // ── Run Monte Carlo ─────────────────────────────────────────────
  const runMC = useCallback(() => {
    setMcRunning(true);
    // Defer para no bloquear UI
    setTimeout(() => {
      const result = runMonteCarlo(
        entry, sl, tp, garch, kalman, ou,
        muBridge, hasBridge, cfg.mcPaths, regime
      );
      setMcResult(result);
      setMcRunning(false);
    }, 50);
  }, [entry, sl, tp, garch, kalman, ou, muBridge, hasBridge, cfg.mcPaths, regime]);

  // Auto-run MC cuando cambian parámetros clave
  useEffect(() => { runMC(); }, [entry, sl, tp, direction, mode]);

  // ── Derived from MC ─────────────────────────────────────────────
  const pTP = mcResult?.pTP ?? 0.5;
  const pSL = mcResult?.pSL ?? 0.5;
  const tpUSD      = tpDist * 100;
  const slUSD      = slDist * 100;
  const expectancy = pTP * tpUSD - pSL * slUSD;
  const breakEven  = 1 / (1 + rr);
  const edge       = pTP - breakEven;
  const kellyFrac  = kelly(pTP, rr);
  const riskUSD    = capital * 0.01;
  const posSize    = slDist > 0 ? riskUSD / slDist : 0;
  const kellySizeUSD = capital * kellyFrac * 0.5; // half-kelly
  const sigma_daily = Math.sqrt(garch.sigma2.at(-1) ?? 1e-4);

  // Brier score (simulado con los paths del MC como proxy)
  const brierEst = mcResult
    ? brierScore(mcResult.pTP_paths.slice(0, 100), mcResult.pTP_paths.slice(0, 100).map(p => p > 0.5 ? 1 : 0))
    : 0;

  // Confidence compuesta
  const confidence = clamp(
    (pTP > 0.5 ? (pTP - 0.5) * 2 : 0) * 60 +
    (edge > 0 ? Math.min(edge * 100, 30) : 0) +
    (!counter ? 10 : 0),
    1, 99
  );

  const noTrade =
    regime === "RANGING" || regime === "LOW_VOL" ||
    expectancy <= 0 || edge <= 0 ||
    confidence < cfg.minConf || rr < cfg.minRR ||
    pTP < 0.52;

  const verdict =
    noTrade           ? "NO TRADE" :
    confidence > 72   ? "HIGH CONFIDENCE" :
    confidence > 55   ? "VALID" : "MARGINAL";

  const phase = detectPhase(rsi14, zSc, volExp, trendStr, ou, livePrice);

  // Zones — memoize derived arrays para evitar referencias inestables
  const gexLevels = useMemo(
    () => bridge?.gamma_exposure ?? [],
    [bridge]
  );
  const dpLevels = useMemo(
    () => (bridge?.dark_pool ?? []).map(d => ({ price: d.price, size: d.size })),
    [bridge]
  );
  const zones = useMemo(
    () => calcZones(livePrice, atr14, lastEMA20, lastEMA50, sigma_daily, gexLevels, dpLevels),
    [livePrice, atr14, lastEMA20, lastEMA50, sigma_daily, gexLevels, dpLevels]
  );

  // ── Colors ──────────────────────────────────────────────────────
  const RC: Record<Regime, string> = {
    TRENDING: "text-emerald-400", RANGING: "text-yellow-400",
    VOLATILE: "text-orange-400",  LOW_VOL: "text-sky-400",
    SQUEEZE:  "text-violet-400",  EXHAUSTION: "text-rose-400",
  };
  const PC: Record<Phase, string> = {
    ABSORPTION: "text-cyan-400", DISTRIBUTION: "text-orange-400",
    CONTINUATION: "text-emerald-400", EXHAUSTION: "text-rose-400",
    SQUEEZE: "text-violet-400", UNKNOWN: "text-slate-500",
  };
  const VC =
    verdict === "NO TRADE"        ? "border-rose-900 text-rose-400" :
    verdict === "HIGH CONFIDENCE" ? "border-emerald-600 text-emerald-300" :
    verdict === "VALID"           ? "border-emerald-800 text-emerald-400" :
                                    "border-yellow-800 text-yellow-400";

  // ══════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════

  return (
    <div className="w-full max-w-4xl mx-auto bg-[#050a05] text-emerald-400 font-mono border border-emerald-900/50 rounded-2xl overflow-hidden">

      {/* TOP BAR */}
      <div className="px-5 py-3 bg-emerald-950/30 border-b border-emerald-900/40 flex justify-between items-center">
        <div>
          <div className="text-xs text-emerald-700 tracking-[0.3em] uppercase">Ak Quant Engine</div>
          <div className="text-[10px] text-emerald-900 mt-0.5">GARCH · KALMAN · OU · MONTE CARLO · FAT TAILS</div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[10px] px-2 py-0.5 rounded border ${
            bridgeStatus === "LIVE"       ? "border-emerald-700 text-emerald-400" :
            bridgeStatus === "CONNECTING" ? "border-yellow-700 text-yellow-500" :
                                            "border-rose-900 text-rose-600"
          }`}>
            {bridgeStatus === "LIVE" ? "● LIVE" : bridgeStatus === "CONNECTING" ? "◌ …" : "○ OFFLINE"}
          </span>
          <div className="text-right">
            <div className="text-2xl font-bold leading-none">${livePrice.toFixed(2)}</div>
            <div className={`text-[10px] mt-0.5 ${RC[regime]}`}>{regime}</div>
          </div>
        </div>
      </div>

      {/* TABS */}
      <div className="flex border-b border-emerald-900/40 px-2">
        {(["CALC", "MONTECARLO", "ZONES", "RISK", "EXPLANATION"] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 text-[10px] font-bold tracking-widest transition-colors border-b-2 ${
              tab === t
                ? "border-emerald-400 text-emerald-300"
                : "border-transparent text-emerald-800 hover:text-emerald-600"
            }`}>
            {t}
          </button>
        ))}
      </div>

      <div className="p-5">

        {/* ═══ CALC ═══ */}
        {tab === "CALC" && (
          <div className="space-y-4">

            {/* Controls */}
            <div className="grid grid-cols-2 gap-2">
              {(["AUTO", "MANUAL"] as CalcMode[]).map(m => (
                <button key={m} onClick={() => setCalcMode(m)}
                  className={`py-2 rounded text-xs font-bold border transition-all ${calcMode === m ? "bg-emerald-400 text-black border-emerald-400" : "border-emerald-900 text-emerald-700 hover:border-emerald-600 hover:text-emerald-400"}`}>
                  {m}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["SCALP", "INTRADAY", "SWING"] as Mode[]).map(m => (
                <button key={m} onClick={() => setMode(m)}
                  className={`py-2 rounded text-xs font-bold border transition-all ${mode === m ? "bg-emerald-400 text-black border-emerald-400" : "border-emerald-900 text-emerald-700 hover:border-emerald-600 hover:text-emerald-400"}`}>
                  {m}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["LONG", "SHORT"] as Direction[]).map(d => (
                <button key={d} onClick={() => setDirection(d)}
                  className={`py-2 rounded text-xs font-bold border transition-all ${
                    direction === d
                      ? d === "LONG" ? "bg-emerald-500 text-black border-emerald-500" : "bg-rose-700 text-white border-rose-700"
                      : "border-emerald-900 text-emerald-700 hover:border-emerald-600 hover:text-emerald-400"
                  }`}>{d}</button>
              ))}
            </div>

            <div>
              <label className="text-[10px] text-emerald-800 block mb-1">CAPITAL ($)</label>
              <input type="number" value={capital}
                onChange={e => setCapital(Number(e.target.value))}
                className="w-full bg-black/60 border border-emerald-900 focus:border-emerald-600 p-2 rounded text-sm outline-none text-emerald-300" />
            </div>

            {calcMode === "MANUAL" && (
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "ENTRY",       val: entry, set: setEntry, bc: "border-emerald-800" },
                  { label: "STOP LOSS",   val: sl,    set: setSL,    bc: "border-rose-900"    },
                  { label: "TAKE PROFIT", val: tp,    set: setTP,    bc: "border-emerald-600" },
                ].map(({ label, val, set, bc }) => (
                  <div key={label}>
                    <label className={`text-[10px] mb-1 block ${label === "STOP LOSS" ? "text-rose-600" : "text-emerald-700"}`}>{label}</label>
                    <input type="number" value={val}
                      onChange={e => set(Number(e.target.value))}
                      className={`w-full bg-black/60 border ${bc} focus:border-emerald-500 p-2 rounded text-sm outline-none text-emerald-300`} />
                  </div>
                ))}
              </div>
            )}

            {/* MC status */}
            {mcRunning && (
              <div className="text-[10px] text-emerald-700 animate-pulse">
                ◌ Simulando {cfg.mcPaths} paths Monte Carlo…
              </div>
            )}

            {/* METRICS GRID */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <M label="P(TP) MC"     val={`${(pTP*100).toFixed(1)}%`}    c={pTP > 0.55 ? "text-emerald-300" : "text-yellow-400"} />
              <M label="P(SL) MC"     val={`${(pSL*100).toFixed(1)}%`}    c="text-rose-400" />
              <M label="CONFIDENCE"   val={`${confidence.toFixed(0)}%`}   c={confidence > 65 ? "text-emerald-300" : "text-yellow-400"} />
              <M label="EXPECTANCY"   val={`$${expectancy.toFixed(2)}`}    c={expectancy > 0 ? "text-emerald-400" : "text-rose-400"} />
              <M label="EDGE"         val={`${(edge*100).toFixed(1)}%`}    c={edge > 0 ? "text-emerald-400" : "text-rose-400"} />
              <M label="R:R"          val={`1:${rr.toFixed(2)}`}           c="text-emerald-400" />
              <M label="KELLY f*"     val={`${(kellyFrac*100).toFixed(1)}%`} c="text-cyan-400" />
              <M label="σ GARCH"      val={`${(Math.sqrt(garch.sigma2.at(-1)??0)*100).toFixed(4)}%`} c="text-sky-400" />
              <M label="μ KALMAN"     val={kalman.mu.toFixed(6)}           c={kalman.mu > 0 ? "text-cyan-400" : "text-orange-400"} />
              <M label="OU θ"         val={ou.theta.toFixed(3)}            c={ou.theta > 1 ? "text-violet-400" : "text-slate-400"} />
              <M label="RSI"          val={rsi14.toFixed(1)}               c={rsi14>70?"text-rose-400":rsi14<30?"text-cyan-400":"text-emerald-400"} />
              <M label="Z-SCORE"      val={zSc.toFixed(2)}                 c={Math.abs(zSc)>2?"text-violet-400":"text-emerald-400"} />
            </div>

            {/* Phase + Regime */}
            <div className="grid grid-cols-2 gap-2">
              <div className="border border-emerald-900/50 rounded p-3 bg-emerald-950/20">
                <div className="text-[10px] text-emerald-800 mb-1">MARKET PHASE</div>
                <div className={`font-bold ${PC[phase]}`}>{phase}</div>
              </div>
              <div className="border border-emerald-900/50 rounded p-3 bg-emerald-950/20">
                <div className="text-[10px] text-emerald-800 mb-1">OU REGIME</div>
                <div className={`font-bold text-xs ${ou.theta > 1.5 ? "text-cyan-400" : ou.theta < 0.3 ? "text-orange-400" : "text-emerald-400"}`}>
                  {ou.theta > 1.5 ? "MEAN REVERTING" : ou.theta < 0.3 ? "RANDOM WALK" : "MILD REVERSION"}
                  <span className="text-emerald-800 ml-1">θ={ou.theta.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* Bridge data */}
            {bridgeStatus === "LIVE" && bridge && (
              <div className="border border-emerald-900/30 rounded p-3 text-[10px] bg-emerald-950/10">
                <div className="text-emerald-700 mb-2 font-bold tracking-widest">ENGINE DATA</div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-emerald-800">COMBINED<br/><span className={`font-bold text-sm ${bridge.combined_score > 0 ? "text-emerald-400" : "text-rose-400"}`}>{bridge.combined_score.toFixed(4)}</span></div>
                  <div className="text-emerald-800">OPT FLOW<br/><span className={`font-bold text-sm ${bridge.option_flow_score > 0 ? "text-emerald-400" : "text-rose-400"}`}>{bridge.option_flow_score.toFixed(4)}</span></div>
                  <div className="text-emerald-800">DARK POOL<br/><span className={`font-bold text-sm ${bridge.dark_pool_score > 0 ? "text-emerald-400" : "text-rose-400"}`}>{bridge.dark_pool_score.toFixed(4)}</span></div>
                </div>
              </div>
            )}

            {/* VERDICT */}
            <div className={`border rounded-xl p-4 ${VC}`}>
              <div className="text-xl font-bold mb-3 tracking-widest">{verdict}</div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
                <div>ENTRY <span className="float-right text-emerald-300">${entry.toFixed(2)}</span></div>
                <div>SIZE (1%) <span className="float-right text-emerald-300">{posSize.toFixed(4)} oz</span></div>
                <div className="text-rose-500">STOP LOSS <span className="float-right">${sl.toFixed(2)}</span></div>
                <div>KELLY SIZE <span className="float-right text-cyan-400">${kellySizeUSD.toFixed(0)}</span></div>
                <div className="text-emerald-300">TAKE PROFIT <span className="float-right">${tp.toFixed(2)}</span></div>
                <div>BREAK EVEN <span className="float-right">{(breakEven*100).toFixed(1)}%</span></div>
                <div>COUNTER TREND <span className={`float-right ${counter ? "text-rose-400" : "text-emerald-400"}`}>{counter ? "YES ⚠" : "NO ✓"}</span></div>
                <div>TREND <span className={`float-right ${bullish ? "text-emerald-400" : "text-rose-400"}`}>{bullish ? "BULLISH" : "BEARISH"}</span></div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ MONTE CARLO ═══ */}
        {tab === "MONTECARLO" && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <div className="text-xs font-bold text-emerald-400 tracking-widest">MONTE CARLO SIMULATION</div>
                <div className="text-[10px] text-emerald-800 mt-0.5">
                  {cfg.mcPaths} paths · GARCH(1,1) + Student-t ν=5 · OU drift
                </div>
              </div>
              <button onClick={runMC}
                className={`px-3 py-1.5 rounded border text-xs font-bold transition-all ${mcRunning ? "border-emerald-900 text-emerald-900" : "border-emerald-600 text-emerald-400 hover:bg-emerald-400 hover:text-black"}`}>
                {mcRunning ? "RUNNING…" : "RE-RUN"}
              </button>
            </div>

            {mcResult ? (
              <>
                {/* Path visualization */}
                <div className="border border-emerald-900/50 rounded-xl p-4 bg-emerald-950/10">
                  <div className="text-[10px] text-emerald-800 mb-3">DISTRIBUCIÓN DE PATHS (P10 / MEDIANA / P90)</div>
                  <MCPathViz
                    median={mcResult.medianPath} p10={mcResult.percentile10}
                    p90={mcResult.percentile90} sl={sl} tp={tp} entry={entry}
                  />
                </div>

                {/* MC metrics */}
                <div className="grid grid-cols-2 gap-2">
                  <M label="P(TP) MC"          val={`${(mcResult.pTP*100).toFixed(2)}%`}    c="text-emerald-300" />
                  <M label="P(SL) MC"           val={`${(mcResult.pSL*100).toFixed(2)}%`}    c="text-rose-400" />
                  <M label="VaR 95%"            val={`$${(mcResult.var95*100).toFixed(2)}`}  c="text-orange-400" />
                  <M label="CVaR / ES"          val={`$${(mcResult.expectedShortfall*100).toFixed(2)}`} c="text-rose-400" />
                  <M label="PATHS SIMULADOS"    val={mcResult.nPaths.toString()}             c="text-emerald-700" />
                  <M label="CONVERGENCIA"       val={mcResult.converged ? "✓ OK" : "⚠ BAJA"} c={mcResult.converged ? "text-emerald-400" : "text-yellow-400"} />
                </div>

                {/* GARCH sigma history sparkline */}
                <div className="border border-emerald-900/50 rounded p-3 bg-emerald-950/10">
                  <div className="text-[10px] text-emerald-800 mb-2">σ GARCH(1,1) — VOLATILIDAD CON MEMORIA</div>
                  <Sparkline data={garch.sigma2.slice(-80).map(s => Math.sqrt(s) * 100)} height={45} />
                  <div className="text-[10px] text-emerald-800 mt-1">
                    σ actual: <span className="text-emerald-400">{(Math.sqrt(garch.sigma2.at(-1)??0)*100).toFixed(4)}%</span>
                    &nbsp;·&nbsp; ω={garch.omega.toExponential(1)} α={garch.alpha} β={garch.beta}
                  </div>
                </div>

                {/* Kalman mu history */}
                <div className="border border-emerald-900/50 rounded p-3 bg-emerald-950/10">
                  <div className="text-[10px] text-emerald-800 mb-2">μ KALMAN — DRIFT ESTIMADO</div>
                  <div className="text-[10px] text-emerald-700">
                    μ = <span className={`font-bold ${kalman.mu > 0 ? "text-emerald-400" : "text-rose-400"}`}>{kalman.mu.toFixed(7)}</span>
                    &nbsp; P={kalman.P.toExponential(2)} Q={kalman.Q.toExponential(2)}
                  </div>
                  <div className="text-[10px] text-emerald-800 mt-1">
                    {kalman.mu > 0 ? "Drift positivo — precio tiende a subir" : "Drift negativo — precio tiende a bajar"}
                  </div>
                </div>

                {/* OU */}
                <div className="border border-emerald-900/50 rounded p-3 bg-emerald-950/10">
                  <div className="text-[10px] text-emerald-800 mb-2">ORNSTEIN-UHLENBECK — RÉGIMEN</div>
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div className="text-emerald-800">θ (velocidad rev.)<br/><span className={`font-bold text-sm ${ou.theta > 1 ? "text-violet-400" : "text-slate-400"}`}>{ou.theta.toFixed(3)}</span></div>
                    <div className="text-emerald-800">μ_OU (media)<br/><span className="font-bold text-sm text-emerald-400">{ou.mu_ou.toFixed(2)}</span></div>
                    <div className="text-emerald-800">σ_OU<br/><span className="font-bold text-sm text-sky-400">{ou.sigma_ou.toFixed(3)}</span></div>
                  </div>
                  <div className="mt-2 text-[10px] text-emerald-800">
                    {ou.theta > 1.5
                      ? "⟳ Régimen mean-reverting fuerte — entradas contra-tendencia tienen edge"
                      : ou.theta < 0.3
                      ? "→ Random walk dominante — seguir tendencia, no counter-trend"
                      : "≈ Reversión leve — combinar con trend y momentum"}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center text-emerald-900 py-12 text-sm">
                {mcRunning ? "Simulando…" : "Establece los parámetros y vuelve aquí."}
              </div>
            )}
          </div>
        )}

        {/* ═══ ZONES ═══ */}
        {tab === "ZONES" && (
          <ZonesTab
            zones={zones}
            livePrice={livePrice}
            bridgeStatus={bridgeStatus}
          />
        )}

        {/* ═══ RISK ═══ */}
        {tab === "RISK" && (
          <div className="space-y-3">
            <div className="text-xs font-bold text-emerald-400 tracking-widest mb-3">GESTIÓN DE RIESGO CUANTITATIVA</div>

            <div className="grid grid-cols-2 gap-3">
              <div className="border border-emerald-900/50 rounded-xl p-4 bg-emerald-950/10 col-span-2">
                <div className="text-[10px] text-emerald-800 mb-1">KELLY CRITERION</div>
                <div className="text-2xl font-bold text-cyan-400">{(kellyFrac*100).toFixed(2)}%</div>
                <div className="text-[10px] text-emerald-800 mt-1">
                  f* = (p·b − q) / b = ({pTP.toFixed(3)}·{rr.toFixed(2)} − {pSL.toFixed(3)}) / {rr.toFixed(2)}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                  <div className="text-emerald-800">Half-Kelly (recomendado)<br/><span className="text-cyan-400 font-bold">${kellySizeUSD.toFixed(0)}</span></div>
                  <div className="text-emerald-800">Sizing 1% risk (actual)<br/><span className="text-emerald-400 font-bold">{posSize.toFixed(4)} oz</span></div>
                </div>
              </div>

              <div className="border border-orange-900/50 rounded-xl p-4 bg-orange-950/10">
                <div className="text-[10px] text-orange-700 mb-1">VaR 95%</div>
                <div className="text-xl font-bold text-orange-400">${(mcResult?.var95??0*100).toFixed(2)}</div>
                <div className="text-[10px] text-orange-800 mt-1">Pérdida máxima en 95% de escenarios</div>
              </div>

              <div className="border border-rose-900/50 rounded-xl p-4 bg-rose-950/10">
                <div className="text-[10px] text-rose-700 mb-1">CVaR / Expected Shortfall</div>
                <div className="text-xl font-bold text-rose-400">${(mcResult?.expectedShortfall??0*100).toFixed(2)}</div>
                <div className="text-[10px] text-rose-800 mt-1">Pérdida promedio en el peor 5%</div>
              </div>

              <div className="border border-emerald-900/50 rounded-xl p-4 bg-emerald-950/10 col-span-2">
                <div className="text-[10px] text-emerald-800 mb-2">ANÁLISIS DE RUINA</div>
                <div className="text-[10px] text-emerald-700 space-y-1">
                  <div>Trades para ruina con 1% risk: <span className="text-emerald-400">{Math.ceil(Math.log(0.01) / Math.log(1 - 0.01))}</span> consecutivos perdedores</div>
                  <div>Drawdown máximo teórico (MC): <span className="text-orange-400">{(pSL * 100).toFixed(1)}% probabilidad de SL en este trade</span></div>
                  <div>Expectancy por $1 arriesgado: <span className={expectancy > 0 ? "text-emerald-400" : "text-rose-400"}>${(expectancy / Math.max(slUSD, 1)).toFixed(3)}</span></div>
                </div>
              </div>

              <div className="border border-sky-900/50 rounded-xl p-4 bg-sky-950/10 col-span-2">
                <div className="text-[10px] text-sky-700 mb-2">BRIER SCORE (CALIBRACIÓN)</div>
                <div className="text-xl font-bold text-sky-400">{brierEst.toFixed(4)}</div>
                <div className="text-[10px] text-sky-800 mt-1">
                  0 = perfectamente calibrado · 1 = completamente descalibrado<br/>
                  Nota: calibración real requiere backtest histórico de trades.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ EXPLANATION ═══ */}
        {tab === "EXPLANATION" && (
          <div className="space-y-3 text-[10px] leading-relaxed">
            <Sec title="GARCH(1,1) — VOLATILIDAD CON MEMORIA">
              <p className="font-mono bg-emerald-950/30 p-2 rounded text-emerald-300 mb-2">{"σ²(t) = ω + α·ε²(t-1) + β·σ²(t-1)"}</p>
              <p className="text-emerald-800">GBM simple asume σ constante — incorrecto. GARCH reconoce que volatilidad alta hoy predice volatilidad alta mañana (clustering). α=0.08 captura el shock reciente, β=0.90 da memoria larga. Resultado: σ dinámica que se adapta al mercado actual.</p>
            </Sec>
            <Sec title="KALMAN FILTER — DRIFT ADAPTATIVO">
              <p className="font-mono bg-emerald-950/30 p-2 rounded text-emerald-300 mb-2">{"μ(t) = μ(t-1) + K · (r(t) − μ(t-1))"}</p>
              <p className="text-emerald-800">El drift μ no es fijo — cambia con el mercado. El Kalman Filter lo estima como variable latente, actualizándose con cada nuevo retorno. K (ganancia de Kalman) balancea confianza en predicción vs observación nueva. Más riguroso que promediar retornos.</p>
            </Sec>
            <Sec title="ORNSTEIN-UHLENBECK — RÉGIMEN">
              <p className="font-mono bg-emerald-950/30 p-2 rounded text-emerald-300 mb-2">{"dS = θ(μ_OU − S)dt + σ_OU·dW"}</p>
              <p className="text-emerald-800">θ mide mean reversion. Si θ &gt; 1.5 → el precio tiene atracción fuerte hacia μ_OU, entradas counter-trend tienen ventaja estadística. Si θ &lt; 0.3 → random walk, seguir tendencia. Estimado por OLS sobre los últimos 60 cierres.</p>
            </Sec>
            <Sec title="MONTE CARLO CON FAT TAILS">
              <p className="font-mono bg-emerald-950/30 p-2 rounded text-emerald-300 mb-2">{"S(t+1) = S(t) + μ·dt + σ_GARCH · t_ν · √dt"}</p>
              <p className="text-emerald-800">En vez de FPT analítico (que asume GBM perfecto), simulamos {cfg.mcPaths} paths. El shock usa distribución Student-t con ν=5 grados de libertad — colas más pesadas que normal, capturando spikes reales del oro. P(TP) = fracción de paths que tocan TP antes que SL.</p>
            </Sec>
            <Sec title="KELLY CRITERION">
              <p className="font-mono bg-emerald-950/30 p-2 rounded text-emerald-300 mb-2">{"f* = (p·b − q) / b"}</p>
              <p className="text-emerald-800">Tamaño óptimo de posición que maximiza crecimiento logarítmico del capital a largo plazo. b = R:R, p = P(TP), q = P(SL). En práctica usar half-Kelly (f*/2) para reducir drawdown. Si f* &lt; 0 → no hay edge matemático, no operar.</p>
            </Sec>
            <Sec title="CVaR — EXPECTED SHORTFALL">
              <p className="text-emerald-800">VaR 95% dice "en el 95% de casos no pierdes más de X". CVaR dice "en el peor 5% de casos, pierdes en promedio Y". CVaR es más honesto para gestión de riesgo — VaR ignora la magnitud de pérdidas extremas.</p>
            </Sec>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUB COMPONENTS
// ══════════════════════════════════════════════════════════════════

function M({ label, val, c }: { label: string; val: string; c: string }) {
  return (
    <div className="border border-emerald-900/50 rounded-lg p-2.5 bg-emerald-950/10">
      <div className="text-[9px] text-emerald-800 mb-1 tracking-wider">{label}</div>
      <div className={`text-sm font-bold ${c}`}>{val}</div>
    </div>
  );
}

function ZonesTab({
  zones, livePrice, bridgeStatus,
}: {
  zones: Zone[];
  livePrice: number;
  bridgeStatus: "CONNECTING" | "LIVE" | "OFFLINE";
}) {
  // Guardar en estado local para que un error no mate el tab padre
  const [renderError, setRenderError] = useState<string | null>(null);

  const safeZones = useMemo(() => {
    try {
      return (zones ?? []).filter(z =>
        z &&
        typeof z.price      === "number" && isFinite(z.price) &&
        typeof z.pReaction  === "number" && isFinite(z.pReaction) &&
        typeof z.label      === "string" &&
        typeof z.type       === "string" &&
        typeof z.strength   === "number"
      );
    } catch (e) {
      setRenderError(String(e));
      return [];
    }
  }, [zones]);

  if (renderError) {
    return (
      <div className="border border-rose-900 rounded p-4 text-[10px] text-rose-500">
        Error renderizando zonas: {renderError}
      </div>
    );
  }

  const safePrice = typeof livePrice === "number" && isFinite(livePrice) ? livePrice : 0;

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-emerald-800 border border-emerald-900/40 rounded p-3 mb-3">
        Zonas ordenadas por P(reacción). Precio:{" "}
        <span className="text-emerald-400">${safePrice.toFixed(2)}</span>
        {bridgeStatus !== "LIVE" && (
          <span className="ml-2 text-yellow-700">— Solo EMA20/50 (bridge offline)</span>
        )}
      </div>

      {safeZones.length === 0 && (
        <div className="text-center text-emerald-900 py-8 text-xs">
          Sin zonas calculadas.
          <div className="mt-2 text-[10px] text-emerald-950">
            Asegúrate de tener datos de precio cargados.
          </div>
        </div>
      )}

      {safeZones.map((z, i) => {
        const pct     = Math.round(clamp(z.pReaction, 0, 1) * 100);
        const dist    = Math.abs(z.price - safePrice);
        const barColor =
          z.pReaction > 0.65 ? "bg-emerald-400" :
          z.pReaction > 0.45 ? "bg-yellow-500"  : "bg-rose-600";
        const textColor =
          z.pReaction > 0.65 ? "text-emerald-300" :
          z.pReaction > 0.45 ? "text-yellow-400"  : "text-rose-400";

        return (
          <div
            key={i}
            className={`border rounded-lg p-3 ${
              z.type === "SUPPORT" ? "border-emerald-900/60" : "border-rose-900/60"
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] font-bold ${
                  z.type === "SUPPORT" ? "text-emerald-500" : "text-rose-500"
                }`}>
                  {z.type}
                </span>
                <span className="text-emerald-700 text-[10px]">{z.label}</span>
                {z.source && (
                  <span className="text-[9px] text-emerald-900 border border-emerald-900/40 px-1 rounded">
                    {z.source}
                  </span>
                )}
              </div>
              <div className="text-right ml-2">
                <div className="font-bold text-emerald-300 text-sm">
                  ${z.price.toFixed(2)}
                </div>
                <div className="text-[10px] text-emerald-800">
                  {dist.toFixed(2)} pts
                </div>
              </div>
            </div>

            <div className="flex justify-between text-[10px] mb-1">
              <span className="text-emerald-800">P(REACCIÓN)</span>
              <span className={`font-bold ${textColor}`}>{pct}%</span>
            </div>
            <div className="w-full bg-emerald-950 rounded-full h-1">
              <div
                className={`h-1 rounded-full ${barColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-emerald-900/50 rounded-lg p-3 bg-emerald-950/10">
      <div className="text-emerald-500 font-bold mb-2 tracking-widest text-[10px]">{title}</div>
      {children}
    </div>
  );
}