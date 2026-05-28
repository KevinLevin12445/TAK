import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, logReturns } from "./utils.js";

const router = Router();

function detectAnomalies(returns: number[], times: string[], window: number, threshold: number) {
  return returns.map((ret, i) => {
    if (i < window) return { time: times[i + 1] || times[i], return_: ret, anomalyUp: false, anomalyDown: false, zscore: 0 };
    const slice = returns.slice(i - window, i);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / window);
    const zscore = std === 0 ? 0 : (ret - mean) / std;
    return {
      time: times[i + 1] || times[i],
      return_: ret,
      anomalyUp: zscore > threshold,
      anomalyDown: zscore < -threshold,
      zscore,
    };
  });
}

router.get("/anomaly", async (req, res) => {
  const period = (req.query.period as string) || "5d";
  const window = parseInt((req.query.window as string) || "20", 10);
  const threshold = parseFloat((req.query.threshold as string) || "2.0");

  try {
    const [bars5, bars15] = await Promise.all([
      fetchOHLCV(GOLD_TICKER, "5m", period),
      fetchOHLCV(GOLD_TICKER, "15m", period),
    ]);

    const closes5 = bars5.map((b) => b.close);
    const times5 = bars5.map((b) => b.time);
    const rets5 = logReturns(closes5);
    const ms5 = detectAnomalies(rets5, times5, window, threshold);

    const closes15 = bars15.map((b) => b.close);
    const times15 = bars15.map((b) => b.time);
    const rets15 = logReturns(closes15);
    const ms15 = detectAnomalies(rets15, times15, window, threshold);

    const log = [
      ...ms5.filter((p) => p.anomalyUp || p.anomalyDown).slice(-20).map((p) => ({
        time: p.time,
        scale: "MS",
        value: p.return_,
      })),
      ...ms15.filter((p) => p.anomalyUp || p.anomalyDown).slice(-20).map((p) => ({
        time: p.time,
        scale: "MI5",
        value: p.return_,
      })),
    ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 30);

    res.json({ ms5, ms15, log, ticker: GOLD_TICKER });
  } catch (err) {
    req.log.error({ err }, "Error fetching anomaly");
    res.status(500).json({ error: "Failed to fetch anomaly data" });
  }
});

export default router;
