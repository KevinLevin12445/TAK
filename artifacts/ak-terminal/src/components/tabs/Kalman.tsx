import { useState } from "react";
import { useGetKalman, getGetKalmanQueryKey } from "@workspace/api-client-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const PERIODS = ["2wk","1mo","3mo","6mo","1y"];

export function KalmanTab() {
  const [period, setPeriod] = useState("1mo");
  const { data, isLoading, refetch } = useGetKalman({ period }, { query: { queryKey: getGetKalmanQueryKey(), refetchInterval: 60000 } });

  const chartData = (data?.points ?? []).map((p) => ({
    time: new Date(p.time).toLocaleDateString([], { month: "short", day: "numeric" }),
    price: p.price,
    trend: parseFloat(p.trend.toFixed(2)),
    upper: parseFloat(p.upper.toFixed(2)),
    lower: parseFloat(p.lower.toFixed(2)),
  }));

  const signalColor =
    data?.signal === "BULLISH" ? "#00ff41" :
    data?.signal === "BEARISH" ? "#ff4444" : "#ffd700";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase">KALMAN FILTER — XAUUSD</span>
        {data && (
          <span className="text-xs border px-2 py-0.5 font-bold"
            style={{ borderColor: signalColor, color: signalColor }}>
            {data.signal}
          </span>
        )}
        {data && (
          <span className="text-xs text-muted-foreground">
            TREND: <span className="text-accent">${data.currentTrend.toFixed(2)}</span>
          </span>
        )}
        <div className="flex-1" />
        <label className="text-muted-foreground text-xs">PERIOD</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={() => refetch()}
          className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">
          ↻ REFRESH
        </button>
      </div>

      <div className="flex gap-4 text-xs px-2">
        <span style={{ color: "#00bcd4" }}>— PRICE</span>
        <span style={{ color: "#00ff41" }}>— KALMAN TREND</span>
        <span style={{ color: "#ffd70088" }}>— UPPER BAND</span>
        <span style={{ color: "#ff444488" }}>— LOWER BAND</span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-8 text-primary animate-pulse">
          LOADING KALMAN DATA █
        </div>
      ) : (
        <div className="border border-primary/20 p-1">
          <ResponsiveContainer width="100%" height={480}>
            <LineChart data={chartData} margin={{ top: 4, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="#00ff4110" />
              <XAxis dataKey="time" tick={{ fill: "#00ff4166", fontSize: 9 }} interval="preserveStartEnd" />
              <YAxis domain={["auto","auto"]} tick={{ fill: "#00ff4166", fontSize: 9 }} width={72}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
              <Tooltip
                contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10, fontFamily: "monospace" }}
                labelStyle={{ color: "#00ff41" }}
                formatter={(v: number) => `$${v?.toFixed(2)}`}
              />
              <Line type="monotone" dataKey="upper" stroke="#ffd70066" dot={false} strokeWidth={1} strokeDasharray="4 2" name="Upper" />
              <Line type="monotone" dataKey="lower" stroke="#ff444466" dot={false} strokeWidth={1} strokeDasharray="4 2" name="Lower" />
              <Line type="monotone" dataKey="price" stroke="#00bcd4" dot={false} strokeWidth={1.5} name="Price" />
              <Line type="monotone" dataKey="trend" stroke="#00ff41" dot={false} strokeWidth={2} name="Kalman Trend" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-3 gap-2">
          <div className="border border-primary/20 p-3 bg-black">
            <div className="text-[10px] text-muted-foreground">CURRENT TREND</div>
            <div className="text-lg font-bold mt-1 text-primary">${data.currentTrend.toFixed(2)}</div>
          </div>
          <div className="border p-3 bg-black" style={{ borderColor: signalColor + "55" }}>
            <div className="text-[10px] text-muted-foreground">SIGNAL</div>
            <div className="text-lg font-bold mt-1" style={{ color: signalColor }}>{data.signal}</div>
          </div>
          <div className="border border-accent/20 p-3 bg-black">
            <div className="text-[10px] text-muted-foreground">TICKER</div>
            <div className="text-lg font-bold mt-1 text-accent">{data.ticker}</div>
          </div>
        </div>
      )}
    </div>
  );
}
