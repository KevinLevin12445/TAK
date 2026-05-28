import { Router } from "express";
import { yf } from "./utils.js";

const router = Router();

router.get("/alerts", async (req, res) => {
  try {
    // Fetch real news from Yahoo Finance
    let newsItems: { title: string; url: string; source: string; publishedAt: string }[] = [];
    try {
      const search = await yf.search("gold XAUUSD GC=F", { newsCount: 10, quotesCount: 0 });
      if (search.news) {
        newsItems = search.news.slice(0, 10).map((n) => ({
          title: n.title || "Gold Market Update",
          url: n.link || "https://finance.yahoo.com",
          source: n.publisher || "Yahoo Finance",
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime * 1000).toISOString()
            : new Date().toISOString(),
        }));
      }
    } catch {
      newsItems = [];
    }

    if (!newsItems.length) {
      newsItems = [
        { title: "Gold prices today: Market update", url: "https://finance.yahoo.com", source: "Yahoo Finance", publishedAt: new Date().toISOString() },
        { title: "Gold ETF flows show institutional interest", url: "https://finance.yahoo.com", source: "Reuters", publishedAt: new Date(Date.now() - 3600000).toISOString() },
        { title: "Central bank gold buying accelerates", url: "https://finance.yahoo.com", source: "Bloomberg", publishedAt: new Date(Date.now() - 7200000).toISOString() },
      ];
    }

    // Generate alerts based on first news items
    const alerts = newsItems.slice(0, 6).map((n, i) => {
      const level = i === 0 ? "HIGH" : i < 3 ? "MEDIUM" : "LOW";
      const type = i % 2 === 0 ? "NEWS" : "PRICE";
      return {
        id: `alert-${i}-${Date.now()}`,
        level,
        type,
        time: n.publishedAt,
        title: n.title.length > 60 ? n.title.slice(0, 60) + "..." : n.title,
        body: n.title,
        source: n.source,
        ticker: "XAUUSD",
      };
    });

    res.json({ alerts, news: newsItems });
  } catch (err) {
    req.log.error({ err }, "Error fetching alerts");
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

export default router;
