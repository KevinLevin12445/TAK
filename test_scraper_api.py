import os
import sys
import json
import time
from datetime import datetime
from flask import Flask, jsonify
from flask_cors import CORS

# Asegurar que el directorio raíz esté en el path
sys.path.append(os.getcwd())

try:
    from engines.insider_engine import InsiderEngine
    print("[SUCCESS] Módulos cargados correctamente.")
except ImportError as e:
    print(f"[ERROR] No se pudo cargar InsiderEngine: {e}")
    sys.exit(1)

app = Flask(__name__)
CORS(app) # Habilitar CORS para evitar bloqueos del navegador

TICKER = "GLD"
engine = InsiderEngine(ticker=TICKER)

def json_serial(obj):
    """Serializador para objetos de pandas/numpy/datetime"""
    if hasattr(obj, 'isoformat'):
        return obj.isoformat()
    if hasattr(obj, 'to_pydatetime'):
        return obj.to_pydatetime().isoformat()
    if isinstance(obj, (int, float, str, bool, type(None))):
        return obj
    return str(obj)

@app.route('/data')
def get_data():
    try:
        # Ejecutar análisis
        engine.run()
        summary = engine.summary()
        
        # Procesar datos para que sean JSON-safe
        state = {
            "timestamp": datetime.now().isoformat(),
            "ticker": TICKER,
            "signal": summary.get("signal", "NEUTRAL"),
            "combined_score": float(summary.get("combined_score", 0)),
            "current_score": float(summary.get("current_score", 0)),
            "option_flow_score": float(summary.get("option_flow_score", 0)),
            "dark_pool_score": float(summary.get("dark_pool_score", 0)),
            "gamma_exposure": engine.gamma_exposure.get("gex_levels", []) if isinstance(engine.gamma_exposure, dict) else [],
            "dark_pool": engine.dark_pool.to_dict(orient="records") if not engine.dark_pool.empty else [],
            "option_flow": engine.option_flow.to_dict(orient="records") if not engine.option_flow.empty else [],
            "transactions": engine.transactions.to_dict(orient="records") if not engine.transactions.empty else [],
            "source": summary.get("data_source", "QUANT_LIVE_ENGINE")
        }
        
        # Limpiar datos para asegurar serialización perfecta
        clean_state = json.loads(json.dumps(state, default=json_serial))
        return jsonify(clean_state)
    
    except Exception as e:
        print(f"[ERROR] {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print("\n" + "="*50)
    print("🚀 QUANT DATA SERVER ACTIVE")
    print(f"📍 URL: http://localhost:5001/data")
    print("="*50 + "\n")
    app.run(port=5001, debug=False)
