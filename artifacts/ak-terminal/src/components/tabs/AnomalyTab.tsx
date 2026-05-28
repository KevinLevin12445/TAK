import { useState } from "react";
import { useGetAnomaly, getGetAnomalyQueryKey } from "@workspace/api-client-react";
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

const PERIODS = ["2d","5d","1mo","3mo"];

export function AnomalyTab() {
  const [period,    setPeriod]    = useState("5d");
  const [window_,   setWindow]    = useState(20);
  const [threshold, setThreshold] = useState(2.0);

  const { data, isLoading, refetch } = useGetAnomaly(
    { period, window: window_, threshold },
    { query: { queryKey: getGetAnomalyQueryKey(), refetchInterval: 60000 } }
  );

  const ms5Data  = (data?.ms5  ?? []).map((p) => ({
    time: new Date(p.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    return: p.return_ * 100,
    up:   p.anomalyUp   ? p.return_ * 100 : null,
    down: p.anomalyDown ? p.return_ * 100 : null,
    zscore: p.zscore,
  }));

  const ms15Data = (data?.ms15 ?? []).map((p) => ({
    time: new Date(p.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    return: p.return_ * 100,
    up:   p.anomalyUp   ? p.return_ * 100 : null,
    down: p.anomalyDown ? p.return_ * 100 : null,
    zscore: p.zscore,
  }));

  const log = data?.log ?? [];

  const chartProps = {
    margin: { top: 4, right: 10, left: 0, bottom: 4 },
  };

  const axisStyle  = { fill: "#00ff4166", fontSize: 8 };
  const gridStyle  = { stroke: "#00ff4110" };
  const ttStyle    = { background: "#000", border: "1px solid #00ff41", fontSize: 10, fontFamily: "monospace" };

  return (
    <div className="flex flex-col gap-2">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase">YFINANCE ANOMALY DR — GC=F</span>
        {data && (
          <span className="text-[10px] text-muted-foreground">
            ventana={window_} · umbral=±{threshold.toFixed(2)} · señales de reversión a la media
          </span>
        )}
        <div className="flex-1" />
        <label className="text-muted-foreground text-xs">PERIOD</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="text-muted-foreground text-xs">WINDOW={window_}</label>
        <input type="range" min={5} max={50} value={window_} onChange={(e) => setWindow(+e.target.value)}
          className="accent-primary w-20" />
        <label className="text-muted-foreground text-xs">σ={threshold}</label>
        <input type="range" min={1} max={4} step={0.25} value={threshold} onChange={(e) => setThreshold(+e.target.value)}
          className="accent-primary w-20" />
        <button onClick={() => refetch()} className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">↻</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-2">
        {/* Charts */}
        <div className="lg:col-span-3 flex flex-col gap-2">
          {isLoading ? (
            <div className="p-16 text-primary animate-pulse flex items-center justify-center">LOADING ANOMALY DATA █</div>
          ) : (
            <>
              {[{ title: "Anomalías MS5", chartData: ms5Data }, { title: "Anomalías MS15", chartData: ms15Data }].map(({ title, chartData }) => (
                <div key={title} className="border border-primary/20 p-1">
                  <p className="text-[10px] text-muted-foreground px-1 mb-1">{title}</p>
                  <ResponsiveContainer width="100%" height={200}>
                    <ComposedChart data={chartData} {...chartProps}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis dataKey="time" tick={axisStyle} interval="preserveStartEnd" />
                      <YAxis tick={axisStyle} width={55} tickFormatter={(v) => v.toFixed(4)} />
                      <ReferenceLine y={0} stroke="#ffffff33" strokeDasharray="3 2" />
                      <ReferenceLine y={threshold * 0.01} stroke="#ff444466" strokeDasharray="4 2" label={{ value: `+${threshold}σ`, fill: "#ff4444", fontSize: 8 }} />
                      <ReferenceLine y={-threshold * 0.01} stroke="#00ff4166" strokeDasharray="4 2" label={{ value: `-${threshold}σ`, fill: "#00ff41", fontSize: 8 }} />
                      <Tooltip contentStyle={ttStyle} formatter={(v: number) => v?.toFixed(6)} />
                      <Line type="monotone" dataKey="return" stroke="#ffd700" dot={false} strokeWidth={1} />
                      <Scatter dataKey="up"   fill="#ff00ff" shape="circle" />
                      <Scatter dataKey="down" fill="#00bcd4" shape="circle" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Log */}
        <div className="border border-primary/20 flex flex-col">
          <p className="text-[10px] text-primary uppercase border-b border-primary/20 px-2 py-1">REGISTRO</p>
          <div className="overflow-auto flex-1 max-h-[450px]">
            {log.map((entry, i) => (
              <div key={i} className="border-b border-primary/10 px-2 py-1 text-[10px]">
                <span className="text-muted-foreground">{new Date(entry.time).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <br />
                <span className={entry.value > 0 ? "text-primary" : "text-destructive"}>
                  {entry.scale} {entry.value > 0 ? "▲" : "▼"} {entry.value > 0 ? "+" : ""}{entry.value.toFixed(4)}
                </span>
              </div>
            ))}
            {!log.length && <p className="text-muted-foreground text-[10px] p-2">No anomalies detected</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
