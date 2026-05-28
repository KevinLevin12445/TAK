import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, calcSMA, calcRSI } from "./utils.js";

const router = Router();

router.get("/history", async (req, res) => {
  const interval = (req.query.interval as string) || "5m";
  const period = (req.query.period as string) || "2d";

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, interval, period);
    const closes = bars.map((b) => b.close);
    const sma20 = calcSMA(closes, 20);
    const sma50 = calcSMA(closes, 50);
    const rsi = calcRSI(closes, 14);

    const candles = bars.map((b, i) => ({
      ...b,
      sma20: sma20[i],
      sma50: sma50[i],
      rsi: rsi[i],
    }));

    res.json({ candles, ticker: GOLD_TICKER, interval, period });
  } catch (err) {
    req.log.error({ err }, "Error fetching gold history");
    res.status(500).json({ error: "Failed to fetch gold history" });
  }
});

export default router;
