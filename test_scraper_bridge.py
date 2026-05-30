"""
quant_bridge.py — BRIDGE UNIFICADO v3
Corre el InsiderEngine en background (thread) + sirve los datos vía Flask.
Solo necesitas UNA terminal:

    python quant_bridge.py

Datos:  http://localhost:5001/data
Estado: http://localhost:5001/status
"""

import os, sys, json, time, logging, threading
from datetime import datetime

from flask import Flask, make_response, request
from flask_cors import CORS

# ─── Path ──────────────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

try:
    from engines.insider_engine import InsiderEngine
    ENGINE_AVAILABLE = True
    print("[SUCCESS] InsiderEngine cargado.")
except ImportError as e:
    ENGINE_AVAILABLE = False
    print(f"[WARNING] InsiderEngine no disponible: {e}")
    print("[INFO] Corriendo en modo DEMO con datos simulados.")

# ─── Config ────────────────────────────────────────────────────────────────────
TICKER        = "GLD"
SCRAPE_INTERVAL = 30      # segundos entre ciclos del engine
PORT          = 5001
LOG_LEVEL     = logging.WARNING

logging.basicConfig(level=LOG_LEVEL)
log = logging.getLogger("quant_bridge")

# ─── Flask ─────────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ─── Engine ────────────────────────────────────────────────────────────────────
engine = InsiderEngine(ticker=TICKER) if ENGINE_AVAILABLE else None

# ─── Shared state (thread-safe con lock) ───────────────────────────────────────
_lock       = threading.Lock()
_cache      = {}
_cache_ts   = 0.0
_cycle_count = 0
_last_error  = None

# ─── Serializer ────────────────────────────────────────────────────────────────
def _safe(obj):
    if obj is None:                     return None
    if isinstance(obj, (bool, str)):    return obj
    if isinstance(obj, (int, float)):   return 0.0 if obj != obj else obj  # NaN → 0
    if hasattr(obj, "isoformat"):       return obj.isoformat()
    if hasattr(obj, "to_pydatetime"):   return obj.to_pydatetime().isoformat()
    if hasattr(obj, "item"):            return obj.item()   # numpy scalar
    if hasattr(obj, "tolist"):          return obj.tolist() # numpy array
    return str(obj)

def _clean(d):
    if isinstance(d, dict):  return {k: _clean(v) for k, v in d.items()}
    if isinstance(d, list):  return [_clean(i) for i in d]
    return _safe(d)

# ─── Demo data ─────────────────────────────────────────────────────────────────
def _demo() -> dict:
    import math, random
    base = 4500 + math.sin(time.time() / 60) * 15
    return {
        "timestamp":         datetime.now().isoformat(),
        "ticker":            TICKER,
        "signal":            "DEMO_NEUTRAL",
        "combined_score":    round(random.uniform(-0.3, 0.3), 4),
        "current_score":     round(random.uniform(-0.5, 0.5), 4),
        "option_flow_score": round(random.uniform(-0.2, 0.4), 4),
        "dark_pool_score":   round(random.uniform(0.0,  0.4), 4),
        "gamma_exposure": [
            {"strike": round(base + 30), "gex":  250000},
            {"strike": round(base + 60), "gex":  180000},
            {"strike": round(base - 25), "gex":  -80000},
        ],
        "dark_pool": [
            {"price": round(base - 20, 2), "size": 320000, "side": "BUY"},
            {"price": round(base - 10, 2), "size": 180000, "side": "BUY"},
            {"price": round(base + 40, 2), "size":  95000, "side": "SELL"},
        ],
        "option_flow": [
            {"strike": round(base + 35), "type": "CALL", "premium": 1200000, "sentiment": "BULLISH"},
            {"strike": round(base + 65), "type": "CALL", "premium":  800000, "sentiment": "BULLISH"},
            {"strike": round(base - 30), "type": "PUT",  "premium":  400000, "sentiment": "BEARISH"},
        ],
        "transactions": [],
        "source": "DEMO_MODE",
        "meta": {"last_update": datetime.now().strftime("%H:%M:%S"), "status": "demo", "cycle": 0},
    }

# ─── ENGINE LOOP — corre en thread background ───────────────────────────────────
def _engine_loop():
    global _cache, _cache_ts, _cycle_count, _last_error

    print(f"[SCRAPER] Thread iniciado. Intervalo: {SCRAPE_INTERVAL}s")

    while True:
        ts_start = time.time()

        if not ENGINE_AVAILABLE or engine is None:
            with _lock:
                _cache    = _demo()
                _cache_ts = ts_start
            time.sleep(SCRAPE_INTERVAL)
            continue

        try:
            # ── Ejecutar ciclo del engine ──────────────────────────────────────
            engine.run()
            summary = engine.summary()

            def _f(k, d=0.0):
                try: return float(summary.get(k, d))
                except: return d

            # ── Extraer DataFrames ─────────────────────────────────────────────
            txns_df = engine.recent_transactions(20)
            opt_df  = engine.recent_option_flow(20)
            dp_df   = engine.recent_dark_pool(20)
            gex_raw = engine.gamma_exposure

            state = {
                "timestamp":         datetime.now().isoformat(),
                "ticker":            TICKER,
                "signal":            str(summary.get("signal", "NEUTRAL")),
                "combined_score":    _f("combined_score"),
                "current_score":     _f("current_score"),
                "option_flow_score": _f("option_flow_score"),
                "dark_pool_score":   _f("dark_pool_score"),
                "gamma_exposure":    gex_raw.get("gex_levels", []) if isinstance(gex_raw, dict) else [],
                "dark_pool":         dp_df.to_dict("records")  if not dp_df.empty  else [],
                "option_flow":       opt_df.to_dict("records") if not opt_df.empty else [],
                "transactions":      txns_df.to_dict("records") if not txns_df.empty else [],
                "source":            str(summary.get("data_source", "LIVE_ENGINE")),
                "meta": {
                    "last_update":        datetime.now().strftime("%H:%M:%S"),
                    "status":             "active",
                    "cycle":              _cycle_count,
                    "n_transactions":     int(summary.get("n_transactions", 0)),
                    "n_option_trades":    int(summary.get("n_option_trades", 0)),
                    "n_dark_pool_prints": int(summary.get("n_dark_pool_prints", 0)),
                },
            }

            with _lock:
                _cache       = _clean(state)
                _cache_ts    = ts_start
                _cycle_count += 1
                _last_error  = None

            elapsed = time.time() - ts_start
            print(f"[{datetime.now().strftime('%H:%M:%S')}] ✅ Ciclo {_cycle_count} OK "
                  f"| score={state['combined_score']:.4f} | {elapsed:.1f}s")

        except Exception as e:
            _last_error = str(e)
            log.error(f"[ENGINE ERROR] {e}", exc_info=True)
            print(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠ Error en ciclo: {e}")
            # Mantener cache anterior si existe; si no, usar demo
            with _lock:
                if not _cache:
                    _cache    = _demo()
                    _cache_ts = ts_start
                else:
                    _cache["meta"]["status"] = "stale"

        # Dormir hasta el próximo ciclo
        elapsed = time.time() - ts_start
        sleep_time = max(0, SCRAPE_INTERVAL - elapsed)
        time.sleep(sleep_time)

# ─── Helpers HTTP ──────────────────────────────────────────────────────────────
def _resp(data: dict, status: int = 200):
    r = make_response(json.dumps(data, default=str), status)
    r.headers["Content-Type"]               = "application/json"
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Cache-Control"]               = "no-cache"
    return r

def _preflight():
    r = make_response("", 204)
    r.headers["Access-Control-Allow-Origin"]  = "*"
    r.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return r

# ─── Routes ────────────────────────────────────────────────────────────────────
@app.route("/data", methods=["GET", "OPTIONS"])
def get_data():
    if request.method == "OPTIONS":
        return _preflight()
    with _lock:
        data = dict(_cache) if _cache else _demo()
    return _resp(data)

@app.route("/status", methods=["GET"])
def get_status():
    with _lock:
        age    = round(time.time() - _cache_ts, 1) if _cache_ts else -1
        cycles = _cycle_count
        err    = _last_error
    return _resp({
        "status":      "online",
        "engine":      "live" if ENGINE_AVAILABLE else "demo",
        "ticker":      TICKER,
        "timestamp":   datetime.now().isoformat(),
        "cache_age_s": age,
        "cycles_done": cycles,
        "last_error":  err,
    })

@app.route("/", methods=["GET"])
def index():
    return _resp({"name": "AK Quant Bridge", "version": "3.0",
                  "endpoints": ["/data", "/status"]})

# ─── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "=" * 55)
    print("  🚀  AK QUANT BRIDGE v3.0  (scraper + server)")
    print(f"  📍  http://localhost:{PORT}/data")
    print(f"  📡  http://localhost:{PORT}/status")
    print(f"  🔧  Engine: {'LIVE' if ENGINE_AVAILABLE else 'DEMO MODE'}")
    print(f"  ⏱   Scrape cada {SCRAPE_INTERVAL}s en background")
    print("=" * 55 + "\n")

    # ── Primer ciclo síncrono antes de levantar Flask ──────────────────────────
    print("[INIT] Ejecutando primer ciclo de datos...")
    try:
        _engine_loop.__wrapped__ = True  # marker
        # Correr manualmente una vez para tener datos desde el inicio
        if ENGINE_AVAILABLE and engine:
            engine.run()
            summary = engine.summary()
            def _f(k, d=0.0):
                try: return float(summary.get(k, d))
                except: return d
            txns_df = engine.recent_transactions(20)
            opt_df  = engine.recent_option_flow(20)
            dp_df   = engine.recent_dark_pool(20)
            gex_raw = engine.gamma_exposure
            _cache = _clean({
                "timestamp": datetime.now().isoformat(), "ticker": TICKER,
                "signal": str(summary.get("signal", "NEUTRAL")),
                "combined_score": _f("combined_score"),
                "current_score": _f("current_score"),
                "option_flow_score": _f("option_flow_score"),
                "dark_pool_score": _f("dark_pool_score"),
                "gamma_exposure": gex_raw.get("gex_levels", []) if isinstance(gex_raw, dict) else [],
                "dark_pool":   dp_df.to_dict("records")  if not dp_df.empty  else [],
                "option_flow": opt_df.to_dict("records") if not opt_df.empty else [],
                "transactions": txns_df.to_dict("records") if not txns_df.empty else [],
                "source": str(summary.get("data_source", "LIVE_ENGINE")),
                "meta": {"last_update": datetime.now().strftime("%H:%M:%S"), "status": "active", "cycle": 0},
            })
            _cache_ts = time.time()
            print("[INIT] ✅ Datos iniciales listos.\n")
        else:
            _cache    = _demo()
            _cache_ts = time.time()
            print("[INIT] ✅ Demo data lista.\n")
    except Exception as e:
        print(f"[INIT] ⚠ Warm-up falló: {e} — continuando con demo.\n")
        _cache    = _demo()
        _cache_ts = time.time()

    # ── Lanzar scraper en thread daemon ───────────────────────────────────────
    t = threading.Thread(target=_engine_loop, daemon=True, name="scraper")
    t.start()
    print(f"[SCRAPER] Thread activo (daemon). Próximo ciclo en {SCRAPE_INTERVAL}s.\n")

    # ── Levantar Flask (blocking) ─────────────────────────────────────────────
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)