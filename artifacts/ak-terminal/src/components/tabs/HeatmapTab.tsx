import { useState, useRef, useEffect } from "react";
import { useGetHeatmap, getGetHeatmapQueryKey } from "@workspace/api-client-react";

// --- color helpers ---
function heatColor(pct: number): string {
  if (pct >  3.0) return "#00c851";
  if (pct >  1.5) return "#00e64d";
  if (pct >  0.5) return "#33ff77";
  if (pct >  0.1) return "#66ffaa";
  if (pct > -0.1) return "#1a1a1a";
  if (pct > -0.5) return "#ff8888";
  if (pct > -1.5) return "#ff4444";
  if (pct > -3.0) return "#cc0000";
  return "#990000";
}
function textColor(pct: number): string {
  return Math.abs(pct) > 0.2 ? "#000" : "#00ff41";
}

// Importance weights for tile sizing (% of row width)
const TILE_WEIGHTS: Record<string, number> = {
  "GC=F": 22, GLD: 13, IAU: 11, NEM: 14, AEM: 9, FNV: 10, GOLD: 10,
  NVDA: 18, AAPL: 17, MSFT: 16, GOOGL: 14, AMZN: 14, META: 13,
  SPY: 25, QQQ: 22, GDX: 18,
  JPM: 16, BAC: 12,
  XOM: 14, CVX: 12,
  WMT: 13, PG: 12,
};

const SECTOR_ORDER = ["Gold & Precious", "Macro ETFs", "Technology", "Financials", "Energy", "Consumer"];

interface Asset {
  ticker: string;
  name: string;
  changePct: number;
  marketCap?: number;
  sector: string;
  price: number;
}

function LiveBeta({ changePct, goldChangePct }: { changePct: number; goldChangePct: number }) {
  if (!goldChangePct || Math.abs(goldChangePct) < 0.01) return null;
  const beta = changePct / goldChangePct;
  const color = beta > 1.1 ? "#00ff41" : beta > 0.8 ? "#ffd700" : beta > 0.3 ? "#00bcd4" : "#ff8888";
  return (
    <span className="text-[9px] font-mono" style={{ color }}>
      β{beta.toFixed(2)}
    </span>
  );
}

function AssetTile({
  asset,
  goldChangePct,
  weight,
}: {
  asset: Asset;
  goldChangePct: number;
  weight: number;
}) {
  const [hover, setHover] = useState(false);
  const bg = heatColor(asset.changePct);
  const fg = textColor(asset.changePct);
  const isGold = asset.ticker === "GC=F";

  return (
    <div
      className="relative flex flex-col items-center justify-center border transition-all duration-300 cursor-default overflow-hidden"
      style={{
        flexBasis: `${weight}%`,
        flexGrow: weight,
        flexShrink: 1,
        minWidth: isGold ? 100 : 72,
        height: isGold ? 96 : 80,
        background: bg,
        borderColor: hover ? "#ffd700" : (isGold ? "#ffd700" : bg),
        borderWidth: isGold ? 2 : 1,
        color: fg,
        boxShadow: isGold ? `0 0 12px ${bg}66` : hover ? `0 0 8px ${bg}88` : "none",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Inner glow for gold */}
      {isGold && (
        <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(ellipse at center, ${bg}44 0%, transparent 70%)` }} />
      )}

      <div className="relative z-10 flex flex-col items-center gap-0.5 px-1 text-center">
        <span className={`font-bold font-mono ${isGold ? "text-sm" : "text-xs"}`}>
          {asset.ticker === "GC=F" ? "XAUUSD" : asset.ticker}
        </span>
        <span className={`font-mono ${isGold ? "text-xs" : "text-[10px]"}`}>
          ${asset.price < 100 ? asset.price.toFixed(2) : asset.price.toFixed(0)}
        </span>
        <span className={`font-bold font-mono ${isGold ? "text-sm" : "text-xs"}`}>
          {asset.changePct >= 0 ? "▲+" : "▼"}{asset.changePct.toFixed(2)}%
        </span>
        {!isGold && <LiveBeta changePct={asset.changePct} goldChangePct={goldChangePct} />}
        {isGold && <span className="text-[9px] opacity-70">LIVE</span>}
      </div>

      {/* Hover detail overlay */}
      {hover && !isGold && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center text-[9px] font-mono"
          style={{ background: "#000e", color: "#00ff41" }}
        >
          <div className="font-bold text-[10px] text-accent">{asset.ticker}</div>
          <div>${asset.price < 100 ? asset.price.toFixed(3) : asset.price.toFixed(2)}</div>
          <div style={{ color: asset.changePct >= 0 ? "#00ff41" : "#ff4444" }}>
            {asset.changePct >= 0 ? "▲+" : "▼"}{asset.changePct.toFixed(3)}%
          </div>
          <div className="text-muted-foreground">
            β={Math.abs(goldChangePct) > 0.01 ? (asset.changePct / goldChangePct).toFixed(3) : "n/a"}
          </div>
        </div>
      )}
    </div>
  );
}

function SectorBlock({
  sector,
  assets,
  goldChangePct,
}: {
  sector: string;
  assets: Asset[];
  goldChangePct: number;
}) {
  if (!assets.length) return null;
  const sectorChange = assets.reduce((a, b) => a + b.changePct, 0) / assets.length;
  const sectorColor = heatColor(sectorChange);

  return (
    <div className="border border-primary/20 p-1.5">
      <div className="flex items-center justify-between mb-1.5 px-1">
        <span className="text-[10px] text-muted-foreground uppercase tracking-widest">{sector}</span>
        <span className="text-[10px] font-bold" style={{ color: sectorChange >= 0 ? "#00ff41" : "#ff4444" }}>
          AVG {sectorChange >= 0 ? "▲+" : "▼"}{sectorChange.toFixed(2)}%
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {assets.map((a) => (
          <AssetTile
            key={a.ticker}
            asset={a}
            goldChangePct={goldChangePct}
            weight={TILE_WEIGHTS[a.ticker] ?? 10}
          />
        ))}
      </div>
    </div>
  );
}

function Breadth({ assets }: { assets: Asset[] }) {
  const up = assets.filter((a) => a.changePct > 0).length;
  const down = assets.filter((a) => a.changePct < 0).length;
  const total = assets.length;
  const upPct = total > 0 ? (up / total) * 100 : 50;

  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] text-muted-foreground uppercase">BREADTH</span>
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-primary font-bold">{up}↑</span>
        <div className="w-32 h-2 bg-destructive/40 rounded-none overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${upPct}%` }} />
        </div>
        <span className="text-[10px] text-destructive font-bold">{down}↓</span>
      </div>
    </div>
  );
}

function CorrelationPanel({
  assets,
  goldChangePct,
}: {
  assets: Asset[];
  goldChangePct: number;
}) {
  const nonGold = assets.filter((a) => a.ticker !== "GC=F" && Math.abs(goldChangePct) > 0.01);
  const betas = nonGold
    .map((a) => ({ ticker: a.ticker, beta: a.changePct / goldChangePct, sector: a.sector }))
    .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta))
    .slice(0, 8);

  return (
    <div className="border border-primary/20 p-2">
      <p className="text-[10px] text-primary uppercase border-b border-primary/20 pb-1 mb-2">
        LIVE β vs GOLD — Intraday Realized Beta (assetΔ% / goldΔ%)
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {betas.map(({ ticker, beta }) => {
          const barWidth = Math.min(Math.abs(beta) * 50, 100);
          const color = Math.abs(beta) > 1.1 ? "#00ff41" : Math.abs(beta) > 0.6 ? "#ffd700" : "#00bcd4";
          return (
            <div key={ticker} className="flex items-center gap-2 py-0.5">
              <span className="text-[10px] font-mono text-accent w-12">{ticker}</span>
              <div className="flex-1 h-1.5 bg-primary/10">
                <div className="h-full" style={{ width: `${barWidth}%`, background: color }} />
              </div>
              <span className="text-[10px] font-mono w-10 text-right" style={{ color }}>
                {beta.toFixed(3)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[9px] text-muted-foreground mt-2">β=1.0 moves 1:1 with gold · β&gt;1 amplified · β&lt;0 inverse</p>
    </div>
  );
}

export function HeatmapTab() {
  const { data, isLoading, refetch, dataUpdatedAt } = useGetHeatmap({
    query: { queryKey: getGetHeatmapQueryKey(), refetchInterval: 30000 },
  });

  const [filter, setFilter] = useState("ALL");
  const sectors = ["ALL", ...SECTOR_ORDER];

  const allAssets: Asset[] = data?.assets ?? [];
  const goldChangePct = data?.goldChangePct ?? 0;
  const goldPrice = data?.goldPrice ?? 0;

  const visibleAssets = filter === "ALL" ? allAssets : allAssets.filter((a) => a.sector === filter);

  const grouped: Record<string, Asset[]> = {};
  for (const s of SECTOR_ORDER) {
    grouped[s] = visibleAssets.filter((a) => a.sector === s);
  }

  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : "—";

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase font-bold">GOLD HEATMAP</span>

        {/* Live gold price */}
        {data && (
          <div className="flex items-center gap-2 border border-primary/40 px-3 py-1 bg-black">
            <span className="text-[10px] text-muted-foreground">XAUUSD</span>
            <span className="text-primary font-bold text-sm">${goldPrice.toFixed(2)}</span>
            <span className={`text-sm font-bold ${goldChangePct >= 0 ? "text-primary" : "text-destructive"}`}>
              {goldChangePct >= 0 ? "▲+" : "▼"}{goldChangePct.toFixed(2)}%
            </span>
          </div>
        )}

        {data && <Breadth assets={allAssets} />}

        <div className="flex-1" />

        <span className="text-[9px] text-muted-foreground">UPD: {lastUpdate}</span>
        <button
          onClick={() => refetch()}
          className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black"
        >
          ↻
        </button>
      </div>

      {/* Sector filter tabs */}
      <div className="flex flex-wrap gap-1 px-1">
        {sectors.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`text-[10px] px-2 py-0.5 border transition-colors ${
              filter === s
                ? "border-accent text-accent bg-accent/10"
                : "border-primary/30 text-muted-foreground hover:border-primary/60 hover:text-primary"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="p-16 text-primary animate-pulse flex items-center justify-center text-xs">
          LOADING HEATMAP DATA █
        </div>
      ) : (
        <>
          {/* Treemap sectors */}
          <div className="flex flex-col gap-2">
            {SECTOR_ORDER.filter((s) => grouped[s]?.length > 0).map((s) => (
              <SectorBlock
                key={s}
                sector={s}
                assets={grouped[s]}
                goldChangePct={goldChangePct}
              />
            ))}
          </div>

          {/* Live beta panel */}
          {Math.abs(goldChangePct) > 0.01 && (
            <CorrelationPanel assets={allAssets} goldChangePct={goldChangePct} />
          )}

          {/* Country ETF performance */}
          {data?.countryPerf && data.countryPerf.length > 0 && (
            <div className="border border-primary/20 p-2">
              <p className="text-[10px] text-muted-foreground uppercase mb-2 border-b border-primary/20 pb-1">
                GLOBAL ETF PERFORMANCE
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.countryPerf.map((c) => {
                  const bg = heatColor(c.changePct);
                  const fg = textColor(c.changePct);
                  return (
                    <div
                      key={c.country}
                      className="flex flex-col items-center justify-center border px-3 py-2 min-w-[80px]"
                      style={{ background: bg, borderColor: bg, color: fg }}
                    >
                      <span className="font-bold text-[11px]">{c.country}</span>
                      <span className="text-[9px] opacity-70">{c.code}</span>
                      <span className="text-xs font-bold">
                        {c.changePct >= 0 ? "▲+" : "▼"}{c.changePct.toFixed(2)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Legend */}
          <div className="flex items-center gap-2 flex-wrap text-[9px] px-1 text-muted-foreground">
            <span>SCALE:</span>
            {[
              [">+3%", "#00c851"], ["+1.5%", "#00e64d"], ["+0.5%", "#33ff77"], ["flat", "#1a1a1a"],
              ["-0.5%", "#ff8888"], ["-1.5%", "#ff4444"], ["<-3%", "#990000"],
            ].map(([l, c]) => (
              <span key={l} className="flex items-center gap-1">
                <span className="w-3 h-3 inline-block border border-white/10" style={{ background: c }} />
                {l}
              </span>
            ))}
            <span className="ml-2">· Hover tiles for detail · β = intraday realized beta vs XAUUSD · Auto-refresh 30s</span>
          </div>
        </>
      )}
    </div>
  );
}
