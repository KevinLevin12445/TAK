import { Router, Request, Response } from "express";

const router = Router();

/**
 * GET /api/gold/insider-bridge
 * Versión final con tipado corregido para evitar errores de 'Spread types'.
 */
router.get("/insider-bridge", async (req: Request, res: Response) => {
  try {
    const response = await fetch("http://localhost:5001/data" );
    
    if (!response.ok) throw new Error("Scraper API error");
    
    // Le decimos a TS que 'data' es un objeto (any) para que permita el spread
    const data = await response.json() as any;
    
    if (data && typeof data === 'object') {
      return res.json({ ...data, source: "SCRAPER_LIVE_API" });
    } else {
      throw new Error("Invalid data format");
    }
    
  } catch (err) {
    return res.json({
      source: "MOCK_MODE (Scraper Offline)",
      timestamp: new Date().toISOString(),
      ticker: "GLD",
      signal: "NEUTRAL",
      combined_score: 0,
      gamma_exposure: [],
      dark_pool: [],
      option_flow: [],
      transactions: [],
      meta: { status: "Please run test_scraper_api.py" }
    });
  }
});

export default router;
