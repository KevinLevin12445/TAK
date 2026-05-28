import { useGetQuantPanel, getGetQuantPanelQueryKey } from "@workspace/api-client-react";

export function QuantPanel() {
  const { data, isLoading } = useGetQuantPanel({
    query: { queryKey: getGetQuantPanelQueryKey(), refetchInterval: 30000 }
  });

  if (isLoading) {
    return <div className="p-4 text-primary">INITIALIZING QUANT PANEL...</div>;
  }

  if (!data) return <div className="p-4 text-destructive">ERR: NO DATA</div>;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2 h-full content-start">
      <MetricCard title="TREND SIGNAL" value={data.signal} color={data.signal?.includes("BUY") ? "primary" : data.signal?.includes("SELL") ? "destructive" : "accent"} />
      <MetricCard title="RSI (14)" value={data.rsi14?.toFixed(2)} color={data.rsi14 && data.rsi14 > 70 ? "destructive" : data.rsi14 && data.rsi14 < 30 ? "primary" : "accent"} />
      <MetricCard title="MACD" value={data.macd?.toFixed(2)} color={data.macd && data.macd > 0 ? "primary" : "destructive"} />
      <MetricCard title="ATR (14)" value={data.atr14?.toFixed(2)} color="accent" />
      <MetricCard title="MOMENTUM (10)" value={data.momentum10?.toFixed(2)} color={data.momentum10 && data.momentum10 > 0 ? "primary" : "destructive"} />
      
      <MetricCard title="SMA 20" value={data.sma20?.toFixed(2)} />
      <MetricCard title="SMA 50" value={data.sma50?.toFixed(2)} />
      <MetricCard title="SMA 200" value={data.sma200?.toFixed(2)} />
      
      <MetricCard title="BB UPPER" value={data.bbUpper?.toFixed(2)} color="secondary" />
      <MetricCard title="BB LOWER" value={data.bbLower?.toFixed(2)} color="secondary" />
      
      <MetricCard title="STOCH K" value={data.stochK?.toFixed(2)} />
      <MetricCard title="STOCH D" value={data.stochD?.toFixed(2)} />
      <MetricCard title="OBV" value={data.obv?.toLocaleString()} />
    </div>
  );
}

function MetricCard({ title, value, color = "primary" }: { title: string, value?: string | number, color?: "primary" | "accent" | "destructive" | "secondary" }) {
  const colorMap = {
    primary: "text-primary border-primary",
    accent: "text-accent border-accent",
    destructive: "text-destructive border-destructive",
    secondary: "text-secondary border-secondary",
  };
  
  return (
    <div className={`border p-3 bg-black flex flex-col justify-between h-24 ${colorMap[color].split(" ")[1]}`}>
      <span className="text-[10px] text-muted-foreground">{title}</span>
      <span className={`text-xl font-bold ${colorMap[color].split(" ")[0]}`}>{value || "---"}</span>
    </div>
  );
}
