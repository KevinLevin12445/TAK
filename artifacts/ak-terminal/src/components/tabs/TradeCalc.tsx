import { useState } from "react";
import { useGetGoldPrice } from "@workspace/api-client-react";

type Mode = "SCALP" | "INTRADAY" | "SWING";

const DEFAULTS = {
  SCALP: { vol: 40, commission: 0.05, capital: 10000, lev: 20 },
  INTRADAY: { vol: 25, commission: 0.03, capital: 10000, lev: 10 },
  SWING: { vol: 18, commission: 0.01, capital: 10000, lev: 5 },
};

export function TradeCalc() {
  const { data: priceData } = useGetGoldPrice();
  
  const [mode, setMode] = useState<Mode>("INTRADAY");
  const [entry, setEntry] = useState(priceData?.price || 2000);
  const [sl, setSl] = useState(1990);
  const [tp1, setTp1] = useState(2020);
  const [dir, setDir] = useState<"LONG"|"SHORT">("LONG");
  
  const [vol, setVol] = useState(DEFAULTS.INTRADAY.vol);
  const [comm, setComm] = useState(DEFAULTS.INTRADAY.commission);
  const [capital, setCapital] = useState(DEFAULTS.INTRADAY.capital);
  const [lev, setLev] = useState(DEFAULTS.INTRADAY.lev);

  // Calculations
  const d_sl = Math.abs(entry - sl);
  const d_tp = Math.abs(entry - tp1);
  const rr = d_sl > 0 ? (d_tp / d_sl).toFixed(2) : "0.00";
  const p_tp = d_sl > 0 && d_tp > 0 ? (d_sl / (d_tp + d_sl)) : 0;
  const ev = (p_tp * d_tp) - ((1 - p_tp) * d_sl) - (comm / 100 * entry);
  const kelly = (parseFloat(rr) > 0) ? ((p_tp * parseFloat(rr) - (1 - p_tp)) / parseFloat(rr)) / 4 : 0;
  const posSize = Math.max(0, kelly * capital * lev);
  const var95 = (vol / 100 / Math.sqrt(252)) * 1.645 * capital;
  
  // Score
  let score = 0;
  if (parseFloat(rr) > 1.5) score += 40;
  else if (parseFloat(rr) > 1) score += 20;
  if (ev > 0) score += 30;
  if (p_tp > 0.4) score += 30;
  else if (p_tp > 0.3) score += 15;

  const scoreColor = score >= 70 ? "text-primary border-primary bg-primary/10" : score >= 40 ? "text-accent border-accent bg-accent/10" : "text-destructive border-destructive bg-destructive/10";
  const scoreBadge = score >= 70 ? "✓ VALID TRADE — EXECUTE" : score >= 40 ? "⚠ MARGINAL — ADJUST LEVELS" : "✗ INVALID — DO NOT ENTER";

  const applyMode = (m: Mode) => {
    setMode(m);
    setVol(DEFAULTS[m].vol);
    setComm(DEFAULTS[m].commission);
    setLev(DEFAULTS[m].lev);
    setCapital(DEFAULTS[m].capital);
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex gap-2">
        {(["SCALP", "INTRADAY", "SWING"] as Mode[]).map(m => (
          <button 
            key={m}
            onClick={() => applyMode(m)}
            className={`px-4 py-1 border ${mode === m ? 'bg-primary text-black border-primary' : 'bg-black text-primary border-primary/30 hover:bg-primary/20'}`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
        {/* Input Panel */}
        <div className="border border-primary p-4 bg-black flex flex-col gap-4">
          <h3 className="text-xl font-bold border-b border-primary/30 pb-2">INPUT PARAMETERS</h3>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-primary/70">DIRECTION</label>
              <div className="flex gap-1">
                <button onClick={() => setDir("LONG")} className={`flex-1 py-1 border ${dir === "LONG" ? "bg-primary text-black border-primary" : "border-primary/30 text-primary"}`}>LONG</button>
                <button onClick={() => setDir("SHORT")} className={`flex-1 py-1 border ${dir === "SHORT" ? "bg-destructive text-black border-destructive" : "border-destructive/30 text-destructive"}`}>SHORT</button>
              </div>
            </div>
            
            <div className="flex flex-col gap-1">
              <label className="text-xs text-primary/70">CAPITAL (USD)</label>
              <input type="number" value={capital} onChange={e => setCapital(Number(e.target.value))} className="bg-input border-primary/30 px-2 py-1 text-primary focus:border-primary outline-none" />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-primary/70">ENTRY PRICE</label>
              <input type="number" value={entry} onChange={e => setEntry(Number(e.target.value))} className="bg-input border-primary/30 px-2 py-1 text-primary focus:border-primary outline-none" />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-primary/70">LEVERAGE</label>
              <select value={lev} onChange={e => setLev(Number(e.target.value))} className="bg-input border-primary/30 px-2 py-1 text-primary focus:border-primary outline-none">
                {[1,2,5,10,20,50,100].map(l => <option key={l} value={l}>{l}x</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-primary/70">STOP LOSS</label>
              <input type="number" value={sl} onChange={e => setSl(Number(e.target.value))} className="bg-input border-destructive/50 px-2 py-1 text-destructive focus:border-destructive outline-none" />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-primary/70">TAKE PROFIT 1</label>
              <input type="number" value={tp1} onChange={e => setTp1(Number(e.target.value))} className="bg-input border-primary/30 px-2 py-1 text-primary focus:border-primary outline-none" />
            </div>
          </div>
        </div>

        {/* Output Panel */}
        <div className="border border-primary p-4 bg-black flex flex-col gap-4">
          <h3 className="text-xl font-bold border-b border-primary/30 pb-2 flex justify-between">
            <span>LIVE ANALYSIS</span>
            <span className="text-primary text-sm font-normal">SCORE: {score.toFixed(0)}/100</span>
          </h3>

          <div className={`p-3 border text-center font-bold text-lg ${scoreColor}`}>
            {scoreBadge}
          </div>

          <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm mt-2">
            <div className="flex justify-between border-b border-primary/20 pb-1">
              <span className="text-primary/70">Distance to SL</span>
              <span className="text-destructive">${d_sl.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-b border-primary/20 pb-1">
              <span className="text-primary/70">Distance to TP</span>
              <span className="text-primary">${d_tp.toFixed(2)}</span>
            </div>
            
            <div className="flex justify-between border-b border-primary/20 pb-1">
              <span className="text-primary/70">Risk:Reward</span>
              <span className="text-accent">1 : {rr}</span>
            </div>
            <div className="flex justify-between border-b border-primary/20 pb-1">
              <span className="text-primary/70">Prob(Hit TP)</span>
              <span className="text-primary">{(p_tp * 100).toFixed(1)}%</span>
            </div>

            <div className="flex justify-between border-b border-primary/20 pb-1">
              <span className="text-primary/70">Expected Value</span>
              <span className={ev > 0 ? "text-primary" : "text-destructive"}>${ev.toFixed(2)}</span>
            </div>
            <div className="flex justify-between border-b border-primary/20 pb-1">
              <span className="text-primary/70">Daily VaR 95%</span>
              <span className="text-accent">${var95.toFixed(2)}</span>
            </div>

            <div className="flex justify-between border-b border-primary/20 pb-1 col-span-2">
              <span className="text-primary/70">Suggested Kelly Size</span>
              <span className="text-primary font-bold">${posSize.toFixed(2)}</span>
            </div>
          </div>
          
          <div className="mt-auto">
            <button className="w-full bg-primary/20 text-primary border border-primary py-2 hover:bg-primary hover:text-black transition-colors">
              COPY DISCORD/TG FORMAT
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}