import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV } from "./utils.js";

const router = Router();

router.get("/order-flow", async (req, res) => {
  const bins = Math.min(100, Math.max(10, parseInt((req.query.bins as string) || "60")));
  const windowBars = Math.min(50, Math.max(5, parseInt((req.query.window as string) || "20")));
  const period = (req.query.period as string) || "1mo";
  const interval = (req.query.interval as string) || "1h";

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, interval, period);
    if (!bars.length) return res.json({ matrix: [], priceBins: [], times: [], prices: [], volProfile: [], poc: 0, vah: 0, val: 0, currentPrice: 0, nom: 0, minP: 0, maxP: 0, bins, binSize: 0 });

    const now = Date.now();
    const filteredBars = bars.filter((b) => new Date(b.time).getTime() <= now + 3600000);

    const allHighs = filteredBars.map((b) => b.high);
    const allLows = filteredBars.map((b) => b.low);
    const minP = Math.min(...allLows);
    const maxP = Math.max(...allHighs);
    const binSize = (maxP - minP) / bins;

    const matrix: number[][] = Array.from({ length: bins }, () => Array(filteredBars.length).fill(0));

    filteredBars.forEach((bar, t) => {
      const range = bar.high - bar.low;
      if (range === 0) return;
      for (let b = 0; b < bins; b++) {
        const binLow = minP + b * binSize;
        const binHigh = binLow + binSize;
        const overlap = Math.max(0, Math.min(bar.high, binHigh) - Math.max(bar.low, binLow));
        if (overlap > 0) {
          matrix[b][t] = (bar.volume * overlap) / range;
        }
      }
    });

    // Smooth with rolling window
    const smoothed: number[][] = matrix.map((row) =>
      row.map((_, t) => {
        const start = Math.max(0, t - windowBars + 1);
        const slice = row.slice(start, t + 1);
        return slice.reduce((a, x) => a + x, 0) / slice.length;
      })
    );

    // Volume profile (sum over time)
    const volProfile = smoothed.map((row) => row.reduce((a, b) => a + b, 0));
    const totalVol = volProfile.reduce((a, b) => a + b, 0) || 1;

    // POC = bin with max volume
    const pocBin = volProfile.indexOf(Math.max(...volProfile));
    const poc = minP + (pocBin + 0.5) * binSize;

    // Value Area (70% of volume centred on POC)
    const target = totalVol * 0.70;
    let cum = volProfile[pocBin];
    let upBin = pocBin;
    let downBin = pocBin;
    while (cum < target && (upBin < bins - 1 || downBin > 0)) {
      const upNext = upBin < bins - 1 ? volProfile[upBin + 1] : -1;
      const downNext = downBin > 0 ? volProfile[downBin - 1] : -1;
      if (upNext >= downNext && upBin < bins - 1) {
        upBin++;
        cum += volProfile[upBin];
      } else if (downBin > 0) {
        downBin--;
        cum += volProfile[downBin];
      } else break;
    }
    const vah = minP + (upBin + 1) * binSize;
    const val = minP + downBin * binSize;

    // Normalize matrix to 0-1
    const matMax = Math.max(...smoothed.flatMap((r) => r));
    const normMatrix = matMax > 0
      ? smoothed.map((row) => row.map((v) => v / matMax))
      : smoothed;

    const currentPrice = filteredBars[filteredBars.length - 1]?.close ?? 0;
    const priceBins = Array.from({ length: bins }, (_, i) => parseFloat((minP + i * binSize).toFixed(2)));

    // Identify "pivot zones" (local vol maxima in profile)
    let pzCount = 0;
    for (let b = 1; b < bins - 1; b++) {
      if (volProfile[b] > volProfile[b - 1] && volProfile[b] > volProfile[b + 1] && volProfile[b] > totalVol / bins * 1.5) {
        pzCount++;
      }
    }

    res.json({
      matrix: normMatrix,
      priceBins,
      times: filteredBars.map((b) => b.time),
      prices: filteredBars.map((b) => b.close),
      volProfile: volProfile.map((v) => parseFloat(v.toFixed(2))),
      poc: parseFloat(poc.toFixed(2)),
      vah: parseFloat(vah.toFixed(2)),
      val: parseFloat(val.toFixed(2)),
      nom: parseFloat(currentPrice.toFixed(2)),
      currentPrice,
      minP: parseFloat(minP.toFixed(2)),
      maxP: parseFloat(maxP.toFixed(2)),
      bins,
      binSize: parseFloat(binSize.toFixed(4)),
      pzCount,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching order flow");
    res.status(500).json({ error: "Failed to fetch order flow" });
  }
});

export default router;
