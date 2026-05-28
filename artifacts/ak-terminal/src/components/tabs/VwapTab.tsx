import { useState } from "react";
import { useGetVwap, getGetVwapQueryKey } from "@workspace/api-client-react";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

const INTERVALS = ["1m","5m","15m","30m","1h"];
const PERIODS   = ["1d","2d","5d"];

const BAND_COLORS = ["#00ff41","#00bcd4","#ffd700","#ff8800","#ff4444"];

export function VwapTab() {
  const [interval, setInterval] = useState("5m");
  const [period,   setPeriod]   = useState("2d");
  const { data, isLoading, refetch } = useGetVwap(
    { interval, period },
    { query: { queryKey: getGetVwapQueryKey(), refetchInterval: 60000 } }
  );

  const chartData = (data?.points ?? []).map((p) => ({
    time: new Date(p.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    price: p.price,
    vwapSession: p.vwapSession,
    vwapTotal: p.vwapTotal,
    sd1p: p.sd1p, sd1n: p.sd1n,
    sd2p: p.sd2p, sd2n: p.sd2n,
    sd3p: p.sd3p, sd3n: p.sd3n,
    sd4p: p.sd4p, sd4n: p.sd4n,
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 border border-primary/30 p-2">
        <span className="text-primary text-xs uppercase">VWAP + BANDAS DE DESVIACIÓN ESTÁNDAR = XAUUSD</span>
        <div className="flex-1" />
        <label className="text-muted-foreground text-xs">Ticker</label>
        <span className="text-primary text-xs border border-primary/40 px-2 py-1">GC=F</span>
        <label className="text-muted-foreground text-xs">Intervalo</label>
        <select value={interval} onChange={(e) => setInterval(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <label className="text-muted-foreground text-xs">Período</label>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}
          className="bg-black border border-primary/40 text-primary text-xs px-2 py-1">
          {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={() => refetch()}
          className="text-xs px-2 py-1 border border-primary text-primary hover:bg-primary hover:text-black flex items-center gap-1">
          ↻ REFRESH
        </button>
      </div>

      {/* Chart legend */}
      <div className="flex flex-wrap gap-3 text-[10px] px-2">
        {[
          { c: "#ff44ff", l: "+4 SD" }, { c: "#ff8800", l: "+3 SD" }, { c: "#ffd700", l: "+2 SD" }, { c: "#00bcd4", l: "+1 SD" },
          { c: "#00ff41", l: "VWAP Sesión" }, { c: "#ffffff88", l: "VWAP Total" },
          { c: "#00bcd4", l: "-1 SD" }, { c: "#ffd700", l: "-2 SD" }, { c: "#ff8800", l: "-3 SD" }, { c: "#ff44ff", l: "-4 SD" },
          { c: "#00bcd4", l: "Precio" },
        ].map((s) => (
          <span key={s.l} style={{ color: s.c }}>— {s.l}</span>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-16 text-primary animate-pulse">LOADING VWAP DATA █</div>
      ) : (
        <div className="border border-primary/20 p-1">
          <p className="text-[10px] text-muted-foreground px-1 mb-1">
            VWAP + BANDAS SD | XAUUSD ({interval}) ·
            Hora: {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} |
            Precio: <span className="text-accent">${data?.currentPrice?.toFixed(2)}</span> |
            VWAP Sesión: <span className="text-primary">${data?.vwapSession?.toFixed(2)}</span> |
            VWAP Total: <span className="text-primary">${data?.vwapTotal?.toFixed(2)}</span>
          </p>
          <ResponsiveContainer width="100%" height={500}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 30, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="#00ff4110" />
              <XAxis dataKey="time" tick={{ fill: "#00ff4144", fontSize: 8 }} interval="preserveStartEnd" />
              <YAxis domain={["auto","auto"]} tick={{ fill: "#00ff4166", fontSize: 9 }} width={72}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`} />
              <Tooltip contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10, fontFamily: "monospace" }}
                formatter={(v: number, name: string) => [`$${v?.toFixed(2)}`, name]} />
              {/* SD bands */}
              <Line type="monotone" dataKey="sd4p" stroke="#ff44ff88" dot={false} strokeWidth={1} name="+4 SD" />
              <Line type="monotone" dataKey="sd3p" stroke="#ff880088" dot={false} strokeWidth={1} name="+3 SD" />
              <Line type="monotone" dataKey="sd2p" stroke="#ffd70088" dot={false} strokeWidth={1} name="+2 SD" />
              <Line type="monotone" dataKey="sd1p" stroke="#00bcd488" dot={false} strokeWidth={1} name="+1 SD" />
              <Line type="monotone" dataKey="sd1n" stroke="#00bcd488" dot={false} strokeWidth={1} name="-1 SD" />
              <Line type="monotone" dataKey="sd2n" stroke="#ffd70088" dot={false} strokeWidth={1} name="-2 SD" />
              <Line type="monotone" dataKey="sd3n" stroke="#ff880088" dot={false} strokeWidth={1} name="-3 SD" />
              <Line type="monotone" dataKey="sd4n" stroke="#ff44ff88" dot={false} strokeWidth={1} name="-4 SD" />
              {/* VWAP lines */}
              <Line type="monotone" dataKey="vwapTotal" stroke="#ffffff88" dot={false} strokeWidth={1.5} strokeDasharray="6 3" name="VWAP Total" />
              <Line type="monotone" dataKey="vwapSession" stroke="#00ff41" dot={false} strokeWidth={2} name="VWAP Sesión" />
              {/* Price */}
              <Line type="monotone" dataKey="price" stroke="#00bcd4" dot={false} strokeWidth={1.5} name="Precio" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground px-1">
        VWAP Sesión = Σ(TP·Vol)/Σ(Vol) por día · Bandas = VWAP ± n·σ(precio típico) · Caché 5 min · Fuente: Yahoo Finance
      </p>
    </div>
  );
}
