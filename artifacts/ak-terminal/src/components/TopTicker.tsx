import { useEffect, useRef, useState } from "react";
import { useGetGoldPrice, getGetGoldPriceQueryKey } from "@workspace/api-client-react";

export function TopTicker() {
  const { data: priceData, isLoading, isError } = useGetGoldPrice({
    query: { queryKey: getGetGoldPriceQueryKey(), refetchInterval: 5000 }
  });

  const prevPriceRef = useRef<number | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (!priceData?.price) return;
    const prev = prevPriceRef.current;
    if (prev !== null && prev !== priceData.price) {
      setFlash(priceData.price > prev ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 500);
      prevPriceRef.current = priceData.price;
      return () => clearTimeout(t);
    }
    prevPriceRef.current = priceData.price;
  }, [priceData?.price]);

  if (isLoading) {
    return (
      <div className="w-full bg-[#001100] border-b border-primary p-1 text-xs sm:text-sm flex items-center justify-between">
        <span>LOADING TICKER <span className="animate-pulse">█</span></span>
      </div>
    );
  }

  if (isError || !priceData) {
    return (
      <div className="w-full bg-[#110000] border-b border-destructive p-1 text-xs sm:text-sm text-destructive flex items-center justify-between">
        <span>ERR: FAILED TO LOAD GOLD PRICE TICKER</span>
      </div>
    );
  }

  const isUp = priceData.change >= 0;
  const changeColor = isUp ? "text-primary" : "text-destructive";
  const sign = isUp ? "▲+" : "▼";

  const flashBg =
    flash === "up" ? "bg-primary/10" : flash === "down" ? "bg-destructive/10" : "";

  return (
    <div
      className={`w-full border-b border-primary/50 px-2 py-1 text-xs sm:text-sm flex flex-wrap items-center gap-4 whitespace-nowrap transition-colors duration-300 ${flashBg || "bg-[#000a00]"}`}
    >
      <div className="flex items-center gap-2 font-bold">
        <span className="text-accent animate-pulse">★</span>
        <span className="text-accent">XAUUSD CFD</span>
        <span
          className={`tabular-nums transition-colors duration-200 ${
            flash === "up"
              ? "text-primary"
              : flash === "down"
              ? "text-destructive"
              : "text-accent"
          }`}
        >
          ${(priceData.price ?? 0).toFixed(2)}
        </span>
      </div>

      <div className={`flex items-center gap-2 ${changeColor}`}>
        <span>{sign}{Math.abs(priceData.change ?? 0).toFixed(2)}</span>
        <span>({sign}{Math.abs(priceData.changePct ?? 0).toFixed(2)}%)</span>
      </div>

      <div className="flex items-center gap-3 text-muted-foreground ml-4">
        <span>H: <span className="text-primary">${priceData.high?.toFixed(2) || "---"}</span></span>
        <span>L: <span className="text-primary">${priceData.low?.toFixed(2) || "---"}</span></span>
        <span>PREV: <span className="text-muted-foreground">${priceData.prevClose?.toFixed(2) || "---"}</span></span>
        <span>VOL: <span className="text-primary/70">{priceData.volume?.toLocaleString() || "---"}</span></span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2 text-xs">
        <span className="text-primary/70">AUTO 5s</span>
        <span className="flex h-2 w-2 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
        </span>
        <span className="text-primary">— LIVE</span>
        {priceData.timestamp && (
          <span className="text-primary/40 text-[10px]">
            {new Date(priceData.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
