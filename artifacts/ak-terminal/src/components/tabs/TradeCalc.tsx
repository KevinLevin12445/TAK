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

// ── R:R targets por modo ─────────────────────────────────────────────────────
// SCALP:    R:R 1:1.8  break-even = 35.7% → necesita P(TP) > 42%
// INTRADAY: R:R 1:8    break-even = 11.1% → necesita P(TP) > 18%  (edge ≥ 7pp)
// SWING:    R:R 1:10   break-even =  9.1% → necesita P(TP) > 15%  (edge ≥ 6pp)
// La lógica quant clave: con R:R altos, el edge NO es tener alta win rate —
// es encontrar setups donde la probabilidad supere el break-even por margen suficiente.
const MODE_CONFIG = {
  SCALP: {
    atrSL: 1.0,  atrTP: 1.8,
    targetRR: 1.8, minRR: 1.2,
    minConf: 60,   mcPaths: 800,
    minPTP: 0.42,  minEdge: 0.06,
    label: "SCALP 1:1.8",
  },
  INTRADAY: {
    atrSL: 1.5,  atrTP: 12.0,
    targetRR: 8.0, minRR: 6.0,
    minConf: 42,   mcPaths: 1500,
    minPTP: 0.18,  minEdge: 0.04,
    label: "INTRADAY 1:8",
  },
  SWING: {
    atrSL: 2.0,  atrTP: 20.0,
    targetRR: 10.0, minRR: 8.0,
    minConf: 38,    mcPaths: 2000,
    minPTP: 0.15,   minEdge: 0.03,
    label: "SWING 1:10",
  },
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
  return clamp(f, 0, 0.25);
}

// ══════════════════════════════════════════════════════════════════
// STRUCTURAL LEVEL FINDER
// Detecta swing highs/lows reales del histórico de velas para
// calcular SL y TP basados en estructura de mercado, no en ATR fijo.
//
// Lógica:
//   SL LONG  → último swing low significativo por debajo del entry
//   SL SHORT → último swing high significativo por encima del entry
//   TP LONG  → siguiente swing high / resistencia estructural
//   TP SHORT → siguiente swing low / soporte estructural
//
// Un swing high = vela cuyo high > N velas anteriores y N velas posteriores
// Un swing low  = vela cuyo low  < N velas anteriores y N velas posteriores
// ══════════════════════════════════════════════════════════════════

interface StructuralLevels {
  sl: number;
  tp: number;
  rr: number;
  slSource: string;  // qué detectó el SL
  tpSource: string;  // qué detectó el TP
  valid: boolean;    // ¿R:R cumple el target del modo?
}

function findSwingHighs(candles: any[], lookback = 5): number[] {
  const highs: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high ?? candles[i].h;
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if ((candles[j].high ?? candles[j].h) >= h) { isSwing = false; break; }
    }
    if (isSwing) highs.push(h);
  }
  return highs;
}

function findSwingLows(candles: any[], lookback = 5): number[] {
  const lows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const l = candles[i].low ?? candles[i].l;
    let isSwing = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if ((candles[j].low ?? candles[j].l) <= l) { isSwing = false; break; }
    }
    if (isSwing) lows.push(l);
  }
  return lows;
}

function calcStructuralLevels(
  candles: any[],
  livePrice: number,
  direction: Direction,
  atr: number,
  ema20: number,
  ema50: number,
  targetRR: number,
  minRR: number,
  lookback = 5
): StructuralLevels {
  if (candles.length < lookback * 3) {
    // Fallback si no hay suficientes velas
    const sl = direction === "LONG" ? livePrice - atr * 1.5 : livePrice + atr * 1.5;
    const tp = direction === "LONG" ? livePrice + atr * targetRR * 1.5 : livePrice - atr * targetRR * 1.5;
    const rr = Math.abs(tp - livePrice) / Math.abs(sl - livePrice);
    return { sl, tp, rr, slSource: "ATR fallback", tpSource: "ATR fallback", valid: rr >= minRR };
  }

  const swingHighs = findSwingHighs(candles, lookback).sort((a, b) => b - a);
  const swingLows  = findSwingLows(candles,  lookback).sort((a, b) => a - b);

  // SL: nivel estructural más cercano en contra de la dirección
  // Con buffer de 0.15×ATR para evitar wicks
  let sl: number;
  let slSource: string;

  if (direction === "LONG") {
    // SL = swing low más cercano POR DEBAJO del precio actual
    const nearLows = swingLows
      .filter(l => l < livePrice - atr * 0.15)
      .sort((a, b) => b - a); // más cercano primero
    if (nearLows.length > 0) {
      sl = nearLows[0] - atr * 0.15; // buffer bajo el swing low
      slSource = `Swing low ${nearLows[0].toFixed(2)}`;
    } else {
      // Fallback: EMA más cercana o ATR
      sl = Math.max(ema20, ema50) < livePrice
        ? Math.max(ema20, ema50) - atr * 0.2
        : livePrice - atr * 1.5;
      slSource = "EMA/ATR fallback";
    }
  } else {
    // SL SHORT = swing high más cercano POR ENCIMA
    const nearHighs = swingHighs
      .filter(h => h > livePrice + atr * 0.15)
      .sort((a, b) => a - b);
    if (nearHighs.length > 0) {
      sl = nearHighs[0] + atr * 0.15;
      slSource = `Swing high ${nearHighs[0].toFixed(2)}`;
    } else {
      sl = Math.min(ema20, ema50) > livePrice
        ? Math.min(ema20, ema50) + atr * 0.2
        : livePrice + atr * 1.5;
      slSource = "EMA/ATR fallback";
    }
  }

  const slDist = Math.abs(livePrice - sl);

  // TP: buscamos el nivel estructural que nos dé el R:R target
  // Primero intentamos swing level natural, luego extendemos si no alcanza
  let tp: number;
  let tpSource: string;

  if (direction === "LONG") {
    // Buscar swing highs por ENCIMA del precio que den R:R ≥ targetRR
    const tpMinDistance = slDist * targetRR;
    const candidateHighs = swingHighs
      .filter(h => h > livePrice + tpMinDistance * 0.7) // al menos 70% del target
      .sort((a, b) => a - b); // más cercano primero

    if (candidateHighs.length > 0) {
      // Usar el primer swing high que dé R:R >= minRR
      const goodHigh = candidateHighs.find(h => (h - livePrice) / slDist >= minRR);
      if (goodHigh) {
        tp = goodHigh - atr * 0.1; // ligeramente bajo la resistencia
        tpSource = `Swing high ${goodHigh.toFixed(2)}`;
      } else {
        // El swing más lejano disponible
        tp = candidateHighs[candidateHighs.length - 1] - atr * 0.1;
        tpSource = `Swing high ext ${tp.toFixed(2)}`;
      }
    } else {
      // No hay swing high suficiente: proyectar R:R target desde SL estructural
      tp = livePrice + slDist * targetRR;
      tpSource = `Proyectado R:R ${targetRR}`;
    }
  } else {
    const tpMinDistance = slDist * targetRR;
    const candidateLows = swingLows
      .filter(l => l < livePrice - tpMinDistance * 0.7)
      .sort((a, b) => b - a);

    if (candidateLows.length > 0) {
      const goodLow = candidateLows.find(l => (livePrice - l) / slDist >= minRR);
      if (goodLow) {
        tp = goodLow + atr * 0.1;
        tpSource = `Swing low ${goodLow.toFixed(2)}`;
      } else {
        tp = candidateLows[candidateLows.length - 1] + atr * 0.1;
        tpSource = `Swing low ext ${tp.toFixed(2)}`;
      }
    } else {
      tp = livePrice - slDist * targetRR;
      tpSource = `Proyectado R:R ${targetRR}`;
    }
  }

  const actualRR = Math.abs(tp - livePrice) / Math.max(slDist, 0.01);

  return {
    sl, tp,
    rr: actualRR,
    slSource, tpSource,
    valid: actualRR >= minRR,
  };
}

// ══════════════════════════════════════════════════════════════════
// QUANT EDGE ENGINE — nivel senior
//
// La clave matemática con R:R altos (1:8, 1:10):
//   Break-even(1:8)  = 1/(1+8)  = 11.1%
//   Break-even(1:10) = 1/(1+10) = 9.09%
//
// Con estos R:R NO necesitas alta win rate — necesitas detectar
// con precisión cuándo el precio tiene probabilidad MAYOR al
// break-even con suficiente margen de seguridad.
//
// El Edge Score evalúa 7 factores independientes:
//   1. Momentum estadístico (Kalman drift direction)
//   2. Trend alignment multi-timeframe (EMA20 vs EMA50)
//   3. Mean reversion OU (¿el precio está estirado?)
//   4. Volatility regime (¿σ favorable para el R:R?)
//   5. RSI extremes (absorción/distribución)
//   6. Z-Score dislocation (¿cuántas σ del precio medio?)
//   7. Bridge institutional signal (si disponible)
//
// Cada factor devuelve un score [-1, +1].
// Score final ponderado → convertido a probabilidad adicional
// sobre el break-even del modo.
// ══════════════════════════════════════════════════════════════════

interface EdgeBreakdown {
  momentum:     number;  // [-1,+1]
  trend:        number;  // [-1,+1]
  ouReversion:  number;  // [-1,+1]
  volatility:   number;  // [-1,+1]
  rsiZone:      number;  // [-1,+1]
  zDislocation: number;  // [-1,+1]
  institutional:number;  // [-1,+1]
  rawScore:     number;  // suma ponderada
  edgeVsBreakEven: number; // P(TP) - break-even
  qualityLabel: string;
}

function calcQuantEdge(params: {
  dir: Direction;
  mode: Mode;
  pTP: number;
  rr: number;
  kalman: KalmanState;
  ou: OUParams;
  livePrice: number;
  rsi: number;
  zSc: number;
  momentum: number;
  trendStr: number;
  bullish: boolean;
  volExp: number;
  regime: Regime;
  bridge: BridgeData | null;
}): EdgeBreakdown {
  const { dir, mode, pTP, rr, kalman, ou, livePrice,
          rsi, zSc, momentum, trendStr, bullish, volExp, regime, bridge } = params;

  const sign = dir === "LONG" ? 1 : -1;
  const cfg  = MODE_CONFIG[mode];
  const breakEvenP = 1 / (1 + rr);

  // ── 1. MOMENTUM (Kalman drift) ──────────────────────────────────
  // Peso alto en SWING/INTRADAY porque drift sostenido es crítico para R:R alto
  const momentumScore = clamp(kalman.mu * sign * 1e5, -1, 1);

  // ── 2. TREND ALIGNMENT ─────────────────────────────────────────
  // EMA alignment + fuerza del trend
  const trendAlign = bullish === (dir === "LONG") ? 1 : -1;
  const trendScore = clamp(trendAlign * (0.5 + trendStr * 0.3), -1, 1);

  // ── 3. OU MEAN REVERSION ───────────────────────────────────────
  // Para SWING: si θ alto y precio estirado → oportunidad de reversion
  // Para SCALP: si θ alto → evitar counter-trend
  const ouDist = (livePrice - ou.mu_ou) / Math.max(ou.sigma_ou, 0.01);
  let ouScore = 0;
  if (mode === "SWING" || mode === "INTRADAY") {
    // SWING quiere entrar cuando el precio está estirado CONTRA la dirección
    // y el OU predice reversión HACIA el target
    if (dir === "LONG"  && ouDist < -1.0) ouScore =  clamp(Math.abs(ouDist) * 0.4, 0, 1);
    if (dir === "SHORT" && ouDist >  1.0) ouScore =  clamp(Math.abs(ouDist) * 0.4, 0, 1);
    if (dir === "LONG"  && ouDist >  1.5) ouScore = -0.5; // precio ya muy alto
    if (dir === "SHORT" && ouDist < -1.5) ouScore = -0.5; // precio ya muy bajo
  } else {
    // SCALP: quiere momentum, no reversion
    ouScore = ou.theta < 0.5 ? 0.3 : -0.1;
  }
  const ouScoreFinal = clamp(ouScore, -1, 1);

  // ── 4. VOLATILITY REGIME ───────────────────────────────────────
  // SWING/INTRADAY necesitan volatilidad EXPANDIENDO (para llegar al TP lejano)
  // SCALP necesita volatilidad moderada
  let volScore = 0;
  if (mode === "SWING" || mode === "INTRADAY") {
    if (regime === "TRENDING")  volScore =  0.7;
    if (regime === "VOLATILE")  volScore =  0.4;  // vol alta ayuda a llegar al TP
    if (regime === "SQUEEZE")   volScore =  0.8;  // expansión inminente
    if (regime === "RANGING")   volScore = -0.8;  // NO mover suficiente para 1:10
    if (regime === "LOW_VOL")   volScore = -0.9;  // imposible llegar al TP
    if (regime === "EXHAUSTION")volScore = -0.6;
  } else {
    if (regime === "TRENDING")  volScore =  0.5;
    if (regime === "VOLATILE")  volScore = -0.3;
    if (regime === "LOW_VOL")   volScore = -0.5;
    if (regime === "SQUEEZE")   volScore =  0.3;
    if (regime === "RANGING")   volScore = -0.6;
  }

  // ── 5. RSI ZONE ─────────────────────────────────────────────────
  let rsiScore = 0;
  if (dir === "LONG") {
    if (rsi < 30)       rsiScore =  0.9;  // oversold fuerte
    else if (rsi < 40)  rsiScore =  0.5;
    else if (rsi < 55)  rsiScore =  0.1;
    else if (rsi > 70)  rsiScore = -0.7;  // overbought = no entrar LONG
    else if (rsi > 60)  rsiScore = -0.3;
  } else {
    if (rsi > 70)       rsiScore =  0.9;
    else if (rsi > 60)  rsiScore =  0.5;
    else if (rsi > 45)  rsiScore =  0.1;
    else if (rsi < 30)  rsiScore = -0.7;
    else if (rsi < 40)  rsiScore = -0.3;
  }

  // ── 6. Z-SCORE DISLOCATION ─────────────────────────────────────
  // Precio muy alejado de su media → mean reversion probable
  // Para SWING: Z extremo en dirección contraria = setup ideal
  let zScore_ = 0;
  if (dir === "LONG"  && zSc < -2.0) zScore_ =  0.8;
  if (dir === "LONG"  && zSc < -1.5) zScore_ =  0.5;
  if (dir === "SHORT" && zSc >  2.0) zScore_ =  0.8;
  if (dir === "SHORT" && zSc >  1.5) zScore_ =  0.5;
  if (dir === "LONG"  && zSc >  2.0) zScore_ = -0.6; // precio ya muy alto
  if (dir === "SHORT" && zSc < -2.0) zScore_ = -0.6;

  // ── 7. INSTITUTIONAL SIGNAL (bridge) ───────────────────────────
  let instScore = 0;
  if (bridge) {
    const raw =
      0.50 * clamp(bridge.combined_score,    -1, 1) +
      0.30 * clamp(bridge.option_flow_score, -1, 1) +
      0.20 * clamp(bridge.dark_pool_score,   -1, 1);
    instScore = clamp(raw * sign, -1, 1);
  }

  // ── PESOS POR MODO ──────────────────────────────────────────────
  // SWING: momentum y volatilidad dominan (necesitas movimiento sostenido)
  // INTRADAY: trend + OU + institutional
  // SCALP: RSI + momentum inmediato
  const weights = mode === "SWING"
    ? { momentum: 0.25, trend: 0.20, ou: 0.15, vol: 0.20, rsi: 0.08, z: 0.07, inst: 0.05 }
    : mode === "INTRADAY"
    ? { momentum: 0.20, trend: 0.22, ou: 0.12, vol: 0.15, rsi: 0.12, z: 0.09, inst: 0.10 }
    : { momentum: 0.18, trend: 0.18, ou: 0.08, vol: 0.12, rsi: 0.22, z: 0.12, inst: 0.10 };

  const rawScore =
    weights.momentum * momentumScore +
    weights.trend    * trendScore    +
    weights.ou       * ouScoreFinal  +
    weights.vol      * volScore      +
    weights.rsi      * rsiScore      +
    weights.z        * zScore_       +
    weights.inst     * instScore;

  // Edge vs break-even real del modo
  const edgeVsBreakEven = pTP - breakEvenP;

  // Quality label basado en edge real y score
  const qualityLabel =
    edgeVsBreakEven < 0           ? "NO EDGE" :
    edgeVsBreakEven < cfg.minEdge ? "EDGE INSUFICIENTE" :
    rawScore < 0.1                ? "SEÑAL DÉBIL" :
    rawScore < 0.3                ? "SETUP VÁLIDO" :
    rawScore < 0.5                ? "SETUP SÓLIDO" :
                                    "SETUP PREMIUM";

  return {
    momentum:        momentumScore,
    trend:           trendScore,
    ouReversion:     ouScoreFinal,
    volatility:      volScore,
    rsiZone:         rsiScore,
    zDislocation:    zScore_,
    institutional:   instScore,
    rawScore,
    edgeVsBreakEven,
    qualityLabel,
  };
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
  const [mcResult,    setMcResult]    = useState<MCResult | null>(null);
  const [mcRunning,   setMcRunning]   = useState(false);
  const [structLevels, setStructLevels] = useState<StructuralLevels | null>(null);
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

  // ── AUTO mode — niveles estructurales reales ───────────────────
  useEffect(() => {
    if (calcMode !== "AUTO") return;
    if (!candles.length) return;

    const levels = calcStructuralLevels(
      candles, livePrice, direction,
      atr14, lastEMA20, lastEMA50,
      cfg.targetRR, cfg.minRR,
      mode === "SCALP" ? 3 : mode === "INTRADAY" ? 5 : 8
    );

    setEntry(livePrice);
    setSL(levels.sl);
    setTP(levels.tp);
    setStructLevels(levels);
  }, [calcMode, candles, livePrice, direction, atr14, lastEMA20, lastEMA50, cfg, mode]);

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
  const kellySizeUSD = capital * kellyFrac * 0.5;
  const sigma_daily = Math.sqrt(garch.sigma2.at(-1) ?? 1e-4);

  // Brier score
  const brierEst = mcResult
    ? brierScore(mcResult.pTP_paths.slice(0, 100), mcResult.pTP_paths.slice(0, 100).map(p => p > 0.5 ? 1 : 0))
    : 0;

  // ── Quant Edge Score — depende del modo ────────────────────────
  // La confidence se ancla al edge REAL sobre break-even del modo,
  // no a P(TP) > 0.5 (lo que sería incorrecto para R:R 1:10)
  const edgeAnalysis = useMemo(() => calcQuantEdge({
    dir: direction, mode, pTP, rr, kalman, ou, livePrice,
    rsi: rsi14, zSc, momentum, trendStr, bullish,
    volExp, regime, bridge,
  }), [direction, mode, pTP, rr, kalman, ou, livePrice, rsi14, zSc, momentum, trendStr, bullish, volExp, regime, bridge]);

  // Confidence: basada en edge vs break-even del modo + quality score
  // Un setup con P(TP)=20% en modo SWING (break-even 9.1%) tiene más
  // edge real que P(TP)=60% en SCALP si el setup quality es mejor
  const edgeOverBE = clamp(edgeAnalysis.edgeVsBreakEven / Math.max(breakEven, 0.01), 0, 5);
  const confidence = clamp(
    edgeOverBE * 25 +
    clamp(edgeAnalysis.rawScore * 40, 0, 40) +
    (!counter ? 8 : 0) +
    (regime === "TRENDING" ? 7 : 0),
    1, 99
  );

  // noTrade: usa minPTP y minEdge específicos del modo, no threshold fijo 0.52
  const noTrade =
    regime === "RANGING" || regime === "LOW_VOL" ||
    expectancy <= 0 ||
    edgeAnalysis.edgeVsBreakEven < cfg.minEdge ||
    pTP < cfg.minPTP ||
    confidence < cfg.minConf ||
    rr < cfg.minRR ||
    edgeAnalysis.qualityLabel === "NO EDGE";

  const verdict =
    noTrade                            ? "NO TRADE" :
    edgeAnalysis.qualityLabel === "SETUP PREMIUM" && confidence > 70 ? "HIGH CONFIDENCE" :
    edgeAnalysis.qualityLabel === "SETUP SÓLIDO"  && confidence > 52 ? "VALID" :
    confidence > 45                    ? "MARGINAL" : "NO TRADE";

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

            {/* QUANT EDGE BREAKDOWN */}
            <div className="border border-emerald-900/40 rounded-xl p-4 bg-emerald-950/10">
              <div className="flex justify-between items-center mb-3">
                <div className="text-[10px] text-emerald-700 font-bold tracking-widest">QUANT EDGE — {cfg.label}</div>
                <div className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                  edgeAnalysis.qualityLabel === "SETUP PREMIUM"     ? "border-emerald-500 text-emerald-300" :
                  edgeAnalysis.qualityLabel === "SETUP SÓLIDO"      ? "border-emerald-700 text-emerald-400" :
                  edgeAnalysis.qualityLabel === "SETUP VÁLIDO"      ? "border-yellow-700 text-yellow-400"   :
                  edgeAnalysis.qualityLabel === "SEÑAL DÉBIL"       ? "border-orange-800 text-orange-400"   :
                  edgeAnalysis.qualityLabel === "EDGE INSUFICIENTE" ? "border-rose-800 text-rose-400"       :
                  "border-rose-900 text-rose-600"
                }`}>{edgeAnalysis.qualityLabel}</div>
              </div>

              <div className="grid grid-cols-3 gap-2 mb-3 text-[10px]">
                <div className="bg-black/30 rounded p-2">
                  <div className="text-emerald-800">Break-even</div>
                  <div className="font-bold text-emerald-500">{(breakEven*100).toFixed(1)}%</div>
                  <div className="text-emerald-900 mt-0.5">win rate mínima</div>
                </div>
                <div className="bg-black/30 rounded p-2">
                  <div className="text-emerald-800">P(TP) MC</div>
                  <div className={`font-bold ${pTP >= cfg.minPTP ? "text-emerald-300" : "text-rose-400"}`}>{(pTP*100).toFixed(1)}%</div>
                  <div className="text-emerald-900 mt-0.5">mín: {(cfg.minPTP*100).toFixed(0)}%</div>
                </div>
                <div className="bg-black/30 rounded p-2">
                  <div className="text-emerald-800">Edge vs B/E</div>
                  <div className={`font-bold ${edgeAnalysis.edgeVsBreakEven >= cfg.minEdge ? "text-cyan-400" : "text-rose-400"}`}>
                    {edgeAnalysis.edgeVsBreakEven >= 0 ? "+" : ""}{(edgeAnalysis.edgeVsBreakEven*100).toFixed(2)}pp
                  </div>
                  <div className="text-emerald-900 mt-0.5">mín: +{(cfg.minEdge*100).toFixed(0)}pp</div>
                </div>
              </div>

              <div className="space-y-1.5">
                {([
                  { label: "MOMENTUM",    val: edgeAnalysis.momentum      },
                  { label: "TREND",       val: edgeAnalysis.trend         },
                  { label: "OU REVERSAL", val: edgeAnalysis.ouReversion   },
                  { label: "VOL REGIME",  val: edgeAnalysis.volatility    },
                  { label: "RSI ZONE",    val: edgeAnalysis.rsiZone       },
                  { label: "Z-SCORE",     val: edgeAnalysis.zDislocation  },
                  { label: "INST SIGNAL", val: edgeAnalysis.institutional },
                ] as { label: string; val: number }[]).map(({ label, val }) => {
                  const pct = Math.abs(val) * 50;
                  const col = val > 0.3 ? "bg-emerald-400" : val > 0 ? "bg-emerald-800"
                            : val < -0.3 ? "bg-rose-500" : "bg-rose-900";
                  return (
                    <div key={label} className="flex items-center gap-2">
                      <div className="text-[9px] text-emerald-800 w-24 shrink-0">{label}</div>
                      <div className="flex-1 flex items-center gap-0.5">
                        <div className="w-1/2 flex justify-end h-1.5">
                          {val < 0 && <div className={`h-1.5 rounded-l ${col}`} style={{ width: `${pct}%` }} />}
                        </div>
                        <div className="w-px h-2.5 bg-emerald-900/60" />
                        <div className="w-1/2 h-1.5">
                          {val >= 0 && <div className={`h-1.5 rounded-r ${col}`} style={{ width: `${pct}%` }} />}
                        </div>
                      </div>
                      <div className={`text-[9px] w-9 text-right font-mono ${val >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                        {val >= 0 ? "+" : ""}{val.toFixed(2)}
                      </div>
                    </div>
                  );
                })}
                <div className="border-t border-emerald-900/30 pt-1.5 flex items-center gap-2">
                  <div className="text-[9px] text-emerald-600 w-24 shrink-0 font-bold">TOTAL SCORE</div>
                  <div className="flex-1 flex items-center gap-0.5">
                    <div className="w-1/2 flex justify-end h-1.5">
                      {edgeAnalysis.rawScore < 0 && <div className="h-1.5 rounded-l bg-rose-500" style={{ width: `${Math.abs(edgeAnalysis.rawScore)*100}%` }} />}
                    </div>
                    <div className="w-px h-2.5 bg-emerald-900/60" />
                    <div className="w-1/2 h-1.5">
                      {edgeAnalysis.rawScore >= 0 && <div className="h-1.5 rounded-r bg-cyan-400" style={{ width: `${edgeAnalysis.rawScore*100}%` }} />}
                    </div>
                  </div>
                  <div className={`text-[9px] w-9 text-right font-mono font-bold ${edgeAnalysis.rawScore >= 0 ? "text-cyan-400" : "text-rose-500"}`}>
                    {edgeAnalysis.rawScore >= 0 ? "+" : ""}{edgeAnalysis.rawScore.toFixed(3)}
                  </div>
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
              <div className="flex justify-between items-start mb-3">
                <div className="text-xl font-bold tracking-widest">{verdict}</div>
                <div className="text-right text-[10px] text-emerald-700">
                  <div>{cfg.label} · R:R {rr.toFixed(1)}x</div>
                  <div>B/E {(breakEven*100).toFixed(1)}% · P(TP) {(pTP*100).toFixed(1)}%</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
                <div>ENTRY <span className="float-right text-emerald-300">${entry.toFixed(2)}</span></div>
                <div>SIZE (1%) <span className="float-right text-emerald-300">{posSize.toFixed(4)} oz</span></div>
                <div className="text-rose-500">STOP LOSS <span className="float-right">${sl.toFixed(2)}</span></div>
                <div>KELLY SIZE <span className="float-right text-cyan-400">${kellySizeUSD.toFixed(0)}</span></div>
                <div className="text-emerald-300">TAKE PROFIT <span className="float-right">${tp.toFixed(2)}</span></div>
                <div>EDGE vs B/E <span className={`float-right ${edgeAnalysis.edgeVsBreakEven >= cfg.minEdge ? "text-cyan-400" : "text-rose-400"}`}>
                  {edgeAnalysis.edgeVsBreakEven >= 0 ? "+" : ""}{(edgeAnalysis.edgeVsBreakEven*100).toFixed(2)}pp
                </span></div>
                <div>COUNTER TREND <span className={`float-right ${counter ? "text-rose-400" : "text-emerald-400"}`}>{counter ? "YES ⚠" : "NO ✓"}</span></div>
                <div>TREND <span className={`float-right ${bullish ? "text-emerald-400" : "text-rose-400"}`}>{bullish ? "BULLISH" : "BEARISH"}</span></div>
              </div>
              {/* Structural sources — AUTO mode only */}
              {calcMode === "AUTO" && structLevels && (
                <div className="mt-3 pt-3 border-t border-emerald-900/30 space-y-1 text-[10px]">
                  <div className="text-emerald-800">
                    SL ESTRUCTURAL:
                    <span className={`ml-2 ${structLevels.valid ? "text-rose-400" : "text-rose-600"}`}>
                      {structLevels.slSource}
                    </span>
                  </div>
                  <div className="text-emerald-800">
                    TP ESTRUCTURAL:
                    <span className={`ml-2 ${structLevels.valid ? "text-emerald-400" : "text-yellow-500"}`}>
                      {structLevels.tpSource}
                    </span>
                  </div>
                  {!structLevels.valid && (
                    <div className="text-yellow-600 mt-1">
                      ⚠ R:R estructural ({structLevels.rr.toFixed(1)}x) bajo el mínimo ({cfg.minRR}x) — ajusta manualmente
                    </div>
                  )}
                </div>
              )}
              {/* Manual mode hint */}
              {calcMode === "MANUAL" && (
                <div className="mt-3 pt-3 border-t border-emerald-900/30 text-[10px] text-emerald-800">
                  Modo manual: probabilidades calculadas con tus niveles exactos.
                  <span className="ml-1 text-emerald-700">R:R actual: {rr.toFixed(2)}x · target: {cfg.targetRR}x</span>
                </div>
              )}
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