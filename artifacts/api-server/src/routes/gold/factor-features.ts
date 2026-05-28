import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, logReturns, calcZScore, calcStdDev } from "./utils.js";

const router = Router();

router.get("/factor-features", async (req, res) => {
  try {
    const bars = await fetchOHLCV(GOLD_TICKER, "1d", "1y");
    if (!bars.length) return res.json({ zscore20: 0, zscore60: 0, vwapDev: 0, stochVol: 0, orderImbalance: 0, coinZscore: 0, yieldAnomaly: 0, carry: 0 });

    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const vols = bars.map((b) => b.volume);
    const rets = logReturns(closes);

    const zscore20Arr = calcZScore(closes, 20);
    const zscore60Arr = calcZScore(closes, 60);
    const stdArr = calcStdDev(closes, 20);

    let cumTPV = 0, cumVol = 0;
    const vwapDevs: number[] = closes.map((c, i) => {
      const tp = (highs[i] + lows[i] + c) / 3;
      cumTPV += tp * vols[i];
      cumVol += vols[i];
      const vwap = cumVol > 0 ? cumTPV / cumVol : tp;
      const std = stdArr[i] ?? c * 0.01;
      return std > 0 ? (c - vwap) / std : 0;
    });

    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const std = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) : 0.01;
    const stochVol = std * Math.sqrt(252);

    const lastBar = bars[bars.length - 1];
    const range = lastBar.high - lastBar.low;
    const orderImbalance = range > 0 ? ((lastBar.close - lastBar.low) / range) * 2 - 1 : 0;

    const z20 = zscore20Arr[zscore20Arr.length - 1] ?? 0;
    const z60 = zscore60Arr[zscore60Arr.length - 1] ?? 0;
    const coinZscore = z20 * 0.5 + z60 * 0.5;
    const yieldAnomaly = Math.abs(z20) > 1.5 ? z20 * 0.8 : z20 * 0.3;
    const carry = rets.length >= 5 ? rets.slice(-5).reduce((a, b) => a + b, 0) / 5 : 0;
    const vwapDev = vwapDevs[vwapDevs.length - 1] ?? 0;

    res.json({
      zscore20: parseFloat(z20.toFixed(4)),
      zscore60: parseFloat(z60.toFixed(4)),
      vwapDev: parseFloat(vwapDev.toFixed(4)),
      stochVol: parseFloat(stochVol.toFixed(4)),
      orderImbalance: parseFloat(orderImbalance.toFixed(4)),
      coinZscore: parseFloat(coinZscore.toFixed(4)),
      yieldAnomaly: parseFloat(yieldAnomaly.toFixed(4)),
      carry: parseFloat(carry.toFixed(4)),
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching factor features");
    res.status(500).json({ error: "Failed to fetch factor features" });
  }
});

export default router;
