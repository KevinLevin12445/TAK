import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, logReturns } from "./utils.js";

const router = Router();

// Simple k-means style regime detection (3 regimes based on return + volatility)
function detectRegimes(rets: number[], nRegimes = 3): number[] {
  if (!rets.length) return [];
  const volatility = rets.map((_, i) => {
    if (i < 5) return Math.abs(rets[i]);
    const slice = rets.slice(i - 5, i);
    const mean = slice.reduce((a, b) => a + b, 0) / 5;
    return Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 5);
  });

  const score = rets.map((r, i) => r + (r > 0 ? volatility[i] : -volatility[i]));
  const sorted = [...score].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)];
  const t2 = sorted[Math.floor((2 * sorted.length) / 3)];

  return score.map((s) => {
    if (s < t1) return 0; // bearish high-vol
    if (s < t2) return 1; // neutral/ranging
    return 2; // bullish trending
  });
}

const REGIME_META = [
  { id: 0, label: "BEAR / HIGH VOL", color: "#ff4444" },
  { id: 1, label: "NEUTRAL / RANGING", color: "#ffd700" },
  { id: 2, label: "BULL / TRENDING", color: "#00ff41" },
];

router.get("/hmm", async (req, res) => {
  const period = (req.query.period as string) || "3mo";

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, "1d", period);
    if (!bars.length) return res.json({ points: [], currentRegime: 1, currentLabel: "NEUTRAL", regimes: REGIME_META.map((r) => ({ ...r, pct: 33 })), ticker: GOLD_TICKER });

    const closes = bars.map((b) => b.close);
    const rets = logReturns(closes);
    const regimes = detectRegimes(rets);

    const points = bars.map((b, i) => {
      const regimeIdx = i > 0 ? (regimes[i - 1] ?? 1) : 1;
      return {
        time: b.time,
        price: b.close,
        regime: regimeIdx,
        regimeLabel: REGIME_META[regimeIdx]?.label ?? "NEUTRAL",
      };
    });

    const counts = [0, 0, 0];
    regimes.forEach((r) => counts[r]++);
    const total = regimes.length || 1;

    const currentRegime = regimes[regimes.length - 1] ?? 1;

    res.json({
      points,
      currentRegime,
      currentLabel: REGIME_META[currentRegime]?.label ?? "NEUTRAL",
      regimes: REGIME_META.map((r) => ({
        ...r,
        pct: parseFloat(((counts[r.id] / total) * 100).toFixed(1)),
      })),
      ticker: GOLD_TICKER,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching HMM regimes");
    res.status(500).json({ error: "Failed to fetch HMM regimes" });
  }
});

export default router;
