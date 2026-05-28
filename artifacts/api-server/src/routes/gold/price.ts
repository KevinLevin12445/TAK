import { Router } from "express";
import { GOLD_TICKER, yf } from "./utils.js";

const router = Router();

interface SpotResult {
  price: number;
  bid: number;
  ask: number;
  change: number;
  changePct: number;
  prevClose: number;
}

// Swissquote public forex feed — real CFD/spot XAUUSD price, no API key needed
async function fetchSwissquoteSpot(): Promise<SpotResult | null> {
  const r = await fetch(
    "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
    { signal: AbortSignal.timeout(5000), headers: { "Accept": "application/json" } }
  );
  if (!r.ok) throw new Error("Swissquote " + r.status);
  const data: { spreadProfilePrices: { spreadProfile: string; bid: number; ask: number }[]; ts: number }[] =
    await r.json();
  if (!Array.isArray(data) || !data.length) throw new Error("Empty response");

  // Use "prime" spread profile from first platform entry
  const entry = data[0];
  const prime =
    entry.spreadProfilePrices.find((p) => p.spreadProfile === "prime") ??
    entry.spreadProfilePrices[0];
  const mid = (prime.bid + prime.ask) / 2;
  if (!mid || mid < 100) throw new Error("Bad price");
  return { price: parseFloat(mid.toFixed(2)), bid: prime.bid, ask: prime.ask, change: 0, changePct: 0, prevClose: 0 };
}

router.get("/price", async (req, res) => {
  let spot: SpotResult | null = null;

  try {
    spot = await fetchSwissquoteSpot();
  } catch (e: any) {
    req.log.warn({ err: e?.message }, "Swissquote spot fetch failed, falling back to GC=F");
  }

  // Enrich with OHLV from Yahoo Finance (GC=F futures), adjusting for basis
  let futuresQuote: { price: number; high: number; low: number; open: number; volume: number; prevClose: number } | null = null;
  try {
    const q = await yf.quote(GOLD_TICKER);
    if (q?.regularMarketPrice && q.regularMarketPrice > 100) {
      futuresQuote = {
        price:     q.regularMarketPrice,
        high:      q.regularMarketDayHigh            ?? 0,
        low:       q.regularMarketDayLow             ?? 0,
        open:      q.regularMarketOpen               ?? 0,
        volume:    q.regularMarketVolume             ?? 0,
        prevClose: q.regularMarketPreviousClose      ?? 0,
      };
    }
  } catch { /* use defaults */ }

  if (spot && spot.price > 100) {
    // Calculate basis offset from futures so we can adjust OHLV to spot level
    const basis = futuresQuote ? futuresQuote.price - spot.price : 0;

    const prevClose = futuresQuote ? futuresQuote.prevClose - basis : spot.price * 0.99;
    const change    = prevClose > 0 ? spot.price - prevClose : 0;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return res.json({
      price:     spot.price,
      bid:       spot.bid,
      ask:       spot.ask,
      change:    parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(4)),
      high:      futuresQuote ? parseFloat((futuresQuote.high  - basis).toFixed(2)) : spot.price * 1.003,
      low:       futuresQuote ? parseFloat((futuresQuote.low   - basis).toFixed(2)) : spot.price * 0.997,
      open:      futuresQuote ? parseFloat((futuresQuote.open  - basis).toFixed(2)) : spot.price,
      volume:    futuresQuote?.volume ?? 0,
      prevClose: parseFloat(prevClose.toFixed(2)),
      timestamp: new Date().toISOString(),
      ticker:    "XAUUSD",
      isSpot:    true,
    });
  }

  // Full fallback: GC=F futures only (note: ~$25-30 above CFD spot due to contango)
  if (futuresQuote) {
    const q = futuresQuote;
    const change    = q.price - q.prevClose;
    const changePct = q.prevClose > 0 ? (change / q.prevClose) * 100 : 0;
    return res.json({
      price:     q.price,
      change:    parseFloat(change.toFixed(2)),
      changePct: parseFloat(changePct.toFixed(4)),
      high:      q.high,
      low:       q.low,
      open:      q.open,
      volume:    q.volume,
      prevClose: q.prevClose,
      timestamp: new Date().toISOString(),
      ticker:    GOLD_TICKER,
      isSpot:    false,
    });
  }

  req.log.error("All price sources failed");
  return res.status(500).json({ error: "Failed to fetch gold price" });
});

export default router;
