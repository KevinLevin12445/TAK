"""
insider_app.py — InsiderEngine Desktop App (tkinter)
Coloca junto a la carpeta engines/

Instalar: pip install yfinance scikit-learn numpy pandas
Correr:   python insider_app.py
"""

import sys, time, threading
from datetime import datetime

sys.path.insert(0, ".")
from engines.insider_engine import InsiderEngine

import tkinter as tk
from tkinter import ttk

TICKER   = "GLD"
INTERVAL = 60

BG    = "#0a0a0a"
BG2   = "#111111"
BG3   = "#1a1a1a"
GREEN = "#00ff88"
RED   = "#ff4444"
YELLOW= "#ffaa00"
DIM   = "#444444"
TEXT  = "#cccccc"
MONO  = "Consolas"

# ─── Engine ───────────────────────────────────────────────────────────────────
engine = InsiderEngine(ticker=TICKER)
lock   = threading.Lock()
meta   = {"last_update": "—", "cycle": 0, "error": None, "ready": False}

def _run_engine():
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
            meta["ready"]         = True
    except Exception as e:
        with lock:
            meta["error"] = str(e)
            meta["ready"] = True

def _refresh_loop():
    while True:
        time.sleep(INTERVAL)
        _run_engine()

threading.Thread(target=_run_engine,    daemon=True).start()
threading.Thread(target=_refresh_loop,  daemon=True).start()

# ─── App ──────────────────────────────────────────────────────────────────────
class InsiderApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"AK-INC INSIDER ENGINE — {TICKER}")
        self.configure(bg=BG)
        self.geometry("1200x750")
        self.minsize(900, 600)
        self._build_ui()
        self._poll()

    def _build_ui(self):
        # Header
        hdr = tk.Frame(self, bg=BG, pady=6, padx=10)
        hdr.pack(fill="x")

        tk.Label(hdr, text="AK-INC INSIDER ENGINE", font=(MONO,13,"bold"),
                 bg=BG, fg=GREEN).pack(side="left")
        tk.Label(hdr, text=f" — {TICKER}", font=(MONO,13),
                 bg=BG, fg=DIM).pack(side="left")

        self.lbl_signal = tk.Label(hdr, text="LOADING...", font=(MONO,11,"bold"),
                                   bg=BG, fg=YELLOW, padx=14)
        self.lbl_signal.pack(side="left", padx=16)

        tk.Button(hdr, text="↺ REFRESH", font=(MONO,9), bg=BG3, fg=GREEN,
                  activebackground=GREEN, activeforeground=BG,
                  relief="flat", bd=0, padx=8, cursor="hand2",
                  command=lambda: threading.Thread(target=_run_engine, daemon=True).start()
                  ).pack(side="right", padx=4)

        self.lbl_ts  = tk.Label(hdr, text="", font=(MONO,9), bg=BG, fg=DIM)
        self.lbl_ts.pack(side="right", padx=8)
        self.lbl_err = tk.Label(hdr, text="", font=(MONO,9), bg=BG, fg=RED)
        self.lbl_err.pack(side="right", padx=4)

        # Score cards
        cards = tk.Frame(self, bg=BG, padx=8, pady=4)
        cards.pack(fill="x")

        self.score_vars = {}
        for lbl in ["COMBINED","SEC EDGAR","OPTION FLOW","DARK POOL","MOMENTUM"]:
            f = tk.Frame(cards, bg=BG2, padx=14, pady=6,
                         highlightbackground=DIM, highlightthickness=1)
            f.pack(side="left", padx=4)
            tk.Label(f, text=lbl, font=(MONO,8), bg=BG2, fg=DIM).pack()
            var = tk.StringVar(value="—")
            l   = tk.Label(f, textvariable=var, font=(MONO,13,"bold"), bg=BG2, fg=GREEN)
            l.pack()
            self.score_vars[lbl] = (var, l)

        tk.Frame(self, bg=DIM, height=1).pack(fill="x", padx=8, pady=2)

        # Notebook
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TNotebook",        background=BG,  borderwidth=0)
        style.configure("TNotebook.Tab",    background=BG2, foreground=DIM,
                        font=(MONO,9), padding=[12,4])
        style.map("TNotebook.Tab",
                  background=[("selected", BG3)],
                  foreground=[("selected", GREEN)])
        style.configure("Treeview",         background=BG2, foreground=TEXT,
                        fieldbackground=BG2, font=(MONO,9), rowheight=22)
        style.configure("Treeview.Heading", background=BG3, foreground=DIM,
                        font=(MONO,9,"bold"), relief="flat")
        style.map("Treeview", background=[("selected", BG3)])

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=8, pady=4)

        self.tree_sec = self._tab(nb, "  SEC EDGAR  ",
            ["DATE","TICKER","INSIDER","ROLE","TYPE","VALUE"],
            [100, 70, 200, 90, 60, 100])

        self.tree_opt = self._tab(nb, "  OPTION FLOW  ",
            ["TIME","TYPE","STRIKE","EXPIRY","SIZE","PREMIUM","HEAT"],
            [70, 60, 80, 70, 70, 90, 60])

        self.tree_dp  = self._tab(nb, "  DARK POOL  ",
            ["TIME","PRICE","SIZE","AMOUNT","TYPE"],
            [80, 100, 90, 110, 70])

        self.tree_gex = self._tab(nb, "  GAMMA EXPOSURE  ",
            ["STRIKE","GEX","BAR"],
            [80, 110, 300])

        # Footer
        self.lbl_src = tk.Label(self, text="", font=(MONO,8),
                                bg=BG, fg=DIM, anchor="w", padx=10)
        self.lbl_src.pack(fill="x", pady=2)

    def _tab(self, nb, title, cols, widths):
        frame = tk.Frame(nb, bg=BG)
        nb.add(frame, text=title)
        tree = ttk.Treeview(frame, columns=cols, show="headings", selectmode="none")
        for col, w in zip(cols, widths):
            tree.heading(col, text=col)
            tree.column(col, width=w, minwidth=40, anchor="w")
        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        tree.tag_configure("buy",  background="#0d2016")
        tree.tag_configure("sell", background="#200d0d")
        tree.tag_configure("call", background="#0a1a10")
        tree.tag_configure("put",  background="#1a0a0a")
        return tree

    # ── Fill table — tags SEPARADOS de values ────────────────────────────────
    def _fill(self, tree, rows, tags):
        """rows = list of tuples (val1,val2,...), tags = list of str"""
        tree.delete(*tree.get_children())
        for vals, tag in zip(rows, tags):
            tree.insert("", "end", values=vals, tags=(tag,) if tag else ())

    # ── Poll UI every 2s ─────────────────────────────────────────────────────
    def _poll(self):
        with lock:
            ready = meta["ready"]
            err   = meta["error"]
            ts    = meta["last_update"]
            cycle = meta["cycle"]

        if ready:
            self._update_ui(ts, cycle, err)

        self.after(2000, self._poll)

    def _update_ui(self, ts, cycle, err):
        self.lbl_ts.config(text=f"updated {ts}  cycle #{cycle}")
        self.lbl_err.config(text=f"⚠ {err}" if err else "")

        with lock:
            summary = engine.summary()
            txns    = engine.recent_transactions(30)
            opt     = engine.recent_option_flow(30)
            dp      = engine.recent_dark_pool(30)
            gex     = engine.gamma_exposure.copy() if engine.gamma_exposure else {}
            src     = engine.data_source

        # Signal
        sig      = summary.get("signal","N/A")
        sig_col  = GREEN if "BULLISH" in sig else RED if "BEARISH" in sig else YELLOW
        self.lbl_signal.config(text=sig, fg=sig_col)

        # Cards
        for lbl, val in [
            ("COMBINED",    summary["combined_score"]),
            ("SEC EDGAR",   summary["current_score"]),
            ("OPTION FLOW", summary["option_flow_score"]),
            ("DARK POOL",   summary["dark_pool_score"]),
            ("MOMENTUM",    summary["momentum"]),
        ]:
            var, lw = self.score_vars[lbl]
            var.set(f"{val:+.4f}")
            lw.config(fg=GREEN if val>0 else RED if val<0 else DIM)

        # SEC EDGAR
        if not txns.empty:
            rows, tags = [], []
            for r in txns.to_dict("records"):
                rows.append((
                    str(r.get("timestamp",""))[:10],
                    r.get("ticker",""),
                    str(r.get("insider",""))[:28],
                    r.get("role",""),
                    r.get("type",""),
                    f"${r.get('value',0)/1e6:.3f}M",
                ))
                tags.append("buy" if r.get("type")=="BUY" else "sell")
            self._fill(self.tree_sec, rows, tags)
        else:
            self._fill(self.tree_sec, [("—","—","No SEC data available","—","—","—")], [""])

        # Option Flow
        if not opt.empty:
            rows, tags = [], []
            for r in opt.to_dict("records"):
                rows.append((
                    r.get("time",""),
                    r.get("type",""),
                    f"${r.get('strike',0):,.0f}",
                    r.get("expiry",""),
                    f"{r.get('size',0):,}",
                    f"${r.get('premium',0):.1f}K",
                    f"{r.get('heat_score',0):.0f}",
                ))
                tags.append("call" if r.get("type")=="Call" else "put")
            self._fill(self.tree_opt, rows, tags)
        else:
            self._fill(self.tree_opt, [("—","—","—","—","No data","—","—")], [""])

        # Dark Pool
        if not dp.empty:
            rows = []
            for r in dp.to_dict("records"):
                rows.append((
                    r.get("time",""),
                    f"${r.get('price',0):,.2f}",
                    f"{r.get('size',0):,}",
                    f"${r.get('amount',0)/1e6:.3f}M",
                    r.get("pool_type",""),
                ))
            self._fill(self.tree_dp, rows, [""]*len(rows))
        else:
            self._fill(self.tree_dp, [("—","—","—","No data","—")], [""])

        # GEX
        levels = gex.get("gex_levels", [])
        if levels:
            max_g  = max(abs(g["gex"]) for g in levels) or 1
            rows   = []
            for g in levels:
                bar = "█" * int(abs(g["gex"]) / max_g * 30)
                rows.append((f"${g['price']:,}", f"{g['gex']:+,}", bar))
            self._fill(self.tree_gex, rows, [""]*len(rows))
        else:
            self._fill(self.tree_gex, [("—","—","No GEX data")], [""])

        # Footer
        self.lbl_src.config(text=(
            f"  {src}  |  "
            f"txns: {summary['n_transactions']}  "
            f"B:{summary['n_buys']} S:{summary['n_sells']}  "
            f"clusters: {summary['n_buy_clusters']}"
        ))


if __name__ == "__main__":
    InsiderApp().mainloop()