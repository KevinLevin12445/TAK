import { useState } from "react";
import { useGetHmmRegimes, getGetHmmRegimesQueryKey } from "@workspace/api-client-react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea, Cell
} from "recharts";

const PERIODS = ["1mo","3mo","6mo","1y"];
const REGIME_COLORS: Record<number, string> = {
  0: "#ff4444",
  1: "#ffd700",
  2: "#00ff41",
};

export function HmmRegimes() {
  const [period, setPeriod] = useState("3mo");
  const { data, isLoading, refetch } = useGetHmmRegimes({ period }, { query: { queryKey: getGetHmmRegimesQueryKey(), refetchInterval: 120000 } });

  const points = data?.points ?? [];
  const chartData = points.map((p) => ({
    time: new Date(p.time).toLocaleDateString([], { month: "short", day: "numeric" }),
    price: p.price,
    regime: p.regime,
    regimeLabel: p.regimeLabel,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase">HMM REGIMES — XAUUSD</span>
        {data && (
          <span className="text-xs border px-2 py-0.5 font-bold"
            style={{ borderColor: REGIME_COLORS[data.currentRegime], color: REGIME_COLORS[data.currentRegime] }}>
            CURRENT: {data.currentLabel}
          </span>
        )}
        <div className="flex-1" />
        <label className="text-muted-foreground text-xs">PERIOD</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={() => refetch()} className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">↻</button>
      </div>

      {/* Regime legend */}
      {data && (
        <div className="flex gap-4 flex-wrap px-2">
          {data.regimes.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs border px-2 py-1" style={{ borderColor: r.color }}>
              <span className="w-2 h-2 inline-block" style={{ background: r.color }} />
              <span style={{ color: r.color }}>{r.label}</span>
              <span className="text-muted-foreground">{r.pct}%</span>
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="p-8 text-primary animate-pulse">LOADING HMM REGIMES █</div>
      ) : (
        <div className="border border-primary/20 p-1">
          <ResponsiveContainer width="100%" height={460}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="#00ff4110" />
              <XAxis dataKey="time" tick={{ fill: "#00ff4166", fontSize: 9 }} interval="preserveStartEnd" />
              <YAxis domain={["auto","auto"]} tick={{ fill: "#00ff4166", fontSize: 9 }} width={72}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
              <Tooltip
                contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10, fontFamily: "monospace" }}
                labelStyle={{ color: "#00ff41" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload;
                  return (
                    <div style={{ background: "#000", border: `1px solid ${REGIME_COLORS[d?.regime ?? 1]}`, padding: "6px", fontSize: 10, fontFamily: "monospace" }}>
                      <p style={{ color: "#00ff41" }}>{label}</p>
                      <p style={{ color: "#ffd700" }}>Price: ${d?.price?.toFixed(2)}</p>
                      <p style={{ color: REGIME_COLORS[d?.regime ?? 1] }}>Regime: {d?.regimeLabel}</p>
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="price"
                dot={false}
                strokeWidth={2}
                stroke="#00bcd4"
                // Color by regime
              />
            </ComposedChart>
          </ResponsiveContainer>
          {/* Color-coded regime background strips */}
          <div className="mt-2 flex h-4">
            {chartData.map((d, i) => (
              <div key={i} className="flex-1 opacity-40" style={{ background: REGIME_COLORS[d.regime] ?? "#888" }} />
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground px-1 mt-1">REGIME TIMELINE — green=bull, gold=neutral, red=bear</p>
        </div>
      )}
    </div>
  );
}
