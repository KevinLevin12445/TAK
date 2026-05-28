import { Router } from "express";
import { GOLD_TICKER, yf } from "./utils.js";

const router = Router();

const HEATMAP_ASSETS = [
  { ticker: "GC=F", name: "GC=F", sector: "Gold & Precious" },
  { ticker: "GLD", name: "GLD", sector: "Gold & Precious" },
  { ticker: "IAU", name: "IAU", sector: "Gold & Precious" },
  { ticker: "NEM", name: "NEM", sector: "Gold & Precious" },
  { ticker: "GOLD", name: "GOLD", sector: "Gold & Precious" },
  { ticker: "AEM", name: "AEM", sector: "Gold & Precious" },
  { ticker: "FNV", name: "FNV", sector: "Gold & Precious" },
  { ticker: "AAPL", name: "AAPL", sector: "Technology" },
  { ticker: "MSFT", name: "MSFT", sector: "Technology" },
  { ticker: "NVDA", name: "NVDA", sector: "Technology" },
  { ticker: "GOOGL", name: "GOOGL", sector: "Technology" },
  { ticker: "AMZN", name: "AMZN", sector: "Technology" },
  { ticker: "META", name: "META", sector: "Technology" },
  { ticker: "SPY", name: "SPY", sector: "Macro ETFs" },
  { ticker: "QQQ", name: "QQQ", sector: "Macro ETFs" },
  { ticker: "GDX", name: "GDX", sector: "Macro ETFs" },
  { ticker: "JPM", name: "JPM", sector: "Financials" },
  { ticker: "BAC", name: "BAC", sector: "Financials" },
  { ticker: "WMT", name: "WMT", sector: "Consumer" },
  { ticker: "PG", name: "PG", sector: "Consumer" },
  { ticker: "XOM", name: "XOM", sector: "Energy" },
  { ticker: "CVX", name: "CVX", sector: "Energy" },
];

const COUNTRY_ETFS = [
  { country: "USA", code: "SPY", lat: 37.1, lng: -95.7 },
  { country: "China", code: "FXI", lat: 35.8, lng: 104.2 },
  { country: "Europe", code: "VGK", lat: 50.1, lng: 9.1 },
  { country: "Japan", code: "EWJ", lat: 36.2, lng: 138.3 },
  { country: "India", code: "INDA", lat: 20.6, lng: 78.9 },
  { country: "Brazil", code: "EWZ", lat: -14.2, lng: -51.9 },
  { country: "Canada", code: "EWC", lat: 56.1, lng: -106.3 },
  { country: "Australia", code: "EWA", lat: -25.3, lng: 133.8 },
];

router.get("/heatmap", async (req, res) => {
  try {
    const tickers = HEATMAP_ASSETS.map((a) => a.ticker);
    const countryTickers = COUNTRY_ETFS.map((c) => c.code);

    const [assetQuotes, countryQuotes] = await Promise.all([
      Promise.allSettled(tickers.map((t) => yf.quote(t))),
      Promise.allSettled(countryTickers.map((t) => yf.quote(t))),
    ]);

    const assets = HEATMAP_ASSETS.map((a, i) => {
      const result = assetQuotes[i];
      if (result.status === "rejected") {
        return { ticker: a.ticker, name: a.name, changePct: 0, marketCap: 0, sector: a.sector, price: 0 };
      }
      const q = result.value;
      return {
        ticker: a.ticker,
        name: a.name,
        changePct: q.regularMarketChangePercent ?? 0,
        marketCap: q.marketCap ?? 1e9,
        sector: a.sector,
        price: q.regularMarketPrice ?? 0,
      };
    });

    const goldAsset = assets.find((a) => a.ticker === GOLD_TICKER);

    const countryPerf = COUNTRY_ETFS.map((c, i) => {
      const result = countryQuotes[i];
      const changePct = result.status === "fulfilled" ? (result.value.regularMarketChangePercent ?? 0) : 0;
      return { country: c.country, code: c.code, changePct, lat: c.lat, lng: c.lng };
    });

    res.json({
      assets,
      goldPrice: goldAsset?.price ?? 0,
      goldChangePct: goldAsset?.changePct ?? 0,
      countryPerf,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching heatmap");
    res.status(500).json({ error: "Failed to fetch heatmap" });
  }
});

export default router;
