import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, calcSMA, calcRSI, calcEMA, calcStdDev } from "./utils.js";

const router = Router();

router.get("/quant", async (req, res) => {
  try {
    const bars = await fetchOHLCV(GOLD_TICKER, "1d", "1y");
    if (!bars.length) return res.json({ price: 0, change: 0, changePct: 0, rsi14: 50, sma20: 0, sma50: 0, trend: "NEUTRAL", signal: "HOLD" });

    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const vols = bars.map((b) => b.volume);
    const n = closes.length;

    const sma20Arr = calcSMA(closes, 20);
    const sma50Arr = calcSMA(closes, 50);
    const sma200Arr = calcSMA(closes, 200);
    const rsiArr = calcRSI(closes, 14);
    const stdArr = calcStdDev(closes, 20);
    const ema12Arr = calcEMA(closes, 12);
    const ema26Arr = calcEMA(closes, 26);

    const price = closes[n - 1];
    const prevClose = closes[n - 2] ?? price;
    const change = price - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    const sma20 = sma20Arr[n - 1] ?? price;
    const sma50 = sma50Arr[n - 1] ?? price;
    const sma200 = sma200Arr[n - 1] ?? price;
    const rsi14 = rsiArr[n - 1] ?? 50;
    const std20 = stdArr[n - 1] ?? price * 0.01;

    const bbUpper = sma20 + 2 * std20;
    const bbLower = sma20 - 2 * std20;
    const bbMid = sma20;

    const ema12 = (ema12Arr[n - 1] as number) ?? price;
    const ema26 = (ema26Arr[n - 1] as number) ?? price;
    const macd = ema12 - ema26;
    const macdArr = closes.map((_, i) => ((ema12Arr[i] as number ?? 0) - (ema26Arr[i] as number ?? 0)));
    const macdSignalArr = calcEMA(macdArr, 9);
    const macdSignal = (macdSignalArr[n - 1] as number) ?? 0;
    const macdHist = macd - macdSignal;

    // Stochastic
    const stochK = (() => {
      const period = 14;
      if (n < period) return 50;
      const periodHighs = highs.slice(n - period);
      const periodLows = lows.slice(n - period);
      const highestHigh = Math.max(...periodHighs);
      const lowestLow = Math.min(...periodLows);
      return highestHigh === lowestLow ? 50 : ((price - lowestLow) / (highestHigh - lowestLow)) * 100;
    })();

    const stochKArr = closes.map((c, i) => {
      if (i < 14) return 50;
      const ph = highs.slice(i - 14, i);
      const pl = lows.slice(i - 14, i);
      const hh = Math.max(...ph), ll = Math.min(...pl);
      return hh === ll ? 50 : ((c - ll) / (hh - ll)) * 100;
    });
    const stochDArr = calcSMA(stochKArr, 3);
    const stochD = stochDArr[n - 1] ?? 50;

    // OBV
    let obv = 0;
    for (let i = 1; i < n; i++) {
      obv += closes[i] > closes[i - 1] ? vols[i] : closes[i] < closes[i - 1] ? -vols[i] : 0;
    }

    // ATR
    const atr14 = (() => {
      const trs = bars.slice(1).map((b, i) => {
        const prevClose = bars[i].close;
        return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
      });
      const last14 = trs.slice(-14);
      return last14.length ? last14.reduce((a, b) => a + b, 0) / last14.length : 0;
    })();

    const momentum10 = n >= 10 ? ((price - closes[n - 10]) / closes[n - 10]) * 100 : 0;

    const trend = price > sma200 && sma50 > sma200 ? "BULLISH" : price < sma200 && sma50 < sma200 ? "BEARISH" : "NEUTRAL";
    const signal = rsi14 > 70 && macd < 0 ? "OVERBOUGHT / SELL" :
      rsi14 < 30 && macd > 0 ? "OVERSOLD / BUY" :
      macd > macdSignal && price > sma20 ? "BUY" :
      macd < macdSignal && price < sma20 ? "SELL" : "HOLD";

    res.json({
      price: parseFloat(price.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(4)),
      rsi14: parseFloat(rsi14.toFixed(2)),
      sma20: parseFloat(sma20.toFixed(2)),
      sma50: parseFloat(sma50.toFixed(2)),
      sma200: parseFloat(sma200.toFixed(2)),
      atr14: parseFloat(atr14.toFixed(2)),
      bbUpper: parseFloat(bbUpper.toFixed(2)),
      bbLower: parseFloat(bbLower.toFixed(2)),
      bbMid: parseFloat(bbMid.toFixed(2)),
      macd: parseFloat(macd.toFixed(4)),
      macdSignal: parseFloat(macdSignal.toFixed(4)),
      macdHist: parseFloat(macdHist.toFixed(4)),
      stochK: parseFloat(stochK.toFixed(2)),
      stochD: parseFloat(stochD.toFixed(2)),
      obv: Math.round(obv),
      momentum10: parseFloat(momentum10.toFixed(4)),
      trend,
      signal,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching quant panel");
    res.status(500).json({ error: "Failed to fetch quant panel" });
  }
});

export default router;
