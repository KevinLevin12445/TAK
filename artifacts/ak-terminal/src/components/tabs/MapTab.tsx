import { useState, useEffect, useCallback, useRef, WheelEvent, MouseEvent as RMouseEvent, TouchEvent } from "react";
import { useGetHeatmap, getGetHeatmapQueryKey } from "@workspace/api-client-react";

// ─── helpers ──────────────────────────────────────────────────────────────────

function pctColor(pct: number) {
  if (pct >  4) return "#00ff41";
  if (pct >  2) return "#33dd55";
  if (pct >  0.5) return "#1db83c";
  if (pct >  0) return "#0d7a26";
  if (pct > -0.5) return "#7a2200";
  if (pct > -2) return "#cc3300";
  return "#ff1a00";
}
function pctBg(pct: number) {
  if (pct >  2) return "#002800";
  if (pct >  0) return "#001600";
  if (pct > -1) return "#1a0600";
  return "#280000";
}
function fmt(pct: number) { return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"; }

// ─── Squarified Treemap ───────────────────────────────────────────────────────

interface TreeItem { ticker: string; sector: string; changePct: number; marketCap: number; price: number; }
interface TileRect { ticker: string; sector: string; changePct: number; price: number; x: number; y: number; w: number; h: number; }

function computeTreemap(items: TreeItem[], x: number, y: number, w: number, h: number): TileRect[] {
  if (!items.length || !w || !h) return [];
  const sorted = [...items].sort((a, b) => b.marketCap - a.marketCap);
  const total  = sorted.reduce((s, i) => s + i.marketCap, 0);
  if (!total) return [];

  const rects: TileRect[] = [];
  let rx = x, ry = y, rw = w, rh = h;

  function layoutRow(row: TreeItem[], horiz: boolean) {
    const rowSum = row.reduce((s, i) => s + i.marketCap, 0);
    let off = horiz ? rx : ry;
    for (const item of row) {
      const frac = item.marketCap / rowSum;
      const side = horiz ? rw * (rowSum / total) : rh * (rowSum / total);
      const perp = horiz ? rh : rw;
      const tw = horiz ? side       : perp * frac;
      const th = horiz ? perp * frac : side;
      const tx = horiz ? rx : off;
      const ty = horiz ? off : ry;
      rects.push({ ticker: item.ticker, sector: item.sector, changePct: item.changePct, price: item.price, x: tx, y: ty, w: tw, h: th });
      if (horiz) off += th; else off += tw;
    }
    if (horiz) { rx += rw * (rowSum / total); rw -= rw * (rowSum / total); }
    else       { ry += rh * (rowSum / total); rh -= rh * (rowSum / total); }
  }

  // Group into rows optimizing aspect ratios
  let row: TreeItem[] = [];
  let remaining = [...sorted];
  let useTotal = total;

  while (remaining.length) {
    const item = remaining.shift()!;
    row.push(item);
    const rowSum = row.reduce((s, i) => s + i.marketCap, 0);
    const horiz = rw >= rh;
    const side  = horiz ? rw * (rowSum / useTotal) : rh * (rowSum / useTotal);
    const perp  = horiz ? rh : rw;
    const maxAR = row.reduce((mx, it) => {
      const frac = it.marketCap / rowSum;
      const l = side; const w2 = perp * frac;
      return Math.max(mx, Math.max(l / w2, w2 / l));
    }, 0);

    if (remaining.length === 0 || maxAR > 1.5) {
      layoutRow(row, horiz);
      useTotal -= rowSum;
      row = [];
    }
  }
  return rects;
}

// ─── EQUITY HEATMAP ──────────────────────────────────────────────────────────

const WEIGHTS: Record<string, number> = {
  "GC=F": 420, "GLD": 380, "IAU": 300, "NEM": 80, "GOLD": 70, "AEM": 62, "FNV": 58,
  "AAPL": 350, "MSFT": 340, "NVDA": 270, "GOOGL": 245, "AMZN": 205, "META": 180,
  "SPY": 320, "QQQ": 280, "GDX": 95,
  "JPM": 135, "BAC": 112,
  "WMT": 105, "PG": 95,
  "XOM": 125, "CVX": 105,
};

function EquityTreemap({ assets, goldPrice, goldChangePct }: { assets: any[]; goldPrice: number; goldChangePct: number }) {
  const VW = 660, VH = 400;
  const items: TreeItem[] = assets.map((a) => ({
    ticker: a.ticker, sector: a.sector ?? "Other",
    changePct: a.changePct, price: a.price,
    marketCap: (a.marketCap && a.marketCap > 1e9 ? a.marketCap / 1e12 : (WEIGHTS[a.ticker] ?? 40)),
  }));
  const rects = computeTreemap(items, 0, 0, VW, VH);

  return (
    <div className="border border-primary/20 bg-[#020b02] flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 border-b border-primary/20">
        <span className="text-[10px] text-primary font-bold">EQUITY HEATMAP</span>
        <span className="text-[10px] text-muted-foreground">size=mkt cap · color=Δ%</span>
        <span className="ml-auto text-[10px]">
          ★ XAUUSD <span className="text-amber-400 font-bold">${goldPrice.toFixed(2)}</span>
          <span className={`ml-1 ${goldChangePct >= 0 ? "text-primary" : "text-destructive"}`}>
            {goldChangePct >= 0 ? "▲" : "▼"}{Math.abs(goldChangePct).toFixed(2)}%
          </span>
        </span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: 340 }}>
          <defs>
            <linearGradient id="eq-scale" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#00ff41"/>
              <stop offset="45%"  stopColor="#88cc44"/>
              <stop offset="55%"  stopColor="#cc4400"/>
              <stop offset="100%" stopColor="#ff1a00"/>
            </linearGradient>
          </defs>
          {rects.map((r) => {
            const col = pctColor(r.changePct);
            const bg  = pctBg(r.changePct);
            const showName  = r.w > 24 && r.h > 14;
            const showPct   = r.w > 28 && r.h > 22;
            const showPrice = r.w > 44 && r.h > 32;
            const fs = Math.min(11, Math.max(6, r.w / 5));
            const cy = r.y + r.h / 2;
            return (
              <g key={r.ticker}>
                <rect x={r.x+.5} y={r.y+.5} width={r.w-1} height={r.h-1}
                  fill={bg} stroke={col+"44"} strokeWidth={0.8} rx={1}/>
                {showName && (
                  <text x={r.x + r.w/2} y={cy - (showPct ? (showPrice ? 8 : 4) : 0)}
                    textAnchor="middle" fill={col} fontSize={fs} fontFamily="Space Mono" fontWeight="bold">{r.ticker}</text>
                )}
                {showPct && (
                  <text x={r.x + r.w/2} y={cy + (showPrice ? 4 : 7)}
                    textAnchor="middle" fill={col+"cc"} fontSize={Math.min(9, fs - 1)} fontFamily="Space Mono">{fmt(r.changePct)}</text>
                )}
                {showPrice && (
                  <text x={r.x + r.w/2} y={cy + 14}
                    textAnchor="middle" fill={col+"77"} fontSize={Math.min(8, fs - 2)} fontFamily="Space Mono">${r.price.toFixed(r.price < 100 ? 2 : 1)}</text>
                )}
              </g>
            );
          })}
          <rect x={VW-14} y={10} width={12} height={VH-20} fill="url(#eq-scale)" rx={2}/>
          <text x={VW-17} y={10}      textAnchor="end" fill="#00ff41" fontSize="7" fontFamily="monospace">+6%</text>
          <text x={VW-17} y={VH/2+3}  textAnchor="end" fill="#ffdd00" fontSize="7" fontFamily="monospace">0%</text>
          <text x={VW-17} y={VH-10}   textAnchor="end" fill="#ff1a00" fontSize="7" fontFamily="monospace">-3%</text>
        </svg>
      </div>
      <div className="flex gap-3 px-2 py-1 border-t border-primary/10 text-[9px] flex-wrap">
        {([["▲>4%","#00ff41"],["▲2-4%","#33dd55"],["▲0-2%","#0d7a26"],["▼0-1%","#7a2200"],["▼1-2%","#cc3300"],["▼>2%","#ff1a00"]] as [string,string][]).map(([l,c])=>(
          <span key={l} style={{color:c}}>{l}</span>
        ))}
      </div>
    </div>
  );
}

// ─── ALERTS + NEWS PANEL ─────────────────────────────────────────────────────

interface AlertItem { id: string; level: string; type: string; time: string; title: string; source: string; }
interface NewsItem  { title: string; url: string; source: string; publishedAt: string; }
interface AlertsData { alerts: AlertItem[]; news: NewsItem[]; }

const LEVEL_COLOR: Record<string,string> = { HIGH:"#ff4444", MEDIUM:"#ffd700", LOW:"#00ff41" };
const LEVEL_BG:    Record<string,string> = { HIGH:"#18000077", MEDIUM:"#18100077", LOW:"#00110077" };

function AlertsPanel({ data, loading }: { data: AlertsData|null; loading: boolean }) {
  return (
    <div className="flex flex-col h-full border border-primary/20 bg-[#020b02] overflow-hidden" style={{ minHeight: 0 }}>
      {/* Live Alerts */}
      <div className="px-2 py-1 border-b border-primary/20 flex items-center gap-2 flex-shrink-0">
        <span className="text-[10px] text-primary font-bold">⚡ LIVE ALERTS</span>
        {loading && <span className="text-[9px] text-muted-foreground animate-pulse ml-auto">updating…</span>}
      </div>
      <div className="overflow-y-auto flex-shrink-0" style={{ maxHeight: 210 }}>
        {!data && loading && <div className="p-4 text-primary animate-pulse text-[10px]">LOADING █</div>}
        {data?.alerts?.map((a) => {
          const col = LEVEL_COLOR[a.level] ?? "#00ff41";
          const bg  = LEVEL_BG[a.level] ?? "#00110077";
          return (
            <div key={a.id} className="border-b border-primary/10 px-2 py-1.5" style={{ background: bg }}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[9px] font-bold px-1 rounded" style={{ color: col, border: `1px solid ${col}66` }}>[{a.level}]</span>
                <span className="text-[9px] text-primary/50">■ {a.type}</span>
                <span className="text-[9px] text-muted-foreground ml-auto">{new Date(a.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
              </div>
              <p className="text-[10px] leading-tight" style={{ color: col+"dd" }}>{a.title}</p>
            </div>
          );
        })}
      </div>
      {/* News Feed */}
      <div className="px-2 py-1 border-y border-primary/20 flex-shrink-0">
        <span className="text-[10px] text-primary font-bold">■ GOLD NEWS FEED</span>
      </div>
      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {data?.news?.map((n, i) => (
          <a key={i} href={n.url} target="_blank" rel="noopener noreferrer"
            className="block border-b border-primary/10 px-2 py-1.5 hover:bg-primary/5 transition-colors">
            <p className="text-[10px] text-primary/90 leading-snug">{n.title}</p>
            <p className="text-[9px] text-muted-foreground mt-0.5">{n.source} · {new Date(n.publishedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</p>
          </a>
        ))}
        {!loading && !data?.news?.length && (
          <div className="p-4 text-muted-foreground text-[10px]">No news available</div>
        )}
      </div>
    </div>
  );
}

// ─── WORLD MAP WITH PAN/ZOOM ──────────────────────────────────────────────────

// More detailed continent SVG paths (Natural Earth simplified)
const CONTINENTS = [
  // North America
  { id:"na",  d:"M 58,48 L78,38 L100,35 L130,32 L160,35 L182,42 L200,55 L215,70 L218,90 L210,115 L202,135 L190,155 L175,168 L158,175 L140,178 L118,172 L100,160 L82,145 L68,125 L58,100 Z" },
  // Greenland
  { id:"gl",  d:"M 172,10 L205,8 L218,16 L220,30 L210,40 L190,44 L172,38 L165,25 Z" },
  // Central America
  { id:"ca",  d:"M 175,178 L210,178 L218,192 L205,200 L185,196 L172,186 Z" },
  // South America
  { id:"sa",  d:"M 170,205 L225,200 L248,220 L255,255 L248,310 L235,355 L210,385 L185,390 L162,365 L150,320 L152,265 L160,230 Z" },
  // Western Europe
  { id:"eu",  d:"M 338,42 L380,36 L420,35 L455,42 L465,58 L468,82 L460,105 L445,118 L418,124 L388,120 L362,112 L342,92 L335,68 Z" },
  // Scandinavia
  { id:"sc",  d:"M 385,10 L420,8 L440,18 L448,34 L438,42 L418,38 L398,34 L382,22 Z" },
  // Africa
  { id:"af",  d:"M 348,132 L455,128 L472,148 L478,185 L475,240 L468,295 L448,348 L415,375 L388,378 L362,355 L342,305 L332,245 L335,185 Z" },
  // Middle East
  { id:"me",  d:"M 468,82 L520,78 L545,88 L548,108 L530,128 L500,132 L472,125 L460,108 Z" },
  // Central Asia
  { id:"ca2", d:"M 545,55 L615,48 L640,58 L650,78 L635,100 L600,112 L560,108 L540,90 Z" },
  // East Asia (mainland)
  { id:"ea",  d:"M 618,48 L700,40 L748,48 L768,65 L778,90 L768,118 L745,138 L712,148 L672,148 L640,138 L618,118 L610,90 Z" },
  // South Asia (India)
  { id:"in",  d:"M 548,110 L610,108 L622,128 L618,158 L598,182 L572,188 L548,172 L538,148 Z" },
  // Southeast Asia
  { id:"sea", d:"M 688,148 L748,142 L762,158 L762,190 L748,210 L722,220 L698,205 L682,180 Z" },
  // Japan
  { id:"jp",  d:"M 758,68 L778,62 L788,72 L785,90 L770,98 L755,88 Z" },
  // Australia
  { id:"au",  d:"M 665,290 L795,284 L818,305 L825,352 L808,402 L768,418 L712,420 L668,400 L645,368 L645,325 Z" },
  // New Zealand
  { id:"nz",  d:"M 825,365 L840,358 L848,372 L840,390 L828,388 Z" },
  // UK/Ireland
  { id:"uk",  d:"M 332,48 L352,42 L358,55 L352,68 L335,65 Z" },
];

const COUNTRY_NODES: Record<string, { cx: number; cy: number }> = {
  "USA":       { cx: 145, cy: 110 },
  "Canada":    { cx: 125, cy: 75  },
  "Brazil":    { cx: 205, cy: 295 },
  "Europe":    { cx: 400, cy: 80  },
  "China":     { cx: 688, cy: 95  },
  "Japan":     { cx: 770, cy: 82  },
  "India":     { cx: 575, cy: 150 },
  "Australia": { cx: 732, cy: 352 },
};

// Gold producer cities (major mines)
const GOLD_PRODUCERS = [
  { cx: 115, cy: 115, name: "Nevada",      label: "USA"  },
  { cx: 732, cy: 355, name: "Perth",       label: "AUS"  },
  { cx: 195, cy: 280, name: "Minas Gerais",label: "BRA"  },
  { cx: 688, cy: 98,  name: "Shandong",    label: "CHN"  },
  { cx: 575, cy: 155, name: "Kolar",       label: "IND"  },
  { cx: 395, cy: 338, name: "South Africa",label: "SAF"  },
  { cx: 148, cy: 70,  name: "Yukon",       label: "CAN"  },
];

interface Transform { x: number; y: number; scale: number; }

interface CountryPerf { country: string; code: string; changePct: number; }

function WorldMap({ countryPerf }: { countryPerf: CountryPerf[] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tfm, setTfm] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const dragging = useRef(false);
  const lastPt   = useRef({ x: 0, y: 0 });
  const pinchRef = useRef<number | null>(null);

  const perfMap: Record<string,number> = {};
  for (const c of countryPerf) perfMap[c.country] = c.changePct;

  // Mouse wheel zoom
  const onWheel = useCallback((e: WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 0.89;
    setTfm(t => {
      const newScale = Math.min(8, Math.max(0.5, t.scale * f));
      // Zoom toward mouse position
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { ...t, scale: newScale };
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      return {
        scale: newScale,
        x: mx - (mx - t.x) * (newScale / t.scale),
        y: my - (my - t.y) * (newScale / t.scale),
      };
    });
  }, []);

  // Mouse drag
  const onMouseDown = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    dragging.current = true;
    lastPt.current = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  }, []);
  const onMouseMove = useCallback((e: RMouseEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPt.current.x;
    const dy = e.clientY - lastPt.current.y;
    lastPt.current = { x: e.clientX, y: e.clientY };
    setTfm(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
  }, []);
  const onMouseUp   = useCallback(() => { dragging.current = false; }, []);

  // Touch pan/pinch zoom
  const onTouchStart = useCallback((e: TouchEvent<SVGSVGElement>) => {
    if (e.touches.length === 1) {
      dragging.current = true;
      lastPt.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = Math.sqrt(dx*dx + dy*dy);
    }
  }, []);
  const onTouchMove = useCallback((e: TouchEvent<SVGSVGElement>) => {
    e.preventDefault();
    if (e.touches.length === 1 && dragging.current) {
      const dx = e.touches[0].clientX - lastPt.current.x;
      const dy = e.touches[0].clientY - lastPt.current.y;
      lastPt.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setTfm(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
    } else if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const f = dist / pinchRef.current;
      pinchRef.current = dist;
      setTfm(t => ({ ...t, scale: Math.min(8, Math.max(0.5, t.scale * f)) }));
    }
  }, []);
  const onTouchEnd = useCallback(() => { dragging.current = false; pinchRef.current = null; }, []);

  const resetView = () => setTfm({ x: 0, y: 0, scale: 1 });

  const VW = 880, VH = 430;

  return (
    <div className="border border-primary/20 bg-[#020b02]">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 border-b border-primary/20">
        <span className="text-[10px] text-primary font-bold">GLOBAL CAPITAL MAP</span>
        <span className="text-[10px] text-muted-foreground">— scroll to zoom · drag to pan</span>
        {countryPerf.length > 0 && (
          <span className="text-[10px] text-muted-foreground ml-2">
            Best: <span className="text-primary">{[...countryPerf].sort((a,b)=>b.changePct-a.changePct)[0]?.country}</span>
          </span>
        )}
        <button onClick={resetView} className="ml-auto text-[9px] px-2 py-0.5 border border-primary/30 text-primary/60 hover:text-primary hover:border-primary transition-colors">⊙ RESET</button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VW} ${VH}`}
        className="w-full select-none"
        style={{ height: 340, cursor: dragging.current ? "grabbing" : "grab" }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Ocean background */}
        <rect x={0} y={0} width={VW} height={VH} fill="#020d08"/>
        {/* Latitude grid lines */}
        {[0,72,144,216,288,360,430].map(y=>(
          <line key={`h${y}`} x1={0} y1={y} x2={VW} y2={y} stroke="#00ff4108" strokeWidth="1"/>
        ))}
        {[0,88,176,264,352,440,528,616,704,792,880].map(x=>(
          <line key={`v${x}`} x1={x} y1={0} x2={x} y2={VH} stroke="#00ff4108" strokeWidth="1"/>
        ))}

        {/* Pan+zoom group */}
        <g transform={`translate(${tfm.x},${tfm.y}) scale(${tfm.scale})`} style={{ transformOrigin: "0 0" }}>
          {/* Continents */}
          {CONTINENTS.map(({ id, d }) => {
            // Color Africa/Middle East by gold flow if possible
            const fill = "#0b1f0b";
            return (
              <path key={id} d={d} fill={fill} stroke="#00ff4128" strokeWidth="0.7"/>
            );
          })}

          {/* Gold producers — gold stars */}
          {GOLD_PRODUCERS.map((p) => (
            <g key={p.name}>
              <text x={p.cx} y={p.cy} textAnchor="middle" fill="#ffd700cc" fontSize={12 / tfm.scale} fontFamily="monospace">★</text>
              {tfm.scale > 1.5 && (
                <text x={p.cx} y={p.cy + 10 / tfm.scale} textAnchor="middle" fill="#ffd70088" fontSize={7 / tfm.scale} fontFamily="Space Mono">{p.name}</text>
              )}
            </g>
          ))}

          {/* Country performance bubbles */}
          {countryPerf.map((c) => {
            const pos = COUNTRY_NODES[c.country];
            if (!pos) return null;
            const col = pctColor(c.changePct);
            const bg  = pctBg(c.changePct);
            const r   = 22 / Math.sqrt(tfm.scale);
            return (
              <g key={c.country}>
                {/* Glow ring */}
                <circle cx={pos.cx} cy={pos.cy} r={r * 1.35} fill="none" stroke={col + "22"} strokeWidth={2 / tfm.scale}/>
                <circle cx={pos.cx} cy={pos.cy} r={r} fill={bg} stroke={col} strokeWidth={1.5 / tfm.scale}/>
                <text x={pos.cx} y={pos.cy - 4 / tfm.scale}
                  textAnchor="middle" fill={col} fontSize={8 / tfm.scale} fontFamily="Space Mono" fontWeight="bold">
                  {c.country.slice(0,3).toUpperCase()}
                </text>
                <text x={pos.cx} y={pos.cy + 7 / tfm.scale}
                  textAnchor="middle" fill={col + "cc"} fontSize={7 / tfm.scale} fontFamily="Space Mono">
                  {fmt(c.changePct)}
                </text>
                {tfm.scale > 1.5 && (
                  <text x={pos.cx} y={pos.cy + 16 / tfm.scale}
                    textAnchor="middle" fill={col + "88"} fontSize={6 / tfm.scale} fontFamily="Space Mono">
                    {c.code}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Color scale bar (fixed, not panned) */}
        <defs>
          <linearGradient id="map-scale" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#00ff41"/>
            <stop offset="50%"  stopColor="#ffdd00"/>
            <stop offset="100%" stopColor="#ff1a00"/>
          </linearGradient>
        </defs>
        <rect x={VW-22} y={30} width={14} height={VH-60} fill="url(#map-scale)" rx={3}/>
        <text x={VW-25} y={28}         textAnchor="end" fill="#00ff41" fontSize="9" fontFamily="monospace">+3%</text>
        <text x={VW-25} y={VH/2+3}     textAnchor="end" fill="#ffdd00" fontSize="9" fontFamily="monospace"> 0%</text>
        <text x={VW-25} y={VH-28}      textAnchor="end" fill="#ff1a00" fontSize="9" fontFamily="monospace">-3%</text>

        {/* Legend */}
        <text x={18} y={VH-12} fill="#ffd700" fontSize="9" fontFamily="monospace">★ Gold Producers</text>
        <text x={18} y={VH-2}  fill="#00ff4155" fontSize="8" fontFamily="monospace">scroll=zoom · drag=pan · RESET to reset</text>
      </svg>
    </div>
  );
}

// ─── MAIN TAB ─────────────────────────────────────────────────────────────────

export function MapTab() {
  const { data: hmData, isLoading: hmLoading, refetch } = useGetHeatmap({
    query: { queryKey: getGetHeatmapQueryKey(), refetchInterval: 60000 },
  });

  const [alertsData, setAlertsData] = useState<AlertsData | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(false);

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    try {
      const r = await fetch("/api/gold/alerts");
      if (r.ok) setAlertsData(await r.json());
    } catch { /* silent */ }
    setAlertsLoading(false);
  }, []);

  useEffect(() => {
    fetchAlerts();
    const id = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  if (hmLoading && !hmData) {
    return <div className="flex items-center justify-center p-16 text-primary animate-pulse">LOADING MAP DATA █</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-2 border border-primary/30 bg-black/60 px-2 py-1.5">
        <span className="text-primary text-xs font-bold">MAP — GLOBAL GOLD ECOSYSTEM</span>
        <div className="flex-1"/>
        <button onClick={() => { refetch(); fetchAlerts(); }}
          className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black transition-colors">
          ↻ REFRESH
        </button>
      </div>

      {/* Top row: treemap (left) + alerts/news (right) */}
      <div className="flex gap-2" style={{ minHeight: 380 }}>
        <div className="flex-1 min-w-0">
          <EquityTreemap
            assets={hmData?.assets ?? []}
            goldPrice={hmData?.goldPrice ?? 0}
            goldChangePct={hmData?.goldChangePct ?? 0}
          />
        </div>
        <div className="flex-shrink-0 flex flex-col" style={{ width: 290 }}>
          <AlertsPanel data={alertsData} loading={alertsLoading}/>
        </div>
      </div>

      {/* Bottom row: world map with pan/zoom */}
      <WorldMap countryPerf={hmData?.countryPerf ?? []}/>

      <p className="text-[9px] text-muted-foreground px-1">
        ETF proxies: SPY=USA · FXI=China · VGK=Europe · EWJ=Japan · INDA=India · EWZ=Brazil · EWC=Canada · EWA=Australia
      </p>
    </div>
  );
}
