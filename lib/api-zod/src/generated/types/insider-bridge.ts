import { Router } from "express";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const router = Router();

// Ruta al archivo de estado del scraper
const SCRAPER_STATE_FILE = join(process.cwd(), "scraper_state.json");

/**
 * GET /api/gold/insider-bridge
 * Lee el estado del scraper (si existe) y lo retorna.
 * Si no existe, retorna datos mock/fallback.
 */
router.get("/insider-bridge", async (req, res) => {
  try {
    let scraperData: any = null;

    // Intentar leer el archivo de estado del scraper
    if (existsSync(SCRAPER_STATE_FILE)) {
      try {
        const raw = readFileSync(SCRAPER_STATE_FILE, "utf-8");
        scraperData = JSON.parse(raw);
      } catch (parseErr) {
        console.warn("Failed to parse scraper state file:", parseErr);
      }
    }

    // Si tenemos datos del scraper, retornarlos enriquecidos
    if (scraperData) {
      return res.json({
        source: "SCRAPER_LIVE",
        timestamp: scraperData.timestamp,
        ticker: scraperData.ticker,
        signal: scraperData.signal,
        current_score: scraperData.current_score,
        option_flow_score: scraperData.option_flow_score,
        dark_pool_score: scraperData.dark_pool_score,
        combined_score: scraperData.combined_score,
        momentum: scraperData.momentum,
        n_transactions: scraperData.n_transactions,
        n_buys: scraperData.n_buys,
        n_sells: scraperData.n_sells,
        n_buy_clusters: scraperData.n_buy_clusters,
        n_option_trades: scraperData.n_option_trades,
        n_dark_pool_prints: scraperData.n_dark_pool_prints,
        data_source: scraperData.data_source,
        transactions: scraperData.transactions || [],
        option_flow: scraperData.option_flow || [],
        dark_pool: scraperData.dark_pool || [],
        gamma_exposure: scraperData.gamma_exposure || [],
        meta: scraperData.meta || {},
      });
    }

    // Fallback: retornar datos mock si no hay scraper
    return res.json({
      source: "FALLBACK_MOCK",
      timestamp: new Date().toISOString(),
      ticker: "GLD",
      signal: "STRONG BULLISH",
      current_score: 0.6969,
      option_flow_score: 0.45,
      dark_pool_score: 0.52,
      combined_score: 0.5729,
      momentum: 125000,
      n_transactions: 12,
      n_buys: 8,
      n_sells: 4,
      n_buy_clusters: 2,
      n_option_trades: 18,
      n_dark_pool_prints: 24,
      data_source: "SEC EDGAR + Mock Insider Finance",
      transactions: [
        {
          timestamp: new Date(Date.now() - 3 * 86400000).toISOString(),
          ticker: "GLD",
          insider: "Tether Global Invest",
          role: "10pct_owner",
          type: "BUY",
          value: 2520000,
        },
      ],
      option_flow: [
        {
          time: new Date().toLocaleTimeString(),
          type: "Call",
          strike: 4550,
          expiry: "06-21",
          size: 2500,
          premium: 1250,
          heat_score: 85,
        },
      ],
      dark_pool: [
        {
          time: new Date().toLocaleTimeString(),
          price: 4538,
          size: 15000,
          amount: 68070000,
          pool_type: "Dark",
        },
      ],
      gamma_exposure: [
        { price: 4400, gex: -150000 },
        { price: 4450, gex: -50000 },
        { price: 4500, gex: 100000 },
        { price: 4550, gex: 250000 },
        { price: 4600, gex: 180000 },
      ],
      meta: {
        last_update: new Date().toLocaleTimeString(),
        cycle: 0,
        error: "Scraper not running",
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching insider bridge data");
    res.status(500).json({ error: "Failed to fetch insider bridge data" });
  }
});

export default router;
