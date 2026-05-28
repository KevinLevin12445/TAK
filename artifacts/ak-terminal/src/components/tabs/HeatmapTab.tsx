import { useState, useEffect, useRef, useCallback } from "react";

declare global {
  interface Window { Plotly: PlotlyType; }
}
interface PlotlyType {
  newPlot: (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => Promise<void>;
  react: (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => Promise<void>;
  purge: (el: HTMLElement) => void;
}

interface OrderFlowData {
  matrix: number[][];
  priceBins: number[];
  times: string[];
  prices: number[];
  volProfile: number[];
  poc: number;
  vah: number;
  val: number;
  nom: number;
  currentPrice: number;
  minP: number;
  maxP: number;
  bins: number;
  binSize: number;
  pzCount: number;
}

function usePlotly() {
  const [loaded, setLoaded] = useState(() => typeof window !== "undefined" && !!window.Plotly);
  useEffect(() => {
    if (window.Plotly) { setLoaded(true); return; }
    const existing = document.querySelector('script[src*="plotly"]') as HTMLScriptElement | null;
    if (existing) { existing.addEventListener("load", () => setLoaded(true)); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    s.async = true;
    s.onload = () => setLoaded(true);
    document.head.appendChild(s);
  }, []);
  return loaded;
}

const PERIOD_OPTIONS = [
  { label: "1W", value: "5d", interval: "15m" },
  { label: "1M", value: "1mo", interval: "1h" },
  { label: "3M", value: "3mo", interval: "1d" },
];

export function HeatmapTab() {
  const [bins, setBins] = useState(60);
  const [window_, setWindow] = useState(20);
  const [periodIdx, setPeriodIdx] = useState(1);
  const [data, setData] = useState<OrderFlowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const plotlyReady = usePlotly();
  const initialized = useRef(false);
  const profileInit = useRef(false);

  const selectedPeriod = PERIOD_OPTIONS[periodIdx];

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/gold/order-flow?bins=${bins}&window=${window_}&period=${selectedPeriod.value}&interval=${selectedPeriod.interval}`);
      if (!r.ok) throw new Error("fetch failed");
      const json = await r.json() as OrderFlowData;
      setData(json);
    } catch {
      setError("ERROR FETCHING ORDER FLOW DATA");
    } finally {
      setLoading(false);
    }
  }, [bins, window_, selectedPeriod.value, selectedPeriod.interval]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!plotlyReady || !plotRef.current || !data || !data.matrix.length) return;
    const el = plotRef.current;

    const dateLabels = data.times.map((t) => t.slice(0, 10));

    // Transpose matrix: Plotly heatmap expects z[y_idx][x_idx]
    // matrix is [bins][times], need z[bin_idx][time_idx] = matrix[bin_idx][time_idx]
    const z = data.matrix; // already [bins][times]

    const heatmapTrace = {
      type: "heatmap",
      x: dateLabels,
      y: data.priceBins.map((p) => `$${p.toFixed(0)}`),
      z,
      colorscale: [
        [0.0, "#000d1a"],
        [0.05, "#001133"],
        [0.15, "#003366"],
        [0.3, "#0055aa"],
        [0.45, "#00aaaa"],
        [0.6, "#00cc44"],
        [0.72, "#aaff00"],
        [0.82, "#ffcc00"],
        [0.91, "#ff6600"],
        [1.0, "#ff0000"],
      ],
      showscale: true,
      colorbar: {
        title: { text: "DENSITY", font: { color: "#00ff41", size: 10, family: "monospace" } },
        tickfont: { color: "#00ff41", size: 9, family: "monospace" },
        bgcolor: "rgba(0,0,0,0)",
        bordercolor: "#00ff4133",
        thickness: 14,
        tickvals: [0, 0.5, 1],
        ticktext: ["LOW", "MED", "HIGH"],
      },
      hovertemplate: "Date: %{x}<br>Price: %{y}<br>Density: %{z:.2f}<extra></extra>",
      zsmooth: "best",
      opacity: 0.92,
    };

    const priceTrace = {
      type: "scatter",
      x: dateLabels,
      y: data.prices.map((p) => `$${p.toFixed(0)}`),
      mode: "lines",
      line: { color: "#ffffff", width: 2 },
      name: "Price",
      hovertemplate: "%{x}<br>$%{y}<extra>Price</extra>",
    };

    // POC line
    const pocLabel = `$${data.poc.toFixed(0)}`;
    const vahLabel = `$${data.vah.toFixed(0)}`;
    const valLabel = `$${data.val.toFixed(0)}`;
    const nomLabel = `$${data.nom.toFixed(0)}`;

    const layout = {
      paper_bgcolor: "#000000",
      plot_bgcolor: "#000a00",
      font: { color: "#00ff41", family: "Space Mono, monospace", size: 10 },
      margin: { l: 70, r: 100, t: 10, b: 50 },
      xaxis: {
        tickfont: { color: "#00ff4166", size: 8 },
        gridcolor: "#00ff4110",
        linecolor: "#00ff4130",
        showgrid: true,
      },
      yaxis: {
        tickfont: { color: "#00ff4166", size: 8 },
        gridcolor: "#00ff4110",
        linecolor: "#00ff4130",
        showgrid: true,
        side: "left",
      },
      shapes: [
        { type: "line", x0: dateLabels[0], x1: dateLabels[dateLabels.length - 1], y0: pocLabel, y1: pocLabel, line: { color: "#ff8800", width: 1.5, dash: "dash" }, layer: "above" },
        { type: "line", x0: dateLabels[0], x1: dateLabels[dateLabels.length - 1], y0: vahLabel, y1: vahLabel, line: { color: "#ff44ff88", width: 1, dash: "dot" }, layer: "above" },
        { type: "line", x0: dateLabels[0], x1: dateLabels[dateLabels.length - 1], y0: valLabel, y1: valLabel, line: { color: "#00bcd488", width: 1, dash: "dot" }, layer: "above" },
        { type: "line", x0: dateLabels[0], x1: dateLabels[dateLabels.length - 1], y0: nomLabel, y1: nomLabel, line: { color: "#00ff4188", width: 1, dash: "dot" }, layer: "above" },
      ],
      annotations: [
        { x: dateLabels[dateLabels.length - 1], y: pocLabel, xref: "x", yref: "y", text: `POC ${pocLabel}`, showarrow: false, font: { color: "#ff8800", size: 9 }, xanchor: "left", bgcolor: "rgba(0,0,0,0.7)", bordercolor: "#ff8800", borderpad: 2 },
        { x: dateLabels[dateLabels.length - 1], y: vahLabel, xref: "x", yref: "y", text: `VAH ${vahLabel}`, showarrow: false, font: { color: "#ff44ff", size: 9 }, xanchor: "left", bgcolor: "rgba(0,0,0,0.7)", bordercolor: "#ff44ff", borderpad: 2 },
        { x: dateLabels[dateLabels.length - 1], y: valLabel, xref: "x", yref: "y", text: `VAL ${valLabel}`, showarrow: false, font: { color: "#00bcd4", size: 9 }, xanchor: "left", bgcolor: "rgba(0,0,0,0.7)", bordercolor: "#00bcd4", borderpad: 2 },
        { x: dateLabels[dateLabels.length - 1], y: nomLabel, xref: "x", yref: "y", text: `NOM ${nomLabel}`, showarrow: false, font: { color: "#00ff41", size: 9 }, xanchor: "left", bgcolor: "rgba(0,0,0,0.7)", bordercolor: "#00ff41", borderpad: 2 },
      ],
      showlegend: false,
      uirevision: `${bins}-${window_}-${periodIdx}`,
    };

    const config = {
      displayModeBar: true,
      displaylogo: false,
      scrollZoom: true,
      responsive: true,
      modeBarButtonsToRemove: ["sendDataToCloud"],
    };

    if (initialized.current) {
      window.Plotly.react(el, [heatmapTrace, priceTrace], layout, config);
    } else {
      window.Plotly.newPlot(el, [heatmapTrace, priceTrace], layout, config);
      initialized.current = true;
    }
  }, [plotlyReady, data, bins, window_, periodIdx]);

  // Volume profile sidebar chart
  useEffect(() => {
    if (!plotlyReady || !profileRef.current || !data || !data.volProfile.length) return;
    const el = profileRef.current;

    const maxVol = Math.max(...data.volProfile) || 1;
    const profileTrace = {
      type: "bar",
      x: data.volProfile,
      y: data.priceBins.map((p) => `$${p.toFixed(0)}`),
      orientation: "h",
      marker: {
        color: data.priceBins.map((p) => {
          const norm = (p - data.minP) / (data.maxP - data.minP || 1);
          if (norm > 0.7) return "#ff0000";
          if (norm > 0.5) return "#ff8800";
          if (norm > 0.3) return "#ffcc00";
          return "#00aa44";
        }),
        opacity: 0.85,
      },
      hovertemplate: "Price: %{y}<br>Volume: %{x:.0f}<extra></extra>",
    };

    const pocY = `$${data.poc.toFixed(0)}`;

    const layout = {
      paper_bgcolor: "#000000",
      plot_bgcolor: "#000a00",
      font: { color: "#00ff41", family: "monospace", size: 9 },
      margin: { l: 5, r: 5, t: 5, b: 30 },
      xaxis: { visible: false, range: [0, maxVol * 1.2] },
      yaxis: { tickfont: { size: 7, color: "#00ff4144" }, showgrid: false },
      shapes: [
        { type: "line", x0: 0, x1: maxVol * 1.2, y0: pocY, y1: pocY, line: { color: "#ff8800", width: 1.5, dash: "dash" } },
      ],
      annotations: [
        { x: maxVol * 0.5, y: pocY, text: "VOL PROFILE", showarrow: false, font: { color: "#ffd700", size: 8 }, bgcolor: "rgba(0,0,0,0.5)" },
      ],
      showlegend: false,
      bargap: 0.02,
    };

    if (profileInit.current) {
      window.Plotly.react(el, [profileTrace], layout, { displayModeBar: false, responsive: true });
    } else {
      window.Plotly.newPlot(el, [profileTrace], layout, { displayModeBar: false, responsive: true });
      profileInit.current = true;
    }
  }, [plotlyReady, data]);

  useEffect(() => {
    return () => {
      if (plotRef.current && window.Plotly) { window.Plotly.purge(plotRef.current); initialized.current = false; }
      if (profileRef.current && window.Plotly) { window.Plotly.purge(profileRef.current); profileInit.current = false; }
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border border-primary/30 p-2">
        <span className="text-primary text-xs font-bold uppercase">ORDER FLOW HEATMAP — Institutional Liquidity Zones</span>
        <div className="flex-1" />
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map((p, i) => (
            <button key={p.label} onClick={() => setPeriodIdx(i)}
              className={`text-[10px] px-2 py-0.5 border transition-colors ${i === periodIdx ? "border-accent text-accent bg-accent/10" : "border-primary/30 text-muted-foreground hover:border-primary/60"}`}>
              {p.label}
            </button>
          ))}
        </div>
        <button onClick={fetchData} disabled={loading}
          className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black disabled:opacity-50">
          {loading ? "..." : "↻"}
        </button>
      </div>

      {/* Sliders */}
      <div className="flex flex-wrap gap-6 px-3 py-2 border border-primary/20 bg-black/40">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">Price bins</span>
          <input type="range" min={20} max={100} value={bins}
            onChange={(e) => setBins(Number(e.target.value))}
            className="w-36 accent-primary cursor-pointer" />
          <span className="text-[11px] text-primary w-8 tabular-nums">{bins}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">Volume accumulation window</span>
          <input type="range" min={1} max={50} value={window_}
            onChange={(e) => setWindow(Number(e.target.value))}
            className="w-36 accent-primary cursor-pointer" />
          <span className="text-[11px] text-primary w-8 tabular-nums">{window_}</span>
        </div>
      </div>

      {/* Info bar */}
      {data && (
        <div className="flex flex-wrap gap-3 items-center px-2 py-1 text-[10px] font-mono border border-primary/20">
          <span className="text-primary font-bold">ORDER FLOW HEATMAP ▶</span>
          <span>POC <span className="text-[#ff8800] font-bold">${data.poc.toFixed(2)}</span></span>
          <span className="text-primary/40">|</span>
          <span>VAH <span className="text-[#ff44ff]">${data.vah.toFixed(2)}</span></span>
          <span className="text-primary/40">|</span>
          <span>VAL <span className="text-[#00bcd4]">${data.val.toFixed(2)}</span></span>
          <span className="text-primary/40">|</span>
          <span>NOM <span className="text-primary font-bold">${data.nom.toFixed(2)}</span></span>
          <span className="text-primary/40">|</span>
          <span>PZ <span className="text-accent">={data.pzCount}</span></span>
          <span className="ml-auto text-primary/40">scroll to zoom · drag to pan</span>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center p-16 text-primary animate-pulse text-sm">
          LOADING ORDER FLOW DATA █
        </div>
      )}

      {error && (
        <div className="flex items-center justify-center p-8 text-destructive text-xs">{error}</div>
      )}

      {!loading && !error && data && (
        <div className="flex gap-1">
          {/* Main heatmap */}
          <div
            ref={plotRef}
            style={{ flex: 1, height: 480, minWidth: 0, touchAction: "none" }}
            className="border border-primary/20"
          />
          {/* Volume profile sidebar */}
          <div
            ref={profileRef}
            style={{ width: 100, height: 480, flexShrink: 0, touchAction: "none" }}
            className="border border-primary/20"
          />
        </div>
      )}

      <p className="text-[10px] text-muted-foreground px-1">
        ORDER FLOW HEATMAP — GC=F (Gold Futures CFD) · Price bins: {bins} · Smoothing window: {window_} bars · Source: Yahoo Finance
      </p>
    </div>
  );
}
