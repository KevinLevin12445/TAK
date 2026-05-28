import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV } from "./utils.js";

const router = Router();

function calcVWAP(bars: { time: string; open: number; high: number; low: number; close: number; volume: number }[]) {
  let cumTPV = 0;
  let cumVol = 0;
  const vwapPoints: number[] = [];

  for (const bar of bars) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumTPV += tp * bar.volume;
    cumVol += bar.volume;
    vwapPoints.push(cumVol > 0 ? cumTPV / cumVol : tp);
  }
  return vwapPoints;
}

function detectSessionBreaks(bars: { time: string }[]): number[] {
  const breaks: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = new Date(bars[i - 1].time);
    const curr = new Date(bars[i].time);
    if (curr.getUTCDate() !== prev.getUTCDate()) {
      breaks.push(i);
    }
  }
  return breaks;
}

router.get("/vwap", async (req, res) => {
  const interval = (req.query.interval as string) || "5m";
  const period = (req.query.period as string) || "2d";

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, interval, period);
    if (!bars.length) return res.json({ points: [], currentPrice: 0, vwapSession: 0, vwapTotal: 0, ticker: GOLD_TICKER });

    const sessionBreaks = detectSessionBreaks(bars);
    const sessionBreakSet = new Set(sessionBreaks);

    let sessTPV = 0, sessVol = 0;
    let totalTPV = 0, totalVol = 0;
    const tpvArr: number[] = [];
    const volArr: number[] = [];

    const points = bars.map((bar, i) => {
      const tp = (bar.high + bar.low + bar.close) / 3;

      if (sessionBreakSet.has(i)) {
        sessTPV = 0;
        sessVol = 0;
      }
      sessTPV += tp * bar.volume;
      sessVol += bar.volume;
      totalTPV += tp * bar.volume;
      totalVol += bar.volume;

      const vwapSession = sessVol > 0 ? sessTPV / sessVol : tp;
      const vwapTotal = totalVol > 0 ? totalTPV / totalVol : tp;

      tpvArr.push(tp);
      volArr.push(bar.volume);

      const deviations = tpvArr.map((p) => (p - vwapTotal) ** 2);
      const variance = deviations.reduce((a, b) => a + b, 0) / tpvArr.length;
      const sd = Math.sqrt(variance);

      return {
        time: bar.time,
        price: bar.close,
        vwapSession,
        vwapTotal,
        sd1p: vwapTotal + sd,
        sd1n: vwapTotal - sd,
        sd2p: vwapTotal + 2 * sd,
        sd2n: vwapTotal - 2 * sd,
        sd3p: vwapTotal + 3 * sd,
        sd3n: vwapTotal - 3 * sd,
        sd4p: vwapTotal + 4 * sd,
        sd4n: vwapTotal - 4 * sd,
      };
    });

    const last = points[points.length - 1];
    res.json({
      points,
      currentPrice: last?.price ?? 0,
      vwapSession: last?.vwapSession ?? 0,
      vwapTotal: last?.vwapTotal ?? 0,
      ticker: GOLD_TICKER,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching VWAP");
    res.status(500).json({ error: "Failed to fetch VWAP" });
  }
});

export default router;
