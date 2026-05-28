import { Router } from "express";
import { logReturns, yf } from "./utils.js";

const router = Router();

const PORTFOLIO_TICKERS = [
  { ticker: "GC=F", name: "Gold Futures" },
  { ticker: "GLD", name: "SPDR Gold ETF" },
  { ticker: "NEM", name: "Newmont Corp" },
  { ticker: "GOLD", name: "Barrick Gold" },
  { ticker: "AEM", name: "Agnico Eagle" },
  { ticker: "FNV", name: "Franco-Nevada" },
];

function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length, m = B[0].length, k = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      for (let l = 0; l < k; l++)
        C[i][j] += A[i][l] * B[l][j];
  return C;
}

function portfolioStats(weights: number[], returns: number[][], covMatrix: number[][]): { ret: number; risk: number } {
  const n = weights.length;
  let ret = 0;
  for (let i = 0; i < n; i++) ret += weights[i] * returns[i].reduce((a, b) => a + b, 0) / returns[i].length;
  ret *= 252;

  let variance = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      variance += weights[i] * weights[j] * covMatrix[i][j];
  return { ret, risk: Math.sqrt(variance * 252) };
}

function covarianceMatrix(allRets: number[][]): number[][] {
  const n = allRets.length;
  const T = Math.min(...allRets.map((r) => r.length));
  const means = allRets.map((r) => r.slice(0, T).reduce((a, b) => a + b, 0) / T);
  const cov: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let t = 0; t < T; t++) sum += (allRets[i][t] - means[i]) * (allRets[j][t] - means[j]);
      cov[i][j] = sum / (T - 1);
    }
  return cov;
}

function correlationMatrix(cov: number[][]): number[][] {
  const n = cov.length;
  const stds = cov.map((row, i) => Math.sqrt(row[i]));
  return cov.map((row, i) => row.map((v, j) => stds[i] && stds[j] ? v / (stds[i] * stds[j]) : 0));
}

router.get("/portfolio", async (req, res) => {
  try {
    const results = await Promise.allSettled(
      PORTFOLIO_TICKERS.map((t) =>
        yf.chart(t.ticker, { interval: "1d", period1: new Date(Date.now() - 365 * 86400000) })
      )
    );

    const allRets: number[][] = [];
    const priceData: { price: number; changePct: number }[] = [];

    for (const r of results) {
      if (r.status === "rejected") {
        allRets.push([0.001]);
        priceData.push({ price: 0, changePct: 0 });
        continue;
      }
      const quotes = r.value.quotes.filter((q) => q.close != null);
      const closes = quotes.map((q) => q.close as number);
      allRets.push(logReturns(closes).length > 0 ? logReturns(closes) : [0.001]);
      const last = closes[closes.length - 1] ?? 0;
      const prev = closes[closes.length - 2] ?? last;
      priceData.push({ price: last, changePct: prev ? ((last - prev) / prev) * 100 : 0 });
    }

    const cov = covarianceMatrix(allRets);
    const corr = correlationMatrix(cov);
    const n = PORTFOLIO_TICKERS.length;

    // Markowitz: simulate random portfolios to find efficient frontier
    const frontier: { risk: number; return_: number; sharpe: number }[] = [];
    let bestSharpe = -Infinity;
    let optimalPortfolio = { risk: 0, return_: 0, sharpe: 0 };
    let optimalWeights: number[] = new Array(n).fill(1 / n);

    for (let sim = 0; sim < 2000; sim++) {
      const raw = Array.from({ length: n }, () => Math.random());
      const sum = raw.reduce((a, b) => a + b, 0);
      const w = raw.map((x) => x / sum);
      const { ret, risk } = portfolioStats(w, allRets, cov);
      const sharpe = risk > 0 ? (ret - 0.05) / risk : 0;
      frontier.push({ risk: parseFloat(risk.toFixed(4)), return_: parseFloat(ret.toFixed(4)), sharpe: parseFloat(sharpe.toFixed(4)) });
      if (sharpe > bestSharpe) {
        bestSharpe = sharpe;
        optimalPortfolio = { risk, return_: ret, sharpe };
        optimalWeights = w;
      }
    }

    const { ret: portRet, risk: portRisk } = portfolioStats(optimalWeights, allRets, cov);
    const portSharpe = portRisk > 0 ? (portRet - 0.05) / portRisk : 0;

    const meanRets = allRets.map((r) => {
      const m = r.reduce((a, b) => a + b, 0) / r.length;
      return m * 252;
    });
    const annualVols = cov.map((row, i) => Math.sqrt(row[i] * 252));

    const assets = PORTFOLIO_TICKERS.map((t, i) => ({
      ticker: t.ticker,
      name: t.name,
      weight: parseFloat(optimalWeights[i].toFixed(4)),
      expectedReturn: parseFloat(meanRets[i].toFixed(4)),
      volatility: parseFloat(annualVols[i].toFixed(4)),
      sharpe: annualVols[i] > 0 ? parseFloat(((meanRets[i] - 0.05) / annualVols[i]).toFixed(4)) : 0,
      price: priceData[i].price,
      changePct: parseFloat(priceData[i].changePct.toFixed(4)),
    }));

    res.json({
      assets,
      frontier: frontier.slice(0, 500),
      optimalPortfolio,
      portfolioReturn: parseFloat(portRet.toFixed(4)),
      portfolioVol: parseFloat(portRisk.toFixed(4)),
      portfolioSharpe: parseFloat(portSharpe.toFixed(4)),
      correlationMatrix: corr.map((row) => row.map((v) => parseFloat(v.toFixed(4)))),
      tickers: PORTFOLIO_TICKERS.map((t) => t.ticker),
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching portfolio");
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
});

export default router;
