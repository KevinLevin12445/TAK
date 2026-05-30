import {
  useState, useEffect, useRef, useCallback,
  WheelEvent, MouseEvent as RMouseEvent, TouchEvent
} from "react";

// ═══════════════════════════════════════════════════════════════════════
//  PRO ATAS HEATMAP v4 — imagen 2 style
//  · Colorscale: negro→azul→cian→naranja→rojo→blanco (ATAS pro)
//  · Zonas de Pivote PP / R1-R3 / S1-S3
//  · Follow-price real (ajusta X automáticamente en cada fetch)
//  · Candlestick overlay sobre heatmap
//  · Vol profile con gradiente percentil (rojo=alto, azul=bajo)
//  · HVN / LVN detectados y marcados
//  · Auto-refresh cada 30s
// ═══════════════════════════════════════════════════════════════════════

interface HeatmapData {
  matrix: number[][];
  priceBins: number[];
  times: string[];
  prices: number[];
  volProfile: number[];
  poc: number; vah: number; val: number; nom: number;
  buyPressure: number[][];
  sellPressure: number[][];
  minP: number; maxP: number;
  bins: number; binSize: number;
  // Pivotes — opcionales (si el backend los devuelve)
  pp?: number; r1?: number; r2?: number; r3?: number;
  s1?: number; s2?: number; s3?: number;
}

interface Transform { x: number; y: number; scale: number; }

interface Candle { ti: number; open: number; high: number; low: number; close: number; }

const PERIOD_OPTIONS = [
  { label: "1H",  value: "1d",  interval: "1m"  },
  { label: "4H",  value: "1d",  interval: "5m"  },
  { label: "1D",  value: "2d",  interval: "5m"  },
  { label: "5D",  value: "5d",  interval: "15m" },
  { label: "1W",  value: "7d",  interval: "30m" },
  { label: "1M",  value: "1mo", interval: "1h"  },
  { label: "3M",  value: "3mo", interval: "1d"  },
];

// ── Canvas layout ──────────────────────────────────────────────────────
const CW_BASE = 14;
const CH_BASE = 8;
const MR      = 78;   // right margin (price axis)
const ML      = 0;
const MB      = 30;   // bottom margin (time axis)
const MT      = 8;    // top margin
const PROF_W  = 100;  // vol profile panel width

// ── Color scales ──────────────────────────────────────────────────────

// ATAS pro: negro → azul oscuro → azul → cian → naranja → rojo → blanco
const HEAT_STOPS: [number, [number,number,number,number]][] = [
  [0.00, [0,   0,   0,   0  ]],
  [0.06, [1,   10,  32,  0.05]],
  [0.14, [2,   24,  64,  0.15]],
  [0.25, [4,   40,  112, 0.30]],
  [0.38, [8,   72,  168, 0.50]],
  [0.52, [16,  112, 208, 0.68]],
  [0.64, [24,  160, 232, 0.80]],
  [0.75, [48,  200, 240, 0.88]],
  [0.85, [255, 102, 0,   0.92]],
  [0.93, [255, 34,  0,   0.97]],
  [1.00, [255, 255, 255, 1.00]],
];

function heatRGBA(t: number): string {
  t = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < HEAT_STOPS.length - 2 && HEAT_STOPS[i + 1][0] <= t) i++;
  const [t0, c0] = HEAT_STOPS[i];
  const [t1, c1] = HEAT_STOPS[i + 1];
  const s = (t - t0) / (t1 - t0);
  const r = Math.round(c0[0] + s * (c1[0] - c0[0]));
  const g = Math.round(c0[1] + s * (c1[1] - c0[1]));
  const b = Math.round(c0[2] + s * (c1[2] - c0[2]));
  const a = +(c0[3] + s * (c1[3] - c0[3])).toFixed(3);
  return `rgba(${r},${g},${b},${a})`;
}

function profileColor(v: number): string {
  // v in [0,1]: azul oscuro→cian→amarillo→naranja→rojo
  if (v >= 0.85) return "rgba(255,60,0,0.97)";
  if (v >= 0.65) return "rgba(255,180,0,0.92)";
  if (v >= 0.40) return "rgba(0,210,230,0.85)";
  if (v >= 0.20) return "rgba(0,120,200,0.78)";
  return "rgba(0,40,110,0.65)";
}

// ── Pivote clásico calculado en front (fallback si backend no lo devuelve) ──
function computePivots(prices: number[], nPeriods = 5) {
  if (prices.length < 10) return null;
  const chunk = Math.max(1, Math.floor(prices.length / nPeriods));
  const Hs: number[] = [], Ls: number[] = [], Cs: number[] = [];
  for (let i = 0; i < nPeriods; i++) {
    const sl = prices.slice(i * chunk, (i + 1) * chunk);
    if (!sl.length) continue;
    Hs.push(Math.max(...sl));
    Ls.push(Math.min(...sl));
    Cs.push(sl[sl.length - 1]);
  }
  const H = Hs.reduce((a, b) => a + b, 0) / Hs.length;
  const L = Ls.reduce((a, b) => a + b, 0) / Ls.length;
  const C = Cs.reduce((a, b) => a + b, 0) / Cs.length;
  const PP = (H + L + C) / 3;
  return {
    pp: PP,
    r1: 2 * PP - L,   r2: PP + (H - L),   r3: H + 2 * (PP - L),
    s1: 2 * PP - H,   s2: PP - (H - L),   s3: L - 2 * (H - PP),
  };
}

// ── Candles agregados desde prices[] ──────────────────────────────────
function buildCandles(prices: number[], nCandles = 50): Candle[] {
  const n = prices.length;
  if (n < 4) return [];
  const chunk = Math.max(1, Math.floor(n / nCandles));
  const out: Candle[] = [];
  for (let i = 0; i < n; i += chunk) {
    const sl = prices.slice(i, i + chunk);
    if (!sl.length) continue;
    out.push({
      ti:    Math.min(i + chunk - 1, n - 1),
      open:  sl[0],
      high:  Math.max(...sl),
      low:   Math.min(...sl),
      close: sl[sl.length - 1],
    });
  }
  return out;
}

// ── HVN / LVN ─────────────────────────────────────────────────────────
function detectPeaksValleys(vp: number[]): { hvn: number[]; lvn: number[] } {
  const hvn: number[] = [], lvn: number[] = [];
  const max = Math.max(...vp, 1);
  for (let i = 1; i < vp.length - 1; i++) {
    if (vp[i] > vp[i-1] && vp[i] > vp[i+1] && vp[i] / max > 0.12) hvn.push(i);
    if (vp[i] < vp[i-1] && vp[i] < vp[i+1] && vp[i] / max < 0.25) lvn.push(i);
  }
  return { hvn: hvn.slice(0, 6), lvn: lvn.slice(0, 4) };
}

// ── Rounded rect helper ───────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─────────────────────────────────────────────────────────────────────

export function HeatmapTab() {
  const [bins, setBins]           = useState(60);
  const [window_, setWindow]      = useState(20);
  const [periodIdx, setPeriodIdx] = useState(4);
  const [showPivots, setShowPivots] = useState(true);
  const [followPrice, setFollowPrice] = useState(true);
  const [data, setData]           = useState<HeatmapData | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [tfm, setTfm]             = useState<Transform>({ x: 0, y: 0, scale: 1 });

  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const profileRef = useRef<HTMLCanvasElement>(null);
  const dragging   = useRef(false);
  const lastPt     = useRef({ x: 0, y: 0 });
  const pinchDist  = useRef<number | null>(null);
  const autoTimer  = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedPeriod = PERIOD_OPTIONS[periodIdx];

  // ── Fetch ─────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(
        `/api/gold/order-flow?bins=${bins}&window=${window_}&period=${selectedPeriod.value}&interval=${selectedPeriod.interval}`
      );
      if (!res.ok) throw new Error("fetch failed");
      const raw = await res.json();

      const buyPressure: number[][] = raw.matrix.map((row: number[]) =>
        row.map((v: number) => v * (0.30 + Math.random() * 0.50))
      );
      const sellPressure: number[][] = raw.matrix.map((_: number[], bi: number) =>
        raw.matrix[bi].map((v: number, ti: number) => Math.max(0, v - buyPressure[bi][ti]))
      );
      setData({ ...raw, buyPressure, sellPressure });
    } catch {
      setError("Error al cargar datos. Reintenta.");
    } finally {
      setLoading(false);
    }
  }, [bins, window_, selectedPeriod.value, selectedPeriod.interval]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh cada 30 segundos
  useEffect(() => {
    autoTimer.current = setInterval(fetchData, 30_000);
    return () => { if (autoTimer.current) clearInterval(autoTimer.current); };
  }, [fetchData]);

  // ── Follow price: mueve X para que el último bar quede al 78% ────
  useEffect(() => {
    if (!followPrice || !data || !canvasRef.current) return;
    const W    = canvasRef.current.width;
    const cw   = CW_BASE * tfm.scale;
    const nTime = data.times.length;
    const targetX = (W - MR - PROF_W) * 0.78 - (nTime - 0.5) * cw;
    setTfm(t => ({ ...t, x: targetX }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, followPrice]);

  // ── Main canvas draw ──────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const chartW = W - MR;   // chart area width (profile drawn separately)
    const { x, y, scale } = tfm;
    const cw    = CW_BASE * scale;
    const ch    = CH_BASE * scale;
    const nTime = data.times.length;
    const nBin  = data.bins;
    const baseY = H - MB + y;

    // Derived data
    const pivots = data.pp
      ? { pp: data.pp, r1: data.r1!, r2: data.r2!, r3: data.r3!, s1: data.s1!, s2: data.s2!, s3: data.s3! }
      : computePivots(data.prices);
    const candles = buildCandles(data.prices, 60);
    const { hvn, lvn } = detectPeaksValleys(data.volProfile);

    // ── Background ──────────────────────────────────────────────────
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    // Max density
    let maxD = 0.001;
    for (let bi = 0; bi < nBin; bi++)
      for (let ti = 0; ti < nTime; ti++) {
        const d = data.matrix[bi]?.[ti] ?? 0;
        if (d > maxD) maxD = d;
      }

    // ── Clip: chart area ────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(ML, MT, chartW - ML, H - MT - MB);
    ctx.clip();

    // ── 1. HEATMAP CELLS (ATAS colorscale) ──────────────────────────
    for (let ti = 0; ti < nTime; ti++) {
      const cx = x + ti * cw;
      if (cx + cw < ML || cx > chartW) continue;
      for (let bi = 0; bi < nBin; bi++) {
        const cy = baseY - (bi + 1) * ch;
        if (cy + ch < MT || cy > H - MB) continue;
        const t = Math.min(1, (data.matrix[bi]?.[ti] ?? 0) / maxD);
        if (t < 0.018) continue;
        ctx.fillStyle = heatRGBA(t);
        ctx.fillRect(cx, cy, cw + 0.6, ch + 0.6);
      }
    }

    // ── 2. PIVOT ZONES ───────────────────────────────────────────────
    if (showPivots && pivots) {
      const priceY = (p: number) => {
        const bi = Math.min(nBin - 1, Math.max(0, Math.floor((p - data.minP) / data.binSize)));
        return baseY - (bi + 0.5) * ch;
      };

      // Zona S1→R1 sombreada
      const yR1 = priceY(pivots.r1), yS1 = priceY(pivots.s1);
      ctx.fillStyle = "rgba(0,238,255,0.03)";
      ctx.fillRect(ML, Math.min(yR1, yS1), chartW - ML, Math.abs(yR1 - yS1));

      // PP
      const yPP = priceY(pivots.pp);
      ctx.strokeStyle = "#00eeff";
      ctx.lineWidth = 1.8;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(ML, yPP); ctx.lineTo(chartW, yPP); ctx.stroke();
      ctx.font = "bold 8px 'Courier New',monospace";
      ctx.fillStyle = "#00eeff";
      const ppLbl = `PP $${pivots.pp.toFixed(0)}`;
      const ppW = ctx.measureText(ppLbl).width + 8;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      roundRect(ctx, ML + 4, yPP - 7, ppW, 13, 2); ctx.fill();
      ctx.fillStyle = "#00eeff";
      ctx.fillText(ppLbl, ML + 8, yPP + 4);

      // R1-R3
      [[pivots.r1,"R1"],[pivots.r2,"R2"],[pivots.r3,"R3"]].forEach(([lv, lbl], i) => {
        const ly = priceY(lv as number);
        if (ly < MT || ly > H - MB) return;
        ctx.strokeStyle = `rgba(255,${60 - i*15},${60 - i*15},${0.75 - i*0.15})`;
        ctx.lineWidth = 1.2 - i * 0.2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(ML, ly); ctx.lineTo(chartW, ly); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(0,0,0,0.82)";
        const rl = `${lbl} $${(lv as number).toFixed(0)}`;
        const rw = ctx.measureText(rl).width + 6;
        roundRect(ctx, chartW * 0.6, ly - 6, rw, 12, 2); ctx.fill();
        ctx.fillStyle = `rgba(255,${80 - i*20},80,0.95)`;
        ctx.font = `bold 8px 'Courier New',monospace`;
        ctx.fillText(rl, chartW * 0.6 + 3, ly + 4);
      });

      // S1-S3
      [[pivots.s1,"S1"],[pivots.s2,"S2"],[pivots.s3,"S3"]].forEach(([lv, lbl], i) => {
        const ly = priceY(lv as number);
        if (ly < MT || ly > H - MB) return;
        ctx.strokeStyle = `rgba(${60 - i*15},${120 - i*20},255,${0.75 - i*0.15})`;
        ctx.lineWidth = 1.2 - i * 0.2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(ML, ly); ctx.lineTo(chartW, ly); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(0,0,0,0.82)";
        const sl = `${lbl} $${(lv as number).toFixed(0)}`;
        const sw = ctx.measureText(sl).width + 6;
        roundRect(ctx, chartW * 0.6, ly - 6, sw, 12, 2); ctx.fill();
        ctx.fillStyle = `rgba(68,${170 - i*30},255,0.95)`;
        ctx.font = `bold 8px 'Courier New',monospace`;
        ctx.fillText(sl, chartW * 0.6 + 3, ly + 4);
      });
    }

    // ── 3. HVN / LVN ────────────────────────────────────────────────
    const priceYbi = (bi: number) => baseY - (bi + 0.5) * ch;

    hvn.forEach(bi => {
      const ly = priceYbi(bi);
      if (ly < MT || ly > H - MB) return;
      ctx.strokeStyle = "rgba(255,238,0,0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(ML, ly); ctx.lineTo(chartW, ly); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,238,0,0.08)";
      ctx.fillRect(ML, ly - ch * 0.8, chartW - ML, ch * 1.6);
    });

    lvn.forEach(bi => {
      const ly = priceYbi(bi);
      if (ly < MT || ly > H - MB) return;
      ctx.strokeStyle = "rgba(255,68,136,0.35)";
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(ML, ly); ctx.lineTo(chartW, ly); ctx.stroke();
      ctx.setLineDash([]);
    });

    // ── 4. GRID (muy tenue) ──────────────────────────────────────────
    ctx.strokeStyle = "rgba(255,255,255,0.018)";
    ctx.lineWidth = 0.5;
    const tGrid = Math.max(1, Math.ceil(10 / cw));
    for (let ti = 0; ti <= nTime; ti += tGrid) {
      const gx = x + ti * cw;
      ctx.beginPath(); ctx.moveTo(gx, MT); ctx.lineTo(gx, H - MB); ctx.stroke();
    }
    const bGrid = Math.max(1, Math.ceil(6 / ch));
    for (let bi = 0; bi <= nBin; bi += bGrid) {
      const gy = baseY - bi * ch;
      ctx.beginPath(); ctx.moveTo(ML, gy); ctx.lineTo(chartW, gy); ctx.stroke();
    }

    // ── 5. CANDLESTICKS ─────────────────────────────────────────────
    candles.forEach(c => {
      const cx = x + c.ti * cw + cw * 0.5;
      if (cx < ML - 20 || cx > chartW + 20) return;
      const hiY  = baseY - ((c.high  - data.minP) / data.binSize) * ch;
      const loY  = baseY - ((c.low   - data.minP) / data.binSize) * ch;
      const opY  = baseY - ((c.open  - data.minP) / data.binSize) * ch;
      const clY  = baseY - ((c.close - data.minP) / data.binSize) * ch;
      const bull = c.close >= c.open;
      const bodyColor = bull ? "rgba(0,220,80,0.82)"  : "rgba(255,50,50,0.82)";
      const wickColor = bull ? "rgba(0,200,60,0.70)"  : "rgba(230,40,40,0.70)";
      const bodyW = Math.max(1.5, cw * 0.55);

      ctx.strokeStyle = wickColor;
      ctx.lineWidth   = 0.8;
      ctx.beginPath();
      ctx.moveTo(cx, hiY); ctx.lineTo(cx, loY);
      ctx.stroke();

      ctx.fillStyle = bodyColor;
      const bodyTop = Math.min(opY, clY);
      const bodyH   = Math.max(1, Math.abs(opY - clY));
      ctx.fillRect(cx - bodyW / 2, bodyTop, bodyW, bodyH);
    });

    ctx.restore(); // end chart clip

    // ── 6. PRICE LINE (blanco/gold suave) ───────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(ML, MT, chartW - ML, H - MT - MB);
    ctx.clip();

    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth   = Math.max(1.5, 1.8 * scale);
    ctx.lineJoin    = "round";
    ctx.shadowColor = "rgba(255,255,255,0.3)";
    ctx.shadowBlur  = 3;
    ctx.beginPath();
    let started = false;
    for (let ti = 0; ti < nTime; ti++) {
      const px    = x + ti * cw + cw * 0.5;
      if (px < ML - 4 || px > chartW + 4) { started = false; continue; }
      const price = data.prices[ti] ?? data.nom;
      const py    = baseY - ((price - data.minP) / data.binSize) * ch;
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    // ── 7. KEY LEVELS (POC, VAH, VAL) ───────────────────────────────
    const levelY = (p: number) => {
      const bi = Math.min(nBin - 1, Math.max(0, Math.floor((p - data.minP) / data.binSize)));
      return baseY - (bi + 0.5) * ch;
    };

    [
      { price: data.poc, color: "#ff8c00", label: "POC", dash: [] as number[] },
      { price: data.vah, color: "#ffd700", label: "VAH", dash: [7, 4] },
      { price: data.val, color: "#ffd700", label: "VAL", dash: [7, 4] },
    ].forEach(({ price, color, label, dash }) => {
      const ly = levelY(price);
      if (ly < MT || ly > H - MB) return;
      ctx.save();
      ctx.strokeStyle = color + "aa";
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(ML, ly); ctx.lineTo(chartW, ly); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // Badge
      ctx.font = "bold 9px 'Courier New',monospace";
      const lbl = `${label} $${price.toFixed(0)}`;
      const tw  = ctx.measureText(lbl).width + 8;
      ctx.fillStyle = "rgba(0,0,0,0.88)";
      roundRect(ctx, chartW + 2, ly - 8, tw, 15, 2); ctx.fill();
      ctx.strokeStyle = color + "66"; ctx.lineWidth = 0.8;
      roundRect(ctx, chartW + 2, ly - 8, tw, 15, 2); ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(lbl, chartW + 6, ly + 4);
    });

    // ── 8. CURRENT PRICE (NOW marker) ────────────────────────────────
    const cpY = levelY(data.nom);
    if (cpY >= MT && cpY <= H - MB) {
      ctx.strokeStyle = "#00ff41";
      ctx.lineWidth   = 1.8;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(ML, cpY); ctx.lineTo(chartW, cpY); ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = "bold 10px 'Courier New',monospace";
      const pStr = `$${data.nom.toFixed(2)}`;
      const pw   = ctx.measureText(pStr).width + 12;
      ctx.fillStyle = "#00ff41";
      roundRect(ctx, chartW + 2, cpY - 9, pw, 18, 3); ctx.fill();
      ctx.fillStyle = "#000000";
      ctx.fillText(pStr, chartW + 7, cpY + 5);

      // flecha
      ctx.fillStyle = "#00ff41";
      ctx.beginPath();
      ctx.moveTo(chartW - 1, cpY - 5);
      ctx.lineTo(chartW - 1, cpY + 5);
      ctx.lineTo(chartW + 6, cpY);
      ctx.closePath(); ctx.fill();
    }

    // ── 9. PRICE AXIS (right, en chartW area) ────────────────────────
    ctx.fillStyle = "#334455";
    ctx.font = "8px 'Courier New',monospace";
    const priceStep = Math.max(1, Math.ceil(24 / ch));
    for (let bi = 0; bi < nBin; bi += priceStep) {
      const py = baseY - (bi + 0.5) * ch;
      if (py < MT || py > H - MB) continue;
      ctx.fillText(`$${data.priceBins[bi].toFixed(0)}`, chartW + 4, py + 3);
    }

    // ── 10. TIME AXIS (bottom) ────────────────────────────────────────
    ctx.fillStyle = "#334455";
    ctx.font = "8px 'Courier New',monospace";
    const tStep = Math.max(1, Math.ceil(40 / cw));
    for (let ti = 0; ti < nTime; ti += tStep) {
      const tx = x + ti * cw;
      if (tx < ML || tx > chartW - 20) continue;
      const d   = new Date(data.times[ti]);
      const lbl = `${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
      ctx.fillText(lbl, tx, H - MB + 14);
    }

  }, [data, tfm, showPivots]);

  // ── Volume profile canvas ─────────────────────────────────────────
  const drawProfile = useCallback(() => {
    const canvas = profileRef.current;
    if (!canvas || !data) return;
    const ctx  = canvas.getContext("2d")!;
    const W    = canvas.width, H = canvas.height;
    const nBin = data.bins;
    const maxV = Math.max(...data.volProfile, 1);
    const barH = (H - MB - MT) / nBin;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    for (let bi = 0; bi < nBin; bi++) {
      const v  = data.volProfile[bi] ?? 0;
      const vn = v / maxV;
      const bw = vn * (W - 4);
      const by = H - MB - (bi + 1) * barH;

      const grad = ctx.createLinearGradient(0, 0, bw, 0);
      grad.addColorStop(0, profileColor(vn));
      grad.addColorStop(1, profileColor(vn).replace(/[\d.]+\)$/, "0.3)"));
      ctx.fillStyle = grad;
      ctx.fillRect(2, by + 0.5, bw, barH - 0.8);

      // bright edge for high-vol bars
      if (vn > 0.7) {
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(bw, by + 0.5, 2, barH - 0.8);
      }
    }

    // POC line
    const pocBi = Math.max(0, Math.min(nBin - 1, Math.floor((data.poc - data.minP) / data.binSize)));
    const pocY  = H - MB - (pocBi + 0.5) * barH;
    ctx.strokeStyle = "#ff8c00"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, pocY); ctx.lineTo(W, pocY); ctx.stroke();

    // VAH / VAL lines
    const vahBi = Math.max(0, Math.min(nBin - 1, Math.floor((data.vah - data.minP) / data.binSize)));
    const valBi = Math.max(0, Math.min(nBin - 1, Math.floor((data.val - data.minP) / data.binSize)));
    ctx.strokeStyle = "#ffd70066"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    [vahBi, valBi].forEach(bii => {
      const ly = H - MB - (bii + 0.5) * barH;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke();
    });
    ctx.setLineDash([]);

    // header
    ctx.fillStyle = "#223344";
    ctx.font = "bold 7px 'Courier New',monospace";
    ctx.fillText("VOL PROFILE", 3, MT + 8);
  }, [data]);

  useEffect(() => { draw(); },        [draw]);
  useEffect(() => { drawProfile(); }, [drawProfile]);

  // ── Interactions ──────────────────────────────────────────────────
  const onWheel = useCallback((e: WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (followPrice) setFollowPrice(false);
    const f = e.deltaY < 0 ? 1.12 : 0.89;
    setTfm(t => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { ...t, scale: Math.min(8, Math.max(0.15, t.scale * f)) };
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const ns = Math.min(8, Math.max(0.15, t.scale * f));
      return { scale: ns, x: mx - (mx - t.x) * (ns / t.scale), y: my - (my - t.y) * (ns / t.scale) };
    });
  }, [followPrice]);

  const onMouseDown = useCallback((e: RMouseEvent<HTMLCanvasElement>) => {
    dragging.current = true;
    lastPt.current   = { x: e.clientX, y: e.clientY };
    if (followPrice) setFollowPrice(false);
  }, [followPrice]);

  const onMouseMove = useCallback((e: RMouseEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPt.current.x, dy = e.clientY - lastPt.current.y;
    lastPt.current = { x: e.clientX, y: e.clientY };
    setTfm(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
  }, []);

  const onMouseUp = useCallback(() => { dragging.current = false; }, []);

  const onTouchStart = useCallback((e: TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      dragging.current = true;
      lastPt.current   = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (followPrice) setFollowPrice(false);
    } else if (e.touches.length === 2) {
      pinchDist.current = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, [followPrice]);

  const onTouchMove = useCallback((e: TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.touches.length === 1 && dragging.current) {
      const dx = e.touches[0].clientX - lastPt.current.x;
      const dy = e.touches[0].clientY - lastPt.current.y;
      lastPt.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setTfm(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
    } else if (e.touches.length === 2 && pinchDist.current !== null) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const f = d / pinchDist.current; pinchDist.current = d;
      setTfm(t => ({ ...t, scale: Math.min(8, Math.max(0.15, t.scale * f)) }));
    }
  }, []);

  const onTouchEnd = useCallback(() => { dragging.current = false; pinchDist.current = null; }, []);

  const resetView = useCallback(() => {
    setTfm({ x: 0, y: 0, scale: 1 });
    setFollowPrice(true);
  }, []);

  // ── Pivotes calculados para infobar ───────────────────────────────
  const pivots = data
    ? (data.pp ? { pp: data.pp, r1: data.r1!, s1: data.s1! } : computePivots(data.prices))
    : null;

  // ── Styles ────────────────────────────────────────────────────────
  const S: Record<string, React.CSSProperties> = {
    root: {
      display: "flex", flexDirection: "column",
      background: "#000000", fontFamily: "'Courier New',monospace",
      border: "1px solid #0a1520", borderRadius: 4,
      overflow: "hidden", userSelect: "none",
    },
    topbar: {
      display: "flex", alignItems: "center", gap: 6, padding: "6px 10px",
      background: "#030810", borderBottom: "1px solid #0a1520", flexWrap: "wrap" as const,
    },
    title: { fontSize: 11, fontWeight: 700, color: "#00ff41", letterSpacing: "0.10em", flex: 1 },
    infobar: {
      display: "flex", alignItems: "center", padding: "4px 10px", gap: 0,
      background: "#020608", borderBottom: "1px solid #0a1520", flexWrap: "wrap" as const,
    },
    ctrl: {
      display: "flex", alignItems: "center", gap: 16, padding: "4px 10px",
      background: "#020608", borderBottom: "1px solid #0a1520", flexWrap: "wrap" as const,
    },
    canvasWrap: { display: "flex", flex: 1, background: "#000" },
    legend: {
      display: "flex", alignItems: "center", gap: 14, padding: "4px 10px",
      background: "#020608", borderTop: "1px solid #0a1520", flexWrap: "wrap" as const,
    },
  };

  const btnBase: React.CSSProperties = {
    fontSize: 9, padding: "2px 7px", borderRadius: 2,
    cursor: "pointer", transition: "all .12s", border: "1px solid #0a1520",
    background: "transparent", color: "#223344",
  };

  return (
    <div style={S.root}>

      {/* ── Topbar ── */}
      <div style={S.topbar}>
        <span style={S.title}>▶ ORDER FLOW HEATMAP — ATAS</span>

        {/* Period selector */}
        <div style={{ display: "flex", gap: 2 }}>
          {PERIOD_OPTIONS.map((p, i) => (
            <button key={p.label} onClick={() => setPeriodIdx(i)} style={{
              ...btnBase,
              border: `1px solid ${i === periodIdx ? "#00ff41" : "#0a1520"}`,
              background: i === periodIdx ? "rgba(0,255,65,0.10)" : "transparent",
              color: i === periodIdx ? "#00ff41" : "#334455",
            }}>{p.label}</button>
          ))}
        </div>

        {/* Pivots toggle */}
        <button onClick={() => setShowPivots(v => !v)} style={{
          ...btnBase,
          border: `1px solid ${showPivots ? "#00eeff" : "#0a1520"}`,
          background: showPivots ? "rgba(0,238,255,0.08)" : "transparent",
          color: showPivots ? "#00eeff" : "#334455",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          <span style={{ fontSize: 7 }}>◈</span> PIVOTES
        </button>

        {/* Follow price */}
        <button onClick={() => setFollowPrice(v => !v)} style={{
          ...btnBase,
          border: `1px solid ${followPrice ? "#00ff41" : "#0a1520"}`,
          background: followPrice ? "rgba(0,255,65,0.08)" : "transparent",
          color: followPrice ? "#00ff41" : "#334455",
          display: "flex", alignItems: "center", gap: 4,
        }}>
          <span style={{ fontSize: 7 }}>●</span> SEGUIR PRECIO
        </button>

        {/* Refresh */}
        <button onClick={fetchData} disabled={loading} style={{
          ...btnBase, fontSize: 14, padding: "0px 7px",
          border: "1px solid #0a1520",
          color: loading ? "#223344" : "#00ff41",
          opacity: loading ? 0.5 : 1,
        }}>{loading ? "…" : "↻"}</button>
      </div>

      {/* ── Infobar ── */}
      {data && (
        <div style={S.infobar}>
          {[
            { lbl: "POC",    val: `$${data.poc.toFixed(0)}`, col: "#ff8c00" },
            { lbl: "VAH",    val: `$${data.vah.toFixed(0)}`, col: "#ffd700" },
            { lbl: "VAL",    val: `$${data.val.toFixed(0)}`, col: "#ffd700" },
            { lbl: "NOW",    val: `$${data.nom.toFixed(2)}`, col: "#00ff41" },
            ...(showPivots && pivots ? [
              { lbl: "PP",   val: `$${pivots.pp.toFixed(0)}`, col: "#00eeff" },
              { lbl: "R1",   val: `$${pivots.r1.toFixed(0)}`, col: "#ff3c3c" },
              { lbl: "S1",   val: `$${pivots.s1.toFixed(0)}`, col: "#44aaff" },
            ] : []),
          ].map(({ lbl, val, col }, i, arr) => (
            <div key={lbl} style={{
              display: "flex", alignItems: "center", gap: 4,
              padding: "0 8px",
              borderRight: i < arr.length - 1 ? "1px solid #0a1520" : "none",
            }}>
              <span style={{ fontSize: 8, color: "#223344", letterSpacing: "0.05em" }}>{lbl}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: col }}>{val}</span>
            </div>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 8, color: "#0e1e2a" }}>
            scroll=zoom · drag=pan · auto 30s
          </span>
        </div>
      )}

      {/* ── Controls ── */}
      <div style={S.ctrl}>
        {[
          { lbl: "Bins", min: 30, max: 100, val: bins,    set: setBins   },
          { lbl: "Ventana", min: 1, max: 60,  val: window_, set: setWindow },
        ].map(({ lbl, min, max, val, set }) => (
          <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 8, color: "#223344" }}>{lbl}</span>
            <input type="range" min={min} max={max} value={val}
              onChange={e => set(+e.target.value)}
              style={{ width: 80, accentColor: "#00ff41", cursor: "pointer" }} />
            <span style={{ fontSize: 9, color: "#00ff41", minWidth: 22 }}>{val}</span>
          </div>
        ))}

        <button onClick={resetView} style={{
          marginLeft: "auto", ...btnBase, color: "#223344",
        }}>⊙ RESET</button>
      </div>

      {/* ── Loading / error ── */}
      {loading && (
        <div style={{ padding: 60, textAlign: "center", color: "#00ff41", fontSize: 11 }}>
          CARGANDO DATOS <span style={{ animation: "blink 1s step-end infinite" }}>█</span>
        </div>
      )}
      {error && (
        <div style={{ padding: 20, textAlign: "center", color: "#ff3c3c", fontSize: 10 }}>{error}</div>
      )}

      {/* ── Canvases ── */}
      {!loading && !error && data && (
        <div style={S.canvasWrap}>
          {/* Main heatmap */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <canvas ref={canvasRef} width={1200} height={520}
              style={{ width: "100%", height: 520, display: "block", cursor: "crosshair" }}
              onWheel={onWheel}
              onMouseDown={onMouseDown} onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}    onMouseLeave={onMouseUp}
              onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            />
          </div>
          {/* Vol profile */}
          <div style={{ width: PROF_W, flexShrink: 0, borderLeft: "1px solid #0a1520" }}>
            <canvas ref={profileRef} width={PROF_W} height={520}
              style={{ width: PROF_W, height: 520, display: "block" }} />
          </div>
        </div>
      )}

      {/* ── Legend ── */}
      <div style={S.legend}>
        {[
          { col: "#ff8c00", lbl: "POC"     },
          { col: "#ffd700", lbl: "VAH/VAL" },
          { col: "#00ff41", lbl: "NOW"     },
          { col: "#00eeff", lbl: "PP"      },
          { col: "#ff3c3c", lbl: "R1-R3"   },
          { col: "#44aaff", lbl: "S1-S3"   },
          { col: "#ffee00", lbl: "HVN"     },
          { col: "#ff4488", lbl: "LVN"     },
          { col: "rgba(0,220,80,0.82)",  lbl: "Alza"  },
          { col: "rgba(255,50,50,0.82)", lbl: "Baja"  },
        ].map(({ col, lbl }) => (
          <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: col, display: "inline-block", flexShrink: 0,
            }} />
            <span style={{ fontSize: 8, color: "#223344" }}>{lbl}</span>
          </div>
        ))}
      </div>

    </div>
  );
}