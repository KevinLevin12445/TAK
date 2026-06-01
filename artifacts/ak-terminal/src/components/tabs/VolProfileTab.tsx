import { useState } from "react";
import { useGetVolumeProfile, getGetVolumeProfileQueryKey } from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from "recharts";

const INTERVALS = ["1m","5m","15m","30m","1h","1d"];
const PERIODS   = ["1d","2d","5d","1mo"];

export function VolProfileTab() {
  const [interval, setInterval] = useState("15m");
  const [period,   setPeriod]   = useState("5d");

  const { data, isLoading, refetch } = useGetVolumeProfile(
    { interval, period },
    { query: { queryKey: getGetVolumeProfileQueryKey(), refetchInterval: 60000 } }
  );

  const profileData = (data?.profile ?? []).map((b) => ({
    price: b.price,
    volume: b.volume,
    buyVol:  b.buyVol,
    sellVol: b.sellVol,
    poc: b.poc,
    vah: b.vah,
    val: b.val,
  }));

  const poc    = data?.poc    ?? 0;
  const vah    = data?.vah    ?? 0;
  const val    = data?.val    ?? 0;
  const maxVol = Math.max(...profileData.map((d) => d.volume), 1);

  return (
    <div className="flex flex-col gap-2">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase">VOL PROFILE — XAUUSD</span>
        {data && (
          <span className="text-[10px] text-muted-foreground ml-3">
            POC: <span className="text-accent">${poc?.toFixed(2)}</span> ·
            VAH: <span className="text-primary">${vah?.toFixed(2)}</span> ·
            VAL: <span className="text-destructive">${val?.toFixed(2)}</span> ·
            Value Area 70%
          </span>
        )}
        <div className="flex-1" />
        <label className="text-muted-foreground text-xs">INTERVAL</label>
        <select value={interval} onChange={(e) => setInterval(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <label className="text-muted-foreground text-xs">PERIOD</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={() => refetch()} className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">↻</button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center p-16 text-primary animate-pulse">LOADING VOL PROFILE █</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
          {/* Horizontal bar chart */}
          <div className="lg:col-span-3 border border-primary/20 p-2">
            <p className="text-[10px] text-muted-foreground mb-1 uppercase">
              VOLUME PROFILE HISTOGRAM — Price levels (Y) vs Volume (X)
            </p>
            <ResponsiveContainer width="100%" height={520}>
              <BarChart
                layout="vertical"
                data={profileData}
                margin={{ top: 4, right: 10, left: 72, bottom: 4 }}
              >
                <CartesianGrid stroke="#00ff4110" />
                <XAxis type="number" tick={{ fill: "#00ff4166", fontSize: 8 }}
                  tickFormatter={(v) => (v/1000).toFixed(0)+"K"} />
                <YAxis type="category" dataKey="price" tick={{ fill: "#00ff4166", fontSize: 8 }}
                  tickFormatter={(v) => `$${Number(v).toFixed(0)}`} width={65} />
                <Tooltip contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10, fontFamily: "monospace" }}
                  formatter={(v: number, name: string) => [v?.toLocaleString(), name.toUpperCase()]} />
                <ReferenceLine x={0} stroke="#ffffff22" />
                <Bar dataKey="buyVol" name="Buy Vol" fill="#00ff41" fillOpacity={0.7} stackId="vol" />
                <Bar dataKey="sellVol" name="Sell Vol" fill="#ff4444" fillOpacity={0.7} stackId="vol" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Stats panel */}
          <div className="border border-primary/20 p-3 flex flex-col gap-2">
            <p className="text-[10px] text-primary uppercase border-b border-primary/20 pb-1">KEY LEVELS</p>
            {[
              { label: "POC (Point of Control)", value: `$${poc?.toFixed(2)}`, color: "#ffd700" },
              { label: "VAH (Value Area High)", value: `$${vah?.toFixed(2)}`, color: "#00ff41" },
              { label: "VAL (Value Area Low)",  value: `$${val?.toFixed(2)}`, color: "#ff4444" },
              { label: "TICKER",  value: data?.ticker ?? "GC=F", color: "#00bcd4" },
              { label: "INTERVAL", value: interval,             color: "#00ff41" },
            ].map((m) => (
              <div key={m.label} className="border border-primary/10 p-2 bg-black">
                <div className="text-[10px] text-muted-foreground">{m.label}</div>
                <div className="text-sm font-bold mt-1" style={{ color: m.color }}>{m.value}</div>
              </div>
            ))}

            <p className="text-[10px] text-primary uppercase border-b border-primary/20 pb-1 mt-2">TOP VOLUME NODES</p>
            <div className="overflow-auto max-h-48">
              {[...profileData]
                .sort((a, b) => b.volume - a.volume)
                .slice(0, 10)
                .map((d, i) => (
                  <div key={d.price} className="flex items-center gap-2 py-0.5 border-b border-primary/10 text-[10px]">
                    <span className="text-muted-foreground w-4">{i + 1}.</span>
                    <span className="text-accent">${Number(d.price).toFixed(2)}</span>
                    <div className="flex-1 bg-primary/10 h-1.5">
                      <div className="h-full bg-primary/50" style={{ width: `${(d.volume / maxVol) * 100}%` }} />
                    </div>
                    <span className="text-primary/70">{(d.volume / 1000).toFixed(0)}K</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
