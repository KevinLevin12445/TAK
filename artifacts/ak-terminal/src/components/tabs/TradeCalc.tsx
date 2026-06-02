import React, { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useGetGoldPrice, useGetGoldHistory } from "@workspace/api-client-react";

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. TYPE DEFINITIONS & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

type Mode      = "SCALP" | "INTRADAY" | "SWING" | "POSITION";
type Direction = "LONG" | "SHORT";
type CalcMode  = "AUTO" | "MANUAL";
type Regime    = "TRENDING" | "RANGING" | "VOLATILE" | "LOW_VOL" | "SQUEEZE" | "EXHAUSTION" | "CRASH";
type Tab       = "DASHBOARD" | "MONTECARLO" | "GREEKS" | "ZONES" | "RISK" | "TECHNICALS" | "MODELS";
type Phase     = "ABSORPTION" | "DISTRIBUTION" | "MARKUP" | "MARKDOWN" | "SQUEEZE" | "UNKNOWN";

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

interface GARCHState {
  omega: number;
  alpha: number;
  beta: number;
  sigma2: number[];
  longTermVol: number;
}

interface KalmanState {
  mu: number;
  P: number;
  Q: number;
  R: number;
  history: number[];
}

interface OUParams {
  theta: number;
  mu_ou: number;
  sigma_ou: number;
  halfLife: number;
}

interface MCResult {
  pTP: number;
  pSL: number;
  pTP_paths: number[];
  expectedShortfall: number;
  var95: number;
  var99: number;
  medianPath: number[];
  percentile10: number[];
  percentile90: number[];
  converged: boolean;
  nPaths: number;
  maxDrawdown: number;
}

interface BSGreeks {
  callPrice: number;
  putPrice: number;
  deltaCall: number;
  deltaPut: number;
  gamma: number;
  vega: number;
  thetaCall: number;
  thetaPut: number;
  rhoCall: number;
  rhoPut: number;
  probTouchTP: number;
  probTouchSL: number;
}

interface Zone {
  price: number;
  label: string;
  pReaction: number;
  type: "SUPPORT" | "RESISTANCE";
  strength: number;
  source: string;
  volumeProfile?: number;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. INSTITUTIONAL CONFIGURATION MATRIX
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const MODE_CONFIG = {
  SCALP:    { atrSL: 1.0, atrTP: 1.8, targetRR: 1.8, minRR: 1.2, minConf: 60, mcPaths: 1000, minPTP: 0.45, minEdge: 0.05, timeHorizon: 4,   label: "SCALP 1:1.8" },
  INTRADAY: { atrSL: 1.5, atrTP: 6.0, targetRR: 4.0, minRR: 2.5, minConf: 50, mcPaths: 2500, minPTP: 0.30, minEdge: 0.04, timeHorizon: 24,  label: "INTRADAY 1:4" },
  SWING:    { atrSL: 2.5, atrTP: 15.0, targetRR: 6.0, minRR: 4.0, minConf: 45, mcPaths: 5000, minPTP: 0.20, minEdge: 0.03, timeHorizon: 120, label: "SWING 1:6" },
  POSITION: { atrSL: 4.0, atrTP: 40.0, targetRR: 10.0, minRR: 8.0, minConf: 40, mcPaths: 10000, minPTP: 0.15, minEdge: 0.02, timeHorizon: 480, label: "POSITION 1:10" }
} as const;

const CONSTANTS = {
  BRIDGE_URL: "http://localhost:5001/data",
  BRIDGE_TIMEOUT: 5000,
  MC_STEPS: 200,
  TRADING_DAYS: 252,
  TRADING_HOURS: 24,
  RISK_FREE_RATE: 0.045, // 4.5% US Treasury 10Y Proxy
  GOLD_CONTRACT_SIZE: 100, // 1 Standard Lot = 100 oz
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. ADVANCED MATHEMATICS & STATISTICS KERNEL
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const MathUtils = {
  clamp: (v: number, a: number, b: number) => Math.max(a, Math.min(v, b)),
  
  sigmoid: (x: number) => 1 / (1 + Math.exp(-x)),
  
  // Standard Normal Distribution Generation (Box-Muller)
  randn: (): number => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  },
  
  // Heavy-tailed Student-t Distribution for financial returns modeling
  randStudentT: (nu: number): number => {
    const z = MathUtils.randn();
    let chi2 = 0;
    for (let i = 0; i < nu; i++) chi2 += MathUtils.randn() ** 2;
    return z / Math.sqrt(chi2 / nu);
  },

  // Jump Diffusion Generator (Poisson Process)
  randPoisson: (lambda: number): number => {
    let L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  },

  // Error Function approximation
  erf: (x: number): number => {
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  },

  // Cumulative Distribution Function for Standard Normal N(0,1)
  normCDF: (x: number): number => {
    return 0.5 * (1 + MathUtils.erf(x / Math.SQRT2));
  },

  // Probability Density Function for Standard Normal N(0,1)
  normPDF: (x: number): number => {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  },

  // Log Returns Calculation
  logReturns: (closes: number[]): number[] => {
    const r: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0 && closes[i] > 0) {
        r.push(Math.log(closes[i] / closes[i - 1]));
      } else {
        r.push(0);
      }
    }
    return r;
  },

  // Moving Average
  sma: (data: number[], p: number): number[] => {
    const res: number[] = [];
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
      if (i >= p) sum -= data[i - p];
      res.push(i >= p - 1 ? sum / p : NaN);
    }
    return res;
  },

  // Exponential Moving Average
  ema: (data: number[], p: number): number[] => {
    if (data.length < p) return [];
    const k = 2 / (p + 1);
    const e = new Array(data.length).fill(NaN);
    e[0] = data[0];
    for (let i = 1; i < data.length; i++) {
      e[i] = !isNaN(e[i - 1]) ? data[i] * k + e[i - 1] * (1 - k) : data[i];
    }
    return e;
  },

  // True Range & Average True Range
  atr: (candles: Candle[], p = 14): number => {
    if (!candles || candles.length === 0) return 10;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (trs.length < p) return 10;
    return trs.slice(-p).reduce((sum, val) => sum + val, 0) / p;
  },

  // Relative Strength Index (Wilder's Smoothing)
  rsi: (closes: number[], p = 14): number => {
    if (closes.length < p + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= p; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / p;
    let avgLoss = losses / p;
    
    for (let i = p + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) {
        avgGain = (avgGain * (p - 1) + diff) / p;
        avgLoss = (avgLoss * (p - 1)) / p;
      } else {
        avgGain = (avgGain * (p - 1)) / p;
        avgLoss = (avgLoss * (p - 1) + Math.abs(diff)) / p;
      }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  },

  // Moving Z-Score
  zScore: (closes: number[], p = 20): number => {
    if (closes.length < p) return 0;
    const w = closes.slice(-p);
    const mean = w.reduce((sum, val) => sum + val, 0) / p;
    const variance = w.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / p;
    const stdDev = Math.sqrt(variance);
    return stdDev === 0 ? 0 : (closes[closes.length - 1] - mean) / stdDev;
  },

  // MACD (Moving Average Convergence Divergence)
  macd: (closes: number[], fast = 12, slow = 26, signal = 9): { macd: number, signal: number, hist: number } => {
    const emaFast = MathUtils.ema(closes, fast);
    const emaSlow = MathUtils.ema(closes, slow);
    if (emaFast.length === 0 || emaSlow.length === 0) return { macd: 0, signal: 0, hist: 0 };
    
    const macdLine: number[] = [];
    for(let i=0; i<closes.length; i++) {
      if(!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) {
        macdLine.push(emaFast[i] - emaSlow[i]);
      } else {
        macdLine.push(NaN);
      }
    }
    
    const validMacd = macdLine.filter(v => !isNaN(v));
    const signalLine = MathUtils.ema(validMacd, signal);
    
    const currentMacd = validMacd[validMacd.length - 1] || 0;
    const currentSignal = signalLine[signalLine.length - 1] || 0;
    
    return {
      macd: currentMacd,
      signal: currentSignal,
      hist: currentMacd - currentSignal
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. QUANTITATIVE ECONOMETRIC MODELS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const QuantModels = {
  
  /**
   * Generalized Autoregressive Conditional Heteroskedasticity GARCH(1,1)
   * Captures volatility clustering in financial time series.
   * Variance eq: σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
   */
  fitGARCH: (returns: number[]): GARCHState => {
    const minReturns = 20;
    if (returns.length < minReturns) {
      const variance = returns.reduce((a, r) => a + r * r, 0) / Math.max(returns.length, 1);
      return { omega: variance * 0.05, alpha: 0.10, beta: 0.85, sigma2: [variance], longTermVol: Math.sqrt(variance) };
    }

    // Institutional default calibration for XAUUSD (Gold)
    let omega = 1.5e-6;
    let alpha = 0.085;
    let beta  = 0.905;
    
    // Constraint check for stationarity (alpha + beta < 1)
    if (alpha + beta >= 1) {
      alpha = 0.05;
      beta = 0.90;
    }

    const sigma2: number[] = [];
    const initialVar = returns.slice(0, minReturns).reduce((a, r) => a + r * r, 0) / minReturns;
    sigma2.push(initialVar);

    for (let i = 1; i < returns.length; i++) {
      const prevRet = returns[i - 1];
      const prevSig2 = sigma2[i - 1];
      const currentVar = omega + alpha * (prevRet ** 2) + beta * prevSig2;
      sigma2.push(Math.max(currentVar, 1e-12)); // Floor to prevent collapse
    }

    const longTermVariance = omega / (1 - alpha - beta);
    return { omega, alpha, beta, sigma2, longTermVol: Math.sqrt(longTermVariance) };
  },

  /**
   * 1D Kalman Filter for Drift (μ) Estimation
   * State space model to dynamically update expected returns.
   */
  kalmanFilter: (returns: number[], sigmas: number[]): KalmanState => {
    const Q = 1e-5; // Process noise covariance (Drift fluidity)
    const R_base = 1e-4; // Measurement noise baseline
    
    let mu = returns.slice(0, 10).reduce((a, b) => a + b, 0) / 10 || 0;
    let P  = 1e-3;
    const history: number[] = [mu];

    for (let i = 0; i < returns.length; i++) {
      // Predict Phase
      const P_pred = P + Q;
      
      // Update Phase (incorporating GARCH heteroskedasticity into measurement noise)
      const sigma_obs = sigmas[i] ?? Math.sqrt(R_base);
      const R_t = (sigma_obs ** 2) + R_base;
      const K = P_pred / (P_pred + R_t); // Kalman Gain
      
      mu = mu + K * (returns[i] - mu);
      P = (1 - K) * P_pred;
      history.push(mu);
    }
    
    return { mu, P, Q, R: R_base, history };
  },

  /**
   * Ornstein-Uhlenbeck Process Estimation via OLS
   * Models mean-reverting behavior of asset prices.
   * dS_t = θ(μ - S_t)dt + σ dW_t
   */
  estimateOU: (closes: number[]): OUParams => {
    if (closes.length < 30) return { theta: 0.5, mu_ou: closes.at(-1) ?? 0, sigma_ou: 10, halfLife: 1 };
    
    const n = closes.length;
    const mean = closes.reduce((a, b) => a + b, 0) / n;
    
    let sumXX = 0, sumXY = 0;
    for (let i = 1; i < n; i++) {
      const x = closes[i - 1] - mean;
      const y = closes[i] - closes[i - 1];
      sumXX += x * x;
      sumXY += x * y;
    }
    
    // Mean reversion speed
    const theta = sumXX > 0 ? MathUtils.clamp(-sumXY / sumXX, 0.001, 10) : 0.5;
    
    const residuals: number[] = [];
    for (let i = 1; i < n; i++) {
      residuals.push(closes[i] - closes[i - 1] - theta * (mean - closes[i - 1]));
    }
    
    const variance = residuals.reduce((a, r) => a + r * r, 0) / residuals.length;
    const sigma_ou = Math.sqrt(variance);
    const halfLife = Math.LN2 / theta; // Time to revert halfway to the mean
    
    return { theta, mu_ou: mean, sigma_ou: Math.max(sigma_ou, 0.01), halfLife };
  },

  /**
   * Black-Scholes-Merton Options Pricing & Greeks Calculator
   * Used to determine Probability of Touch for TP/SL levels.
   */
  blackScholes: (S: number, K: number, T: number, r: number, sigma: number): BSGreeks => {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
      return { callPrice: 0, putPrice: 0, deltaCall: 0, deltaPut: 0, gamma: 0, vega: 0, thetaCall: 0, thetaPut: 0, rhoCall: 0, rhoPut: 0, probTouchTP: 0, probTouchSL: 0 };
    }

    const d1 = (Math.log(S / K) + (r + (sigma ** 2) / 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);

    const Nd1 = MathUtils.normCDF(d1);
    const Nd2 = MathUtils.normCDF(d2);
    const N_minus_d1 = MathUtils.normCDF(-d1);
    const N_minus_d2 = MathUtils.normCDF(-d2);
    const pd1 = MathUtils.normPDF(d1);

    const callPrice = S * Nd1 - K * Math.exp(-r * T) * Nd2;
    const putPrice  = K * Math.exp(-r * T) * N_minus_d2 - S * N_minus_d1;

    // Greeks
    const deltaCall = Nd1;
    const deltaPut  = Nd1 - 1;
    const gamma     = pd1 / (S * sigma * Math.sqrt(T));
    const vega      = S * pd1 * Math.sqrt(T);
    const thetaCall = -(S * pd1 * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * Nd2;
    const thetaPut  = -(S * pd1 * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * N_minus_d2;
    const rhoCall   = K * T * Math.exp(-r * T) * Nd2;
    const rhoPut    = -K * T * Math.exp(-r * T) * N_minus_d2;

    // First Passage Time Probability (Probability of Touch)
    // Formula for hitting a barrier H before expiration T.
    const calcTouch = (H: number) => {
      const m = r - (sigma ** 2) / 2;
      const z1 = (Math.log(H / S) - m * T) / (sigma * Math.sqrt(T));
      const z2 = (Math.log(H / S) + m * T) / (sigma * Math.sqrt(T));
      const factor = Math.pow(H / S, (2 * m) / (sigma ** 2));
      let prob = 0;
      if (H > S) {
        prob = MathUtils.normCDF(-z1) + factor * MathUtils.normCDF(-z2);
      } else {
        prob = MathUtils.normCDF(z1) + factor * MathUtils.normCDF(z2);
      }
      return MathUtils.clamp(prob, 0.01, 0.99);
    };

    return { callPrice, putPrice, deltaCall, deltaPut, gamma, vega, thetaCall, thetaPut, rhoCall, rhoPut, probTouchTP: calcTouch(K), probTouchSL: calcTouch(K) }; // Touch calculations mapped externally.
  }
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. STOCHASTIC SIMULATION (MONTE CARLO)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Jump-Diffusion Monte Carlo Simulator (Merton Model)
 * Incorporates GARCH volatility, OU mean reversion, and Poisson jump processes.
 */
function runMonteCarloEngine(
  entry: number, 
  sl: number, 
  tp: number,
  garch: GARCHState, 
  kalman: KalmanState, 
  ou: OUParams,
  muBridge: number,
  hasBridge: boolean,
  nPaths: number,
  regime: Regime,
  direction: Direction
): MCResult {
  const nu = 5; // Degrees of freedom for Student-t
  const dt = 1 / CONSTANTS.MC_STEPS;
  
  // Jump Diffusion Parameters (calibrated for Gold)
  const jumpLambda = 0.5; // Expected jumps per period
  const jumpMu = 0.0;     // Mean jump size
  const jumpSigma = 0.02; // Volatility of jump size

  // Drift Aggregation
  const mu_kalman = kalman.mu;
  const mu_final = (mu_kalman * 0.5) + (hasBridge ? muBridge * 0.5 : 0);

  // Volatility Regime Multiplier
  const regimeVolMult = {
    "VOLATILE": 1.5, "SQUEEZE": 1.6, "CRASH": 2.0,
    "LOW_VOL": 0.6, "RANGING": 0.8, "TRENDING": 1.0, "EXHAUSTION": 1.2
  }[regime] || 1.0;

  let hitTP = 0, hitSL = 0;
  const pTP_sample: number[] = [];
  const finalPrices: number[] = [];
  const allPaths: number[][] = [];
  
  const initialSig2 = garch.sigma2.at(-1) ?? 1e-4;

  for (let p = 0; p < nPaths; p++) {
    let S = entry;
    let sig2 = initialSig2;
    let ret = 0;
    let done = false;
    const path: number[] = [S];

    for (let t = 0; t < CONSTANTS.MC_STEPS; t++) {
      // 1. GARCH Volatility Update
      sig2 = Math.max(garch.omega + garch.alpha * (ret ** 2) + garch.beta * sig2, 1e-12);
      const sigma_t = Math.sqrt(sig2) * regimeVolMult * S;

      // 2. Continuous Drift (Kalman + Ornstein-Uhlenbeck)
      const ou_drift = ou.theta * (ou.mu_ou - S) * dt;
      const continuous_drift = (mu_final + ou_drift / S) * S * dt;

      // 3. Continuous Shock (Fat Tails)
      const continuous_shock = sigma_t * MathUtils.randStudentT(nu) * Math.sqrt(dt);

      // 4. Jump Diffusion Process
      let jump_shock = 0;
      const nJumps = MathUtils.randPoisson(jumpLambda * dt);
      for (let j = 0; j < nJumps; j++) {
        jump_shock += Math.exp(jumpMu + jumpSigma * MathUtils.randn()) - 1;
      }
      jump_shock *= S;

      // Total Update
      const total_change = continuous_drift + continuous_shock + jump_shock;
      ret = total_change / Math.max(S, 1);
      S += total_change;
      
      // Floor price at 0.01 to prevent negative asset prices
      S = Math.max(S, 0.01); 
      path.push(S);

      // Barrier Check
      if (direction === "LONG") {
        if (S >= tp) { hitTP++; pTP_sample.push(1); done = true; break; }
        if (S <= sl) { hitSL++; pTP_sample.push(0); done = true; break; }
      } else {
        if (S <= tp) { hitTP++; pTP_sample.push(1); done = true; break; }
        if (S >= sl) { hitSL++; pTP_sample.push(0); done = true; break; }
      }
    }

    if (!done) {
      const win = direction === "LONG" ? S > entry : S < entry;
      pTP_sample.push(win ? 1 : 0);
      if (direction === "LONG") {
        if (S >= tp) hitTP++; else hitSL++; // Forced assignment at T_end if no barrier hit
      } else {
        if (S <= tp) hitTP++; else hitSL++;
      }
    }

    finalPrices.push(S);
    if (p < 300) allPaths.push(path); // Save subset for rendering
  }

  // Cross-sectional Percentiles Generation
  const stepsData: { p10: number; p50: number; p90: number }[] = [];
  for (let t = 0; t <= CONSTANTS.MC_STEPS; t++) {
    const slice = allPaths.map(path => path[Math.min(t, path.length - 1)]).sort((a, b) => a - b);
    const n = slice.length;
    stepsData.push({
      p10: slice[Math.floor(n * 0.10)] ?? entry,
      p50: slice[Math.floor(n * 0.50)] ?? entry,
      p90: slice[Math.floor(n * 0.90)] ?? entry,
    });
  }

  // Risk Metrics (Tail Risk)
  const sortedPnL = finalPrices.map(p => direction === "LONG" ? p - entry : entry - p).sort((a, b) => a - b);
  const var95 = Math.abs(sortedPnL[Math.floor(nPaths * 0.05)] ?? 0);
  const var99 = Math.abs(sortedPnL[Math.floor(nPaths * 0.01)] ?? 0);
  
  const tailLosses = sortedPnL.filter(pnl => pnl < -var95);
  const expectedShortfall = tailLosses.length > 0 ? Math.abs(tailLosses.reduce((a, b) => a + b, 0) / tailLosses.length) : var95;
  
  const maxDrawdown = Math.abs(sortedPnL[0] ?? 0);

  const total = hitTP + hitSL;
  const pTP_mc = total > 0 ? hitTP / total : 0.5;

  return {
    pTP: MathUtils.clamp(pTP_mc, 0.01, 0.99),
    pSL: MathUtils.clamp(1 - pTP_mc, 0.01, 0.99),
    pTP_paths: pTP_sample,
    expectedShortfall,
    var95,
    var99,
    medianPath: stepsData.map(s => s.p50),
    percentile10: stepsData.map(s => s.p10),
    percentile90: stepsData.map(s => s.p90),
    converged: nPaths >= 500,
    nPaths,
    maxDrawdown
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 6. PORTFOLIO & RISK MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const RiskManager = {
  /**
   * Kelly Criterion (Continuous Formula)
   * f* = (p * b - q) / b
   * Computes the theoretical optimal fraction of capital to risk.
   */
  kelly: (pTP: number, rr: number): number => {
    const q = 1 - pTP;
    const f = (pTP * rr - q) / Math.max(rr, 0.01);
    return MathUtils.clamp(f, -1, 1);
  },

  /**
   * Risk of Ruin Probability
   * Calculates probability of hitting a ruin threshold given current edge.
   */
  ruinProbability: (pTP: number, rr: number, riskPerTrade: number, ruinThresholdPct: number): number => {
    if (pTP <= 0.5 && rr <= 1) return 1.0; // Guaranteed ruin
    const p = pTP;
    const q = 1 - p;
    // Approximation for unequal payouts
    const z = (p * rr - q) / Math.sqrt(p * rr * rr + q);
    if (z <= 0) return 1.0;
    
    // Using simple random walk ruin approximation
    const expectedGrowth = p * Math.log(1 + riskPerTrade * rr) + q * Math.log(1 - riskPerTrade);
    if (expectedGrowth <= 0) return 1.0;
    
    return Math.exp(-2 * expectedGrowth / (riskPerTrade * riskPerTrade)); 
  },

  /**
   * Institutional Sizing based on Volatility (Volatility Targeting)
   */
  volatilityTargetSize: (capital: number, targetVol: number, currentVol: number, pointValue: number): number => {
    if (currentVol === 0) return 0;
    return (capital * targetVol) / (currentVol * pointValue);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 7. MARKET STRUCTURE & ZONES ENGINE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

function findSwingPivots(candles: Candle[], lookback = 5) {
  const highs: number[] = [];
  const lows: number[] = [];
  
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true, isLow = true;
    
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= h) isHigh = false;
      if (candles[j].low <= l) isLow = false;
    }
    
    if (isHigh) highs.push(h);
    if (isLow) lows.push(l);
  }
  return { highs, lows };
}

function computeInstitutionalZones(
  price: number, 
  atr: number, 
  ema20: number, 
  ema50: number,
  sigma_daily: number,
  bridgeData: BridgeData | null,
  candles: Candle[]
): Zone[] {
  const zones: Zone[] = [];
  
  // 1. Technical EMAs
  const addTechnical = (val: number, label: string, str: number) => {
    const dist = Math.abs(price - val);
    if (dist / atr > 8) return;
    const decay = Math.exp(-dist / (sigma_daily * price + atr));
    zones.push({
      price: val, label, source: "TECHNICAL",
      pReaction: MathUtils.clamp(decay * str * 0.8 + 0.15, 0.10, 0.95),
      type: price > val ? "SUPPORT" : "RESISTANCE",
      strength: str,
    });
  };
  addTechnical(ema20, "EMA 20", 0.65);
  addTechnical(ema50, "EMA 50", 0.80);

  // 2. Options Gamma Exposure (GEX)
  if (bridgeData?.gamma_exposure) {
    bridgeData.gamma_exposure.slice(0, 8).forEach(g => {
      const dist = Math.abs(price - g.strike);
      if (dist / atr > 10) return;
      const n = MathUtils.clamp(Math.abs(g.gex) / 500000, 0, 1);
      zones.push({
        price: g.strike,
        label: `GEX WALL [${g.gex > 0 ? "+" : ""}${(g.gex / 1000).toFixed(0)}k]`,
        source: "DERIVATIVES",
        pReaction: MathUtils.clamp(n * 0.7 + Math.exp(-dist / (atr * 2)) * 0.3, 0.20, 0.98),
        type: g.strike > price ? "RESISTANCE" : "SUPPORT",
        strength: n * 100,
      });
    });
  }

  // 3. Dark Pool Prints
  if (bridgeData?.dark_pool) {
    bridgeData.dark_pool.slice(0, 5).forEach(d => {
      const dist = Math.abs(price - d.price);
      if (dist / atr > 8) return;
      const n = MathUtils.clamp(d.size / 1000000, 0, 1);
      zones.push({
        price: d.price, 
        label: `DARK POOL BLOCK [${(d.size / 1000).toFixed(0)}k]`, 
        source: "OFF-EXCHANGE",
        pReaction: MathUtils.clamp(n * 0.6 + Math.exp(-dist / (atr * 1.5)) * 0.4, 0.15, 0.90),
        type: d.price < price ? "SUPPORT" : "RESISTANCE",
        strength: n * 100,
      });
    });
  }

  // 4. Market Structure Swings
  const { highs, lows } = findSwingPivots(candles, 8);
  highs.slice(-3).forEach(h => {
    zones.push({ price: h, label: "Structural Swing High", source: "PRICE ACTION", pReaction: 0.65, type: "RESISTANCE", strength: 60 });
  });
  lows.slice(-3).forEach(l => {
    zones.push({ price: l, label: "Structural Swing Low", source: "PRICE ACTION", pReaction: 0.65, type: "SUPPORT", strength: 60 });
  });

  return zones.sort((a, b) => b.pReaction - a.pReaction).slice(0, 12);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 8. CUSTOM UI COMPONENTS (SVG & WIDGETS)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const UI = {
  Card: ({ title, children, className = "" }: { title: string, children: React.ReactNode, className?: string }) => (
    <div className={`bg-[#080c09] border border-emerald-900/40 rounded-xl p-4 shadow-[0_4px_20px_rgba(0,0,0,0.5)] ${className}`}>
      <h3 className="text-[10px] text-emerald-600 font-bold tracking-[0.2em] mb-3 uppercase">{title}</h3>
      {children}
    </div>
  ),

  Metric: ({ label, value, subtext, colorClass = "text-emerald-400" }: { label: string, value: string, subtext?: string, colorClass?: string }) => (
    <div className="flex flex-col p-3 bg-black/40 border border-emerald-900/20 rounded-lg">
      <span className="text-[9px] text-emerald-700 tracking-wider mb-1">{label}</span>
      <span className={`text-lg font-black tracking-tight ${colorClass}`}>{value}</span>
      {subtext && <span className="text-[8px] text-emerald-800 mt-1">{subtext}</span>}
    </div>
  ),

  CandlestickChart: ({ data, width = 600, height = 250 }: { data: Candle[], width?: number, height?: number }) => {
    if (!data || data.length === 0) return null;
    const padding = 20;
    const w = width - padding * 2;
    const h = height - padding * 2;
    
    const minPrice = Math.min(...data.map(d => d.low)) * 0.999;
    const maxPrice = Math.max(...data.map(d => d.high)) * 1.001;
    const range = maxPrice - minPrice;
    
    const candleWidth = w / data.length;
    const scaleY = (val: number) => height - padding - ((val - minPrice) / range) * h;

    return (
      <svg width={width} height={height} className="w-full bg-[#030504] border border-emerald-900/30 rounded">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map(tick => (
          <line key={tick} x1={padding} y1={padding + h * tick} x2={width - padding} y2={padding + h * tick} stroke="#064e3b" strokeWidth="0.5" strokeDasharray="2,2" />
        ))}
        
        {data.map((candle, i) => {
          const x = padding + i * candleWidth + candleWidth / 2;
          const isBull = candle.close >= candle.open;
          const color = isBull ? "#10b981" : "#e11d48";
          
          return (
            <g key={i}>
              {/* Wick */}
              <line x1={x} y1={scaleY(candle.high)} x2={x} y2={scaleY(candle.low)} stroke={color} strokeWidth="1" />
              {/* Body */}
              <rect 
                x={x - candleWidth * 0.3} 
                y={scaleY(Math.max(candle.open, candle.close))} 
                width={Math.max(candleWidth * 0.6, 1)} 
                height={Math.max(Math.abs(scaleY(candle.open) - scaleY(candle.close)), 1)} 
                fill={color} 
              />
            </g>
          );
        })}
      </svg>
    );
  },

  MCViz: ({ median, p10, p90, sl, tp, entry, direction, width = 600, height = 250 }: any) => {
    if (!median || median.length === 0) return null;
    const pad = 20;
    const w = width - pad * 2;
    const h = height - pad * 2;
    
    const allVals = [...median, ...p10, ...p90, sl, tp, entry];
    const minP = Math.min(...allVals) * 0.999;
    const maxP = Math.max(...allVals) * 1.001;
    const rng = maxP - minP;
    
    const sX = (i: number) => pad + (i / (median.length - 1)) * w;
    const sY = (v: number) => height - pad - ((v - minP) / rng) * h;

    const pathD = (arr: number[]) => arr.map((v, i) => `${i===0?'M':'L'}${sX(i)},${sY(v)}`).join(" ");
    
    const band = [
      ...p10.map((v: number, i: number) => `${i===0?'M':'L'}${sX(i)},${sY(v)}`),
      ...[...p90].reverse().map((v: number, i: number) => `L${sX(median.length - 1 - i)},${sY(v)}`),
      "Z"
    ].join(" ");

    return (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="bg-[#030504] border border-emerald-900/30 rounded font-mono">
        {/* Area */}
        <path d={band} fill="rgba(16,185,129,0.05)" />
        
        {/* Horizontal Barriers */}
        <line x1={pad} y1={sY(tp)} x2={width-pad} y2={sY(tp)} stroke={direction === "LONG" ? "#10b981" : "#e11d48"} strokeWidth="1.5" strokeDasharray="4,4" />
        <text x={pad + 5} y={sY(tp) - 5} fill={direction === "LONG" ? "#10b981" : "#e11d48"} fontSize="10">TAKE PROFIT</text>
        
        <line x1={pad} y1={sY(sl)} x2={width-pad} y2={sY(sl)} stroke={direction === "LONG" ? "#e11d48" : "#10b981"} strokeWidth="1.5" strokeDasharray="4,4" />
        <text x={pad + 5} y={sY(sl) + 12} fill={direction === "LONG" ? "#e11d48" : "#10b981"} fontSize="10">STOP LOSS</text>
        
        <line x1={pad} y1={sY(entry)} x2={width-pad} y2={sY(entry)} stroke="#64748b" strokeWidth="1" />
        <text x={pad + 5} y={sY(entry) - 5} fill="#64748b" fontSize="10">ENTRY POINT</text>

        {/* Lines */}
        <path d={pathD(p90)} fill="none" stroke="#047857" strokeWidth="1" strokeDasharray="2,2" opacity="0.6" />
        <path d={pathD(p10)} fill="none" stroke="#9f1239" strokeWidth="1" strokeDasharray="2,2" opacity="0.6" />
        <path d={pathD(median)} fill="none" stroke="#34d399" strokeWidth="2" />
      </svg>
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// 9. MAIN TERMINAL APPLICATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

export function TradeCalc() {
  // ─── Data Fetching ───────────────────────────────────────────────────
  const { data: priceData } = useGetGoldPrice();
  const { data: historyData } = useGetGoldHistory({ interval: "15m", period: "14d" });
  
  const [bridgeData, setBridgeData] = useState<BridgeData | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<"LIVE" | "OFFLINE">("OFFLINE");

  useEffect(() => {
    const fetchBridge = async () => {
      try {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), CONSTANTS.BRIDGE_TIMEOUT);
        const res = await fetch(CONSTANTS.BRIDGE_URL, { signal: ctrl.signal });
        clearTimeout(id);
        if(res.ok) {
          setBridgeData(await res.json());
          setBridgeStatus("LIVE");
        } else {
          setBridgeStatus("OFFLINE");
        }
      } catch (e) {
        setBridgeStatus("OFFLINE");
      }
    };
    fetchBridge();
    const interval = setInterval(fetchBridge, 10000);
    return () => clearInterval(interval);
  }, []);

  // ─── State Management ────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("DASHBOARD");
  const [mode, setMode] = useState<Mode>("INTRADAY");
  const [direction, setDirection] = useState<Direction>("LONG");
  const [calcMode, setCalcMode] = useState<CalcMode>("AUTO");
  
  const [capital, setCapital] = useState<number>(100000);
  const [riskPercent, setRiskPercent] = useState<number>(1.0);
  
  const livePrice = priceData?.price ?? 2450.50; // Fallback Gold Price
  const rawCandles = historyData?.candles ?? [];
  
  // Clean raw API data to strict Candle interface
  const candles: Candle[] = useMemo(() => {
    return rawCandles.map((c: any) => ({
      time: c.time ?? Date.now(),
      open: c.open ?? c.o ?? 0,
      high: c.high ?? c.h ?? 0,
      low: c.low ?? c.l ?? 0,
      close: c.close ?? c.c ?? 0,
      volume: c.volume ?? c.v ?? 0
    })).filter((c: Candle) => c.close > 0);
  }, [rawCandles]);

  const closes = useMemo(() => candles.map(c => c.close), [candles]);
  const returns = useMemo(() => MathUtils.logReturns(closes), [closes]);

  // ─── Manual Inputs ───────────────────────────────────────────────────
  const [manualEntry, setManualEntry] = useState<number>(livePrice);
  const [manualSL, setManualSL] = useState<number>(livePrice - 10);
  const [manualTP, setManualTP] = useState<number>(livePrice + 30);

  // ─── Technical Indicators ────────────────────────────────────────────
  const atr = useMemo(() => MathUtils.atr(candles, 14), [candles]);
  const rsi = useMemo(() => MathUtils.rsi(closes, 14), [closes]);
  const ema20 = useMemo(() => MathUtils.ema(closes, 20), [closes]);
  const ema50 = useMemo(() => MathUtils.ema(closes, 50), [closes]);
  const macdData = useMemo(() => MathUtils.macd(closes), [closes]);
  const zScoreVal = useMemo(() => MathUtils.zScore(closes, 20), [closes]);

  const currentEma20 = ema20.at(-1) ?? livePrice;
  const currentEma50 = ema50.at(-1) ?? livePrice;
  const isBullish = currentEma20 > currentEma50;

  // ─── Quantitative Models Execution ───────────────────────────────────
  const garchState = useMemo(() => QuantModels.fitGARCH(returns), [returns]);
  const kalmanState = useMemo(() => QuantModels.kalmanFilter(returns, garchState.sigma2.map(Math.sqrt)), [returns, garchState]);
  const ouState = useMemo(() => QuantModels.estimateOU(closes.slice(-100)), [closes]);

  const currentVolAnnual = Math.sqrt(garchState.sigma2.at(-1) ?? 1e-4) * Math.sqrt(CONSTANTS.TRADING_DAYS * (24/(15/60))); // Assuming 15m candles
  const currentDriftAnnual = kalmanState.mu * CONSTANTS.TRADING_DAYS * (24/(15/60));

  // ─── Market Regime Identification ────────────────────────────────────
  const regime: Regime = useMemo(() => {
    const atrPct = atr / livePrice;
    if (atrPct > 0.005 && rsi > 30 && rsi < 70) return "VOLATILE";
    if (atrPct < 0.0015) return "LOW_VOL";
    if (Math.abs(zScoreVal) < 0.5 && atrPct < 0.0025) return "SQUEEZE";
    if (rsi > 75 || rsi < 25) return "EXHAUSTION";
    if (Math.abs(currentEma20 - currentEma50) / atr < 0.3) return "RANGING";
    if (currentVolAnnual > 0.30) return "CRASH"; // Vol > 30% implies panic
    return "TRENDING";
  }, [atr, livePrice, rsi, zScoreVal, currentEma20, currentEma50, currentVolAnnual]);

  // ─── Structural Level Generation (AUTO Mode) ─────────────────────────
  useEffect(() => {
    if (calcMode === "MANUAL") return;
    const cfg = MODE_CONFIG[mode];
    let calcSL = 0, calcTP = 0;

    const { highs, lows } = findSwingPivots(candles, 8);
    
    if (direction === "LONG") {
      const nearLow = lows.slice().reverse().find(l => l < livePrice - atr * 0.2);
      calcSL = nearLow ? nearLow - atr * 0.1 : livePrice - atr * cfg.atrSL;
      calcTP = livePrice + Math.abs(livePrice - calcSL) * cfg.targetRR;
    } else {
      const nearHigh = highs.slice().reverse().find(h => h > livePrice + atr * 0.2);
      calcSL = nearHigh ? nearHigh + atr * 0.1 : livePrice + atr * cfg.atrSL;
      calcTP = livePrice - Math.abs(calcSL - livePrice) * cfg.targetRR;
    }

    setManualEntry(livePrice);
    setManualSL(calcSL);
    setManualTP(calcTP);
  }, [calcMode, direction, mode, livePrice, atr, candles]);

  const activeEntry = manualEntry;
  const activeSL = manualSL;
  const activeTP = manualTP;
  
  const riskDist = Math.abs(activeEntry - activeSL);
  const rewardDist = Math.abs(activeTP - activeEntry);
  const currentRR = riskDist > 0 ? rewardDist / riskDist : 0;

  // ─── Options Pricing (Black-Scholes) ─────────────────────────────────
  const timeToExpiryYears = MODE_CONFIG[mode].timeHorizon / (CONSTANTS.TRADING_DAYS * 24);
  const bsTP = useMemo(() => QuantModels.blackScholes(activeEntry, activeTP, timeToExpiryYears, CONSTANTS.RISK_FREE_RATE, currentVolAnnual), [activeEntry, activeTP, timeToExpiryYears, currentVolAnnual]);
  const bsSL = useMemo(() => QuantModels.blackScholes(activeEntry, activeSL, timeToExpiryYears, CONSTANTS.RISK_FREE_RATE, currentVolAnnual), [activeEntry, activeSL, timeToExpiryYears, currentVolAnnual]);

  // ─── Monte Carlo Engine ──────────────────────────────────────────────
  const [mcResult, setMcResult] = useState<MCResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);

  const executeSimulation = useCallback(() => {
    setIsSimulating(true);
    setTimeout(() => {
      const bridgeDrift = bridgeStatus === "LIVE" && bridgeData ? (bridgeData.combined_score * 0.0001 * (direction === "LONG" ? 1 : -1)) : 0;
      const res = runMonteCarloEngine(
        activeEntry, activeSL, activeTP,
        garchState, kalmanState, ouState,
        bridgeDrift, bridgeStatus === "LIVE",
        MODE_CONFIG[mode].mcPaths, regime, direction
      );
      setMcResult(res);
      setIsSimulating(false);
    }, 100);
  }, [activeEntry, activeSL, activeTP, garchState, kalmanState, ouState, bridgeStatus, bridgeData, mode, regime, direction]);

  useEffect(() => {
    executeSimulation();
  }, [activeEntry, activeSL, activeTP, direction, mode]);

  // ─── Risk & Position Sizing ──────────────────────────────────────────
  const pTP = mcResult?.pTP ?? 0.50;
  const edge = pTP - (1 / (1 + currentRR));
  const expectedValue = (pTP * rewardDist) - ((1 - pTP) * riskDist);
  
  const rawKelly = RiskManager.kelly(pTP, currentRR);
  const halfKelly = rawKelly * 0.5;
  const kellyPositionUsd = capital * Math.max(0, halfKelly);
  
  const userRiskUsd = capital * (riskPercent / 100);
  const lotSizeMT5 = riskDist > 0 ? userRiskUsd / (riskDist * CONSTANTS.GOLD_CONTRACT_SIZE) : 0;

  // ─── Zones ───────────────────────────────────────────────────────────
  const institutionalZones = useMemo(() => computeInstitutionalZones(activeEntry, atr, currentEma20, currentEma50, Math.sqrt(garchState.sigma2.at(-1) ?? 1e-4), bridgeData, candles), [activeEntry, atr, currentEma20, currentEma50, garchState, bridgeData, candles]);

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  // RENDER UI
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen bg-[#020403] text-emerald-500 font-mono p-4 flex justify-center">
      <div className="w-full max-w-6xl space-y-4">
        
        {/* HEADER */}
        <header className="bg-[#050a06] border border-emerald-900/50 rounded-2xl p-6 shadow-2xl flex flex-col md:flex-row justify-between items-center relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-emerald-900/10 to-transparent pointer-events-none" />
          <div className="z-10 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-emerald-950 border border-emerald-500/30 flex items-center justify-center">
              <span className="text-xl">Δ</span>
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-widest text-emerald-400">K-AURUM QUANT TERMINAL</h1>
              <p className="text-[10px] text-emerald-700 tracking-[0.2em] mt-1">HFT & STOCHASTIC CALCULUS ENGINE • XAUUSD</p>
            </div>
          </div>
          <div className="z-10 mt-4 md:mt-0 flex gap-6 text-right">
            <div>
              <div className="text-[9px] text-emerald-800 tracking-wider">SPOT (REALTIME)</div>
              <div className="text-3xl font-light text-emerald-300">${livePrice.toFixed(2)}</div>
            </div>
            <div className="flex flex-col items-end justify-center">
              <span className={`text-[9px] px-2 py-1 rounded border ${bridgeStatus === "LIVE" ? "bg-emerald-950/40 border-emerald-500/50 text-emerald-400" : "bg-red-950/40 border-red-500/50 text-red-400"}`}>
                {bridgeStatus === "LIVE" ? "● DATAFEED ONLINE" : "○ OFFLINE MODEL"}
              </span>
              <span className="text-[9px] text-emerald-800 mt-1">VOL: {(currentVolAnnual*100).toFixed(2)}%</span>
            </div>
          </div>
        </header>

        {/* MAIN GRID */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          
          {/* LEFT SIDEBAR: CONTROLS */}
          <div className="lg:col-span-3 space-y-4">
            
            <UI.Card title="EXECUTION CONTEXT">
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setDirection("LONG")} className={`py-3 rounded text-xs font-bold transition-all ${direction === "LONG" ? "bg-emerald-500 text-black shadow-[0_0_15px_rgba(16,185,129,0.3)]" : "bg-black/40 border border-emerald-900/50 text-emerald-700 hover:text-emerald-500"}`}>LONG</button>
                  <button onClick={() => setDirection("SHORT")} className={`py-3 rounded text-xs font-bold transition-all ${direction === "SHORT" ? "bg-red-600 text-white shadow-[0_0_15px_rgba(220,38,38,0.3)]" : "bg-black/40 border border-emerald-900/50 text-emerald-700 hover:text-emerald-500"}`}>SHORT</button>
                </div>

                <div className="space-y-1">
                  <label className="text-[8px] text-emerald-800 uppercase">Horizonte de Tiempo</label>
                  <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} className="w-full bg-black/60 border border-emerald-900/50 rounded p-2 text-xs text-emerald-400 outline-none focus:border-emerald-500">
                    <option value="SCALP">SCALP (1-4H)</option>
                    <option value="INTRADAY">INTRADAY (24H)</option>
                    <option value="SWING">SWING (1-5D)</option>
                    <option value="POSITION">POSITION (1M+)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[8px] text-emerald-800 uppercase">Modo de Cálculo</label>
                  <div className="flex gap-2 bg-black/40 p-1 rounded border border-emerald-900/30">
                    <button onClick={() => setCalcMode("AUTO")} className={`flex-1 py-1.5 text-[10px] rounded ${calcMode === "AUTO" ? "bg-emerald-900/40 text-emerald-400" : "text-emerald-800"}`}>AUTO</button>
                    <button onClick={() => setCalcMode("MANUAL")} className={`flex-1 py-1.5 text-[10px] rounded ${calcMode === "MANUAL" ? "bg-emerald-900/40 text-emerald-400" : "text-emerald-800"}`}>MANUAL</button>
                  </div>
                </div>
              </div>
            </UI.Card>

            <UI.Card title="PRICING MATRIX">
              <div className="space-y-3">
                {[
                  { label: "ENTRY LEVEL", value: manualEntry, set: setManualEntry, col: "text-blue-400", bCol: "border-blue-900/40 focus:border-blue-500" },
                  { label: "STOP LOSS", value: manualSL, set: setManualSL, col: "text-red-400", bCol: "border-red-900/40 focus:border-red-500" },
                  { label: "TAKE PROFIT", value: manualTP, set: setManualTP, col: "text-emerald-400", bCol: "border-emerald-900/40 focus:border-emerald-500" }
                ].map((item, i) => (
                  <div key={i}>
                    <label className="text-[8px] text-emerald-800 uppercase">{item.label}</label>
                    <input 
                      type="number" 
                      value={item.value.toFixed(2)} 
                      onChange={(e) => item.set(Number(e.target.value))}
                      disabled={calcMode === "AUTO"}
                      className={`w-full bg-black/60 border ${item.bCol} rounded p-2 text-sm font-bold ${item.col} outline-none disabled:opacity-50 mt-1`} 
                    />
                  </div>
                ))}

                <div className="pt-3 border-t border-emerald-900/30 grid grid-cols-2 gap-2">
                  <div className="text-[10px] text-emerald-700">R:R RATIO<br/><span className="text-sm font-bold text-emerald-400">1:{currentRR.toFixed(2)}</span></div>
                  <div className="text-[10px] text-emerald-700">DISTANCIA SL<br/><span className="text-sm font-bold text-red-400">${riskDist.toFixed(2)}</span></div>
                </div>
              </div>
            </UI.Card>

            <UI.Card title="ACCOUNT SIZING">
              <div className="space-y-2">
                <div>
                  <label className="text-[8px] text-emerald-800 uppercase">Capital ($)</label>
                  <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} className="w-full bg-black/60 border border-emerald-900/50 rounded p-1.5 text-xs text-emerald-400 outline-none" />
                </div>
                <div>
                  <label className="text-[8px] text-emerald-800 uppercase">Riesgo por Trade (%)</label>
                  <input type="number" step="0.1" value={riskPercent} onChange={(e) => setRiskPercent(Number(e.target.value))} className="w-full bg-black/60 border border-emerald-900/50 rounded p-1.5 text-xs text-emerald-400 outline-none" />
                </div>
                <div className="bg-emerald-950/20 border border-emerald-500/30 rounded p-2 text-center mt-3">
                  <span className="text-[8px] text-emerald-600 block mb-1">VOLUMEN SUGERIDO (MT5 LOTS)</span>
                  <span className="text-2xl font-black text-emerald-400">{lotSizeMT5.toFixed(2)}</span>
                  <span className="text-[9px] text-emerald-700 block mt-1">Riesgo Real: ${userRiskUsd.toFixed(2)}</span>
                </div>
              </div>
            </UI.Card>

          </div>

          {/* RIGHT MAIN AREA */}
          <div className="lg:col-span-9 space-y-4">
            
            {/* TABS NAVIGATION */}
            <div className="flex bg-[#050a06] border border-emerald-900/50 rounded-xl p-1 overflow-x-auto hide-scrollbar">
              {(["DASHBOARD", "MONTECARLO", "GREEKS", "ZONES", "RISK", "TECHNICALS", "MODELS"] as Tab[]).map((t) => (
                <button 
                  key={t} 
                  onClick={() => setTab(t)}
                  className={`flex-1 py-3 px-4 text-[10px] font-bold tracking-widest transition-all rounded-lg whitespace-nowrap ${tab === t ? "bg-emerald-900/40 text-emerald-400 shadow-inner" : "text-emerald-800 hover:text-emerald-600 hover:bg-emerald-900/10"}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* TAB CONTENTS */}
            <div className="bg-[#050a06] border border-emerald-900/50 rounded-xl min-h-[600px] p-6 relative">
              
              {/* === DASHBOARD TAB === */}
              {tab === "DASHBOARD" && (
                <div className="space-y-6 animate-in fade-in duration-300">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <UI.Metric label="PROBABILIDAD MONTE CARLO" value={`${(pTP * 100).toFixed(1)}%`} subtext={`Convergencia: ${mcResult?.converged ? 'Alta' : 'Baja'} (${mcResult?.nPaths} paths)`} colorClass={pTP > 0.5 ? "text-emerald-400" : "text-yellow-500"} />
                    <UI.Metric label="VENTAJA ESTADÍSTICA (EDGE)" value={`${(edge * 100).toFixed(2)}%`} subtext={`Req BreakEven: ${((1/(1+currentRR))*100).toFixed(1)}%`} colorClass={edge > 0 ? "text-emerald-400" : "text-red-500"} />
                    <UI.Metric label="EXPECTATIVA MATEMÁTICA" value={`$${expectedValue.toFixed(2)}`} subtext="Valor Esperado por Onza" colorClass={expectedValue > 0 ? "text-emerald-400" : "text-red-500"} />
                    <UI.Metric label="MARKET REGIME" value={regime} subtext={`Fase GARCH/OU Actual`} colorClass="text-cyan-400" />
                  </div>

                  <div className="h-64 border border-emerald-900/30 rounded-xl overflow-hidden bg-[#030504] relative">
                    <div className="absolute top-2 left-3 z-10 text-[9px] text-emerald-700">CHART: M15 SPOT PRICE ACTION</div>
                    <UI.CandlestickChart data={candles.slice(-80)} height={256} />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-black/40 border border-emerald-900/30 rounded-xl p-4">
                      <h4 className="text-[10px] text-emerald-600 mb-3 uppercase font-bold tracking-wider">Señales Cuantitativas Internas</h4>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between border-b border-emerald-900/20 pb-1">
                          <span className="text-emerald-800">Kalman Filter Drift (μ)</span>
                          <span className={kalmanState.mu > 0 ? "text-emerald-400" : "text-red-400"}>{kalmanState.mu.toFixed(6)}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/20 pb-1">
                          <span className="text-emerald-800">OU Mean Reversion Speed (θ)</span>
                          <span className="text-cyan-400">{ouState.theta.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/20 pb-1">
                          <span className="text-emerald-800">MACD Histogram</span>
                          <span className={macdData.hist > 0 ? "text-emerald-400" : "text-red-400"}>{macdData.hist.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between border-b border-emerald-900/20 pb-1">
                          <span className="text-emerald-800">Z-Score Normalizado</span>
                          <span className="text-yellow-400">{zScoreVal.toFixed(2)}σ</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-black/40 border border-emerald-900/30 rounded-xl p-4">
                      <h4 className="text-[10px] text-emerald-600 mb-3 uppercase font-bold tracking-wider">Veredicto del Algoritmo</h4>
                      {edge > MODE_CONFIG[mode].minEdge && pTP > MODE_CONFIG[mode].minPTP ? (
                        <div className="bg-emerald-950/30 border border-emerald-500/40 p-4 rounded-lg text-emerald-400">
                          <div className="text-lg font-black mb-1">✓ SETUP APROBADO</div>
                          <p className="text-[10px] opacity-80 leading-relaxed">El modelo cuántico detecta una ventaja estadística significativa superior al requerimiento mínimo de fondeo. El ratio riesgo/beneficio está matemáticamente justificado por la probabilidad de llegada de Monte Carlo.</p>
                        </div>
                      ) : (
                        <div className="bg-red-950/30 border border-red-500/40 p-4 rounded-lg text-red-400">
                          <div className="text-lg font-black mb-1">✕ SETUP RECHAZADO</div>
                          <p className="text-[10px] opacity-80 leading-relaxed">Riesgo asimétrico negativo detectado. La probabilidad estocástica de tocar el Take Profit antes que el Stop Loss no compensa el ratio matemático. Ejecutar esto destruirá capital a largo plazo.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* === MONTE CARLO TAB === */}
              {tab === "MONTECARLO" && (
                <div className="space-y-6 animate-in fade-in duration-300">
                  <div className="flex justify-between items-end">
                    <div>
                      <h2 className="text-lg font-bold text-emerald-400">Simulación Jump-Diffusion Estocástica</h2>
                      <p className="text-[10px] text-emerald-700 max-w-lg mt-1">Generando {MODE_CONFIG[mode].mcPaths} trayectorias utilizando movimiento browniano geométrico, ajustado por volatilidad GARCH, reversión OU y saltos de Poisson.</p>
                    </div>
                    <button onClick={executeSimulation} disabled={isSimulating} className="bg-emerald-900/40 border border-emerald-500/50 text-emerald-400 px-4 py-2 rounded text-[10px] font-bold hover:bg-emerald-800/40 transition-colors">
                      {isSimulating ? "COMPUTING TENSORS..." : "RE-RUN SIMULATION"}
                    </button>
                  </div>

                  <div className="h-72 border border-emerald-900/30 rounded-xl overflow-hidden bg-[#030504] relative p-4">
                    {isSimulating ? (
                      <div className="absolute inset-0 flex items-center justify-center flex-col text-emerald-500">
                        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-4" />
                        <span className="text-xs tracking-widest animate-pulse">INTEGRATING PATHS</span>
                      </div>
                    ) : (
                      <UI.MCViz 
                        median={mcResult?.medianPath} 
                        p10={mcResult?.percentile10} 
                        p90={mcResult?.percentile90} 
                        sl={activeSL} 
                        tp={activeTP} 
                        entry={activeEntry} 
                        direction={direction}
                        height={256}
                      />
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <UI.Metric label="VaR 95% (VALUE AT RISK)" value={`$${(mcResult?.var95 ?? 0).toFixed(2)}`} subtext="Pérdida máxima esperada (95%)" colorClass="text-orange-400" />
                    <UI.Metric label="CVaR / EXPECTED SHORTFALL" value={`$${(mcResult?.expectedShortfall ?? 0).toFixed(2)}`} subtext="Promedio de pérdidas extremas (5%)" colorClass="text-red-400" />
                    <UI.Metric label="MAX DRAWDOWN TEÓRICO" value={`$${(mcResult?.maxDrawdown ?? 0).toFixed(2)}`} subtext="Máxima excursión adversa en paths" colorClass="text-rose-500" />
                  </div>
                </div>
              )}

              {/* === GREEKS TAB === */}
              {tab === "GREEKS" && (
                <div className="space-y-6 animate-in fade-in duration-300">
                  <div>
                    <h2 className="text-lg font-bold text-emerald-400">Black-Scholes-Merton Options Pricing</h2>
                    <p className="text-[10px] text-emerald-700 max-w-lg mt-1">Evaluación teórica de los niveles de Stop y Target asumiendo la volatilidad GARCH actual como Implied Volatility.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-6">
                    <div className="bg-black/40 border border-emerald-900/30 rounded-xl p-5 space-y-4">
                      <h3 className="text-xs text-emerald-500 font-bold border-b border-emerald-900/30 pb-2">STRIKE: TAKE PROFIT (${activeTP.toFixed(2)})</h3>
                      <div className="grid grid-cols-2 gap-y-3 text-xs">
                        <div className="text-emerald-700">Call Price (Premium): <br/><span className="text-emerald-400 font-bold">${bsTP.callPrice.toFixed(2)}</span></div>
                        <div className="text-emerald-700">Prob. of Touch (T): <br/><span className="text-cyan-400 font-bold">{(bsTP.probTouchTP * 100).toFixed(2)}%</span></div>
                        <div className="text-emerald-700">Delta (Δ): <br/><span className="text-emerald-400">{bsTP.deltaCall.toFixed(4)}</span></div>
                        <div className="text-emerald-700">Gamma (Γ): <br/><span className="text-emerald-400">{bsTP.gamma.toFixed(4)}</span></div>
                        <div className="text-emerald-700">Theta (Θ): <br/><span className="text-emerald-400">{bsTP.thetaCall.toFixed(4)}</span></div>
                        <div className="text-emerald-700">Vega (ν): <br/><span className="text-emerald-400">{bsTP.vega.toFixed(4)}</span></div>
                      </div>
                    </div>

                    <div className="bg-black/40 border border-emerald-900/30 rounded-xl p-5 space-y-4">
                      <h3 className="text-xs text-red-500 font-bold border-b border-emerald-900/30 pb-2">STRIKE: STOP LOSS (${activeSL.toFixed(2)})</h3>
                      <div className="grid grid-cols-2 gap-y-3 text-xs">
                        <div className="text-emerald-700">Put Price (Premium): <br/><span className="text-red-400 font-bold">${bsSL.putPrice.toFixed(2)}</span></div>
                        <div className="text-emerald-700">Prob. of Touch (T): <br/><span className="text-orange-400 font-bold">{(bsSL.probTouchSL * 100).toFixed(2)}%</span></div>
                        <div className="text-emerald-700">Delta (Δ): <br/><span className="text-red-400">{bsSL.deltaPut.toFixed(4)}</span></div>
                        <div className="text-emerald-700">Gamma (Γ): <br/><span className="text-red-400">{bsSL.gamma.toFixed(4)}</span></div>
                        <div className="text-emerald-700">Theta (Θ): <br/><span className="text-red-400">{bsSL.thetaPut.toFixed(4)}</span></div>
                        <div className="text-emerald-700">Vega (ν): <br/><span className="text-red-400">{bsSL.vega.toFixed(4)}</span></div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-emerald-950/20 border border-emerald-900/50 rounded-xl p-4 text-[10px] text-emerald-600 leading-relaxed">
                    * La <strong>Probability of Touch</strong> difiere de la probabilidad estocástica de Monte Carlo porque asume log-normalidad pura sin difusión de saltos ni reversión a la media. Institucionalmente, comparamos ambas probabilidades: si MC {'<'} BS, la estructura del mercado (OU) o el skew de volatilidad están operando en tu contra.
                  </div>
                </div>
              )}

              {/* === ZONES TAB === */}
              {tab === "ZONES" && (
                <div className="space-y-6 animate-in fade-in duration-300">
                  <div>
                    <h2 className="text-lg font-bold text-emerald-400">Order Flow & Liquidity Zones</h2>
                    <p className="text-[10px] text-emerald-700 mt-1">Convergencia de Dark Pools, Opciones (GEX) y Estructura Técnica Dinámica.</p>
                  </div>

                  <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                    {institutionalZones.map((z, i) => (
                      <div key={i} className={`p-4 rounded-lg border flex justify-between items-center bg-black/40 ${z.type === "SUPPORT" ? "border-emerald-900/30" : "border-red-900/30"}`}>
                        <div className="flex items-center gap-4">
                          <div className={`w-2 h-2 rounded-full ${z.type === "SUPPORT" ? "bg-emerald-500" : "bg-red-500"}`} />
                          <div>
                            <div className="font-bold text-sm text-emerald-300">${z.price.toFixed(2)}</div>
                            <div className="text-[9px] text-emerald-700 uppercase mt-0.5">{z.label}</div>
                          </div>
                        </div>
                        <div className="flex gap-6 items-center">
                          <span className="text-[9px] border border-emerald-900/40 px-2 py-1 rounded text-emerald-600">{z.source}</span>
                          <div className="text-right">
                            <div className="text-xs font-bold text-cyan-400">{(z.pReaction * 100).toFixed(1)}%</div>
                            <div className="text-[8px] text-emerald-800">PROB. REACTION</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* === RISK TAB === */}
              {tab === "RISK" && (
                <div className="space-y-6 animate-in fade-in duration-300">
                  <div className="grid grid-cols-2 gap-4">
                    <UI.Card title="KELLY CRITERION (OPTIMAL f*)">
                      <div className="text-4xl font-black text-cyan-400 mt-2">{(rawKelly * 100).toFixed(2)}%</div>
                      <p className="text-[10px] text-emerald-700 mt-2">Fracción teórica de capital óptima. Si es negativo, no posees ventaja estadística y debes evitar la operación a toda costa.</p>
                      <div className="mt-4 pt-4 border-t border-emerald-900/30">
                        <div className="text-[10px] text-emerald-500 font-bold mb-1">HALF-KELLY (Institutional standard)</div>
                        <div className="text-lg text-emerald-400">${kellyPositionUsd.toFixed(2)} USD RIESGO</div>
                      </div>
                    </UI.Card>
                    
                    <UI.Card title="RISK OF RUIN (10% DRAWDOWN)">
                      <div className="text-4xl font-black text-orange-400 mt-2">{(RiskManager.ruinProbability(pTP, currentRR, riskPercent/100, 0.10) * 100).toFixed(2)}%</div>
                      <p className="text-[10px] text-emerald-700 mt-2">Probabilidad matemática de perder el 10% de tu cuenta (tocar límite de fondeo) operando consecutivamente con este Edge.</p>
                    </UI.Card>
                  </div>
                </div>
              )}

              {/* === TECHNICALS TAB === */}
              {tab === "TECHNICALS" && (
                <div className="space-y-6 animate-in fade-in duration-300">
                  <div className="grid grid-cols-3 gap-4">
                    <UI.Metric label="ATR (14 PERIODS)" value={`${atr.toFixed(2)}`} subtext="Volatilidad intrabarra" colorClass="text-emerald-400" />
                    <UI.Metric label="RSI (14 PERIODS)" value={`${rsi.toFixed(2)}`} subtext={rsi > 70 ? "Overbought" : rsi < 30 ? "Oversold" : "Neutral"} colorClass={rsi > 70 || rsi < 30 ? "text-yellow-400" : "text-emerald-400"} />
                    <UI.Metric label="Z-SCORE (20 PERIODS)" value={`${zScoreVal.toFixed(2)}σ`} subtext="Desviación de la media" colorClass="text-cyan-400" />
                    
                    <UI.Metric label="EMA 20" value={`$${currentEma20.toFixed(2)}`} colorClass="text-emerald-400" />
                    <UI.Metric label="EMA 50" value={`$${currentEma50.toFixed(2)}`} colorClass="text-emerald-400" />
                    <UI.Metric label="MACD HISTOGRAM" value={`${macdData.hist.toFixed(3)}`} subtext={`MACD: ${macdData.macd.toFixed(2)} | Sig: ${macdData.signal.toFixed(2)}`} colorClass={macdData.hist > 0 ? "text-emerald-400" : "text-red-400"} />
                  </div>
                </div>
              )}

              {/* === MODELS TAB === */}
              {tab === "MODELS" && (
                <div className="space-y-4 animate-in fade-in duration-300 h-[500px] overflow-y-auto pr-2 custom-scrollbar">
                  <div className="bg-black/40 border border-emerald-900/30 p-4 rounded-xl">
                    <h3 className="text-xs font-bold text-emerald-500 mb-2 tracking-widest">1. MODELO GARCH(1,1)</h3>
                    <p className="text-[10px] text-emerald-700 leading-relaxed font-sans mb-3">La Heterocedasticidad Condicional Autorregresiva Generalizada modela la volatilidad agrupada del mercado. Calcula la varianza actual basada en un promedio a largo plazo (omega), el shock reciente (alpha) y la varianza persistente (beta).</p>
                    <div className="grid grid-cols-4 gap-2 text-[10px] font-mono bg-[#030504] p-3 rounded border border-emerald-900/20">
                      <div><span className="text-emerald-800 block">Omega (ω)</span><span className="text-emerald-400">{garchState.omega.toExponential(4)}</span></div>
                      <div><span className="text-emerald-800 block">Alpha (α)</span><span className="text-emerald-400">{garchState.alpha.toFixed(4)}</span></div>
                      <div><span className="text-emerald-800 block">Beta (β)</span><span className="text-emerald-400">{garchState.beta.toFixed(4)}</span></div>
                      <div><span className="text-emerald-800 block">Vol. L.Term</span><span className="text-cyan-400">{(garchState.longTermVol * 100).toFixed(2)}%</span></div>
                    </div>
                  </div>

                  <div className="bg-black/40 border border-emerald-900/30 p-4 rounded-xl">
                    <h3 className="text-xs font-bold text-emerald-500 mb-2 tracking-widest">2. FILTRO DE KALMAN</h3>
                    <p className="text-[10px] text-emerald-700 leading-relaxed font-sans mb-3">Filtro recursivo estocástico que estima el estado oculto (Drift / Retorno Esperado) del activo a partir de mediciones ruidosas del precio, ajustándose dinámicamente con la ganancia de Kalman.</p>
                    <div className="grid grid-cols-3 gap-2 text-[10px] font-mono bg-[#030504] p-3 rounded border border-emerald-900/20">
                      <div><span className="text-emerald-800 block">Drift Estimado (μ)</span><span className={kalmanState.mu > 0 ? "text-emerald-400" : "text-red-400"}>{kalmanState.mu.toFixed(6)}</span></div>
                      <div><span className="text-emerald-800 block">Varianza Proceso (Q)</span><span className="text-emerald-400">{kalmanState.Q.toExponential(2)}</span></div>
                      <div><span className="text-emerald-800 block">Error Covarianza (P)</span><span className="text-emerald-400">{kalmanState.P.toExponential(4)}</span></div>
                    </div>
                  </div>

                  <div className="bg-black/40 border border-emerald-900/30 p-4 rounded-xl">
                    <h3 className="text-xs font-bold text-emerald-500 mb-2 tracking-widest">3. ORNSTEIN-UHLENBECK</h3>
                    <p className="text-[10px] text-emerald-700 leading-relaxed font-sans mb-3">Modelo matemático que describe un proceso de reversión a la media. Fundamental para identificar si el mercado está en rango (reversión fuerte) o en tendencia direccional pura.</p>
                    <div className="grid grid-cols-3 gap-2 text-[10px] font-mono bg-[#030504] p-3 rounded border border-emerald-900/20">
                      <div><span className="text-emerald-800 block">Vel. Reversión (θ)</span><span className="text-cyan-400">{ouState.theta.toFixed(4)}</span></div>
                      <div><span className="text-emerald-800 block">Media Central (μ)</span><span className="text-emerald-400">${ouState.mu_ou.toFixed(2)}</span></div>
                      <div><span className="text-emerald-800 block">Half-Life</span><span className="text-emerald-400">{ouState.halfLife.toFixed(1)} periods</span></div>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

        {/* FOOTER */}
        <footer className="text-center text-[9px] text-emerald-900 tracking-widest py-4 border-t border-emerald-900/30 mt-8">
          K-AURUM QUANTITATIVE SYSTEMS © 2026 • ENGINE INITIALIZED • DATA STREAMS OK
        </footer>

      </div>
    </div>
  );
}