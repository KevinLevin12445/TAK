"""
insider_app.py — InsiderEngine Desktop App (tkinter)
Coloca junto a la carpeta engines/

Instalar: pip install yfinance scikit-learn numpy pandas
Correr:   python insider_app.py

tkinter ya viene incluido con Python — no necesita instalación extra.
"""

import sys, time, threading
from datetime import datetime

sys.path.insert(0, ".")
from engines.insider_engine import InsiderEngine

import tkinter as tk
from tkinter import ttk, font as tkfont

# ─── Config ───────────────────────────────────────────────────────────────────
TICKER   = "GLD"
INTERVAL = 60  # segundos entre refreshes

# ─── Colores (tema terminal verde) ───────────────────────────────────────────
BG       = "#0a0a0a"
BG2      = "#111111"
BG3      = "#1a1a1a"
GREEN    = "#00ff88"
RED      = "#ff4444"
YELLOW   = "#ffaa00"
DIM      = "#444444"
TEXT     = "#cccccc"
MONO     = "Consolas"

# ─── Engine en background ─────────────────────────────────────────────────────
engine = InsiderEngine(ticker=TICKER)
lock   = threading.Lock()
meta   = {"last_update": "—", "cycle": 0, "error": None, "loading": True}

def _refresh_loop():
    while True:
        time.sleep(INTERVAL)
        _run_engine()

def _run_engine():
    with lock:
        meta["loading"] = True
    try:
        n = InsiderEngine(ticker=TICKER)
        n.run()
        with lock:
            engine.transactions   = n.transactions
            engine.score_series   = n.score_series
            engine.clusters       = n.clusters
            engine.momentum       = n.momentum
            engine.current_score  = n.current_score
            engine.data_source    = n.data_source
            engine.option_flow    = n.option_flow
            engine.dark_pool      = n.dark_pool
            engine.gamma_exposure = n.gamma_exposure
            meta["last_update"]   = datetime.now().strftime("%H:%M:%S")
            meta["cycle"]        += 1
            meta["error"]         = None
            meta["loading"]       = False
    except Exception as e:
        with lock:
            meta["error"]   = str(e)
            meta["loading"] = False

# Carga inicial en thread para no bloquear la UI
threading.Thread(target=lambda: (_run_engine(),), daemon=True).start()
threading.Thread(target=_refresh_loop, daemon=True).start()

# ─── App ──────────────────────────────────────────────────────────────────────
class InsiderApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"AK-INC INSIDER ENGINE — {TICKER}")
        self.configure(bg=BG)
        self.geometry("1100x720")
        self.minsize(900, 600)

        self._build_ui()
        self._schedule_refresh()

    # ── UI Builder ────────────────────────────────────────────────────────────
    def _build_ui(self):
        mono = (MONO, 10)
        mono_sm = (MONO, 9)
        mono_lg = (MONO, 14, "bold")

        # ── Header ────────────────────────────────────────────────────────────
        hdr = tk.Frame(self, bg=BG, pady=6, padx=10)
        hdr.pack(fill="x")

        tk.Label(hdr, text=f"AK-INC INSIDER ENGINE", font=(MONO, 13, "bold"),
                 bg=BG, fg=GREEN).pack(side="left")
        tk.Label(hdr, text=f" — {TICKER}", font=(MONO, 13),
                 bg=BG, fg=DIM).pack(side="left")

        self.lbl_signal = tk.Label(hdr, text="LOADING...", font=(MONO, 11, "bold"),
                                   bg=BG, fg=YELLOW, padx=10)
        self.lbl_signal.pack(side="left", padx=20)

        # refresh button
        tk.Button(hdr, text="↺ REFRESH", font=mono_sm, bg=BG3, fg=GREEN,
                  activebackground=GREEN, activeforeground=BG,
                  relief="flat", bd=0, padx=8, cursor="hand2",
                  command=lambda: threading.Thread(target=_run_engine, daemon=True).start()
                  ).pack(side="right", padx=4)

        self.lbl_ts = tk.Label(hdr, text="updated —", font=mono_sm, bg=BG, fg=DIM)
        self.lbl_ts.pack(side="right", padx=8)

        self.lbl_err = tk.Label(hdr, text="", font=mono_sm, bg=BG, fg=RED)
        self.lbl_err.pack(side="right", padx=4)

        # ── Score cards ───────────────────────────────────────────────────────
        cards = tk.Frame(self, bg=BG, padx=8, pady=4)
        cards.pack(fill="x")

        self.score_vars = {}
        for label in ["COMBINED", "SEC EDGAR", "OPTION FLOW", "DARK POOL", "MOMENTUM"]:
            f = tk.Frame(cards, bg=BG2, padx=12, pady=6, relief="flat",
                         highlightbackground=DIM, highlightthickness=1)
            f.pack(side="left", padx=4, fill="y")
            tk.Label(f, text=label, font=(MONO, 8), bg=BG2, fg=DIM).pack()
            var = tk.StringVar(value="—")
            lbl = tk.Label(f, textvariable=var, font=(MONO, 13, "bold"), bg=BG2, fg=GREEN)
            lbl.pack()
            self.score_vars[label] = (var, lbl)

        # ── Divider ───────────────────────────────────────────────────────────
        tk.Frame(self, bg=DIM, height=1).pack(fill="x", padx=8, pady=2)

        # ── Notebook (tabs) ───────────────────────────────────────────────────
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TNotebook",       background=BG,  borderwidth=0)
        style.configure("TNotebook.Tab",   background=BG2, foreground=DIM,
                        font=(MONO, 9), padding=[12, 4])
        style.map("TNotebook.Tab",
                  background=[("selected", BG3)],
                  foreground=[("selected", GREEN)])
        style.configure("Treeview",        background=BG2, foreground=TEXT,
                        fieldbackground=BG2, font=(MONO, 9), rowheight=22)
        style.configure("Treeview.Heading", background=BG3, foreground=DIM,
                        font=(MONO, 9, "bold"))
        style.map("Treeview", background=[("selected", BG3)])

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=8, pady=4)

        # Tab: SEC EDGAR
        self.tree_sec = self._make_tab(nb, "SEC EDGAR",
            ["DATE","TICKER","INSIDER","ROLE","TYPE","VALUE"])

        # Tab: Option Flow
        self.tree_opt = self._make_tab(nb, "OPTION FLOW",
            ["TIME","TYPE","STRIKE","EXPIRY","SIZE","PREMIUM","HEAT"])

        # Tab: Dark Pool
        self.tree_dp = self._make_tab(nb, "DARK POOL",
            ["TIME","PRICE","SIZE","AMOUNT","TYPE"])

        # Tab: GEX
        self.tree_gex = self._make_tab(nb, "GAMMA EXPOSURE",
            ["STRIKE","GEX","BAR"])

        # ── Footer ────────────────────────────────────────────────────────────
        self.lbl_source = tk.Label(self, text="", font=(MONO, 8),
                                   bg=BG, fg=DIM, anchor="w", padx=10)
        self.lbl_source.pack(fill="x", pady=2)

    def _make_tab(self, nb, title, cols):
        frame = tk.Frame(nb, bg=BG)
        nb.add(frame, text=f"  {title}  ")
        tree = ttk.Treeview(frame, columns=cols, show="headings", selectmode="none")
        for col in cols:
            tree.heading(col, text=col)
            w = 160 if col in ("INSIDER","BAR") else 80
            tree.column(col, width=w, minwidth=50, anchor="w")
        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        tree.tag_configure("buy",  background="#003615")
        tree.tag_configure("sell", background="#861818")
        tree.tag_configure("call", background="#245e0d")
        tree.tag_configure("put",  background="#581919")
        return tree

    # ── Refresh UI ────────────────────────────────────────────────────────────
    def _schedule_refresh(self):
        self._update_ui()
        self.after(2000, self._schedule_refresh)  # poll UI every 2s

    def _update_ui(self):
        with lock:
            loading  = meta["loading"]
            err      = meta["error"]
            ts       = meta["last_update"]
            cycle    = meta["cycle"]
            if not loading and not err:
                summary = engine.summary()
                txns    = engine.recent_transactions(20)
                opt     = engine.recent_option_flow(20)
                dp      = engine.recent_dark_pool(20)
                gex     = engine.gamma_exposure.copy() if engine.gamma_exposure else {}
                src     = engine.data_source
            else:
                summary = None

        # Header
        if loading and cycle == 0:
            self.lbl_ts.config(text="loading...")
            return
        self.lbl_ts.config(text=f"updated {ts}  cycle #{cycle}")
        self.lbl_err.config(text=f"⚠ {err}" if err else "")

        if not summary:
            return

        # Signal
        sig = summary.get("signal", "N/A")
        sig_color = GREEN if "BULLISH" in sig else RED if "BEARISH" in sig else YELLOW
        self.lbl_signal.config(text=sig, fg=sig_color)

        # Score cards
        card_map = {
            "COMBINED":   summary["combined_score"],
            "SEC EDGAR":  summary["current_score"],
            "OPTION FLOW":summary["option_flow_score"],
            "DARK POOL":  summary["dark_pool_score"],
            "MOMENTUM":   summary["momentum"],
        }
        for label, val in card_map.items():
            var, lbl = self.score_vars[label]
            var.set(f"{val:+.4f}")
            lbl.config(fg=GREEN if val > 0 else RED if val < 0 else DIM)

        # SEC EDGAR table
        self._fill_tree(self.tree_sec, [
            (str(r.get("timestamp",""))[:10], 
            r.get("ticker",""), 
            str(r.get("insider",""))[:22],
             r.get("role",""), r.get("type",""),
             f"${r.get('value',0)/1e6:.2f}M",
             "buy" if r.get("type") == "BUY" else "sell")
            for r in (txns.to_dict("records") if not txns.empty else [])
        ])

        # Option flow table
        self._fill_tree(self.tree_opt, [
            (r.get("time",""), r.get("type",""), f"${r.get('strike',0)}",
             r.get("expiry",""), str(r.get("size",0)),
             f"${r.get('premium',0):.1f}K", f"{r.get('heat_score',0):.0f}",
             "call" if r.get("type") == "Call" else "put")
            for r in (opt.to_dict("records") if not opt.empty else [])
        ])

        # Dark pool table
        self._fill_tree(self.tree_dp, [
            (r.get("time",""), f"${r.get('price',0):,.2f}",
             f"{r.get('size',0):,}", f"${r.get('amount',0)/1e6:.2f}M",
             r.get("pool_type",""), "")
            for r in (dp.to_dict("records") if not dp.empty else [])
        ])

        # GEX table
        levels = gex.get("gex_levels", [])
        max_gex = max((abs(g["gex"]) for g in levels), default=1)
        self._fill_tree(self.tree_gex, [
            (f"${g['price']}", f"{g['gex']:+,}",
             ("█" * int(abs(g["gex"]) / max_gex * 20)).ljust(20), "")
            for g in levels
        ])

        # Source footer
        self.lbl_source.config(text=f"  {src}  |  "
            f"txns: {summary['n_transactions']}  "
            f"B:{summary['n_buys']} S:{summary['n_sells']}  "
            f"clusters: {summary['n_buy_clusters']}")

    def _fill_tree(self, tree, rows):
        tree.delete(*tree.get_children())
        for row in rows:
            tag  = row[-1] if row else ""
            vals = row[:-1]
            tree.insert("", "end", values=vals, tags=(tag,) if tag else ())


# ─── Run ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app = InsiderApp()
    app.mainloop()