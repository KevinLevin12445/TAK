import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, logReturns, calcZScore } from "./utils.js";

const router = Router();

router.get("/risk", async (req, res) => {
  try {
    const bars = await fetchOHLCV(GOLD_TICKER, "1d", "1y");
    if (!bars.length) return res.json({ var95: 0, expectedShortfall: 0, maxDrawdown: 0, currentDrawdown: 0, annualVol: 0, sharpeRatio: 0 });

    const closes = bars.map((b) => b.close);
    const rets = logReturns(closes);

    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    const annualVol = std * Math.sqrt(252);

    const sortedRets = [...rets].sort((a, b) => a - b);
    const var95Idx = Math.floor(rets.length * 0.05);
    const var95 = Math.abs(sortedRets[var95Idx] ?? 0);
    const esRets = sortedRets.slice(0, var95Idx);
    const expectedShortfall = esRets.length > 0 ? Math.abs(esRets.reduce((a, b) => a + b, 0) / esRets.length) : var95;

    // Max drawdown
    let peak = closes[0];
    let maxDD = 0;
    for (const c of closes) {
      if (c > peak) peak = c;
      const dd = (peak - c) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    const currentPeak = Math.max(...closes);
    const currentClose = closes[closes.length - 1];
    const currentDrawdown = (currentPeak - currentClose) / currentPeak;

    const sharpeRatio = std > 0 ? (mean * 252 - 0.05) / (std * Math.sqrt(252)) : 0;

    // Factor features
    const zscore20Arr = calcZScore(closes, 20);
    const zscore60Arr = calcZScore(closes, 60);
    const zscore20 = zscore20Arr[zscore20Arr.length - 1] ?? 0;
    const zscore60 = zscore60Arr[zscore60Arr.length - 1] ?? 0;

    // VWAP dev
    let cumTPV = 0, cumVol = 0;
    const vwapDevs: number[] = [];
    for (const b of bars) {
      const tp = (b.high + b.low + b.close) / 3;
      cumTPV += tp * b.volume;
      cumVol += b.volume;
      const vwap = cumVol > 0 ? cumTPV / cumVol : tp;
      vwapDevs.push((b.close - vwap) / Math.max(vwap * 0.01, 1));
    }
    const vwapDev = vwapDevs[vwapDevs.length - 1] ?? 0;

    const stochVol = std * Math.sqrt(252);
    const orderImbalance = (() => {
      const lastBar = bars[bars.length - 1];
      const range = lastBar.high - lastBar.low;
      if (!range) return 0;
      return ((lastBar.close - lastBar.low) / range) * 2 - 1;
    })();
    const coinZscore = zscore20 * 0.5 + zscore60 * 0.5;
    const yieldAnomaly = Math.abs(zscore20) > 2 ? zscore20 : zscore20 * 0.5;
    const carry = rets.length > 0 ? rets.slice(-5).reduce((a, b) => a + b, 0) / 5 : 0;

    res.json({
      var95: parseFloat(var95.toFixed(6)),
      expectedShortfall: parseFloat(expectedShortfall.toFixed(6)),
      maxDrawdown: parseFloat((-maxDD).toFixed(4)),
      currentDrawdown: parseFloat((-currentDrawdown).toFixed(4)),
      annualVol: parseFloat(annualVol.toFixed(4)),
      sharpeRatio: parseFloat(sharpeRatio.toFixed(4)),
      zscore20: parseFloat(zscore20.toFixed(4)),
      zscore60: parseFloat(zscore60.toFixed(4)),
      vwapDev: parseFloat(vwapDev.toFixed(4)),
      stochVol: parseFloat(stochVol.toFixed(4)),
      orderImbalance: parseFloat(orderImbalance.toFixed(4)),
      coinZscore: parseFloat(coinZscore.toFixed(4)),
      yieldAnomaly: parseFloat(yieldAnomaly.toFixed(4)),
      carry: parseFloat(carry.toFixed(4)),
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching risk metrics");
    res.status(500).json({ error: "Failed to fetch risk metrics" });
  }
});

export default router;
