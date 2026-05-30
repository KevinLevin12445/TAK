import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV, calcSMA, calcStdDev, calcRSI, calcZScore, logReturns } from "./utils.js";

const router = Router();

const SURFACE_FEATURES = [
  { key: "stoch_volatility",  label: "Stoch.Vol"     },
  { key: "rsi",               label: "RSI"           },
  { key: "zscore_20",         label: "Z-Score 20"    },
  { key: "zscore_60",         label: "Z-Score 60"    },
  { key: "vwap_dev",          label: "VWAP Dev"      },
  { key: "order_imbalance",   label: "Order Imb."    },
  { key: "carry",             label: "Carry"         },
  { key: "yield_anomaly",     label: "Yield Anom."   },
];

function minMaxNorm(arr: number[]): number[] {
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const range = max - min || 1;
  return arr.map((v) => (v - min) / range);
}

router.get("/gc3d-surface", async (req, res) => {
  const period = (req.query.period as string) || "3mo";

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, "1d", period);
    if (!bars.length) {
      return res.json({ matrix: [], featureLabels: [], dates: [], currentPrice: 0, rawMatrix: [] });
    }

    const closes = bars.map((b) => b.close);
    const highs  = bars.map((b) => b.high);
    const lows   = bars.map((b) => b.low);
    const vols   = bars.map((b) => b.volume);
    const rets   = logReturns(closes);

    const sma20    = calcSMA(closes, 20);
    const stdDev20 = calcStdDev(closes, 20);
    const zscore20 = calcZScore(closes, 20);
    const zscore60 = calcZScore(closes, 60);
    const rsi14    = calcRSI(closes, 14);

    const logRetsZeroed = [0, ...rets];
    const stochVol = logRetsZeroed.map((_, i) => {
      if (i < 20) return Math.abs(logRetsZeroed[i]) * 10;
      const slice = logRetsZeroed.slice(i - 20, i);
      const mean  = slice.reduce((a, b) => a + b, 0) / 20;
      return Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20) * Math.sqrt(252);
    });

    let cumTPV = 0, cumVol = 0;
    const vwapDev = closes.map((c, i) => {
      const tp = (highs[i] + lows[i] + c) / 3;
      cumTPV += tp * vols[i];
      cumVol += vols[i];
      const vwap = cumVol > 0 ? cumTPV / cumVol : tp;
      const std  = stdDev20[i] ?? 1;
      return std > 0 ? (c - vwap) / std : 0;
    });

    const carry = closes.map((c, i) => {
      if (i < 5) return 0;
      return (c - closes[i - 5]) / closes[i - 5];
    });

    const orderImbalance = bars.map((b) => {
      const range = b.high - b.low;
      if (range === 0) return 0;
      return ((b.close - b.low) / range) * 2 - 1;
    });

    const yieldAnomaly = calcZScore(zscore20, 20);

    const rawMap: Record<string, number[]> = {
      stoch_volatility: stochVol,
      rsi:              rsi14.map((r) => (r ?? 50)),
      zscore_20:        zscore20,
      zscore_60:        zscore60,
      vwap_dev:         vwapDev,
      order_imbalance:  orderImbalance,
      carry,
      yield_anomaly:    yieldAnomaly,
    };

    // matrix[featureIdx][dateIdx] = normalised value 0..1
    const matrix: number[][] = SURFACE_FEATURES.map((f) =>
      minMaxNorm(rawMap[f.key] ?? closes.map(() => 0))
    );

    // raw (un-normalised) matrix for tooltip
    const rawMatrix: number[][] = SURFACE_FEATURES.map((f) =>
      rawMap[f.key] ?? closes.map(() => 0)
    );

    const dates = bars.map((b) => b.time.slice(0, 10));

    return res.json({
      matrix,
      rawMatrix,
      featureLabels: SURFACE_FEATURES.map((f) => f.label),
      featureKeys:   SURFACE_FEATURES.map((f) => f.key),
      dates,
      currentPrice:  closes[closes.length - 1] ?? 0,
      ticker: GOLD_TICKER,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching gc3d-surface");
    return res.status(500).json({ error: "Failed to fetch surface" });
  }
});

export default router;
