import numpy as np
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta
from sklearn.cluster import DBSCAN
import warnings

warnings.filterwarnings("ignore")

GOLD_PROXIES = ["NEM", "GOLD", "AEM", "KGC"]
PROXY_NAMES = {
    "NEM":  "Newmont Corp",
    "GOLD": "Barrick Gold",
    "AEM":  "Agnico Eagle",
    "KGC":  "Kinross Gold",
}
ROLE_WEIGHTS = {
    "CEO": 1.0, "CFO": 0.9, "Director": 0.7, "VP": 0.6, "10pct_owner": 0.5, "Other": 0.3,
}
DECAY_LAMBDA = 0.05


def _decay_weight(delta_days: float, lam: float = DECAY_LAMBDA) -> float:
    return np.exp(-lam * max(delta_days, 0))


def _map_role(position: str) -> str:
    p = str(position).lower()
    if "chief executive" in p or p.startswith("ceo"): return "CEO"
    if "chief financial" in p or p.startswith("cfo"): return "CFO"
    if "director" in p: return "Director"
    if "vice president" in p or " vp" in p: return "VP"
    if "10%" in p or "10 percent" in p: return "10pct_owner"
    return "Other"


def _parse_txn_type(text: str) -> str:
    t = str(text).lower()
    return "BUY" if any(w in t for w in ["purchase", "acquisition", "buy", "grant", "award"]) else "SELL"


def fetch_real_transactions(tickers=None, lookback_days=180):
    if tickers is None:
        tickers = GOLD_PROXIES
    
    frames = []
    fetched_from = []
    cutoff = pd.Timestamp.utcnow().tz_localize(None) - pd.Timedelta(days=lookback_days)
    
    for sym in tickers:
        try:
            tk = yf.Ticker(sym)
            df = tk.insider_transactions
            if df is None or (isinstance(df, pd.DataFrame) and df.empty):
                continue
            
            df = df.copy().reset_index(drop=True)
            date_col = next((c for c in df.columns if "date" in c.lower() or "start" in c.lower()), None)
            if date_col is None:
                continue
            
            df["timestamp"] = pd.to_datetime(df[date_col], errors="coerce").dt.tz_localize(None)
            df = df.dropna(subset=["timestamp"])
            df = df[df["timestamp"] >= cutoff]
            if df.empty:
                continue
            
            txn_col = next((c for c in df.columns if any(k in c.lower() for k in ["transaction", "text"])), None)
            df["type"] = df[txn_col].apply(_parse_txn_type) if txn_col else "BUY"
            
            pos_col = next((c for c in df.columns if any(k in c.lower() for k in ["position", "title"])), None)
            df["role"] = df[pos_col].apply(_map_role) if pos_col else "Other"
            
            name_col = next((c for c in df.columns if "insider" in c.lower() or "name" in c.lower()), None)
            df["insider"] = df[name_col] if name_col else sym
            
            val_col = next((c for c in df.columns if "value" in c.lower()), None)
            shr_col = next((c for c in df.columns if "share" in c.lower()), None)
            
            if val_col:
                df["value"] = pd.to_numeric(df[val_col], errors="coerce").fillna(0).abs()
            elif shr_col:
                df["value"] = pd.to_numeric(df[shr_col], errors="coerce").fillna(0).abs() * 35.0
            else:
                df["value"] = 1_000_000.0
            
            df["value"] = df["value"].clip(lower=1.0)
            df["ticker"] = sym
            df["company"] = PROXY_NAMES.get(sym, sym)
            
            frames.append(df[["timestamp", "type", "role", "value", "ticker", "company", "insider"]].copy())
            fetched_from.append(PROXY_NAMES.get(sym, sym))
        
        except Exception:
            pass
    
    if not frames:
        return pd.DataFrame(columns=["timestamp", "type", "role", "value", "ticker", "company", "insider"]), "LIVE DATA UNAVAILABLE"
    
    result = pd.concat(frames, ignore_index=True).sort_values("timestamp").reset_index(drop=True)
    source = f"SEC EDGAR Form 4 — {', '.join(fetched_from)}"
    return result, source


def generate_mock_option_flow():
    """Genera datos MOCK de Option Flow"""
    now = datetime.now()
    data = []
    
    for i in range(15):
        data.append({
            "date": (now - timedelta(hours=i)).strftime("%m-%d"),
            "time": (now - timedelta(hours=i)).strftime("%H:%M"),
            "type": "Call" if np.random.random() > 0.4 else "Put",
            "expiry": "06-21" if np.random.random() > 0.5 else "07-18",
            "strike": round(4500 + np.random.randint(-200, 200), 2),
            "price": round(np.random.uniform(0.5, 5.0), 2),
            "size": np.random.randint(100, 5000),
            "premium": round(np.random.uniform(50, 5000), 2),
            "heat_score": round(np.random.uniform(20, 95), 1),
        })
    
    return pd.DataFrame(data)


def generate_mock_dark_pool():
    """Genera datos MOCK de Dark Pool"""
    now = datetime.now()
    data = []
    
    for i in range(12):
        data.append({
            "date": (now - timedelta(minutes=i*5)).strftime("%m-%d"),
            "time": (now - timedelta(minutes=i*5)).strftime("%H:%M:%S"),
            "price": round(4500 + np.random.randint(-50, 50), 2),
            "size": np.random.randint(1000, 50000),
            "amount": round(np.random.uniform(100000, 2000000), 0),
            "pool_type": "Dark",
        })
    
    return pd.DataFrame(data)


def generate_mock_gamma_exposure():
    """Genera datos MOCK de Gamma Exposure"""
    return {
        "timestamp": datetime.now().isoformat(),
        "ticker": "GLD",
        "gex_levels": [
            {"price": 4400, "gex": -150000},
            {"price": 4450, "gex": -50000},
            {"price": 4500, "gex": 100000},
            {"price": 4550, "gex": 250000},
            {"price": 4600, "gex": 180000},
        ]
    }


class InsiderEngine:
    def __init__(self, decay_lambda: float = DECAY_LAMBDA, ticker: str = "GLD"):
        self.decay_lambda = decay_lambda
        self.ticker = ticker
        self.transactions = pd.DataFrame()
        self.score_series = pd.Series(dtype=float)
        self.clusters = np.array([])
        self.momentum = 0.0
        self.current_score = 0.0
        self.data_source = "—"
        
        self.option_flow = pd.DataFrame()
        self.dark_pool = pd.DataFrame()
        self.gamma_exposure = {}

    def load(self, transactions=None):
        if transactions is not None and not transactions.empty:
            self.transactions = transactions.copy()
        else:
            self.transactions = pd.DataFrame(columns=["timestamp", "type", "role", "value", "ticker", "company", "insider"])
            self.data_source = "LIVE DATA UNAVAILABLE"

    def load_insider_finance_data_mock(self):
        """Carga datos MOCK de Insider Finance"""
        self.option_flow = generate_mock_option_flow()
        self.dark_pool = generate_mock_dark_pool()
        self.gamma_exposure = generate_mock_gamma_exposure()
        self.data_source = f"SEC EDGAR + Mock Insider Finance (Updated: {datetime.now().strftime('%H:%M:%S')})"

    def compute_score(self, reference_time=None):
        if self.transactions.empty:
            return 0.0
        ref = reference_time or datetime.utcnow()
        score = 0.0
        for _, row in self.transactions.iterrows():
            ts = row["timestamp"]
            if hasattr(ts, "to_pydatetime"):
                ts = ts.to_pydatetime()
            delta_days = (ref - ts).total_seconds() / 86400
            w = ROLE_WEIGHTS.get(row["role"], 0.3)
            decay = _decay_weight(delta_days, self.decay_lambda)
            sign = 1.0 if row["type"] == "BUY" else -1.0
            score += sign * row["value"] * decay * w
        return score

    def compute_option_flow_score(self):
        if self.option_flow.empty:
            return 0.0
        score = 0.0
        for _, row in self.option_flow.iterrows():
            sign = 1.0 if row["type"] == "Call" else -1.0
            weight = (row["size"] / 1000) * (row["heat_score"] / 100) if row["heat_score"] > 0 else 0
            score += sign * weight
        return score / 100.0

    def compute_dark_pool_score(self):
        if self.dark_pool.empty:
            return 0.0
        buys = self.dark_pool[self.dark_pool["amount"] > 0]["amount"].sum()
        sells = self.dark_pool[self.dark_pool["amount"] < 0]["amount"].sum()
        if buys + abs(sells) == 0:
            return 0.0
        return (buys - abs(sells)) / (buys + abs(sells))

    def build_score_series(self):
        if self.transactions.empty:
            return pd.Series(dtype=float)
        dates = pd.date_range(
            start=self.transactions["timestamp"].min().date(),
            end=datetime.utcnow().date(),
            freq="D",
        )
        scores = [
            self.compute_score(datetime(d.year, d.month, d.day, 23, 59, 59))
            for d in dates
        ]
        self.score_series = pd.Series(scores, index=dates, name="InsiderScore")
        self.current_score = float(self.score_series.iloc[-1]) if len(self.score_series) > 0 else 0.0
        return self.score_series

    def compute_momentum(self, window: int = 5):
        if len(self.score_series) < window + 1:
            return 0.0
        recent = self.score_series.iloc[-window:]
        prev = self.score_series.iloc[-2 * window: -window]
        if len(prev) == 0:
            return 0.0
        self.momentum = float(recent.mean() - prev.mean())
        return self.momentum

    def detect_clusters(self, eps_days: float = 7.0, min_samples: int = 2):
        if self.transactions.empty:
            return pd.DataFrame()
        buys = self.transactions[self.transactions["type"] == "BUY"].copy()
        if len(buys) < min_samples:
            return pd.DataFrame()
        base = buys["timestamp"].min()
        X = ((buys["timestamp"] - base).dt.total_seconds() / 86400).values.reshape(-1, 1)
        db = DBSCAN(eps=eps_days, min_samples=min_samples)
        labels = db.fit_predict(X)
        buys["cluster"] = labels
        self.clusters = labels
        return buys

    def recent_transactions(self, n: int = 8):
        if self.transactions.empty:
            return pd.DataFrame()
        df = self.transactions.sort_values("timestamp", ascending=False).head(n)
        cols = [c for c in ["timestamp", "ticker", "insider", "role", "type", "value"] if c in df.columns]
        return df[cols].copy()

    def recent_option_flow(self, n: int = 10):
        if self.option_flow.empty:
            return pd.DataFrame()
        return self.option_flow.head(n)

    def recent_dark_pool(self, n: int = 10):
        if self.dark_pool.empty:
            return pd.DataFrame()
        return self.dark_pool.head(n)

    def run(self):
        txns, source = fetch_real_transactions()
        self.data_source = source
        self.load(txns)
        self.build_score_series()
        self.compute_momentum()
        self.detect_clusters()
        self.load_insider_finance_data_mock()

    def summary(self):
        clusters_df = self.detect_clusters()
        n_clusters = int((clusters_df["cluster"] >= 0).sum()) if not clusters_df.empty else 0
        buys = len(self.transactions[self.transactions["type"] == "BUY"]) if not self.transactions.empty else 0
        sells = len(self.transactions[self.transactions["type"] == "SELL"]) if not self.transactions.empty else 0
        no_data = self.transactions.empty
        
        sec_score = self.current_score
        option_flow_score = self.compute_option_flow_score()
        dark_pool_score = self.compute_dark_pool_score()
        combined_score = (sec_score * 0.4 + option_flow_score * 0.3 + dark_pool_score * 0.3)
        
        if combined_score > 0.2:
            signal = "STRONG BULLISH"
        elif combined_score > 0:
            signal = "BULLISH"
        elif combined_score < -0.2:
            signal = "STRONG BEARISH"
        elif combined_score < 0:
            signal = "BEARISH"
        else:
            signal = "NEUTRAL"
        
        return {
            "current_score": self.current_score,
            "option_flow_score": option_flow_score,
            "dark_pool_score": dark_pool_score,
            "combined_score": combined_score,
            "momentum": self.momentum,
            "n_transactions": len(self.transactions),
            "n_buy_clusters": n_clusters,
            "n_buys": buys,
            "n_sells": sells,
            "n_option_trades": len(self.option_flow),
            "n_dark_pool_prints": len(self.dark_pool),
            "signal": "N/A" if no_data else signal,
            "data_available": not no_data,
            "data_source": self.data_source,
        }
    
    def render_streamlit(self):
        """Renderiza los datos en Streamlit"""
        try:
            import streamlit as st
            
            st.markdown("### 📊 SEC EDGAR FORM 4 (Insiders)")
            if not self.transactions.empty:
                st.dataframe(self.recent_transactions(10), use_container_width=True)
            else:
                st.warning("No SEC EDGAR data available")
            
            st.markdown("### ⚡ OPTION FLOW (Insider Finance)")
            if not self.option_flow.empty:
                st.dataframe(self.recent_option_flow(15), use_container_width=True)
            else:
                st.info("No option flow data available")
            
            st.markdown("### 🌑 DARK POOL (Institutional Orders)")
            if not self.dark_pool.empty:
                st.dataframe(self.recent_dark_pool(15), use_container_width=True)
            else:
                st.info("No dark pool data available")
            
            st.markdown("### 📈 GAMMA EXPOSURE (GEX Levels)")
            if self.gamma_exposure and self.gamma_exposure.get("gex_levels"):
                gex_df = pd.DataFrame(self.gamma_exposure["gex_levels"])
                st.dataframe(gex_df, use_container_width=True)
            else:
                st.info("No gamma exposure data available")
            
            st.markdown("### 📋 SUMMARY")
            summary = self.summary()
            col1, col2, col3, col4 = st.columns(4)
            with col1:
                st.metric("Signal", summary["signal"])
            with col2:
                st.metric("Combined Score", f"{summary['combined_score']:.3f}")
            with col3:
                st.metric("Option Trades", summary["n_option_trades"])
            with col4:
                st.metric("Dark Pool Prints", summary["n_dark_pool_prints"])
            
            st.caption(f"Data Source: {summary['data_source']}")
            
        except ImportError:
            print("Streamlit no instalado")
