import { Router } from "express";
import { GOLD_TICKER, fetchOHLCV } from "./utils.js";

const router = Router();

function buildVolumeProfile(
  bars: { time: string; open: number; high: number; low: number; close: number; volume: number }[],
  nBins: number
) {
  if (!bars.length) return { profile: [], poc: 0, vah: 0, val: 0 };

  const minPrice = Math.min(...bars.map((b) => b.low));
  const maxPrice = Math.max(...bars.map((b) => b.high));
  const binSize = (maxPrice - minPrice) / nBins || 1;

  const profile: { price: number; buyVol: number; sellVol: number; volume: number; poc: boolean; vah: boolean; val: boolean }[] = Array.from({ length: nBins }, (_, i) => ({
    price: parseFloat((minPrice + (i + 0.5) * binSize).toFixed(2)),
    buyVol: 0,
    sellVol: 0,
    volume: 0,
    poc: false,
    vah: false,
    val: false,
  }));

  for (const bar of bars) {
    const isBuy = bar.close >= bar.open;
    const barsSpanned = Math.max(1, Math.ceil((bar.high - bar.low) / binSize));
    const vol = bar.volume / barsSpanned;
    const startBin = Math.max(0, Math.floor((bar.low - minPrice) / binSize));
    const endBin = Math.min(nBins - 1, Math.ceil((bar.high - minPrice) / binSize));
    for (let i = startBin; i <= endBin; i++) {
      if (isBuy) profile[i].buyVol += vol;
      else profile[i].sellVol += vol;
      profile[i].volume += vol;
    }
  }

  let maxVol = 0, pocIdx = 0;
  profile.forEach((p, i) => { if (p.volume > maxVol) { maxVol = p.volume; pocIdx = i; } });
  profile[pocIdx].poc = true;
  const poc = profile[pocIdx].price;

  const totalVol = profile.reduce((a, p) => a + p.volume, 0);
  let cumVol = 0;
  let vah = poc, val = poc;
  const sortedByVol = [...profile].sort((a, b) => b.volume - a.volume);
  for (const p of sortedByVol) {
    cumVol += p.volume;
    if (cumVol <= totalVol * 0.7) {
      vah = Math.max(vah, p.price + binSize / 2);
      val = Math.min(val, p.price - binSize / 2);
    } else break;
  }

  profile.forEach((p) => {
    p.vah = Math.abs(p.price - vah) < binSize;
    p.val = Math.abs(p.price - val) < binSize;
    p.buyVol  = Math.round(p.buyVol);
    p.sellVol = Math.round(p.sellVol);
    p.volume  = Math.round(p.volume);
  });

  return { profile, poc, vah, val };
}

router.get("/volume-profile", async (req, res) => {
  const interval = (req.query.interval as string) || "15m";
  const period   = (req.query.period   as string) || "5d";
  const nBins    = parseInt((req.query.bins as string) || "50", 10);

  try {
    const bars = await fetchOHLCV(GOLD_TICKER, interval, period);
    if (!bars.length) return res.json({ profile: [], poc: 0, vah: 0, val: 0, ticker: GOLD_TICKER, currentPrice: 0 });

    const { profile, poc, vah, val } = buildVolumeProfile(bars, nBins);
    const currentPrice = bars[bars.length - 1].close;

    res.json({ profile, poc, vah, val, ticker: GOLD_TICKER, currentPrice });
  } catch (err) {
    req.log.error({ err }, "Error fetching volume profile");
    res.status(500).json({ error: "Failed to fetch volume profile" });
  }
});

export default router;
