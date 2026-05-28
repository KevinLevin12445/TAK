import { useGetPortfolio, getGetPortfolioQueryKey } from "@workspace/api-client-react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts";

function MetricBox({ label, value, color = "#00ff41" }: { label: string; value: string; color?: string }) {
  return (
    <div className="border p-2 bg-black flex flex-col gap-1" style={{ borderColor: color + "44" }}>
      <span className="text-[10px] text-muted-foreground uppercase">{label}</span>
      <span className="text-sm font-bold" style={{ color }}>{value}</span>
    </div>
  );
}

export function PortfolioTab() {
  const { data, isLoading } = useGetPortfolio({ query: { queryKey: getGetPortfolioQueryKey(), refetchInterval: 300000 } });

  if (isLoading) return <div className="p-8 text-primary animate-pulse">COMPUTING MARKOWITZ EFFICIENT FRONTIER █</div>;
  if (!data) return <div className="p-4 text-destructive text-xs">ERR: NO PORTFOLIO DATA</div>;

  const frontierData = (data.frontier ?? []).map((p) => ({
    x: p.risk * 100,
    y: p.return_ * 100,
    sharpe: p.sharpe,
  }));

  const tickers = data.tickers ?? [];
  const corrMatrix = data.correlationMatrix ?? [];

  return (
    <div className="flex flex-col gap-3">
      {/* Header metrics */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
        <MetricBox label="PORTFOLIO RETURN" value={`${(data.portfolioReturn * 100).toFixed(2)}%`} color="#00ff41" />
        <MetricBox label="PORTFOLIO VOL" value={`${(data.portfolioVol * 100).toFixed(2)}%`} color="#ffd700" />
        <MetricBox label="SHARPE RATIO" value={data.portfolioSharpe?.toFixed(4)} color="#00bcd4" />
        <MetricBox label="OPT RETURN" value={`${(data.optimalPortfolio.return_ * 100).toFixed(2)}%`} color="#00ff41" />
        <MetricBox label="OPT RISK" value={`${(data.optimalPortfolio.risk * 100).toFixed(2)}%`} color="#ffd700" />
        <MetricBox label="OPT SHARPE" value={data.optimalPortfolio.sharpe?.toFixed(4)} color="#00bcd4" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Efficient Frontier Chart */}
        <div className="lg:col-span-2 border border-primary/20 p-2">
          <p className="text-[10px] text-muted-foreground mb-1 uppercase">
            MARKOWITZ EFFICIENT FRONTIER (2000 SIMULATED PORTFOLIOS) — GC=F, GLD, NEM, GOLD, AEM, FNV
          </p>
          <ResponsiveContainer width="100%" height={380}>
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid stroke="#00ff4110" />
              <XAxis type="number" dataKey="x" name="Risk (%)" tick={{ fill: "#00ff4166", fontSize: 9 }}
                label={{ value: "Risk (Ann. Vol %)", fill: "#00ff4166", fontSize: 9, dy: 10 }} />
              <YAxis type="number" dataKey="y" name="Return (%)" tick={{ fill: "#00ff4166", fontSize: 9 }} width={52}
                label={{ value: "Return (%)", fill: "#00ff4166", fontSize: 9, angle: -90, dx: -10 }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10, fontFamily: "monospace" }}
                formatter={(v: number, n: string) => [n === "sharpe" ? v?.toFixed(4) : `${v?.toFixed(2)}%`, n.toUpperCase()]} />
              <Scatter data={frontierData}
                shape={(props: any) => {
                  const { cx, cy, payload } = props;
                  const sharpe = payload.sharpe ?? 0;
                  const color = sharpe > 1 ? "#00ff41" : sharpe > 0.5 ? "#ffd700" : sharpe > 0 ? "#00bcd4" : "#ff4444";
                  return <circle cx={cx} cy={cy} r={3} fill={color} fillOpacity={0.6} />;
                }}
              />
            </ScatterChart>
          </ResponsiveContainer>
          <div className="flex gap-3 text-[10px] flex-wrap mt-1">
            {[["Sharpe>1","#00ff41"],["Sharpe>0.5","#ffd700"],["Sharpe>0","#00bcd4"],["Sharpe<0","#ff4444"]].map(([l,c]) => (
              <span key={l} style={{ color: c as string }}>● {l}</span>
            ))}
          </div>
        </div>

        {/* Assets Table */}
        <div className="border border-primary/20 flex flex-col">
          <p className="text-[10px] text-primary uppercase border-b border-primary/20 px-2 py-1">OPTIMAL WEIGHTS + ASSET STATS</p>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-primary/20">
                {["ASSET","WEIGHT","RET","VOL","SHARPE","PRICE"].map((h) => (
                  <th key={h} className="text-left px-2 py-1 text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data.assets ?? []).map((a) => (
                <tr key={a.ticker} className="border-b border-primary/10 hover:bg-primary/5">
                  <td className="px-2 py-1 text-accent font-bold">{a.ticker}</td>
                  <td className="px-2 py-1 text-primary">{(a.weight * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1" style={{ color: a.expectedReturn > 0 ? "#00ff41" : "#ff4444" }}>
                    {(a.expectedReturn * 100).toFixed(1)}%
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{(a.volatility * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1" style={{ color: a.sharpe > 0.5 ? "#00ff41" : a.sharpe > 0 ? "#ffd700" : "#ff4444" }}>
                    {a.sharpe?.toFixed(3)}
                  </td>
                  <td className="px-2 py-1 text-primary">${a.price?.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Correlation Matrix */}
      {corrMatrix.length > 0 && (
        <div className="border border-primary/20 p-2 overflow-auto">
          <p className="text-[10px] text-muted-foreground uppercase mb-2">CORRELATION MATRIX</p>
          <table className="text-[10px]">
            <thead>
              <tr>
                <th className="px-3 py-1 text-left text-muted-foreground w-20"></th>
                {tickers.map((t) => <th key={t} className="px-3 py-1 text-muted-foreground">{t}</th>)}
              </tr>
            </thead>
            <tbody>
              {corrMatrix.map((row, i) => (
                <tr key={i}>
                  <td className="px-3 py-1 text-accent font-bold">{tickers[i]}</td>
                  {row.map((v, j) => {
                    const abs = Math.abs(v);
                    const bg = i === j ? "#00ff4122" : abs > 0.8 ? (v > 0 ? "#00ff4144" : "#ff444444") : abs > 0.5 ? (v > 0 ? "#00ff4122" : "#ff444422") : "#00000000";
                    const color = i === j ? "#00ff41" : abs > 0.5 ? (v > 0 ? "#00ff41" : "#ff4444") : "#ffd700";
                    return (
                      <td key={j} className="px-3 py-1 text-center" style={{ background: bg, color }}>{v?.toFixed(3)}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
