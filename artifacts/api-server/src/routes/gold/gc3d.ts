import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, calcSMA, calcStdDev, calcRSI, calcZScore, logReturns } from "./utils.js";

const router = Router();

const FEATURES = [
  { key: "stoch_volatility", label: "Stoch. Volatility" },
  { key: "zscore_20", label: "Z-Score 20" },
  { key: "zscore_60", label: "Z-Score 60" },
  { key: "vwap_dev", label: "VWAP Dev" },
  { key: "order_imbalance", label: "Order Imbalance" },
  { key: "carry", label: "Carry" },
  { key: "yield_anomaly", label: "Yield Anomaly" },
  { key: "rsi", label: "RSI" },
];

router.get("/gc3d", async (req, res) => {
  const feature = (req.query.feature as string) || "stoch_volatility";
  const period = (req.query.period as string) || "1mo";

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, "1d", period);
    if (!bars.length) return res.json({ points: [], feature, features: FEATURES, ticker: GOLD_TICKER, currentPrice: 0 });

    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const vols = bars.map((b) => b.volume);
    const rets = logReturns(closes);
    const paddedRets = [0, ...rets];

    const sma20 = calcSMA(closes, 20);
    const rsi14 = calcRSI(closes, 14);
    const stdDev20 = calcStdDev(closes, 20);
    const zscore20 = calcZScore(closes, 20);
    const zscore60 = calcZScore(closes, 60);

    // Stochastic volatility: rolling std of log returns (20d)
    const logRetsZeroed = [0, ...rets];
    const stochVol = logRetsZeroed.map((_, i) => {
      if (i < 20) return Math.abs(logRetsZeroed[i]) * 10;
      const slice = logRetsZeroed.slice(i - 20, i);
      const mean = slice.reduce((a, b) => a + b, 0) / 20;
      return Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20) * Math.sqrt(252);
    });

    // VWAP deviation
    let cumTPV = 0, cumVol = 0;
    const vwapDev = closes.map((c, i) => {
      const tp = (highs[i] + lows[i] + c) / 3;
      cumTPV += tp * vols[i];
      cumVol += vols[i];
      const vwap = cumVol > 0 ? cumTPV / cumVol : tp;
      const std = stdDev20[i] ?? 1;
      return std > 0 ? (c - vwap) / std : 0;
    });

    // Carry: forward rate - spot (simulated from price momentum)
    const carry = closes.map((c, i) => {
      if (i < 5) return 0;
      return (c - closes[i - 5]) / closes[i - 5];
    });

    // Order imbalance: buy vol / total vol proxy
    const orderImbalance = bars.map((b) => {
      const range = b.high - b.low;
      if (range === 0) return 0;
      const buyFrac = (b.close - b.low) / range;
      return buyFrac * 2 - 1;
    });

    // Yield anomaly: zscore of zscore20
    const yieldAnomaly = calcZScore(zscore20, 20);

    const featureMap: Record<string, number[]> = {
      stoch_volatility: stochVol,
      zscore_20: zscore20,
      zscore_60: zscore60,
      vwap_dev: vwapDev,
      order_imbalance: orderImbalance,
      carry,
      yield_anomaly: yieldAnomaly,
      rsi: rsi14.map((r) => (r ?? 50) / 100),
    };

    const featureData = featureMap[feature] ?? stochVol;
    const points = bars.map((b, i) => ({
      time: b.time,
      price: b.close,
      featureValue: featureData[i] ?? 0,
    }));

    res.json({
      points,
      feature,
      features: FEATURES,
      ticker: GOLD_TICKER,
      currentPrice: closes[closes.length - 1] ?? 0,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching GC3D");
    res.status(500).json({ error: "Failed to fetch GC3D data" });
  }
});

export default router;
