import { useState, useEffect, useRef, useCallback } from "react";
import { useGetGc3d, getGetGc3dQueryKey } from "@workspace/api-client-react";

declare global {
  interface Window { Plotly: PlotlyType; }
}
interface PlotlyType {
  newPlot: (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => Promise<void>;
  react:   (el: HTMLElement, data: unknown[], layout: unknown, config?: unknown) => Promise<void>;
  purge:   (el: HTMLElement) => void;
}

const FEATURES = [
  { key: "stoch_volatility", label: "Stoch. Volatility" },
  { key: "zscore_20",        label: "Z-Score 20"        },
  { key: "zscore_60",        label: "Z-Score 60"        },
  { key: "vwap_dev",         label: "VWAP Dev"          },
  { key: "order_imbalance",  label: "Order Imbalance"   },
  { key: "carry",            label: "Carry"             },
  { key: "yield_anomaly",    label: "Yield Anomaly"     },
  { key: "rsi",              label: "RSI"               },
];

const PERIODS = ["1mo", "3mo", "6mo", "1y"];

function usePlotlyScript() {
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

interface Point { time: number; price: number; featureValue: number; }

interface SurfaceData {
  matrix: number[][];
  rawMatrix: number[][];
  featureLabels: string[];
  dates: string[];
  currentPrice: number;
}

// ─── Scatter 3D ──────────────────────────────────────────────────────────────
function Scatter3DChart({ points, feature, featureLabel }: { points: Point[]; feature: string; featureLabel: string }) {
  const divRef = useRef<HTMLDivElement>(null);
  const plotlyReady = usePlotlyScript();
  const initialized = useRef(false);

  useEffect(() => {
    if (!plotlyReady || !divRef.current || !points.length) return;
    const el = divRef.current;

    const xs = points.map((p) => new Date(p.time).toISOString().slice(0, 10));
    const ys = points.map((p) => p.price);
    const zs = points.map((p) => p.featureValue);

    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const norm = zs.map((z) => (maxZ - minZ > 0 ? (z - minZ) / (maxZ - minZ) : 0.5));

    const colors = norm.map((n) => {
      const r = Math.round(255 * Math.min(1, n * 2));
      const g = Math.round(255 * Math.min(1, (1 - n) * 2));
      return `rgb(${r},${g},30)`;
    });

    const last = points[points.length - 1];
    const currentMarker = {
      type: "scatter3d", mode: "markers",
      x: [new Date(last.time).toISOString().slice(0, 10)],
      y: [last.price],
      z: [last.featureValue],
      marker: { size: 8, color: "#ffd700", symbol: "diamond" },
      name: "Current",
      hovertemplate: `NOW<br>$${last.price.toFixed(2)}<extra>◆ CURRENT</extra>`,
    };

    const scatter = {
      type: "scatter3d", mode: "markers+lines",
      x: xs, y: ys, z: zs,
      marker: { size: 3, color: colors, opacity: 0.85 },
      line: { color: "#00ff4140", width: 1 },
      hovertemplate: "Date: %{x}<br>Price: $%{y:.2f}<br>" + featureLabel + ": %{z:.4f}<extra></extra>",
      name: featureLabel,
    };

    const layout = {
      paper_bgcolor: "#000000",
      font: { color: "#00ff41", family: "Space Mono, monospace", size: 10 },
      margin: { l: 0, r: 0, t: 0, b: 0 },
      scene: {
        bgcolor: "#000a00",
        xaxis: { title: { text: "DATE", font: { color: "#00ff4188", size: 10 } }, tickfont: { color: "#00ff4166", size: 8 }, gridcolor: "#00ff4120", linecolor: "#00ff4140" },
        yaxis: { title: { text: "PRICE $", font: { color: "#ffd70088", size: 10 } }, tickfont: { color: "#ffd70066", size: 8 }, gridcolor: "#ffd70020", linecolor: "#ffd70040" },
        zaxis: { title: { text: featureLabel.toUpperCase(), font: { color: "#00bcd488", size: 10 } }, tickfont: { color: "#00bcd466", size: 8 }, gridcolor: "#00bcd420", linecolor: "#00bcd440" },
        camera: { eye: { x: 1.6, y: -1.8, z: 0.9 } },
      },
      showlegend: false,
      uirevision: feature,
    };

    const config = { displayModeBar: true, modeBarButtonsToRemove: ["sendDataToCloud"], displaylogo: false, scrollZoom: true, responsive: true, showTips: false };

    if (initialized.current) window.Plotly.react(el, [scatter, currentMarker], layout, config);
    else { window.Plotly.newPlot(el, [scatter, currentMarker], layout, config); initialized.current = true; }
  }, [plotlyReady, points, feature, featureLabel]);

  useEffect(() => () => { if (divRef.current && window.Plotly) { window.Plotly.purge(divRef.current); initialized.current = false; } }, []);

  if (!plotlyReady) return <div className="flex items-center justify-center h-[500px] text-primary animate-pulse">LOADING PLOTLY █</div>;
  if (!points.length) return <div className="flex items-center justify-center h-[500px] text-muted-foreground">NO DATA</div>;

  return <div ref={divRef} style={{ width: "100%", height: 520, touchAction: "none" }} className="border border-primary/20" />;
}

// ─── Bloomberg-style Multi-Feature Surface ───────────────────────────────────
function MultiFeatureSurface({ period }: { period: string }) {
  const divRef = useRef<HTMLDivElement>(null);
  const plotlyReady = usePlotlyScript();
  const initialized = useRef(false);
  const [surfData, setSurfData] = useState<SurfaceData | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/gold/gc3d-surface?period=${period}`);
      if (!r.ok) throw new Error("fetch failed");
      setSurfData(await r.json());
    } catch { setError("SURFACE DATA UNAVAILABLE"); }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!plotlyReady || !divRef.current || !surfData?.matrix?.length) return;
    const el = divRef.current;

    const { matrix, rawMatrix, featureLabels, dates, currentPrice } = surfData;

    // Downsample dates for readability
    const step = Math.max(1, Math.floor(dates.length / 60));
    const xDates   = dates.filter((_, i) => i % step === 0);
    const zMatrix  = matrix.map((row)    => row.filter((_, i) => i % step === 0));
    const rawMatrix2 = rawMatrix.map((row) => row.filter((_, i) => i % step === 0));

    // Hover text matrix: [featureIdx][dateIdx]
    const hoverText = zMatrix.map((row, fi) =>
      row.map((_, di) => `Date: ${xDates[di]}<br>Feature: ${featureLabels[fi]}<br>Raw: ${(rawMatrix2[fi]?.[di] ?? 0).toFixed(4)}<br>Intensity: ${(zMatrix[fi]?.[di] ?? 0).toFixed(3)}`)
    );

    // Bloomberg rainbow colorscale
    const colorscale = [
      [0.00, "#00008B"],
      [0.15, "#0000FF"],
      [0.30, "#00BFFF"],
      [0.45, "#00FF80"],
      [0.60, "#ADFF2F"],
      [0.72, "#FFD700"],
      [0.84, "#FF8C00"],
      [0.92, "#FF4500"],
      [1.00, "#FF0000"],
    ];

    const surface = {
      type: "surface",
      x: xDates,
      y: featureLabels,
      z: zMatrix,
      text: hoverText,
      hovertemplate: "%{text}<extra></extra>",
      colorscale,
      showscale: true,
      opacity: 1.0,
      colorbar: {
        title: { text: "INTENSITY", font: { color: "#aaffaa", size: 10, family: "monospace" } },
        tickfont: { color: "#aaffaa", size: 9, family: "monospace" },
        bgcolor: "rgba(0,0,0,0)",
        bordercolor: "#00ff4133",
        thickness: 16,
        tickvals: [0, 0.25, 0.5, 0.75, 1],
        ticktext: ["0.00", "0.25", "0.50", "0.75", "1.00"],
        x: 1.01,
      },
      contours: {
        x: { show: true, color: "#ffffff20", width: 1, highlight: false },
        y: { show: true, color: "#ffffff20", width: 1, highlight: false },
        z: {
          show: true,
          usecolormap: true,
          highlightcolor: "#ffffff",
          width: 1,
          project: { x: true, y: true, z: false },
        },
      },
      lighting: {
        ambient: 0.75,
        diffuse: 0.9,
        roughness: 0.4,
        specular: 0.15,
        fresnel: 0.1,
      },
      lightposition: { x: 100, y: 200, z: 500 },
      hidesurface: false,
      cauto: false,
      cmin: 0,
      cmax: 1,
    };

    const layout = {
      paper_bgcolor: "#00060a",
      font: { color: "#aaffaa", family: "Space Mono, monospace", size: 10 },
      margin: { l: 0, r: 80, t: 30, b: 0 },
      title: {
        text: `GC3D — MULTI-FEATURE SURFACE  |  GC=F  |  $${currentPrice.toFixed(2)}  |  ${dates.length} sessions`,
        font: { color: "#aaffaa", size: 11 },
        x: 0.02,
      },
      scene: {
        bgcolor: "#00060a",
        aspectratio: { x: 2.0, y: 0.9, z: 0.7 },
        xaxis: {
          title: { text: "DATE", font: { color: "#aaffaacc", size: 10 } },
          tickfont: { color: "#aaffaa99", size: 8 },
          gridcolor: "#00ff4120",
          linecolor: "#00ff4155",
          zerolinecolor: "#00ff4130",
          showspikes: false,
        },
        yaxis: {
          title: { text: "FEATURE", font: { color: "#aaffaacc", size: 10 } },
          tickfont: { color: "#aaffaa99", size: 9 },
          gridcolor: "#00ff4120",
          linecolor: "#00ff4155",
          zerolinecolor: "#00ff4130",
          showspikes: false,
        },
        zaxis: {
          title: { text: "INTENSITY", font: { color: "#aaffaacc", size: 10 } },
          tickfont: { color: "#aaffaa99", size: 8 },
          gridcolor: "#00ff4115",
          linecolor: "#00ff4140",
          zerolinecolor: "#00ff4130",
          range: [0, 1],
          showspikes: false,
        },
        camera: {
          eye:    { x: -1.55, y: -1.90, z: 0.80 },
          center: { x:  0.0,  y:  0.0,  z: -0.1 },
          up:     { x:  0,    y:  0,    z:  1   },
        },
      },
      showlegend: false,
      uirevision: period,
    };

    const config = {
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["sendDataToCloud"],
      scrollZoom: true,
      responsive: true,
      showTips: false,
    };

    if (initialized.current) window.Plotly.react(el, [surface], layout, config);
    else { window.Plotly.newPlot(el, [surface], layout, config); initialized.current = true; }
  }, [plotlyReady, surfData, period]);

  useEffect(() => () => {
    if (divRef.current && window.Plotly) { window.Plotly.purge(divRef.current); initialized.current = false; }
  }, []);

  if (loading) return <div className="flex items-center justify-center h-[480px] text-primary animate-pulse text-sm">BUILDING FEATURE SURFACE █</div>;
  if (error)   return (
    <div className="flex flex-col items-center justify-center h-[480px] gap-3">
      <span className="text-destructive text-xs">{error}</span>
      <button onClick={load} className="text-xs px-3 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">↻ RETRY</button>
    </div>
  );
  if (!plotlyReady || !surfData) return <div className="flex items-center justify-center h-[480px] text-primary animate-pulse">LOADING PLOTLY █</div>;

  return (
    <div ref={divRef}
      style={{ width: "100%", height: 540, touchAction: "none" }}
      className="border border-primary/20"
    />
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────
export function Gc3dTab() {
  const [feature, setFeature] = useState("stoch_volatility");
  const [period,  setPeriod]  = useState("3mo");
  const [view,    setView]    = useState<"scatter" | "surface">("surface");

  const { data, isLoading, refetch } = useGetGc3d(
    { feature, period },
    { query: { queryKey: getGetGc3dQueryKey(), refetchInterval: 120000 } }
  );

  const featureLabel = FEATURES.find((f) => f.key === feature)?.label ?? feature;

  const points = (data?.points ?? []).map((p) => ({
    time: new Date(p.time).getTime(),
    price: p.price,
    featureValue: p.featureValue,
  }));

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase font-bold">GC3D — 3D ALPHA SURFACE</span>
        {data && (
          <span className="text-xs text-accent ml-2">
            XAUUSD ${data.currentPrice?.toFixed(2)} · {points.length} sessions
          </span>
        )}
        <div className="flex-1" />

        <div className="flex gap-1">
          {(["surface", "scatter"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`text-[10px] px-2 py-1 border transition-colors ${
                view === v ? "border-accent text-accent bg-accent/10" : "border-primary/30 text-muted-foreground hover:border-primary/60"
              }`}>
              {v === "surface" ? "▦ Multi-Feature Surface" : "◉ Scatter 3D"}
            </button>
          ))}
        </div>

        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <button onClick={() => refetch()}
          className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">↻</button>
      </div>

      {/* Feature selector (only for Scatter) */}
      {view === "scatter" && (
        <div className="flex gap-2 flex-wrap text-[10px] px-2">
          {FEATURES.map((f) => (
            <button key={f.key} onClick={() => setFeature(f.key)}
              className={`px-2 py-0.5 border transition-colors ${
                feature === f.key ? "border-accent text-accent bg-accent/10" : "border-primary/30 text-muted-foreground hover:border-primary/60"
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      )}

      {view === "surface" && (
        <div className="px-2">
          <p className="text-[10px] text-muted-foreground">
            Y-axis = all 8 alpha features (as feature slices) · X-axis = time · Z-axis = normalized intensity (0–1) ·{" "}
            <span className="text-primary/60">drag to rotate · scroll to zoom · hover for values</span>
          </p>
        </div>
      )}

      {/* Charts */}
      {view === "surface" && <MultiFeatureSurface period={period} />}

      {view === "scatter" && (
        isLoading ? (
          <div className="p-16 text-primary animate-pulse flex items-center justify-center text-sm">LOADING 3D DATA █</div>
        ) : (
          <div>
            <p className="text-[10px] text-muted-foreground px-2 pb-1">
              Feature: <span className="text-accent">{featureLabel}</span>
              <span className="ml-3 text-primary/40">scroll to zoom · drag to rotate · hover for values</span>
            </p>
            <Scatter3DChart points={points} feature={feature} featureLabel={featureLabel} />
          </div>
        )
      )}

      <p className="text-[10px] text-muted-foreground px-1 mt-1">
        {view === "surface"
          ? "MULTI-FEATURE SURFACE — Each ribbon = one alpha feature across time. Color intensity = normalized 0–1. Source: Yahoo Finance GC=F"
          : `Z = f(time, price, ${feature}) | COLOR = feature intensity | GOLD ◆ = current | Source: Yahoo Finance GC=F`}
      </p>
    </div>
  );
}
