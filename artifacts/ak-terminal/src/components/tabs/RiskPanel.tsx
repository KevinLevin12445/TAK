import { useGetRiskMetrics, useGetInsider, useGetFactorFeatures, getGetRiskMetricsQueryKey, getGetInsiderQueryKey } from "@workspace/api-client-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

function MetricBox({ label, value, color = "#00ff41" }: { label: string; value: string; color?: string }) {
  return (
    <div className="border p-3 bg-black flex flex-col gap-1" style={{ borderColor: color + "55" }}>
      <span className="text-[10px] text-muted-foreground uppercase">{label}</span>
      <span className="text-base font-bold" style={{ color }}>{value}</span>
    </div>
  );
}

function FactorBox({ label, value }: { label: string; value: number }) {
  const color = value > 0.5 ? "#00ff41" : value < -0.5 ? "#ff4444" : "#ffd700";
  return (
    <div className="border border-primary/20 p-2 bg-black">
      <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
      <div className="text-sm font-bold mt-1" style={{ color }}>{value?.toFixed(4)}</div>
    </div>
  );
}

export function RiskPanel() {
  const { data: risk, isLoading: riskLoading } = useGetRiskMetrics({ query: { queryKey: getGetRiskMetricsQueryKey(), refetchInterval: 60000 } });
  const { data: insider, isLoading: insiderLoading } = useGetInsider({ query: { queryKey: getGetInsiderQueryKey(), refetchInterval: 120000 } });

  const signalColor = insider?.signal === "BULLISH" ? "#00ff41" : insider?.signal === "BEARISH" ? "#ff4444" : "#ffd700";
  const flowData = (insider?.netFlow ?? []).map((f) => ({
    date: new Date(f.date).toLocaleDateString([], { month: "short", day: "numeric" }),
    cumulative: f.cumulative,
  }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
      {/* LEFT — Risk Metrics */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-primary uppercase border-b border-primary/20 pb-1">RISK METRICS</p>
        {riskLoading ? (
          <div className="text-primary animate-pulse">LOADING RISK DATA █</div>
        ) : risk ? (
          <>
            <MetricBox label="VAR 95% (HIST)" value={risk.var95?.toFixed(6)} color="#ffd700" />
            <MetricBox label="EXP. SHORTFALL" value={risk.expectedShortfall?.toFixed(6)} color="#ffd700" />
            <MetricBox label="MAX DRAWDOWN" value={`${(risk.maxDrawdown * 100).toFixed(2)}%`} color="#ff4444" />
            <MetricBox label="CURR. DRAWDOWN" value={`${(risk.currentDrawdown * 100).toFixed(2)}%`} color="#ff4444" />
            <MetricBox label="ANNUAL VOL" value={`${(risk.annualVol * 100).toFixed(2)}%`} color="#00bcd4" />
            <MetricBox label="SHARPE RATIO" value={risk.sharpeRatio?.toFixed(4)} color="#00ff41" />
          </>
        ) : <div className="text-destructive text-xs">ERR: NO RISK DATA</div>}
      </div>

      {/* CENTER — Insider Engine */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-primary uppercase border-b border-primary/20 pb-1">
          INSIDER ENGINE · REAL — SEC EDGAR Form 4
        </p>
        {insiderLoading ? (
          <div className="text-primary animate-pulse">LOADING INSIDER DATA █</div>
        ) : insider ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <MetricBox label="SIGNAL" value={insider.signal} color={signalColor} />
              <MetricBox label="SCORE" value={`+${insider.score?.toFixed(2)}`} color={signalColor} />
              <MetricBox label="MOMENTUM" value={insider.momentum?.toFixed(2)} color="#ffd700" />
              <MetricBox label="BUYS" value={String(insider.buys)} color="#00ff41" />
              <MetricBox label="SELLS" value={String(insider.sells)} color="#ff4444" />
              <MetricBox label="BUY CLUSTERS" value={String(insider.buyClusters)} color="#00ff41" />
            </div>

            {/* Net Flow Chart */}
            <div className="border border-primary/20 mt-1 p-1">
              <p className="text-[10px] text-muted-foreground px-1 mb-1">CUMULATIVE NET FLOW</p>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={flowData} margin={{ top: 2, right: 8, left: 0, bottom: 2 }}>
                  <CartesianGrid stroke="#00ff4110" />
                  <XAxis dataKey="date" tick={{ fill: "#00ff4144", fontSize: 8 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: "#00ff4166", fontSize: 8 }} width={50}
                    tickFormatter={(v) => (v/1e6).toFixed(0)+"M"} />
                  <ReferenceLine y={0} stroke="#ffffff33" strokeDasharray="3 2" />
                  <Tooltip contentStyle={{ background: "#000", border: "1px solid #00ff41", fontSize: 10 }}
                    formatter={(v: number) => `$${(v/1e6).toFixed(2)}M`} />
                  <Line type="monotone" dataKey="cumulative" stroke="#00ff41" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Recent transactions table */}
            <div className="border border-primary/20 overflow-auto max-h-48">
              <p className="text-[10px] text-muted-foreground px-2 py-1 border-b border-primary/20">RECENT FORM 4 FILINGS</p>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-primary/20">
                    {["DATE","TKR","INSIDER","ROLE","TYPE","VALUE"].map((h) => (
                      <th key={h} className="text-left px-2 py-1 text-muted-foreground">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(insider.transactions ?? []).slice(0, 12).map((t, i) => (
                    <tr key={i} className="border-b border-primary/10 hover:bg-primary/5">
                      <td className="px-2 py-1 text-muted-foreground">{t.date?.slice(5)}</td>
                      <td className="px-2 py-1 text-accent">{t.ticker}</td>
                      <td className="px-2 py-1 text-primary/70 max-w-[100px] truncate">{t.insider}</td>
                      <td className="px-2 py-1 text-muted-foreground">{t.role}</td>
                      <td className="px-2 py-1" style={{ color: t.type === "BUY" ? "#00ff41" : "#ff4444" }}>{t.type}</td>
                      <td className="px-2 py-1 text-primary/70">{t.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : <div className="text-destructive text-xs">ERR: NO INSIDER DATA</div>}
      </div>

      {/* RIGHT — Factor Features */}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-primary uppercase border-b border-primary/20 pb-1">FACTOR FEATURES (LATEST)</p>
        {risk ? (
          <div className="grid grid-cols-1 gap-2">
            <FactorBox label="ZSCORE_20" value={risk.zscore20 ?? 0} />
            <FactorBox label="ZSCORE_60" value={risk.zscore60 ?? 0} />
            <FactorBox label="VWAP_DEV" value={risk.vwapDev ?? 0} />
            <FactorBox label="STOCHVOL" value={risk.stochVol ?? 0} />
            <FactorBox label="ORDERIMBALANCE" value={risk.orderImbalance ?? 0} />
            <FactorBox label="COINT_ZSCORE" value={risk.coinZscore ?? 0} />
            <FactorBox label="YIELDANOMALY" value={risk.yieldAnomaly ?? 0} />
            <FactorBox label="CARRY" value={risk.carry ?? 0} />
          </div>
        ) : <div className="text-muted-foreground text-xs">LOADING...</div>}
      </div>
    </div>
  );
}
