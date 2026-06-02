import { useState } from "react";
import { TopTicker } from "@/components/TopTicker";
import { QuantPanel } from "@/components/tabs/QuantPanel";
import { TradeCalc } from "@/components/tabs/TradeCalc";
import { Command } from "@/components/tabs/Command";
import { KalmanTab } from "@/components/tabs/Kalman";
import { HmmRegimes } from "@/components/tabs/HmmRegimes";
import { HeatmapTab } from "@/components/tabs/HeatmapTab";
import { Gc3dTab } from "@/components/tabs/Gc3dTab";
import { RiskPanel } from "@/components/tabs/RiskPanel";
import { PortfolioTab } from "@/components/tabs/PortfolioTab";
import { MapTab } from "@/components/tabs/MapTab";
import { VwapTab } from "@/components/tabs/VwapTab";
import { AnomalyTab } from "@/components/tabs/AnomalyTab";
import { VolProfileTab } from "@/components/tabs/VolProfileTab";
import { BsVolTab } from "@/components/tabs/BsVolTab";
import { useWebNotifications } from "@/hooks/useWebNotifications";

const TABS = [
  { id: "quant",      label: "⊹ QUANT PANEL" },
  { id: "command",    label: "⊹ COMMAND" },
  { id: "kalman",     label: "⊹ KALMAN" },
  { id: "hmm",        label: "⊹ HMM REGIMES" },
  { id: "bsvol",      label: "⊹ BS/VOL" },
  { id: "heatmap",    label: "⊹ HEATMAP" },
  { id: "gc3d",       label: "⊹ GC3D" },
  { id: "risk",       label: "⊹ RISK" },
  { id: "portfolio",  label: "⊹ PORTFOLIO" },
  { id: "map",        label: "⊹ MAP",       badge: "map" },
  { id: "vwap",       label: "⊹ VWAP" },
  { id: "anomaly",    label: "⚡ ANOMALY DR" },
  { id: "volprofile", label: "— VOL PROFILE" },
  { id: "calc",       label: "⊹ TRADE CALC" },
];

export default function Terminal() {
  const [activeTab, setActiveTab] = useState("quant");
  const {
    permission,
    requestPermission,
    newInsiderCount,
    newNewsCount,
    clearInsiderBadge,
    clearNewsBadge,
  } = useWebNotifications();

  const totalAlerts = newInsiderCount + newNewsCount;

  function handleTabClick(id: string) {
    setActiveTab(id);
    if (id === "map") {
      clearInsiderBadge();
      clearNewsBadge();
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-mono selection:bg-primary selection:text-black">
      <TopTicker />

      {/* Navigation Tabs */}
      <div
        className="w-full border-b border-primary/30 bg-black flex overflow-x-auto overflow-y-hidden items-stretch"
        style={{ scrollbarWidth: "none" }}
      >
        {TABS.map((tab) => {
          const badge = tab.id === "map" ? totalAlerts : 0;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              className={`relative whitespace-nowrap px-3 py-2 text-xs font-bold border-r border-primary/30 transition-colors flex-shrink-0 ${
                activeTab === tab.id
                  ? "bg-primary text-black"
                  : "bg-black text-primary hover:bg-primary/20"
              }`}
            >
              {tab.label}
              {badge > 0 && (
                <span className="absolute -top-1 -right-1 bg-destructive text-white text-[8px] font-bold rounded-full px-1 min-w-[14px] text-center leading-4">
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </button>
          );
        })}

        {/* Notification permission button */}
        <div className="ml-auto flex items-center px-2">
          {permission !== "granted" ? (
            <button
              onClick={requestPermission}
              className="text-[9px] px-2 py-1 border border-primary/30 text-primary/60 hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
              title="Enable browser notifications for insider orders & news"
            >
              🔔 ENABLE ALERTS
            </button>
          ) : (
            <span className="text-[9px] text-primary/40 px-2">🔔 ALERTS ON</span>
          )}
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 p-2 overflow-auto relative">
        <div
          className="fixed inset-0 pointer-events-none z-50 opacity-[0.02]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,65,0.5) 2px, rgba(0,255,65,0.5) 3px)",
          }}
        />

        {activeTab === "quant"      && <QuantPanel />}
        {activeTab === "command"    && <Command />}
        {activeTab === "kalman"     && <KalmanTab />}
        {activeTab === "hmm"        && <HmmRegimes />}
        {activeTab === "bsvol"      && <BsVolTab />}
        {activeTab === "heatmap"    && <HeatmapTab />}
        {activeTab === "gc3d"       && <Gc3dTab />}
        {activeTab === "risk"       && <RiskPanel />}
        {activeTab === "portfolio"  && <PortfolioTab />}
        {activeTab === "map"        && <MapTab />}
        {activeTab === "vwap"       && <VwapTab />}
        {activeTab === "anomaly"    && <AnomalyTab />}
        {activeTab === "volprofile" && <VolProfileTab />}
        {activeTab === "calc"       && <TradeCalc />}
      </main>

      <footer className="w-full border-t border-primary/30 bg-black p-1 text-center text-[10px] text-primary/50">
        AK-INC TERMINAL v1.0.0 &nbsp;|&nbsp; For informational purposes only. Not financial advice. &nbsp;|&nbsp; Data: Yahoo Finance &nbsp;|&nbsp; AUTO-REFRESH ACTIVE
      </footer>
    </div>
  );
}