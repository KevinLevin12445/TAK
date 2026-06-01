import { useState, useEffect, useRef, useMemo } from "react";
import { useGetGc3d, getGetGc3dQueryKey } from "@workspace/api-client-react";
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";

// ─── Constants ────────────────────────────────────────────────────────────────
const FEATURES = [
  { key: "stoch_volatility", label: "Stoch. Volatility" },
  { key: "zscore_20",        label: "Z-Score 20" },
  { key: "zscore_60",        label: "Z-Score 60" },
  { key: "vwap_dev",         label: "VWAP Dev" },
  { key: "order_imbalance",  label: "Order Imbalance" },
  { key: "carry",            label: "Carry" },
  { key: "yield_anomaly",    label: "Yield Anomaly" },
  { key: "rsi",              label: "RSI" },
];
const PERIODS = ["1mo", "3mo", "6mo", "1y"];

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Pt3 { time: number; price: number; featureValue: number; }
interface GridData {
  grid: (number | null)[][];
  counts: number[][];
  T: number;
  F: number;
  minP: number; maxP: number;
  minF: number; maxF: number;
  tLabels: string[];
  fLabels: string[];
}
interface ProjCell {
  corners: { sx: number; sy: number }[];
  depth: number;
  val: number;
  ti: number; fi: number;
  avgPrice: number;
  avgFeature: number;
}

// ─── Jet colormap (blue→cyan→green→yellow→red) ────────────────────────────────
function jetColor(t: number, alpha = 1): string {
  const c = (x: number) => Math.max(0, Math.min(1, x));
  const r = c(1.5 - Math.abs(4 * t - 3));
  const g = c(1.5 - Math.abs(4 * t - 2));
  const b = c(1.5 - Math.abs(4 * t - 1));
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${alpha})`;
}

// ─── Build T×F grid from point cloud ──────────────────────────────────────────
function buildGrid(points: Pt3[]): GridData {
  if (!points.length) return { grid: [], counts: [], T: 0, F: 0, minP: 0, maxP: 0, minF: 0, maxF: 0, tLabels: [], fLabels: [] };
  const n = points.length;
  const T = Math.min(18, Math.max(6, Math.ceil(n / 3)));
  const F = Math.min(12, Math.max(4, Math.ceil(n / 5)));

  const sorted = [...points].sort((a, b) => a.time - b.time);
  const minT = sorted[0].time, maxT = sorted[sorted.length - 1].time;
  const prices = points.map((p) => p.price);
  const feats  = points.map((p) => p.featureValue);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const minF = Math.min(...feats),  maxF = Math.max(...feats);
  const tRange = maxT - minT || 1, fRange = maxF - minF || 1;

  const sums:   number[][] = Array.from({ length: T }, () => new Array(F).fill(0));
  const counts: number[][] = Array.from({ length: T }, () => new Array(F).fill(0));

  for (const p of sorted) {
    const ti = Math.min(T - 1, Math.floor((p.time - minT) / tRange * T));
    const fi = Math.min(F - 1, Math.floor((p.featureValue - minF) / fRange * F));
    sums[ti][fi]   += p.price;
    counts[ti][fi] += 1;
  }

  const grid: (number | null)[][] = sums.map((row, ti) =>
    row.map((s, fi) => counts[ti][fi] > 0 ? s / counts[ti][fi] : null)
  );

  // Fill nulls with bilinear neighbours
  for (let iter = 0; iter < 3; iter++) {
    for (let ti = 0; ti < T; ti++) {
      for (let fi = 0; fi < F; fi++) {
        if (grid[ti][fi] !== null) continue;
        const ns: number[] = [];
        for (const [dt, df] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,1],[-1,1],[1,-1]]) {
          const v = grid[ti + dt]?.[fi + df];
          if (v !== null && v !== undefined) ns.push(v);
        }
        if (ns.length) grid[ti][fi] = ns.reduce((a, b) => a + b) / ns.length;
      }
    }
  }

  // Labels
  const tLabels = Array.from({ length: T }, (_, i) => {
    const t = new Date(minT + (i / (T - 1)) * (maxT - minT));
    return t.toLocaleDateString([], { month: "short", day: "numeric" });
  });
  const fLabels = Array.from({ length: F }, (_, i) =>
    (minF + (i / (F - 1)) * fRange).toFixed(2)
  );

  return { grid, counts, T, F, minP, maxP, minF, maxF, tLabels, fLabels };
}

// ─── 3D orthographic projection ───────────────────────────────────────────────
function makeProject(azDeg: number, elDeg: number, scale: number, cx: number, cy: number) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const cosAz = Math.cos(az), sinAz = Math.sin(az);
  const cosEl = Math.cos(el), sinEl = Math.sin(el);

  return (x: number, y: number, z: number) => {
    // Rotate Y axis by azimuth
    const x1 = x * cosAz - z * sinAz;
    const z1 = x * sinAz + z * cosAz;
    // Rotate X axis by elevation
    const y2 = y * cosEl + z1 * sinEl;
    const z2 = -y * sinEl + z1 * cosEl;
    return { sx: cx + x1 * scale, sy: cy - y2 * scale, depth: z2 };
  };
}

// ─── Surface rendering ────────────────────────────────────────────────────────
function renderBloombergSurface(
  ctx: CanvasRenderingContext2D,
  gd: GridData,
  az: number,
  el: number,
  W: number,
  H: number
): ProjCell[] {
  const { grid, counts, T, F, minP, maxP, minF, maxF, tLabels, fLabels } = gd;
  if (!T || !F) return [];

  ctx.clearRect(0, 0, W, H);

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, "#060b14");
  bgGrad.addColorStop(1, "#000");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  const pad = { l: 90, r: 90, t: 36, b: 60 };
  const cx = pad.l + (W - pad.l - pad.r) / 2;
  const cy = pad.t + (H - pad.t - pad.b) * 0.45;
  const scale = Math.min(W - pad.l - pad.r, H - pad.t - pad.b) * 0.42;

  const proj = makeProject(az, el, scale, cx, cy);

  // ─── Floor plane ─────────────────────────────────────────────────
  ctx.fillStyle = "rgba(0,20,40,0.7)";
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 0.5;

  const floorCorners = [
    proj(0, 0, 0), proj(1, 0, 0), proj(1, 0, 1), proj(0, 0, 1),
  ];
  ctx.beginPath();
  ctx.moveTo(floorCorners[0].sx, floorCorners[0].sy);
  floorCorners.slice(1).forEach((c) => ctx.lineTo(c.sx, c.sy));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Floor grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const a = proj(t, 0, 0), b = proj(t, 0, 1);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    const c = proj(0, 0, t), d = proj(1, 0, t);
    ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.stroke();
  }

  // ─── Back walls (axis planes) ─────────────────────────────────────
  // Time-Price plane (Z=1)
  ctx.fillStyle = "rgba(0,10,25,0.5)";
  const wallT = [proj(0, 0, 1), proj(1, 0, 1), proj(1, 1, 1), proj(0, 1, 1)];
  ctx.beginPath();
  ctx.moveTo(wallT[0].sx, wallT[0].sy);
  wallT.slice(1).forEach((c) => ctx.lineTo(c.sx, c.sy));
  ctx.closePath();
  ctx.fill();

  // Feature-Price plane (X=0)
  const wallF = [proj(0, 0, 0), proj(0, 0, 1), proj(0, 1, 1), proj(0, 1, 0)];
  ctx.beginPath();
  ctx.moveTo(wallF[0].sx, wallF[0].sy);
  wallF.slice(1).forEach((c) => ctx.lineTo(c.sx, c.sy));
  ctx.closePath();
  ctx.fill();

  // Wall grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 0.4;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    // Time wall: horizontal and vertical lines
    const a = proj(t, 0, 1), b = proj(t, 1, 1);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    const c = proj(0, t, 1), d = proj(1, t, 1);
    ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.stroke();
    // Feature wall
    const e = proj(0, t, 0), f2 = proj(0, t, 1);
    ctx.beginPath(); ctx.moveTo(e.sx, e.sy); ctx.lineTo(f2.sx, f2.sy); ctx.stroke();
    const g = proj(0, 0, t), h = proj(0, 1, t);
    ctx.beginPath(); ctx.moveTo(g.sx, g.sy); ctx.lineTo(h.sx, h.sy); ctx.stroke();
  }

  // ─── Build cells list with depth sorting ─────────────────────────
  const pRange = maxP - minP || 1;
  const cells: ProjCell[] = [];

  for (let ti = 0; ti < T - 1; ti++) {
    for (let fi = 0; fi < F - 1; fi++) {
      const v00 = grid[ti]?.[fi]     ?? null;
      const v10 = grid[ti+1]?.[fi]   ?? null;
      const v11 = grid[ti+1]?.[fi+1] ?? null;
      const v01 = grid[ti]?.[fi+1]   ?? null;
      const vals = [v00, v10, v11, v01].filter((v): v is number => v !== null);
      if (!vals.length) continue;
      const avgVal = vals.reduce((a, b) => a + b) / vals.length;

      const y00 = v00 !== null ? (v00 - minP) / pRange : (avgVal - minP) / pRange;
      const y10 = v10 !== null ? (v10 - minP) / pRange : (avgVal - minP) / pRange;
      const y11 = v11 !== null ? (v11 - minP) / pRange : (avgVal - minP) / pRange;
      const y01 = v01 !== null ? (v01 - minP) / pRange : (avgVal - minP) / pRange;

      const x0 = ti / (T - 1), x1 = (ti + 1) / (T - 1);
      const z0 = fi / (F - 1), z1 = (fi + 1) / (F - 1);

      const p00 = proj(x0, y00, z0);
      const p10 = proj(x1, y10, z0);
      const p11 = proj(x1, y11, z1);
      const p01 = proj(x0, y01, z1);

      const depth = (p00.depth + p10.depth + p11.depth + p01.depth) / 4;
      const tNorm = (avgVal - minP) / pRange;

      cells.push({
        corners: [p00, p10, p11, p01],
        depth,
        val: tNorm,
        ti, fi,
        avgPrice: avgVal,
        avgFeature: minF + ((fi + 0.5) / F) * (maxF - minF),
      });
    }
  }

  // Sort back→front
  cells.sort((a, b) => b.depth - a.depth);

  // ─── Draw filled faces ─────────────────────────────────────────────
  for (const cell of cells) {
    const [c0, c1, c2, c3] = cell.corners;
    ctx.beginPath();
    ctx.moveTo(c0.sx, c0.sy);
    ctx.lineTo(c1.sx, c1.sy);
    ctx.lineTo(c2.sx, c2.sy);
    ctx.lineTo(c3.sx, c3.sy);
    ctx.closePath();
    ctx.fillStyle = jetColor(cell.val, 0.9);
    ctx.fill();
  }

  // ─── Draw white grid lines ─────────────────────────────────────────
  ctx.lineWidth = 0.6;
  for (const cell of cells) {
    const [c0, c1, c2, c3] = cell.corners;
    ctx.beginPath();
    ctx.moveTo(c0.sx, c0.sy);
    ctx.lineTo(c1.sx, c1.sy);
    ctx.lineTo(c2.sx, c2.sy);
    ctx.lineTo(c3.sx, c3.sy);
    ctx.closePath();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.stroke();
  }

  // ─── Axis lines (edges) ────────────────────────────────────────────
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  const edges: [[number,number,number],[number,number,number]][] = [
    [[0,0,0],[1,0,0]], [[0,0,0],[0,0,1]], [[0,0,0],[0,1,0]],
    [[1,0,0],[1,0,1]], [[0,0,1],[1,0,1]],
  ];
  for (const [from, to] of edges) {
    const a = proj(...from), b = proj(...to);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
  }

  // ─── Axis tick labels ─────────────────────────────────────────────
  ctx.font = "9px Space Mono";

  // X axis: time labels (along Z=0, Y=0)
  ctx.fillStyle = "#00ff4199";
  const tStep = Math.max(1, Math.floor(T / 4));
  for (let ti = 0; ti < T; ti += tStep) {
    const p = proj(ti / (T - 1), 0, 0);
    ctx.fillText(tLabels[ti] ?? "", p.sx - 14, p.sy + 14);
  }
  // X axis label
  const midX = proj(0.5, 0, 0);
  ctx.fillStyle = "#00ff41cc";
  ctx.font = "10px Space Mono";
  ctx.fillText("← DATE →", midX.sx - 25, midX.sy + 26);

  // Z axis: feature labels (along X=0, Y=0)
  ctx.font = "9px Space Mono";
  ctx.fillStyle = "#ffd70099";
  const fStep = Math.max(1, Math.floor(F / 3));
  for (let fi = 0; fi < F; fi += fStep) {
    const p = proj(0, 0, fi / (F - 1));
    ctx.fillText(fLabels[fi] ?? "", p.sx - 36, p.sy + 4);
  }
  // Z axis label
  const midZ = proj(0, 0, 0.5);
  ctx.fillStyle = "#ffd700cc";
  ctx.font = "10px Space Mono";
  ctx.fillText("← FEATURE →", midZ.sx - 46, midZ.sy + 18);

  // Y axis: price labels (along X=0, Z=0)
  ctx.fillStyle = "#00bcd499";
  ctx.font = "9px Space Mono";
  for (let yi = 0; yi <= 4; yi++) {
    const yFrac = yi / 4;
    const p = proj(0, yFrac, 0);
    const priceVal = minP + yFrac * (maxP - minP);
    ctx.fillText(`$${priceVal.toFixed(0)}`, p.sx - 52, p.sy + 3);
  }

  // ─── Bloomberg-style header ────────────────────────────────────────
  ctx.fillStyle = "#ffd700";
  ctx.font = "bold 11px Space Mono";
  ctx.fillText(`GC3D SURFACE — XAUUSD`, 8, 18);
  ctx.fillStyle = "#00ff41aa";
  ctx.font = "9px Space Mono";
  ctx.fillText(`az=${az.toFixed(0)}°  el=${el.toFixed(0)}° · drag to rotate · hover for data`, 8, 30);
  ctx.fillStyle = "#00bcd4aa";
  ctx.fillText(`${(T-1)*(F-1)} cells · ${gd.tLabels[0]} – ${gd.tLabels[T-1]}`, W - 210, 18);

  // ─── Colorbar ──────────────────────────────────────────────────────
  const cbX = W - 22, cbY = pad.t, cbH = H - pad.t - pad.b;
  for (let i = 0; i < cbH; i++) {
    const t = 1 - i / cbH;
    ctx.fillStyle = jetColor(t);
    ctx.fillRect(cbX, cbY + i, 14, 1);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(cbX, cbY, 14, cbH);
  ctx.fillStyle = "#ffffff99";
  ctx.font = "9px Space Mono";
  ctx.fillText(`$${maxP.toFixed(0)}`, cbX - 4, cbY + 9);
  ctx.fillText(`$${minP.toFixed(0)}`, cbX - 4, cbY + cbH);
  ctx.fillText(`$${((minP+maxP)/2).toFixed(0)}`, cbX - 4, cbY + cbH / 2);

  return cells;
}

// ─── Bloomberg 3D Surface Component ───────────────────────────────────────────
function BloombergSurface({ points, feature, period }: {
  points: Pt3[];
  feature: string;
  period: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [az, setAz] = useState(35);
  const [el, setEl] = useState(28);
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const projCellsRef = useRef<ProjCell[]>([]);
  const [hoverCell, setHoverCell] = useState<ProjCell | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const gd = useMemo(() => buildGrid(points), [points]);

  // Render surface
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !gd.T) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cells = renderBloombergSurface(ctx, gd, az, el, canvas.width, canvas.height);
    projCellsRef.current = cells;
  }, [gd, az, el]);

  const handleMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragging.current) {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      setAz((a) => a + dx * 0.4);
      setEl((v) => Math.max(5, Math.min(75, v + dy * 0.25)));
      lastMouse.current = { x: e.clientX, y: e.clientY };
      setHoverCell(null);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    let nearest: ProjCell | null = null;
    let minDist = 28;
    for (const cell of projCellsRef.current) {
      const cx2 = cell.corners.reduce((a, b) => a + b.sx, 0) / 4;
      const cy2 = cell.corners.reduce((a, b) => a + b.sy, 0) / 4;
      const d = Math.hypot(cx2 - mx, cy2 - my);
      if (d < minDist) { minDist = d; nearest = cell; }
    }

    if (nearest) {
      const cRect = containerRef.current?.getBoundingClientRect();
      if (cRect) {
        setTooltipPos({ x: e.clientX - cRect.left + 14, y: e.clientY - cRect.top - 10 });
      }
    }
    setHoverCell(nearest);
  };

  const handleMouseUp = () => { dragging.current = false; };
  const handleMouseLeave = () => { dragging.current = false; setHoverCell(null); };

  // Build side panel data
  const timeSeries = useMemo(() => {
    if (!gd.T) return [];
    return Array.from({ length: gd.T }, (_, ti) => {
      const vals = (gd.grid[ti] ?? []).filter((v): v is number => v !== null);
      const avg = vals.length ? vals.reduce((a, b) => a + b) / vals.length : null;
      return { t: gd.tLabels[ti], price: avg ? parseFloat(avg.toFixed(2)) : null };
    }).filter((d) => d.price !== null);
  }, [gd]);

  const featureSeries = useMemo(() => {
    if (!gd.F) return [];
    return Array.from({ length: gd.F }, (_, fi) => {
      const vals: number[] = [];
      for (let ti = 0; ti < gd.T; ti++) {
        const v = gd.grid[ti]?.[fi];
        if (v !== null && v !== undefined) vals.push(v);
      }
      const avg = vals.length ? vals.reduce((a, b) => a + b) / vals.length : null;
      const fVal = gd.fLabels[fi];
      return { f: fVal, price: avg ? parseFloat(avg.toFixed(2)) : null };
    }).filter((d) => d.price !== null);
  }, [gd]);

  const featureLabel = FEATURES.find((f) => f.key === feature)?.label ?? feature;

  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 260px" }}>
      {/* Main 3D canvas */}
      <div ref={containerRef} className="relative">
        <canvas
          ref={canvasRef}
          width={900}
          height={500}
          className="w-full border border-primary/20 cursor-crosshair"
          style={{ maxHeight: 500 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        />

        {/* Hover tooltip overlay */}
        {hoverCell && (
          <div
            className="absolute z-50 pointer-events-none border border-accent/70 bg-black/98 text-[10px] font-mono p-2 min-w-[200px]"
            style={{ left: tooltipPos.x, top: tooltipPos.y }}
          >
            <div className="text-accent font-bold border-b border-accent/30 pb-1 mb-1 flex items-center gap-2">
              <span style={{ background: jetColor(hoverCell.val), width: 10, height: 10, display: "inline-block", border: "1px solid #fff4" }} />
              CELL [{hoverCell.ti},{hoverCell.fi}]
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <span className="text-muted-foreground">PRICE (avg)</span>
              <span className="text-primary font-bold">${hoverCell.avgPrice.toFixed(2)}</span>
              <span className="text-muted-foreground">{featureLabel.toUpperCase()}</span>
              <span className="text-accent">{hoverCell.avgFeature.toFixed(4)}</span>
              <span className="text-muted-foreground">NORMALIZED</span>
              <span style={{ color: jetColor(hoverCell.val) }}>{(hoverCell.val * 100).toFixed(1)}%</span>
              <span className="text-muted-foreground">TIME IDX</span>
              <span className="text-muted-foreground">{gd.tLabels[hoverCell.ti]}</span>
              <span className="text-muted-foreground">MIN–MAX</span>
              <span className="text-muted-foreground">${gd.minP.toFixed(0)}–${gd.maxP.toFixed(0)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Side panels */}
      <div className="flex flex-col gap-2">
        {/* Time cross-section */}
        <div className="border border-primary/20 p-1.5">
          <p className="text-[10px] text-muted-foreground uppercase mb-1">
            PRICE OVER TIME (avg/bin)
          </p>
          <ResponsiveContainer width="100%" height={140}>
            <AreaChart data={timeSeries} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ffd700" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#ffd700" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#00ff4110" />
              <XAxis dataKey="t" tick={{ fill: "#00ff4155", fontSize: 7 }} interval="preserveStartEnd" />
              <YAxis domain={["auto","auto"]} tick={{ fill: "#00ff4155", fontSize: 7 }} width={44}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
              <Tooltip contentStyle={{ background: "#000", border: "1px solid #ffd700", fontSize: 9, fontFamily: "monospace" }}
                formatter={(v: number) => [`$${v.toFixed(2)}`, "Price"]} />
              <Area type="monotone" dataKey="price" stroke="#ffd700" fill="url(#goldGrad)" strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Feature cross-section */}
        <div className="border border-primary/20 p-1.5">
          <p className="text-[10px] text-muted-foreground uppercase mb-1">
            PRICE vs {featureLabel.toUpperCase()}
          </p>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={featureSeries} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="#00ff4110" />
              <XAxis dataKey="f" tick={{ fill: "#00ff4155", fontSize: 7 }} interval="preserveStartEnd" />
              <YAxis domain={["auto","auto"]} tick={{ fill: "#00ff4155", fontSize: 7 }} width={44}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
              <Tooltip contentStyle={{ background: "#000", border: "1px solid #00bcd4", fontSize: 9, fontFamily: "monospace" }}
                formatter={(v: number) => [`$${v.toFixed(2)}`, "Price avg"]} />
              <Line type="monotone" dataKey="price" stroke="#00bcd4" strokeWidth={1.5} dot={{ r: 2, fill: "#00bcd4" }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Stats panel */}
        <div className="border border-primary/20 p-2 flex flex-col gap-1">
          <p className="text-[10px] text-primary uppercase border-b border-primary/20 pb-1 mb-1">SURFACE STATS</p>
          {[
            { l: "MAX PRICE",   v: `$${gd.maxP.toFixed(2)}`, c: "#ff4444" },
            { l: "MIN PRICE",   v: `$${gd.minP.toFixed(2)}`, c: "#00ff41" },
            { l: "PRICE RANGE", v: `$${(gd.maxP - gd.minP).toFixed(2)}`, c: "#ffd700" },
            { l: "FEAT MAX",    v: gd.maxF.toFixed(4), c: "#00bcd4" },
            { l: "FEAT MIN",    v: gd.minF.toFixed(4), c: "#00bcd4" },
            { l: "GRID",        v: `${gd.T}×${gd.F} = ${gd.T * gd.F} cells`, c: "#ffffff88" },
            { l: "PERIOD",      v: period, c: "#ffd700" },
            { l: "FEATURE",     v: featureLabel, c: "#00ff41" },
          ].map(({ l, v, c }) => (
            <div key={l} className="flex justify-between text-[10px]">
              <span className="text-muted-foreground">{l}</span>
              <span className="font-mono font-bold" style={{ color: c }}>{v}</span>
            </div>
          ))}
        </div>

        {/* Color legend */}
        <div className="border border-primary/20 p-1.5">
          <p className="text-[10px] text-muted-foreground uppercase mb-1">COLORMAP LEGEND</p>
          <div className="flex flex-col gap-0.5">
            {[1, 0.75, 0.5, 0.25, 0].map((t) => {
              const price = gd.minP + t * (gd.maxP - gd.minP);
              return (
                <div key={t} className="flex items-center gap-2">
                  <div className="w-4 h-3 border border-white/10" style={{ background: jetColor(t) }} />
                  <span className="text-[9px] font-mono text-muted-foreground">${price.toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Scatter 3D (kept as secondary view) ─────────────────────────────────────
interface ProjectedPoint { screenX: number; screenY: number; point: Pt3; idx: number; }

function Canvas3D({ points, feature }: { points: Pt3[]; feature: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [angle, setAngle] = useState(30);
  const dragging = useRef(false);
  const lastX = useRef(0);
  const projectedRef = useRef<ProjectedPoint[]>([]);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; point: Pt3; idx: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !points.length) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    const prices   = points.map((p) => p.price);
    const features = points.map((p) => p.featureValue);
    const n = points.length;
    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const minF = Math.min(...features), maxF = Math.max(...features);
    const norm = (v: number, lo: number, hi: number) => hi === lo ? 0.5 : (v - lo) / (hi - lo);

    const rad = (angle * Math.PI) / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);
    const project = (tx: number, ty: number, tz: number) => ({
      x: W * 0.1 + (tx * cosA - tz * sinA) * W * 0.8,
      y: H * 0.9 - ty * H * 0.75 - (tx * sinA + tz * cosA) * H * 0.1,
    });

    // Axes
    [
      [project(0,0,0), project(1,0,0), "TIME →",  "#00ff4188"],
      [project(0,0,0), project(0,1,0), "PRICE →", "#ffd70088"],
      [project(0,0,0), project(0,0,1), feature.toUpperCase() + " →", "#00bcd488"],
    ].forEach(([from, to, label, color]: any[]) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      ctx.fillStyle = color; ctx.font = "9px Space Mono";
      ctx.fillText(label, to.x + 4, to.y);
    });

    const projected: ProjectedPoint[] = [];
    points.forEach((p, i) => {
      const tx = i / (n - 1 || 1);
      const ty = norm(p.price, minP, maxP);
      const tz = norm(p.featureValue, minF, maxF);
      const { x, y } = project(tx, ty, tz);
      projected.push({ screenX: x, screenY: y, point: p, idx: i });
    });
    projectedRef.current = projected;

    ctx.strokeStyle = "#00ff4118"; ctx.lineWidth = 0.5;
    ctx.beginPath();
    projected.forEach(({ screenX, screenY }, i) => {
      if (i === 0) ctx.moveTo(screenX, screenY); else ctx.lineTo(screenX, screenY);
    });
    ctx.stroke();

    projected.forEach(({ screenX, screenY, point }) => {
      const ty = norm(point.price, minP, maxP);
      const r = Math.round(255 * (1 - ty));
      const g2 = Math.round(200 * ty + 55);
      ctx.fillStyle = `rgba(${r},${g2},65,0.9)`;
      ctx.beginPath(); ctx.arc(screenX, screenY, 5, 0, Math.PI * 2); ctx.fill();
    });

    ctx.fillStyle = "#ffd700"; ctx.font = "11px Space Mono";
    ctx.fillText(`SCATTER 3D — XAUUSD — ${feature} — ${n} pts`, 10, 18);
    ctx.fillStyle = "#00ff4166"; ctx.font = "9px Space Mono";
    ctx.fillText("← DRAG TO ROTATE  |  HOVER FOR DATA →", W / 2 - 100, H - 6);
  }, [points, feature, angle]);

  const handleMouseDown = (e: React.MouseEvent) => { dragging.current = true; lastX.current = e.clientX; };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragging.current) {
      setAngle((a) => a + (e.clientX - lastX.current) * 0.5);
      lastX.current = e.clientX;
      setTooltip(null);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    let nearest: ProjectedPoint | null = null;
    let minDist = 18;
    for (const p of projectedRef.current) {
      const d = Math.hypot(p.screenX - mx, p.screenY - my);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    if (nearest) {
      const cRect = containerRef.current?.getBoundingClientRect();
      if (cRect) setTooltip({ x: e.clientX - cRect.left + 12, y: e.clientY - cRect.top - 8, point: nearest.point, idx: nearest.idx });
    } else setTooltip(null);
  };
  const handleMouseUp = () => { dragging.current = false; };
  const handleMouseLeave = () => { dragging.current = false; setTooltip(null); };

  const featureLabel = FEATURES.find((f) => f.key === feature)?.label ?? feature;

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas ref={canvasRef} width={900} height={300}
        className="w-full border border-primary/20 cursor-crosshair" style={{ maxHeight: 300 }}
        onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp} onMouseLeave={handleMouseLeave}
      />
      {tooltip && (
        <div className="absolute z-50 pointer-events-none border border-primary/60 bg-black/95 text-[10px] font-mono p-2 min-w-[180px]"
          style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="text-primary font-bold mb-1 border-b border-primary/30 pb-1">PT #{tooltip.idx + 1}</div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">DATE</span>
            <span className="text-accent">{new Date(tooltip.point.time).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">PRICE</span>
            <span className="text-primary font-bold">${tooltip.point.price.toFixed(2)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">{featureLabel.toUpperCase().slice(0,12)}</span>
            <span className="text-accent">{tooltip.point.featureValue.toFixed(4)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Tab ──────────────────────────────────────────────────────────────────
export function Gc3dTab() {
  const [feature, setFeature] = useState("stoch_volatility");
  const [period,  setPeriod]  = useState("3mo");

  const { data, isLoading, refetch } = useGetGc3d(
    { feature, period },
    { query: { queryKey: getGetGc3dQueryKey(), refetchInterval: 120000 } }
  );

  const points: Pt3[] = (data?.points ?? []).map((p) => ({
    time: new Date(p.time).getTime(),
    price: p.price,
    featureValue: p.featureValue,
  }));

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase font-bold">GC3D — 3D GOLD ANALYSIS</span>
        {data && <span className="text-xs text-accent">${data.currentPrice?.toFixed(2)}</span>}
        {data && <span className="text-xs text-muted-foreground">{points.length} pts</span>}
        <div className="flex-1" />
        <label className="text-muted-foreground text-xs">FEATURE</label>
        <select value={feature} onChange={(e) => setFeature(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {FEATURES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <label className="text-muted-foreground text-xs">PERIOD</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={() => refetch()} className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">↻</button>
      </div>

      {/* Feature tabs */}
      <div className="flex gap-1.5 flex-wrap text-[10px] px-1">
        {FEATURES.map((f) => (
          <button key={f.key} onClick={() => setFeature(f.key)}
            className={`px-2 py-0.5 border ${feature === f.key ? "border-accent text-accent bg-accent/10" : "border-primary/30 text-muted-foreground hover:border-primary/60"}`}>
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="p-16 text-primary animate-pulse flex items-center justify-center">LOADING 3D DATA █</div>
      ) : !points.length ? (
        <div className="p-8 text-destructive text-xs text-center">ERR: NO DATA — try a different period</div>
      ) : (
        <>
          {/* Bloomberg 3D Surface */}
          <div className="border border-primary/20 p-1.5">
            <p className="text-[10px] text-primary uppercase border-b border-primary/20 pb-1 mb-2 flex items-center gap-2">
              <span>SURFACE 3D</span>
              <span className="text-muted-foreground font-normal">
                — Price surface over Time × {FEATURES.find((f) => f.key === feature)?.label}
                · Left-right drag = azimuth · Up-down drag = elevation
              </span>
            </p>
            <BloombergSurface points={points} feature={feature} period={period} />
          </div>

          {/* Scatter 3D */}
          <div className="border border-primary/20 p-1.5">
            <p className="text-[10px] text-muted-foreground uppercase pb-1 mb-1">
              SCATTER 3D — Time × Price × {FEATURES.find((f) => f.key === feature)?.label}
              · Hover points for details
            </p>
            <Canvas3D points={points} feature={feature} />
          </div>
        </>
      )}
    </div>
  );
}
