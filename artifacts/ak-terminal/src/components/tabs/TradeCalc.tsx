import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGetGoldPrice,
  useGetGoldHistory,
} from "@workspace/api-client-react";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type Mode      = "SCALP" | "INTRADAY" | "SWING";
type Direction = "LONG"  | "SHORT";
type CalcMode  = "AUTO"  | "MANUAL";
type Regime    = "TRENDING" | "RANGING" | "VOLATILE" | "LOW_VOL";
type Signal    = "LONG" | "SHORT" | "NO TRADE";
type Tab       = "OVERVIEW" | "PEM" | "FPT" | "RISK";

interface Candle {
  open?: number; o?: number;
  high?: number; h?: number;
  low?:  number; l?: number;
  close?: number; c?: number;
  volume?: number; vol?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const MODE_CFG = {
  SCALP:    { atrSL: 1.0, atrTP: 1.8, bePct: 0.40, minRR: 1.2, label: "1–5 min"   },
  INTRADAY: { atrSL: 1.8, atrTP: 3.2, bePct: 0.40, minRR: 1.8, label: "15–60 min" },
  SWING:    { atrSL: 2.5, atrTP: 5.0, bePct: 0.45, minRR: 2.5, label: "4h–1d"     },
} as const;

// PEM weights
const PEM_W = {
  ALPHA_MR: 0.40, ALPHA_MIC: 0.45, ALPHA_FAC: 0.15,
  W_Z20: 0.30, W_Z60: 0.25, W_STOCH: 0.25, W_AM5: 0.10, W_AM15: 0.10,
  W_OFI: 0.70, W_VWAP: 0.30,
  W_CARRY: 0.35, W_YIELD: 0.40, W_RSI: 0.25,
  K: 3.0,
};

// ─────────────────────────────────────────────────────────────────────────────
// MATH / INDICATORS
// ─────────────────────────────────────────────────────────────────────────────

const clamp   = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function calcEMA(data: number[], period: number): number[] {
  if (!data.length) return [];
  const k = 2 / (period + 1);
  const out = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 1;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = candles[i].high   ?? candles[i].h  ?? 0;
    const l  = candles[i].low    ?? candles[i].l  ?? 0;
    const pc = candles[i - 1].close ?? candles[i - 1].c ?? 0;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const sl = trs.slice(-period);
  return sl.reduce((a, b) => a + b, 0) / sl.length || 1;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const sl = closes.slice(-period - 1);
  let g = 0, l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    d >= 0 ? (g += d) : (l += Math.abs(d));
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function calcStoch(candles: Candle[], period = 14): number {
  if (candles.length < period) return 0.5;
  const sl = candles.slice(-period);
  const h  = Math.max(...sl.map((c) => c.high ?? c.h ?? 0));
  const l  = Math.min(...sl.map((c) => c.low  ?? c.l ?? 0));
  const cl = candles.at(-1)?.close ?? candles.at(-1)?.c ?? 0;
  return h === l ? 0.5 : (cl - l) / (h - l);
}

function calcZScore(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const sl = closes.slice(-period);
  const mu = sl.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(sl.map((x) => (x - mu) ** 2).reduce((a, b) => a + b, 0) / period);
  return sd === 0 ? 0 : (closes.at(-1)! - mu) / sd;
}

function calcVWAPDev(candles: Candle[], period = 20): number {
  if (candles.length < period) return 0;
  const sl = candles.slice(-period);
  let cv = 0, ct = 0;
  for (const c of sl) {
    const h = c.high ?? c.h ?? 0, lo = c.low ?? c.l ?? 0, cl = c.close ?? c.c ?? 0;
    const v = c.volume ?? c.vol ?? 1;
    cv += v; ct += ((h + lo + cl) / 3) * v;
  }
  const vwap = cv > 0 ? ct / cv : 0;
  const cl_  = candles.at(-1)?.close ?? candles.at(-1)?.c ?? vwap;
  const vals  = sl.map((c) => c.close ?? c.c ?? 0);
  const mu   = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd   = Math.sqrt(vals.map((x) => (x - mu) ** 2).reduce((a, b) => a + b, 0) / vals.length);
  return sd === 0 ? 0 : clamp((cl_ - vwap) / sd, -3, 3) / 3;
}

function calcOFI(candles: Candle[], period = 10): number {
  if (candles.length < period) return 0;
  const sl = candles.slice(-period);
  let buy = 0, sell = 0;
  for (const c of sl) {
    const o = c.open ?? c.o ?? 0, cl = c.close ?? c.c ?? 0, v = c.volume ?? c.vol ?? 1;
    cl >= o ? (buy += v) : (sell += v);
  }
  const t = buy + sell;
  return t === 0 ? 0 : clamp((buy - sell) / t, -1, 1);
}

function calcCarry(closes: number[], ATR: number): number {
  if (closes.length < 50 || ATR === 0) return 0;
  const e20 = calcEMA(closes, 20).at(-1)!;
  const e50 = calcEMA(closes, 50).at(-1)!;
  return clamp((e20 - e50) / ATR, -3, 3) / 3;
}

function calcYield(closes: number[], ATR: number): number {
  if (closes.length < 6 || ATR === 0) return 0;
  return clamp((closes.at(-1)! - closes.at(-6)!) / ATR, -3, 3) / 3;
}

function calcAnomaly(closes: number[], period: number, ATR: number): number {
  if (closes.length < period || ATR === 0) return 0;
  const e = calcEMA(closes, period).at(-1)!;
  return clamp((closes.at(-1)! - e) / ATR, -3, 3) / 3;
}

function calcOUTheta(closes: number[], period = 20): number {
  if (closes.length < period) return 0;
  const sl = closes.slice(-period);
  const mu = sl.reduce((a, b) => a + b, 0) / period;
  const d  = sl.map((x) => x - mu);
  let cov = 0, varx = 0;
  for (let i = 0; i < d.length - 1; i++) {
    cov  += d[i] * d[i + 1];
    varx += d[i] ** 2;
  }
  if (varx === 0) return 0;
  return clamp(-Math.log(Math.abs(cov / varx)), 0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// PEM — Probabilistic Edge Model (from HTML formulas)
// ─────────────────────────────────────────────────────────────────────────────

interface PEMOut {
  sMR: number; sMIC: number; sFAC: number;
  cas: number; pLong: number; pShort: number; signal: Signal;
}

function computePEM(
  z20: number, z60: number, sto: number, am5: number, am15: number,
  OFI: number, vwap: number, carry: number, yld: number, RSI: number
): PEMOut {
  const rn   = RSI / 100;
  const sMR  = PEM_W.W_Z20 * (-z20) + PEM_W.W_Z60 * (-z60) + PEM_W.W_STOCH * (0.5 - sto)
             + PEM_W.W_AM5 * (-am5) + PEM_W.W_AM15 * (-am15);
  const sMIC = PEM_W.W_OFI * OFI + PEM_W.W_VWAP * vwap;
  const sFAC = PEM_W.W_CARRY * (-carry) + PEM_W.W_YIELD * (-yld) + PEM_W.W_RSI * (rn - 0.5);
  const cas  = PEM_W.ALPHA_MR * sMR + PEM_W.ALPHA_MIC * sMIC + PEM_W.ALPHA_FAC * sFAC;
  const pL   = sigmoid(PEM_W.K * cas);
  return {
    sMR, sMIC, sFAC, cas, pLong: pL, pShort: 1 - pL,
    signal: pL > 0.65 ? "LONG" : pL < 0.35 ? "SHORT" : "NO TRADE",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRST PASSAGE TIME (two-barrier GBM, Harrison 1985)
// ─────────────────────────────────────────────────────────────────────────────

interface FPTOut {
  pTP: number; pSL: number; pBE: number;
  ev: number; rr: number; minWR: number; kelly: number;
}

function computeFPT(tpDist: number, slDist: number, beDist: number,
  mu: number, sigma: number, sign: 1 | -1): FPTOut {
  const a  = Math.abs(tpDist);
  const b  = Math.abs(slDist);
  const be = Math.abs(beDist);
  const muA = sign * (mu - sigma * sigma / 2);
  const theta = sigma * sigma > 0 ? 2 * muA / (sigma * sigma) : 0;

  let pTP: number, pSL: number, pBE: number;

  if (Math.abs(theta) < 0.001 || !isFinite(theta) || a + b === 0) {
    pTP = b > 0 ? b / (a + b) : 0.5;
    pSL = a > 0 ? a / (a + b) : 0.5;
    pBE = be > 0 && be < a ? b / (be + b) : be >= a ? pTP : 0;
  } else {
    const ea = Math.exp(theta * a);
    const eb = Math.exp(-theta * b);
    const D  = ea - eb;
    pTP = D !== 0 ? (1 - eb) / D : 0.5;
    pSL = D !== 0 ? (ea - 1) / D : 0.5;
    if (be > 0 && be < a) {
      const ebe = Math.exp(theta * be);
      const Db  = ebe - eb;
      pBE = Db !== 0 ? (1 - eb) / Db : 0.5;
    } else {
      pBE = be >= a ? pTP : 0;
    }
  }

  pTP = clamp(pTP, 0, 1);
  pSL = clamp(pSL, 0, 1);
  pBE = clamp(pBE, 0, 1);

  const rr    = b > 0 ? a / b : 0;
  const ev    = pTP * a - pSL * b;
  const minWR = a + b > 0 ? b / (a + b) : 0;
  const kelly = rr > 0 ? pTP - pSL / rr : 0;
  return { pTP, pSL, pBE, ev, rr, minWR, kelly };
}

const kellyFrac = (p: number, rr: number, f = 0.25) =>
  Math.max(0, (p - (1 - p) / Math.max(rr, 0.001)) * f);

// ─────────────────────────────────────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg0: "#050608", bg1: "#080b10", bg2: "#0d1118", bg3: "#111620",
  border: "#18202e", border2: "#1e2a3c",
  accent: "#00d4ff", green: "#00e87a", red: "#ff2d55",
  yellow: "#ffc020", purple: "#9b70ff", teal: "#00ccaa",
  muted: "#2d3d52", dim: "#111820",
  text: "#b8cce0", sub: "#4a6080", label: "#364a62",
} as const;

const MONO = "'IBM Plex Mono','Fira Code',monospace";

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const PHead = ({ left, right }: { left: string; right?: string }) => (
  <div style={{
    background: C.bg2, borderBottom: `1px solid ${C.border}`,
    padding: "4px 10px", fontSize: 9, color: C.sub, letterSpacing: "0.12em",
    display: "flex", justifyContent: "space-between",
  }}>
    <span>{left}</span>
    {right && <span style={{ color: C.label }}>{right}</span>}
  </div>
);

const Row = ({ label, val, vc }: { label: string; val: string; vc?: string }) => (
  <div style={{
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "4px 10px", borderBottom: `1px solid ${C.dim}`,
  }}>
    <span style={{ fontSize: 9, color: C.sub, letterSpacing: "0.08em" }}>{label}</span>
    <span style={{ fontSize: 11, fontWeight: 500, color: vc ?? C.text }}>{val}</span>
  </div>
);

const Cell = ({
  label, val, vc, sub, span = 1,
}: { label: string; val: string; vc?: string; sub?: string; span?: number }) => (
  <div style={{
    background: C.bg2, padding: "8px 10px",
    borderRight: `1px solid ${C.dim}`, borderBottom: `1px solid ${C.dim}`,
    gridColumn: span > 1 ? `span ${span}` : undefined,
  }}>
    <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.1em", marginBottom: 3 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 500, color: vc ?? C.text }}>{val}</div>
    {sub && <div style={{ fontSize: 9, color: C.label, marginTop: 2 }}>{sub}</div>}
  </div>
);

const Btn = ({
  label, active, onClick, ac,
}: { label: string; active: boolean; onClick: () => void; ac?: string }) => (
  <button onClick={onClick} style={{
    fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em",
    padding: "5px 0", cursor: "pointer", width: "100%",
    background: active ? (ac ?? C.accent) + "18" : "transparent",
    color: active ? (ac ?? C.accent) : C.sub,
    border: `1px solid ${active ? (ac ?? C.accent) + "66" : C.border}`,
    borderRadius: 2, outline: "none",
    transition: "all 0.1s",
  }}>
    {label}
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

export function TradeCalc() {

  // API
  const { data: priceData }   = useGetGoldPrice();
  const { data: historyData } = useGetGoldHistory({ interval: "15m", period: "7d" });

  const livePrice: number  = priceData?.price ?? 4500;
  const candles: Candle[]  = historyData?.candles ?? [];
  const closes = useMemo(() => candles.map((c) => c.close ?? c.c ?? 0), [candles]);

  // State
  const [mode,     setMode]     = useState<Mode>("INTRADAY");
  const [calcMode, setCalcMode] = useState<CalcMode>("AUTO");
  const [dir,      setDir]      = useState<Direction>("LONG");
  const [capital,  setCapital]  = useState(10000);
  const [riskPct,  setRiskPct]  = useState(1);
  const [entry,    setEntry]    = useState(livePrice);
  const [sl,       setSL]       = useState(livePrice - 20);
  const [tp,       setTP]       = useState(livePrice + 36);
  const [be,       setBE]       = useState(livePrice + 14);
  const [tab,      setTab]      = useState<Tab>("OVERVIEW");

  const cfg = MODE_CFG[mode];

  // Indicators
  const ATR14 = useMemo(() => calcATR(candles, 14),    [candles]);
  const ATR50 = useMemo(() => calcATR(candles, 50),    [candles]);
  const RSI14 = useMemo(() => calcRSI(closes, 14),     [closes]);
  const STOCH = useMemo(() => calcStoch(candles, 14),  [candles]);
  const Z20   = useMemo(() => calcZScore(closes, 20),  [closes]);
  const Z60   = useMemo(() => calcZScore(closes, 60),  [closes]);
  const VWAPD = useMemo(() => calcVWAPDev(candles, 20),[candles]);
  const OFI   = useMemo(() => calcOFI(candles, 10),   [candles]);
  const CARRY = useMemo(() => calcCarry(closes, ATR14),[closes, ATR14]);
  const YIELD = useMemo(() => calcYield(closes, ATR14),[closes, ATR14]);
  const AM5   = useMemo(() => calcAnomaly(closes, 5,  ATR14), [closes, ATR14]);
  const AM15  = useMemo(() => calcAnomaly(closes, 15, ATR14), [closes, ATR14]);
  const THETA = useMemo(() => calcOUTheta(closes, 20), [closes]);

  const EMA20L = useMemo(() => calcEMA(closes, 20).at(-1) ?? livePrice, [closes, livePrice]);
  const EMA50L = useMemo(() => calcEMA(closes, 50).at(-1) ?? livePrice, [closes, livePrice]);
  const volExp   = ATR50 > 0 ? ATR14 / ATR50 : 1;
  const trendStr = ATR14 > 0 ? Math.abs(EMA20L - EMA50L) / ATR14 : 0;
  const bull     = EMA20L > EMA50L;

  const regime: Regime =
    volExp > 1.8       ? "VOLATILE" :
    ATR14 < ATR50*0.75 ? "LOW_VOL"  :
    trendStr < 0.3     ? "RANGING"  : "TRENDING";

  // Auto levels
  useEffect(() => {
    if (calcMode !== "AUTO") return;
    const sign = dir === "LONG" ? 1 : -1;
    const slD  = +(ATR14 * cfg.atrSL).toFixed(2);
    const tpD  = +(ATR14 * cfg.atrTP).toFixed(2);
    const beD  = +(tpD * cfg.bePct).toFixed(2);
    setEntry(+livePrice.toFixed(2));
    setSL(  +(livePrice - sign * slD).toFixed(2));
    setTP(  +(livePrice + sign * tpD).toFixed(2));
    setBE(  +(livePrice + sign * beD).toFixed(2));
  }, [calcMode, ATR14, dir, cfg, livePrice]);

  // Distances
  const slD = +Math.abs(entry - sl).toFixed(2);
  const tpD = +Math.abs(tp - entry).toFixed(2);
  const beD = +Math.abs(be - entry).toFixed(2);
  const beValid = dir === "LONG"
    ? be > entry && be < tp
    : be < entry && be > tp;

  // PEM
  const pem = useMemo(() => computePEM(Z20, Z60, STOCH, AM5, AM15, OFI, VWAPD, CARRY, YIELD, RSI14),
    [Z20, Z60, STOCH, AM5, AM15, OFI, VWAPD, CARRY, YIELD, RSI14]);

  // FPT
  const mu_d  = pem.cas * 0.002;
  const sig_d = ATR14 > 0 ? ATR14 / Math.max(livePrice, 1) : 0.008;
  const fpt   = useMemo(() => computeFPT(tpD, slD, beD, mu_d, sig_d, dir === "LONG" ? 1 : -1),
    [tpD, slD, beD, mu_d, sig_d, dir]);

  // Sizing
  const riskUSD  = capital * (riskPct / 100);
  const fixedSz  = slD > 0 ? riskUSD / slD : 0;
  const kellyF   = kellyFrac(fpt.pTP, fpt.rr, 0.25);
  const kellyUSD = capital * kellyF;

  // Verdict
  const ctrTrend   = (dir === "LONG" && !bull) || (dir === "SHORT" && bull);
  const confidence = clamp(sigmoid(pem.cas * PEM_W.K * 0.9) * 100, 1, 99);
  const noTrade    = regime === "RANGING" || regime === "LOW_VOL" || fpt.ev <= 0 || fpt.rr < cfg.minRR;
  const verdict    = noTrade ? "NO TRADE" : confidence > 72 ? "HIGH CONF" : confidence > 52 ? "VALID" : "MARGINAL";

  // Clock
  const [tick, setTick] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setTick(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Formatters
  const f2  = (n: number) => n.toFixed(2);
  const f3  = (n: number) => n.toFixed(3);
  const f4  = (n: number) => n.toFixed(4);
  const fp  = (n: number) => `${(n * 100).toFixed(1)}%`;
  const fpm = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  const col = (n: number) => n > 0 ? C.green : n < 0 ? C.red : C.text;

  const verdictCol  = verdict === "NO TRADE" ? C.red : verdict === "HIGH CONF" ? C.green : verdict === "VALID" ? C.accent : C.yellow;
  const signalCol   = pem.signal === "LONG" ? C.green : pem.signal === "SHORT" ? C.red : C.yellow;
  const regimeColor: Record<Regime, string> = { TRENDING: C.green, RANGING: C.yellow, VOLATILE: C.red, LOW_VOL: C.muted };

  // ── TAB NAV ──────────────────────────────────────────────────────────────

  const NavBtn = ({ id, lbl }: { id: Tab; lbl: string }) => (
    <button onClick={() => setTab(id)} style={{
      fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", padding: "7px 18px",
      cursor: "pointer", background: tab === id ? C.bg2 : "transparent",
      color: tab === id ? C.accent : C.sub,
      border: "none", borderRight: `1px solid ${C.border}`,
      borderBottom: `2px solid ${tab === id ? C.accent : "transparent"}`,
      outline: "none", transition: "all 0.12s",
    }}>{lbl}</button>
  );

  // ── SIDEBAR ───────────────────────────────────────────────────────────────

  const sidebar = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: 210, flexShrink: 0 }}>

      {/* Calc mode */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3 }}>
        <PHead left="CALC MODE" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, padding: 8 }}>
          <Btn label="AUTO"   active={calcMode === "AUTO"}   onClick={() => setCalcMode("AUTO")} />
          <Btn label="MANUAL" active={calcMode === "MANUAL"} onClick={() => setCalcMode("MANUAL")} />
        </div>
      </div>

      {/* Timeframe */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3 }}>
        <PHead left="TIMEFRAME" right={cfg.label} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1, padding: 8 }}>
          {(["SCALP", "INTRADAY", "SWING"] as Mode[]).map((m) => (
            <Btn key={m} label={m} active={mode === m} onClick={() => setMode(m)} />
          ))}
        </div>
        <div style={{ padding: "0 10px 6px", fontSize: 9, color: C.label }}>minRR · {cfg.minRR}R</div>
      </div>

      {/* Direction */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3 }}>
        <PHead left="DIRECTION" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, padding: 8 }}>
          <Btn label="▲ LONG"  active={dir === "LONG"}  onClick={() => setDir("LONG")}  ac={C.green} />
          <Btn label="▼ SHORT" active={dir === "SHORT"} onClick={() => setDir("SHORT")} ac={C.red}   />
        </div>
      </div>

      {/* Manual levels */}
      {calcMode === "MANUAL" && (
        <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3 }}>
          <PHead left="LEVELS" />
          <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {([
              ["ENTRY",       entry, setEntry, C.text],
              ["STOP LOSS",   sl,    setSL,    C.red],
              ["TAKE PROFIT", tp,    setTP,    C.green],
              ["BREAK EVEN",  be,    setBE,    C.yellow],
            ] as [string, number, (n: number) => void, string][]).map(([lbl, val, set, vc]) => (
              <div key={lbl}>
                <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.08em", marginBottom: 3 }}>{lbl}</div>
                <input
                  type="number" value={val} step="0.01"
                  onChange={(e) => set(+e.target.value)}
                  style={{
                    background: C.bg3, border: `1px solid ${vc}44`, borderRadius: 2,
                    color: vc, fontFamily: MONO, fontSize: 12, padding: "4px 8px",
                    width: "100%", outline: "none",
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Capital */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3 }}>
        <PHead left="CAPITAL & RISK" />
        <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div>
            <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.08em", marginBottom: 3 }}>CAPITAL ($)</div>
            <input type="number" value={capital} onChange={(e) => setCapital(+e.target.value)}
              style={{ background: C.bg3, border: `1px solid ${C.border2}`, borderRadius: 2, color: C.text, fontFamily: MONO, fontSize: 12, padding: "4px 8px", width: "100%", outline: "none" }} />
          </div>
          <div>
            <div style={{ fontSize: 9, color: C.sub, letterSpacing: "0.08em", marginBottom: 3, display: "flex", justifyContent: "space-between" }}>
              <span>RISK %</span><span style={{ color: C.accent }}>{riskPct}%</span>
            </div>
            <input type="range" min={0.5} max={5} step={0.5} value={riskPct}
              onChange={(e) => setRiskPct(+e.target.value)}
              style={{ width: "100%", accentColor: C.accent }} />
          </div>
          <Row label="RISK $" val={`$${riskUSD.toFixed(0)}`} vc={C.yellow} />
        </div>
      </div>

      {/* Market state */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3 }}>
        <PHead left="MARKET STATE" />
        <Row label="REGIME"    val={regime}                  vc={regimeColor[regime]} />
        <Row label="TREND"     val={bull ? "BULLISH" : "BEARISH"} vc={bull ? C.green : C.red} />
        <Row label="VOL EXP"   val={`${f2(volExp)}×`}        vc={volExp > 1.5 ? C.red : C.text} />
        <Row label="TREND STR" val={f2(trendStr)}             vc={trendStr > 0.5 ? C.green : C.muted} />
        <Row label="CTR TREND" val={ctrTrend ? "YES" : "NO"} vc={ctrTrend ? C.red : C.green} />
        <Row label="RSI 14"    val={RSI14.toFixed(1)}         vc={RSI14 < 30 ? C.green : RSI14 > 70 ? C.red : C.text} />
        <Row label="ATR 14"    val={f2(ATR14)}                vc={C.text} />
        <Row label="OU θ"      val={THETA.toFixed(4)}         vc={col(THETA - 0.1)} />
      </div>
    </div>
  );

  // ── VERDICT BAR ──────────────────────────────────────────────────────────

  const verdictBar = (
    <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
      {/* prob gradient line */}
      <div style={{ height: 2, display: "flex" }}>
        <div style={{ width: `${(pem.pLong * 100).toFixed(1)}%`, background: C.green, transition: "width 0.4s" }} />
        <div style={{ flex: 1, background: C.red }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)" }}>
        <Cell label="VERDICT"    val={verdict}          vc={verdictCol} />
        <Cell label="PEM SIGNAL" val={pem.signal}       vc={signalCol} />
        <Cell label="P(LONG)"    val={fp(pem.pLong)}    vc={C.green}   sub="threshold 65%" />
        <Cell label="CONFIDENCE" val={`${confidence.toFixed(1)}%`} vc={C.accent} />
        <Cell label="CAS · OU θ" val={`${f4(pem.cas)} · ${THETA.toFixed(3)}`} vc={col(pem.cas)} />
      </div>
    </div>
  );

  // ── TAB: OVERVIEW ─────────────────────────────────────────────────────────

  const tabOverview = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

      {/* Levels */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left={`TRADE LEVELS · ${dir} · ${mode}`} right={cfg.label} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 1 }}>
          <Cell label="ENTRY"        val={`$${f2(entry)}`}  vc={C.text} />
          <Cell label="STOP LOSS"    val={`$${f2(sl)}`}     vc={C.red}    sub={`${f2(slD)} pts risk`} />
          <Cell label="TAKE PROFIT"  val={`$${f2(tp)}`}     vc={C.green}  sub={`${f2(tpD)} pts target`} />
          <Cell label="BREAK EVEN"   val={beValid ? `$${f2(be)}` : "— (set in manual)"} vc={beValid ? C.yellow : C.muted} sub={beValid ? `${f2(beD)} pts` : ""} />
        </div>
      </div>

      {/* FPT grid */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="FIRST PASSAGE TIME · GBM 2-BARRIER (Harrison 1985)" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 1 }}>
          <Cell label="P(TP FIRST)"  val={fp(fpt.pTP)}   vc={fpt.pTP > 0.5 ? C.green : C.red} />
          <Cell label="P(SL FIRST)"  val={fp(fpt.pSL)}   vc={fpt.pSL > 0.5 ? C.red : C.text} />
          <Cell label="P(BE FIRST)"  val={beValid ? fp(fpt.pBE) : "—"} vc={beValid ? C.yellow : C.muted} />
          <Cell label="EV (pts)"      val={f2(fpt.ev)}    vc={col(fpt.ev)}  sub={fpt.ev > 0 ? "positive edge" : "negative edge"} />
          <Cell label="R:R"           val={`1:${f2(fpt.rr)}`} vc={fpt.rr >= cfg.minRR ? C.green : C.red} sub={`min ${cfg.minRR}R`} />
          <Cell label="MIN WIN%"      val={fp(fpt.minWR)} vc={C.text} />
        </div>
      </div>

      {/* Sizing */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="POSITION SIZING · KELLY FRACTIONAL 25%" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 1 }}>
          <Cell label="FIXED SIZE"   val={`${fixedSz.toFixed(4)} oz`}      vc={C.text} sub="risk$/slDist" />
          <Cell label="KELLY RAW f*" val={fp(Math.max(0, fpt.kelly))}      vc={col(fpt.kelly)} />
          <Cell label="KELLY 25%"    val={`${(kellyF * 100).toFixed(2)}%`} vc={kellyF > 0 ? C.green : C.muted} />
          <Cell label="KELLY $"      val={`$${kellyUSD.toFixed(0)}`}        vc={kellyF > 0 ? C.green : C.muted} />
          <Cell label="RISK $"       val={`$${riskUSD.toFixed(0)}`}         vc={C.yellow} />
        </div>
      </div>

      {/* Live indicators */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="LIVE INDICATORS (CALCULATED FROM 15M CANDLES)" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 1 }}>
          <Cell label="OFI"       val={f3(OFI)}   vc={col(OFI)}   sub="order flow imbal." />
          <Cell label="VWAP DEV"  val={f3(VWAPD)} vc={col(VWAPD)} sub="norm. deviation" />
          <Cell label="Z-20"      val={f3(Z20)}   vc={col(-Z20)}  sub="rolling z-score" />
          <Cell label="Z-60"      val={f3(Z60)}   vc={col(-Z60)}  sub="rolling z-score" />
          <Cell label="STOCH %K"  val={fp(STOCH)} vc={STOCH < 0.2 ? C.green : STOCH > 0.8 ? C.red : C.text} sub="0–1 norm." />
          <Cell label="ANOM M5"   val={f4(AM5)}   vc={col(AM5)} />
          <Cell label="ANOM M15"  val={f4(AM15)}  vc={col(AM15)} />
          <Cell label="CARRY"     val={f4(CARRY)} vc={col(CARRY)} />
          <Cell label="YIELD"     val={f4(YIELD)} vc={col(YIELD)} />
          <Cell label="RSI 14"    val={RSI14.toFixed(1)} vc={RSI14 < 30 ? C.green : RSI14 > 70 ? C.red : C.text} />
        </div>
      </div>
    </div>
  );

  // ── TAB: PEM ──────────────────────────────────────────────────────────────

  const tabPEM = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="PEM — PROBABILISTIC EDGE MODEL · 3-LAYER ARCHITECTURE" />
        <div style={{ padding: "6px 12px", fontSize: 10, color: C.sub, borderBottom: `1px solid ${C.border}`, lineHeight: 1.9 }}>
          <span style={{ color: C.purple }}>CAS</span> = <span style={{ color: C.accent }}>0.40</span>·S_MR +{" "}
          <span style={{ color: C.accent }}>0.45</span>·S_MIC + <span style={{ color: C.accent }}>0.15</span>·S_FAC
          {"   →   "}
          <span style={{ color: C.green }}>P(LONG)</span> = σ(3·CAS){"   →   "}
          <span style={{ color: signalCol }}>SIGNAL: {pem.signal}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1 }}>
          {/* S_MR */}
          <div style={{ background: C.bg2, padding: "10px 12px", borderRight: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.accent, letterSpacing: "0.1em", marginBottom: 4 }}>S_MR · MEAN REVERSION (α=0.40)</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: col(pem.sMR), marginBottom: 8, fontFamily: MONO }}>{f4(pem.sMR)}</div>
            {[
              ["w=0.30 · z-score 20", -Z20,    fpm(-Z20)],
              ["w=0.25 · z-score 60", -Z60,    fpm(-Z60)],
              ["w=0.25 · stochastic", 0.5-STOCH, fpm(0.5-STOCH)],
              ["w=0.10 · anom M5",    -AM5,    fpm(-AM5)],
              ["w=0.10 · anom M15",   -AM15,   fpm(-AM15)],
            ].map(([l, v, d]) => (
              <div key={l as string} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, padding: "3px 0", borderTop: `1px solid ${C.dim}` }}>
                <span style={{ color: C.sub }}>{l as string}</span>
                <span style={{ color: col(v as number) }}>{d as string}</span>
              </div>
            ))}
          </div>
          {/* S_MIC */}
          <div style={{ background: C.bg2, padding: "10px 12px", borderRight: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 9, color: C.accent, letterSpacing: "0.1em", marginBottom: 4 }}>S_MIC · MICROSTRUCTURE (α=0.45)</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: col(pem.sMIC), marginBottom: 8, fontFamily: MONO }}>{f4(pem.sMIC)}</div>
            {[
              ["w=0.70 · OFI",      OFI,   fpm(OFI)],
              ["w=0.30 · VWAP dev", VWAPD, fpm(VWAPD)],
            ].map(([l, v, d]) => (
              <div key={l as string} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, padding: "3px 0", borderTop: `1px solid ${C.dim}` }}>
                <span style={{ color: C.sub }}>{l as string}</span>
                <span style={{ color: col(v as number) }}>{d as string}</span>
              </div>
            ))}
          </div>
          {/* S_FAC */}
          <div style={{ background: C.bg2, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: C.accent, letterSpacing: "0.1em", marginBottom: 4 }}>S_FAC · FACTOR BIAS (α=0.15)</div>
            <div style={{ fontSize: 20, fontWeight: 500, color: col(pem.sFAC), marginBottom: 8, fontFamily: MONO }}>{f4(pem.sFAC)}</div>
            {[
              ["w=0.35 · carry",  -CARRY,        fpm(-CARRY)],
              ["w=0.40 · yield",  -YIELD,        fpm(-YIELD)],
              ["w=0.25 · RSI",    RSI14/100-0.5, fpm(RSI14/100-0.5)],
            ].map(([l, v, d]) => (
              <div key={l as string} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, padding: "3px 0", borderTop: `1px solid ${C.dim}` }}>
                <span style={{ color: C.sub }}>{l as string}</span>
                <span style={{ color: col(v as number) }}>{d as string}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* P bar */}
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="PROBABILITY DISTRIBUTION · P(LONG) vs P(SHORT)" />
        <div style={{ padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 6 }}>
            <span style={{ color: C.green }}>LONG {fp(pem.pLong)}</span>
            <span style={{ color: C.sub }}>65 / 35 threshold</span>
            <span style={{ color: C.red }}>SHORT {fp(pem.pShort)}</span>
          </div>
          <div style={{ position: "relative", height: 24, background: C.dim, borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              position: "absolute", left: 0, top: 0, height: "100%",
              width: `${(pem.pLong * 100).toFixed(1)}%`,
              background: `${C.green}44`, borderRight: `2px solid ${C.green}`,
              transition: "width 0.4s",
            }} />
            <div style={{ position: "absolute", left: "65%", top: 0, height: "100%", width: 1, background: `${C.accent}88` }} />
            <div style={{ position: "absolute", left: "35%", top: 0, height: "100%", width: 1, background: `${C.red}88` }} />
            <div style={{
              position: "absolute", top: "50%", left: `${(pem.pLong * 100).toFixed(1)}%`,
              transform: "translateY(-50%)",
              width: 2, height: "80%", background: C.green,
            }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginTop: 3, color: C.label }}>
            <span>SHORT ZONE (0–35%)</span>
            <span>NO TRADE (35–65%)</span>
            <span>LONG ZONE (65–100%)</span>
          </div>
        </div>
      </div>
    </div>
  );

  // ── TAB: FPT ──────────────────────────────────────────────────────────────

  const tabFPT = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="FIRST PASSAGE TIME · GBM 2-BARRIER" />
        <div style={{ padding: "5px 12px", fontSize: 9, color: C.sub, borderBottom: `1px solid ${C.border}`, lineHeight: 1.9 }}>
          θ = 2μ̃/σ²{"  ·  "}
          P(TP) = (1 − e<sup>θb</sup>) / (e<sup>θa</sup> − e<sup>θb</sup>){"  ·  "}
          EV = P(TP)·a − P(SL)·b
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 1 }}>
          <Cell label="P(TP HIT FIRST)" val={fp(fpt.pTP)}   vc={fpt.pTP > 0.5 ? C.green : C.red}   sub="upside target" />
          <Cell label="P(SL HIT FIRST)" val={fp(fpt.pSL)}   vc={fpt.pSL > 0.5 ? C.red : C.text}    sub="stopout prob" />
          <Cell label="P(BE HIT FIRST)" val={beValid ? fp(fpt.pBE) : "— set BE in manual"} vc={beValid ? C.yellow : C.muted} />
          <Cell label="EXPECTED VALUE"   val={`${f2(fpt.ev)} pts`} vc={col(fpt.ev)} sub={fpt.ev > 0 ? "edge positive" : "edge negative"} />
          <Cell label="RISK:REWARD"      val={`1:${f2(fpt.rr)}`}  vc={fpt.rr >= cfg.minRR ? C.green : C.red} sub={`min ${cfg.minRR}R required`} />
          <Cell label="MIN WIN RATE"     val={fp(fpt.minWR)}       vc={C.text} sub="for EV breakeven" />
        </div>
      </div>

      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="DRIFT PARAMETERS" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1 }}>
          <Cell label="TP DIST" val={`${f2(tpD)} pts`}  vc={C.green} />
          <Cell label="SL DIST" val={`${f2(slD)} pts`}  vc={C.red} />
          <Cell label="BE DIST" val={beValid ? `${f2(beD)} pts` : "—"} vc={C.yellow} />
          <Cell label="DRIFT μ̃" val={`${(mu_d * 10000).toFixed(2)} bps`} vc={col(mu_d)} />
          <Cell label="σ (ATR/px)" val={`${(sig_d * 100).toFixed(3)}%`} vc={C.text} />
          <Cell label="θ (drift param)" val={(2 * mu_d / Math.max(sig_d ** 2, 1e-10)).toFixed(3)} vc={C.text} />
          <Cell label="ATR 14" val={f2(ATR14)} vc={C.text} />
          <Cell label="OU SPEED θ" val={THETA.toFixed(4)} vc={col(THETA - 0.1)} sub="AR(1) revert speed" />
        </div>
      </div>

      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="EV DECOMPOSITION" />
        <div style={{ padding: "10px 14px" }}>
          <div style={{ fontSize: 10, color: C.sub, marginBottom: 8, lineHeight: 1.8 }}>
            EV = P(TP) × TP − P(SL) × SL = {fp(fpt.pTP)} × {f2(tpD)} − {fp(fpt.pSL)} × {f2(slD)} ={"  "}
            <span style={{ color: col(fpt.ev), fontWeight: 500, fontSize: 13 }}>{f2(fpt.ev)} pts</span>
          </div>
          <div style={{ position: "relative", height: 12, background: C.dim, borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              position: "absolute", left: 0, top: 0, height: "100%",
              width: `${Math.min(100, fpt.pTP * 100).toFixed(0)}%`,
              background: fpt.ev > 0 ? `${C.green}44` : `${C.red}44`,
              transition: "width 0.3s",
            }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.label, marginTop: 4 }}>
            <span>win contribution: {f2(fpt.pTP * tpD)}</span>
            <span>loss contribution: {f2(fpt.pSL * slD)}</span>
          </div>
        </div>
      </div>
    </div>
  );

  // ── TAB: RISK ─────────────────────────────────────────────────────────────

  const tabRisk = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="KELLY CRITERION · FRACTIONAL 25%" />
        <div style={{ padding: "5px 12px", fontSize: 9, color: C.sub, borderBottom: `1px solid ${C.border}` }}>
          f* = p − (1−p)/RR{"   "}·{"   "}f_used = f* × 0.25
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1 }}>
          <Cell label="CAPITAL"      val={`$${capital.toLocaleString()}`}    vc={C.text} />
          <Cell label="RISK %"       val={`${riskPct}%`}                    vc={C.text} />
          <Cell label="RISK $"       val={`$${riskUSD.toFixed(0)}`}          vc={C.yellow} />
          <Cell label="SL DIST"      val={`${f2(slD)} pts`}                  vc={C.red} />
          <Cell label="FIXED SIZE"   val={`${fixedSz.toFixed(4)} oz`}        vc={C.text} sub="risk$/slDist" />
          <Cell label="KELLY RAW f*" val={fp(Math.max(0, fpt.kelly))}       vc={col(fpt.kelly)} sub="full kelly" />
          <Cell label="KELLY 25%"    val={`${(kellyF * 100).toFixed(2)}%`}  vc={kellyF > 0 ? C.green : C.muted} sub="fractional" />
          <Cell label="KELLY $"      val={`$${kellyUSD.toFixed(0)}`}         vc={kellyF > 0 ? C.green : C.muted} />
        </div>
      </div>

      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="ORNSTEIN-UHLENBECK PROCESS · MEAN REVERSION SPEED" />
        <div style={{ padding: "5px 12px", fontSize: 9, color: C.sub, borderBottom: `1px solid ${C.border}` }}>
          dX_t = θ(μ−X_t)dt + σdW_t{"   "}·{"   "}θ estimated via AR(1) autocorrelation (lag-1)
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1 }}>
          <Cell label="OU SPEED θ"   val={THETA.toFixed(4)} vc={col(THETA - 0.1)} sub="higher = faster revert" />
          <Cell label="Z-SCORE 20"   val={f3(Z20)}  vc={col(-Z20)} sub="oversold if < −1" />
          <Cell label="Z-SCORE 60"   val={f3(Z60)}  vc={col(-Z60)} sub="structural level" />
          <Cell label="VOL EXPANSION" val={`${f2(volExp)}×`} vc={volExp > 1.5 ? C.red : C.green} sub="atr14/atr50" />
        </div>
      </div>

      <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 3, overflow: "hidden" }}>
        <PHead left="EXECUTION PLAN" />
        {([
          ["INSTRUMENT",  "XAUUSD CFD",                            C.text],
          ["DIRECTION",   dir,                                      dir === "LONG" ? C.green : C.red],
          ["MODE",        `${mode} · ${cfg.label}`,                C.text],
          ["ENTRY",       `$${f2(entry)}`,                         C.text],
          ["STOP LOSS",   `$${f2(sl)}   (distance: ${f2(slD)})`,  C.red],
          ["TAKE PROFIT", `$${f2(tp)}   (distance: ${f2(tpD)})`,  C.green],
          ["BREAK EVEN",  beValid ? `$${f2(be)}   (${f2(beD)} pts)` : "not set (use manual mode)", beValid ? C.yellow : C.muted],
          ["R:R",         `1:${f2(fpt.rr)}   (min ${cfg.minRR}R)`, fpt.rr >= cfg.minRR ? C.green : C.red],
          ["REGIME",      regime,                                   regimeColor[regime]],
          ["CTR TREND",   ctrTrend ? "YES  ⚠" : "NO  ✓",          ctrTrend ? C.red : C.green],
          ["VERDICT",     verdict,                                   verdictCol],
        ] as [string, string, string][]).map(([l, v, vc]) => (
          <Row key={l} label={l} val={v} vc={vc} />
        ))}
      </div>
    </div>
  );

  // ── RENDER ────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }
        * { box-sizing:border-box; }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; }
        input[type=number] { -moz-appearance:textfield; }
      `}</style>

      <div style={{ fontFamily: MONO, background: C.bg0, color: C.text, fontSize: 12, lineHeight: 1.4, border: `1px solid ${C.border}`, borderRadius: 3 }}>

        {/* TOPBAR */}
        <div style={{ background: C.bg1, borderBottom: `1px solid ${C.border}`, padding: "6px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <span style={{ fontSize: 10, color: C.sub, letterSpacing: "0.15em" }}>AK-INC</span>
            <span style={{ color: C.border2 }}>│</span>
            <span style={{ fontSize: 10, color: C.accent, letterSpacing: "0.1em" }}>XAUUSD CFD</span>
            <span style={{ fontSize: 18, fontWeight: 500, color: C.text }}>${f2(livePrice)}</span>
            <span style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 2,
              color: (priceData?.change ?? 0) >= 0 ? C.green : C.red,
              background: ((priceData?.change ?? 0) >= 0 ? C.green : C.red) + "18",
              border: `1px solid ${((priceData?.change ?? 0) >= 0 ? C.green : C.red)}44`,
            }}>
              {(priceData?.change ?? 0) >= 0 ? "+" : ""}{f2(priceData?.change ?? 0)} ({f2(priceData?.changePct ?? 0)}%)
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 10, color: C.sub }}>
            <span>H {f2(priceData?.high ?? 0)}</span>
            <span>L {f2(priceData?.low  ?? 0)}</span>
            <span>ATR {f2(ATR14)}</span>
            <span>RSI {RSI14.toFixed(1)}</span>
            <span>OFI {f3(OFI)}</span>
            <span style={{ color: C.accent }}>{tick.toTimeString().slice(0, 8)}</span>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.green, display: "inline-block", animation: "pulse 1.4s infinite" }} />
          </div>
        </div>

        {/* TAB NAV */}
        <div style={{ display: "flex", background: C.bg1, borderBottom: `1px solid ${C.border}` }}>
          <NavBtn id="OVERVIEW" lbl="OVERVIEW" />
          <NavBtn id="PEM"      lbl="PEM MODEL" />
          <NavBtn id="FPT"      lbl="TP/SL PROB" />
          <NavBtn id="RISK"     lbl="RISK & SIZING" />
        </div>

        {/* BODY */}
        <div style={{ display: "flex", gap: 8, padding: 10, alignItems: "flex-start" }}>
          {sidebar}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
            {verdictBar}
            {tab === "OVERVIEW" && tabOverview}
            {tab === "PEM"      && tabPEM}
            {tab === "FPT"      && tabFPT}
            {tab === "RISK"     && tabRisk}
          </div>
        </div>

      </div>
    </>
  );
}