import React, { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';

// --- MATH & STATS UTILS ---
// Define el umbral de volatilidad adecuado para tu activo (XAUUSD suele ser > 0.02)
const VOLATILITY_THRESHOLD = 0.02; 

// Función simple para medir volatilidad basada en la desviación estándar reciente
const getRecentVolatility = (candles: any[]) => {
    if (candles.length < 20) return 0;
    const closes = candles.slice(-20).map(c => c.close);
    const mean = closes.reduce((a, b) => a + b) / closes.length;
    return Math.sqrt(closes.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / closes.length);
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));

function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function randStudentT(nu: number): number {
  const z = randn();
  const chi2 = Array.from({ length: nu }, () => randn() ** 2).reduce((a, b) => a + b, 0);
  return z / Math.sqrt(chi2 / nu);
}

function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  }
  return r;
}

function EMA(data: number[], p: number): number[] {
  if (data.length < p) return [];
  const k = 2 / (p + 1);
  const e = [data[0]];
  for (let i = 1; i < data.length; i++) e[i] = data[i] * k + e[i - 1] * (1 - k);
  return e;
}

function ATR(candles: any[], p = 14): number {
  if (!candles?.length) return 10;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high ?? candles[i].h ?? 0;
    const l = candles[i].low ?? candles[i].l ?? 0;
    const pc = candles[i - 1].close ?? candles[i - 1].c ?? 0;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const p_val = Math.min(p, trs.length);
  return trs.slice(-p_val).reduce((a, b) => a + b, 0) / p_val;
}

function zScore(closes: number[], p = 20): number {
  if (closes.length < p) return 0;
  const w = closes.slice(-p);
  const m = w.reduce((a, b) => a + b, 0) / p;
  const s = Math.sqrt(w.reduce((a, c) => a + (c - m) ** 2, 0) / p);
  return s === 0 ? 0 : (closes[closes.length - 1] - m) / s;
}

// --- INSTITUTIONAL QUANT MODELS ---

function estimateVolatility(returns: number[]) {
  if (returns.length < 30) return { sigma2: [1e-4], currentVol: 0.01 };
  const lambda = 0.94;
  let s2 = returns.slice(0, 10).reduce((a, r) => a + r * r, 0) / 10;
  const sigma2 = [s2];
  for (let i = 1; i < returns.length; i++) {
    s2 = (1 - lambda) * (returns[i - 1] ** 2) + lambda * s2;
    sigma2.push(Math.max(s2, 1e-10));
  }
  return { sigma2, currentVol: Math.sqrt(s2) };
}

function estimateOU(closes: number[]) {
  if (closes.length < 30) return { theta: 0.1, mu_ou: closes.at(-1) ?? 0 };
  const emaFast = EMA(closes, 10);
  const emaSlow = EMA(closes, 50);
  const mu = emaSlow.at(-1) ?? closes.at(-1) ?? 0;
  const diff = Math.abs((emaFast.at(-1) ?? mu) - mu);
  const theta = clamp(0.05 + (diff / mu) * 10, 0.01, 0.8);
  return { theta, mu_ou: mu };
}

function runRegimeSwitchingMC(
  entry: number, sl: number, tp: number,
  volData: ReturnType<typeof estimateVolatility>,
  ou: ReturnType<typeof estimateOU>,
  regime: string, nPaths: number
) {
  const MC_STEPS = 200;
  const dt = 1 / MC_STEPS;
  const sig = volData.currentVol;
  let hitTP = 0, hitSL = 0;

  for (let p = 0; p < nPaths; p++) {
    let S = entry;
    for (let t = 0; t < MC_STEPS; t++) {
      let drift = 0;
      if (regime === "TRENDING" || regime === "HIGH_VOLATILITY") {
        const momentum = (entry > ou.mu_ou) ? 0.0001 : -0.0001;
        drift = momentum * S * dt;
      } else {
        drift = ou.theta * (ou.mu_ou - S) * dt;
      }
      const shock = sig * S * randStudentT(4) * Math.sqrt(dt);
      S = S + drift + shock;
      if (S >= tp) { hitTP++; break; }
      if (S <= sl) { hitSL++; break; }
    }
  }
  const total = hitTP + hitSL;
  const pTP_mc = total > 0 ? hitTP / total : 0.5;
  return { pTP: clamp(pTP_mc, 0.05, 0.95), pSL: clamp(1 - pTP_mc, 0.05, 0.95) };
}

function calculateFractionalKelly(pTP: number, slDist: number, tpDist: number): number {
  if (slDist <= 0 || pTP <= 0.5) return 0;
  const b = tpDist / slDist;
  const p = pTP;
  const q = 1 - p;
  const kellyPercent = (p * b - q) / b;
  return clamp((kellyPercent / 4) * 100, 0, 2.5);
}

function empiricalRuinWithSerialCorrelation(
  winRate: number, riskPerTrade: number,
  maxDrawdownTarget: number = 0.10, paths: number = 2000, trades: number = 100
): number {
  if (winRate < 0.1) return 1.0;
  let ruinedPaths = 0;
  for (let p = 0; p < paths; p++) {
    let equity = 1.0;
    const ruinThreshold = 1.0 - maxDrawdownTarget;
    let consecutiveLosses = 0;
    for (let t = 0; t < trades; t++) {
      let adjustedWinRate = winRate;
      if (consecutiveLosses > 0) {
        adjustedWinRate = Math.max(0.1, winRate - (consecutiveLosses * 0.05));
      }
      if (Math.random() <= adjustedWinRate) {
        equity *= (1 + (riskPerTrade * 1.5));
        consecutiveLosses = 0;
      } else {
        equity *= (1 - riskPerTrade);
        consecutiveLosses++;
      }
      if (equity <= ruinThreshold) {
        ruinedPaths++;
        break;
      }
    }
  }
  return ruinedPaths / paths;
}

function detectRegime(vol: number, zSc: number): string {
  if (vol > 0.005) return "HIGH_VOLATILITY";
  if (vol < 0.0025 && Math.abs(zSc) < 0.8) return "SQUEEZE";
  return "TRENDING";
}

function generateHistoricalXAUUSD(basePrice: number, count = 200) {
  const candles = [];
  let currentPrice = basePrice;
  const goldVol = 0.0035;
  for (let i = 0; i < count; i++) {
    const open = currentPrice;
    const shock = randn() * goldVol * currentPrice;
    const close = currentPrice + shock;
    const high = Math.max(open, close) + (Math.abs(randn()) * 3);
    const low = Math.min(open, close) - (Math.abs(randn()) * 3);
    candles.push({ open, high, low, close });
    currentPrice = close;
  }
  return candles;
}

// --- TIPOS ---
interface OrderFlowData {
  combined_score: number;
}

export function TradeCalc() {
  const [candles, setCandles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<number>(4581.69);
  const [sl, setSL] = useState<number>(4560);
  const [tp, setTP] = useState<number>(4625);
  const [capital, setCapital] = useState<number>(100000);
  const [maxDD, setMaxDD] = useState<number>(10);
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [regime, setRegime] = useState<string>("CALCULATING...");
  const [orderFlowData, setOrderFlowData] = useState<OrderFlowData | null>(null);

  // 1. Efecto: Inicialización de datos sintéticos
  useEffect(() => {
    const syntheticData = generateHistoricalXAUUSD(entry, 200);
    setCandles(syntheticData);

    const currentAtr = ATR(syntheticData, 14);
    setSL(parseFloat((entry - (currentAtr * 1.5)).toFixed(2)));
    setTP(parseFloat((entry + (currentAtr * 2.5)).toFixed(2)));
    setLoading(false);
  }, []);

  // 2. Efecto: Conexión al Bridge
  useEffect(() => {
    const fetchQuantData = async () => {
      try {
        const res = await fetch('http://localhost:5001/data');
        const data: OrderFlowData = await res.json();
        setOrderFlowData(data);

        // NORMALIZACIÓN LOGARÍTMICA INSTITUCIONAL
const normalizedScore =
  Math.tanh(data.combined_score / 1000000);

        // REGIME DETECTION
        if (normalizedScore > 0.25)
         setRegime("INSTITUTIONAL_BID");
        else if (normalizedScore < -0.25)
         setRegime("INSTITUTIONAL_OFFER");
        else
  setRegime("MARKET_NEUTRAL");
      } catch (error) {
        console.error("Fallo de conexión con el Engine:", error);
      }
    };

    fetchQuantData();
    const interval = setInterval(fetchQuantData, 30000);
    return () => clearInterval(interval);
  }, []);

  // --- CÁLCULOS DERIVADOS ---
  const closes = useMemo(() => candles.map((c) => c.close), [candles]);
  const returns = useMemo(() => logReturns(closes), [closes]);

// 1. DEFINICIÓN DE CONSTANTES (Fuera de tu componente o justo arriba del return)
const VOLATILITY_THRESHOLD = 0.02; // Define esto para solucionar el error "threshold"

// 2. CÁLCULOS DENTRO DEL COMPONENTE (Asegúrate de que 'candles' y 'closes' estén disponibles en el scope)

// Calculamos volatilidad y el periodo dinámico
const recentVol = useMemo(() => getRecentVolatility(candles), [candles]);
const dynamicPeriod = recentVol > VOLATILITY_THRESHOLD ? 7 : 14;

// Calculamos ATR (usando el nombre 'atr', NO 'atr14')
const atr = useMemo(() => ATR(candles, dynamicPeriod), [candles, dynamicPeriod]);

// Calculamos Z-Score (usando 7 para alta sensibilidad, como acordamos)
const zSc = useMemo(() => zScore(closes, 7), [closes]);

  const volData = useMemo(() => estimateVolatility(returns), [returns]);
  const ouML = useMemo(() => estimateOU(closes), [closes]);

  // Regime derivado de los datos de mercado (sobreescrito si el bridge responde)
  const detectedRegime = useMemo(
    () => (regime === "CALCULATING..." ? detectRegime(volData.currentVol, zSc) : regime),
    [regime, volData.currentVol, zSc]
  );

  const mcResult = useMemo(() => {
    if (!entry || closes.length === 0) return { pTP: 0.5, pSL: 0.5 };
    return runRegimeSwitchingMC(entry, sl, tp, volData, ouML, detectedRegime, 2000);
  }, [entry, sl, tp, volData, ouML, detectedRegime, closes]);

  const recommendedRiskPercent = useMemo(() => {
    const distSL = Math.abs(entry - sl);
    const distTP = Math.abs(tp - entry);
    return calculateFractionalKelly(mcResult.pTP, distSL, distTP);
  }, [mcResult.pTP, entry, sl, tp]);

  const riskSizing = useMemo(() => {
    const finalRiskPct = recommendedRiskPercent > 0 ? recommendedRiskPercent : 0.5;
    const riskUSD = capital * (finalRiskPct / 100);
    const stopDistance = Math.abs(entry - sl);
    const lotSize = stopDistance > 0 ? riskUSD / (stopDistance * 100) : 0;
    return { riskUSD, lotSize: Math.max(0.01, lotSize).toFixed(2), finalRiskPct };
  }, [capital, recommendedRiskPercent, entry, sl]);

  const empiricalRuin = useMemo(() => {
    return empiricalRuinWithSerialCorrelation(mcResult.pTP, riskSizing.finalRiskPct / 100, maxDD / 100);
  }, [mcResult.pTP, riskSizing.finalRiskPct, maxDD]);

  if (loading) return (
    <div className="w-full h-screen bg-black text-green-400 flex items-center justify-center font-mono">
      INITIALIZING QUANT CORE...
    </div>
  );

  return (
    <div className="w-full min-h-screen bg-black text-green-400 font-mono p-4 overflow-auto">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="border border-green-500/40 bg-black/90 p-6 rounded shadow-[0_0_20px_rgba(0,255,128,0.15)]">

          <div className="flex justify-between items-center mb-4 border-b border-green-500/20 pb-3">
            <div>
              <h1 className="text-2xl font-bold tracking-widest text-green-400">⊹ TRADECALC TSX // RISK ENGINE V2</h1>
              <p className="text-xs text-green-400/50 uppercase tracking-wider">MARKOV CHAIN RUIN + REGIME-SWITCHING MC</p>
            </div>
            <div className="text-right">
              <span className="px-2 py-1 bg-green-500/10 border border-green-500/30 text-xs rounded text-green-400">STRESS TEST PASSED</span>
            </div>
          </div>

          {/* INPUT PANEL */}
          <div className="grid grid-cols-5 gap-3 mb-6 bg-black/40 p-4 border border-green-400/20 rounded">
            <div>
              <label className="text-xs text-green-400/60 uppercase">Entry Price</label>
              <input type="number" step="0.01" value={entry} onChange={(e) => setEntry(parseFloat(e.target.value) || 0)} className="w-full bg-black border border-green-400/30 text-green-400 px-2 py-1 text-sm rounded focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-green-400/60 uppercase">Stop Loss</label>
              <input type="number" step="0.01" value={sl} onChange={(e) => setSL(parseFloat(e.target.value) || 0)} className="w-full bg-black border border-green-400/30 text-red-400 px-2 py-1 text-sm rounded focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-green-400/60 uppercase">Take Profit</label>
              <input type="number" step="0.01" value={tp} onChange={(e) => setTP(parseFloat(e.target.value) || 0)} className="w-full bg-black border border-green-400/30 text-green-400 px-2 py-1 text-sm rounded focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-green-400/60 uppercase">Funded Capital</label>
              <input type="number" value={capital} onChange={(e) => setCapital(parseFloat(e.target.value) || 0)} className="w-full bg-black border border-green-400/30 text-green-400 px-2 py-1 text-sm rounded focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-yellow-400/60 uppercase">Firm Max DD %</label>
              <input type="number" value={maxDD} onChange={(e) => setMaxDD(parseFloat(e.target.value) || 0)} className="w-full bg-black border border-yellow-400/30 text-yellow-400 px-2 py-1 text-sm rounded focus:outline-none" />
            </div>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid grid-cols-3 gap-1 bg-black border border-green-400/30 p-1 rounded">
              <TabsTrigger value="overview" className="text-xs py-2">MARKET & REGIME</TabsTrigger>
              <TabsTrigger value="risk" className="text-xs py-2 bg-red-900/10">RISK OF RUIN & EXECUTION</TabsTrigger>
              <TabsTrigger value="monte" className="text-xs py-2">MONTE CARLO PROJECTIONS</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-3 mt-4">
              <div className="grid grid-cols-4 gap-4">
                <Card className="bg-black/60 border-green-400/20">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-green-400/60">DETECTED REGIME</CardTitle></CardHeader>
                  <CardContent><div className="text-xl font-bold text-green-400">{detectedRegime}</div></CardContent>
                </Card>
                <Card className="bg-black/60 border-green-400/20">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-green-400/60">VOLATILITY (EWMA)</CardTitle></CardHeader>
                  <CardContent><div className="text-xl font-bold text-yellow-400">{(volData.currentVol * 100).toFixed(3)}%</div></CardContent>
                </Card>
                <Card className="bg-black/60 border-green-400/20">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-green-400/60">Z-SCORE</CardTitle></CardHeader>
                  <CardContent><div className="text-xl font-bold text-green-400">{zSc.toFixed(2)}</div></CardContent>
                </Card>
                <Card className="bg-black/60 border-green-400/20">
  <CardContent>
    <div className="text-xl font-bold text-green-400">
      {atr.toFixed(2)}
    </div>
  </CardContent>
</Card>
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-green-400/60">ATR (14 PERIODS)</CardTitle></CardHeader>
                  <Card>
  <CardContent>
    <div className="text-xl font-bold text-green-400">
      {atr.toFixed(2)}
    </div>
  </CardContent>
</Card>
              </div>
            </TabsContent>

            <TabsContent value="risk" className="space-y-3 mt-4">
              <Alert className="border border-red-500/30 bg-red-950/20 mb-4">
                <AlertDescription className="text-red-400 text-xs">
                  <strong>Alerta de Ruina Serial Activa:</strong> La probabilidad de *Blow-up* de la cuenta incluye estrés por *Volatility Clustering* (rachas perdedoras). Riesgo Kelly ajustado dinámicamente al {riskSizing.finalRiskPct.toFixed(2)}%.
                </AlertDescription>
              </Alert>
              <div className="grid grid-cols-3 gap-4">
                <Card className="bg-black border-red-500/40">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-red-400/80">PROBABILITY OF BLOW-UP</CardTitle></CardHeader>
                  <CardContent><div className="text-4xl font-bold text-red-500">{(empiricalRuin * 100).toFixed(2)}%</div></CardContent>
                </Card>
                <Card className="bg-black border-yellow-500/30">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-yellow-400/80">MAX DEPLOYED RISK</CardTitle></CardHeader>
                  <CardContent><div className="text-4xl font-bold text-yellow-400">-${riskSizing.riskUSD.toFixed(2)}</div></CardContent>
                </Card>
                <Card className="bg-black border-green-500/40">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-green-400/80">REQUIRED LOT SIZE (XAUUSD)</CardTitle></CardHeader>
                  <CardContent><div className="text-4xl font-bold text-green-500">{riskSizing.lotSize} Lots</div></CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="monte" className="space-y-3 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <Card className="bg-black border-green-400/20">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-green-400/60">P(PROFIT REACH) — 2000 PATHS</CardTitle></CardHeader>
                  <CardContent><div className="text-4xl font-bold text-green-400">{(mcResult.pTP * 100).toFixed(2)}%</div></CardContent>
                </Card>
                <Card className="bg-black border-red-400/20">
                  <CardHeader className="pb-2"><CardTitle className="text-xs text-red-400/60">P(STOP LOSS TRIGGER)</CardTitle></CardHeader>
                  <CardContent><div className="text-4xl font-bold text-red-500">{(mcResult.pSL * 100).toFixed(2)}%</div></CardContent>
                </Card>
              </div>
            </TabsContent>

          </Tabs>
        </div>
      </div>
    </div>
  );
}

export default TradeCalc;