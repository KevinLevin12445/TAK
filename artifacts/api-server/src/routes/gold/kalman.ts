import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV } from "./utils.js";

const router = Router();

// Simple 1D Kalman filter
function kalmanFilter(closes: number[], processNoise = 1e-5, measurementNoise = 1e-1) {
  let x = closes[0]; // state estimate
  let p = 1.0; // error covariance
  const results: { trend: number; upper: number; lower: number }[] = [];

  for (const z of closes) {
    // Predict
    const xPred = x;
    const pPred = p + processNoise;
    // Update
    const K = pPred / (pPred + measurementNoise);
    x = xPred + K * (z - xPred);
    p = (1 - K) * pPred;
    const uncertainty = Math.sqrt(p) * 1.96;
    results.push({ trend: x, upper: x + uncertainty * 10, lower: x - uncertainty * 10 });
  }
  return results;
}

router.get("/kalman", async (req, res) => {
  const period = (req.query.period as string) || "1mo";

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, "1d", period);
    if (!bars.length) return res.json({ points: [], currentTrend: 0, signal: "NEUTRAL", ticker: GOLD_TICKER });

    const closes = bars.map((b) => b.close);
    const filtered = kalmanFilter(closes);

    const points = bars.map((b, i) => ({
      time: b.time,
      price: b.close,
      trend: filtered[i].trend,
      upper: filtered[i].upper,
      lower: filtered[i].lower,
    }));

    const lastTrend = filtered[filtered.length - 1];
    const lastPrice = closes[closes.length - 1];
    const prevTrend = filtered[filtered.length - 2]?.trend ?? lastTrend.trend;
    const signal = lastPrice > lastTrend.trend && lastTrend.trend > prevTrend ? "BULLISH" :
      lastPrice < lastTrend.trend && lastTrend.trend < prevTrend ? "BEARISH" : "NEUTRAL";

    res.json({ points, currentTrend: lastTrend.trend, signal, ticker: GOLD_TICKER });
  } catch (err) {
    req.log.error({ err }, "Error fetching Kalman");
    res.status(500).json({ error: "Failed to fetch Kalman data" });
  }
});

export default router;
