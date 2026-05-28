import YahooFinance from "yahoo-finance2";

export const yf = new YahooFinance();

export const GOLD_TICKER = "GC=F";
export const SPOT_TICKER = "XAUUSD=X";
export const GOLD_RELATED = ["GC=F", "GLD", "IAU", "NEM", "GOLD", "AEM", "FNV", "WPM", "RGLD", "AUY"];
export const HEATMAP_TICKERS = ["GC=F", "GLD", "IAU", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "SPY", "QQQ", "NEM", "GOLD", "AEM", "FNV", "JPM", "BAC", "XOM", "CVX", "WMT", "PG"];
export const PORTFOLIO_TICKERS = ["GC=F", "GLD", "NEM", "GOLD", "AEM", "FNV"];

export interface OHLCVBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function periodToDays(period: string): number {
  const map: Record<string, number> = {
    "1d": 1, "2d": 2, "5d": 5, "1wk": 7, "2wk": 14,
    "1mo": 30, "2mo": 61, "3mo": 92, "6mo": 183,
    "1y": 365, "2y": 730, "5y": 1825, "ytd": 180, "max": 3650,
  };
  return map[period] ?? 30;
}

export async function fetchOHLCV(ticker: string, interval: string, period: string): Promise<OHLCVBar[]> {
  try {
    const validIntervals = ["1m","2m","5m","15m","30m","60m","90m","1h","1d","5d","1wk","1mo","3mo"] as const;
    const safeInterval = validIntervals.includes(interval as typeof validIntervals[number]) ? interval as typeof validIntervals[number] : "5m";
    const days = periodToDays(period);
    const period1 = new Date(Date.now() - days * 86400000);
    const now = Date.now() + 3600000; // allow 1h buffer for in-progress bars
    const result = await yf.chart(ticker, {
      interval: safeInterval,
      period1,
    });
    const quotes = result.quotes ?? [];
    return quotes
      .filter((q) => q.open != null && q.close != null && new Date(q.date).getTime() <= now)
      .map((q) => ({
        time: new Date(q.date).toISOString(),
        open: q.open ?? 0,
        high: q.high ?? 0,
        low: q.low ?? 0,
        close: q.close ?? 0,
        volume: q.volume ?? 0,
      }));
  } catch {
    return [];
  }
}

export function calcSMA(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const slice = data.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

export function calcRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function calcEMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  const k = 2 / (period + 1);
  let ema = data[0];
  result[0] = ema;
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

export function calcStdDev(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const slice = data.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    return Math.sqrt(variance);
  });
}

export function pctReturns(closes: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return rets;
}

export function logReturns(closes: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  return rets;
}

export function calcZScore(data: number[], window: number): number[] {
  return data.map((val, i) => {
    if (i < window) return 0;
    const slice = data.slice(i - window, i);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / window);
    return std === 0 ? 0 : (val - mean) / std;
  });
}
