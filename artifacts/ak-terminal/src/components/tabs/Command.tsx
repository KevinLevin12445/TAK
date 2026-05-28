import { useState } from "react";
import { useGetGoldHistory, getGetGoldHistoryQueryKey } from "@workspace/api-client-react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

const INTERVALS = ["1m","2m","5m","15m","30m","1h","1d"];
const PERIODS   = ["1d","2d","5d","1mo","3mo","6mo","1y"];

export function Command() {
  const [interval, setInterval] = useState("5m");
  const [period,   setPeriod]   = useState("2d");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const { data, isLoading, refetch } = useGetGoldHistory(
    { interval, period },
    { query: { queryKey: getGetGoldHistoryQueryKey(), refetchInterval: autoRefresh ? 60000 : (false as false) } }
  );

  const candles = data?.candles ?? [];

  const chartData = candles.map((c) => ({
    time: new Date(c.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    open: c.open,
    close: c.close,
    high: c.high,
    low: c.low,
    volume: c.volume,
    sma20: c.sma20,
    sma50: c.sma50,
    rsi: c.rsi,
    // candlestick as bar
    barLow: Math.min(c.open, c.close),
    barHigh: Math.max(c.open, c.close),
    range: Math.abs(c.high - c.low),
    rangeBase: c.low,
    bullish: c.close >= c.open,
  }));

  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const firstClose = candles[0]?.close ?? lastClose;
  const dayChange = lastClose - firstClose;
  const dayChangePct = firstClose ? (dayChange / firstClose) * 100 : 0;

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase">COMMAND CENTER — XAUUSD</span>
        <span className={`text-xs font-bold ml-4 ${dayChange >= 0 ? "text-primary" : "text-destructive"}`}>
          {dayChange >= 0 ? "▲+" : "▼"}{Math.abs(dayChange).toFixed(2)} ({dayChangePct.toFixed(2)}%)
        </span>
        <div className="flex-1" />
        <div className="flex gap-2 items-center flex-wrap">
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
          <button onClick={() => setAutoRefresh(!autoRefresh)}
            className={`text-xs px-2 py-1 border ${autoRefresh ? "border-primary text-primary" : "border-primary/30 text-muted-foreground"}`}>
            AUTO-REFRESH {autoRefresh ? "ON" : "OFF"}
          </button>
          <button onClick={() => refetch()}
            className="text-xs px-2 py-1 border border-primary/40 text-primary hover:bg-primary hover:text-black">
            ↻ REFRESH
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-primary animate-pulse">
          LOADING CHART DATA <span className="ml-2">█</span>
        </div>
      ) : (
        <>
          {/* Price Chart */}
          <div className="border border-primary/20 p-1">
            <p className="text-[10px] text-muted-foreground px-1 mb-1">
              OHLCV — {data?.ticker} ({interval}) · SMA20=<span className="text-accent">{chartData[chartData.length-1]?.sma20?.toFixed(2) ?? "—"}</span> · SMA50=<span className="text-secondary">{chartData[chartData.length-1]?.sma50?.toFixed(2) ?? "—"}</span>
            </p>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="#00ff4115" />
                <XAxis dataKey="time" tick={{ fill: "#00ff4166", fontSize: 9 }} interval="preserveStartEnd" />
                <YAxis domain={["auto","auto"]} tick={{ fill: "#00ff4166", fontSize: 9 }} width={68}
                  tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
                <Tooltip
                  contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10, fontFamily: "monospace" }}
                  labelStyle={{ color: "#00ff41" }}
                  itemStyle={{ color: "#ffd700" }}
                  formatter={(v: number) => `$${v.toFixed(2)}`}
                />
                {/* wick lines */}
                <Bar dataKey="range" stackId="wick" fill="transparent" stroke="#00ff4144" />
                {/* body bars */}
                <Bar dataKey="barHigh" stackId="body" fill="transparent"
                  // @ts-ignore
                  shape={(props: any) => {
                    const { x, y, width, height, payload } = props;
                    const color = payload.bullish ? "#00ff41" : "#ff4444";
                    return <rect x={x + width * 0.15} y={y} width={width * 0.7} height={height} fill={color} fillOpacity={0.85} />;
                  }}
                />
                <Line type="monotone" dataKey="sma20" stroke="#ffd700" dot={false} strokeWidth={1} connectNulls />
                <Line type="monotone" dataKey="sma50" stroke="#00bcd4" dot={false} strokeWidth={1} connectNulls />
                <ReferenceLine y={lastClose} stroke="#00ff4166" strokeDasharray="4 2" label={{ value: `$${lastClose.toFixed(2)}`, fill: "#00ff41", fontSize: 9 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* RSI */}
          <div className="border border-primary/20 p-1">
            <p className="text-[10px] text-muted-foreground px-1 mb-1">RSI (14) · OB=70 OS=30</p>
            <ResponsiveContainer width="100%" height={100}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid stroke="#00ff4108" />
                <XAxis dataKey="time" tick={{ fill: "#00ff4144", fontSize: 8 }} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fill: "#00ff4166", fontSize: 9 }} width={30} />
                <Tooltip contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10 }}
                  formatter={(v: number) => v?.toFixed(2)} />
                <ReferenceLine y={70} stroke="#ff444466" strokeDasharray="4 2" />
                <ReferenceLine y={30} stroke="#00ff4166" strokeDasharray="4 2" />
                <Line type="monotone" dataKey="rsi" stroke="#00bcd4" dot={false} strokeWidth={1.5} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Volume */}
          <div className="border border-primary/20 p-1">
            <p className="text-[10px] text-muted-foreground px-1 mb-1">VOLUME</p>
            <ResponsiveContainer width="100%" height={70}>
              <ComposedChart data={chartData} margin={{ top: 2, right: 8, left: 0, bottom: 2 }}>
                <XAxis dataKey="time" hide />
                <YAxis tick={{ fill: "#00ff4166", fontSize: 8 }} width={40} tickFormatter={(v) => (v/1e6).toFixed(1)+"M"} />
                <Bar dataKey="volume"
                  // @ts-ignore
                  shape={(props: any) => {
                    const { x, y, width, height, payload } = props;
                    return <rect x={x} y={y} width={width} height={height} fill={payload.bullish ? "#00ff4188" : "#ff444488"} />;
                  }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
