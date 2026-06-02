import numpy as np
import pandas as pd
import yfinance as yf
from scipy.stats import mstats
from sklearn.mixture import GaussianMixture  # <--- Usamos esto que ya lo tienes instalado
import warnings
warnings.filterwarnings("ignore")

print("=== 1. DESCARGANDO DATOS DEL ORO Y MACRO ===")
# Descargamos Oro, Dólar y Volatilidad de una sola vez
tickers = {'XAUUSD': 'GC=F', 'DXY': 'DX-Y.NYB', 'VIX': '^VIX'}
raw_data = yf.download(tickers=list(tickers.values()), period="1y", interval="1d", group_by='ticker')

# Limpiamos y ordenamos los datos
df = pd.DataFrame()
df['Oro_Close'] = raw_data['GC=F']['Close'].ffill().bfill()
df['DXY_Close'] = raw_data['DX-Y.NYB']['Close'].ffill().bfill()
df['VIX_Close'] = raw_data['^VIX']['Close'].ffill().bfill()

# Calcular retornos del oro sin picos locos (Winsorización)
df['Oro_Ret'] = np.log(df['Oro_Close'] / df['Oro_Close'].shift(1)).fillna(0)
df['Oro_Ret_Clean'] = mstats.winsorize(df['Oro_Ret'], limits=[0.01, 0.01])
df['Oro_Vol'] = df['Oro_Ret_Clean'].rolling(window=20).std() * np.sqrt(252)
df = df.dropna()

print("=== 2. CALCULANDO FILTRO DE KALMAN Y FEATURES ===")
# Filtro de Kalman para ver la tendencia real sin ruido
vals = df['Oro_Close'].to_numpy()
xhat = np.zeros(len(vals))
xhat[0] = vals[0]
P = 1.0
for k in range(1, len(vals)):
    Pminus = P + 1e-5
    K = Pminus / (Pminus + 1e-2)
    xhat[k] = xhat[k-1] + K * (vals[k] - xhat[k-1])
    P = (1 - K) * Pminus
df['Kalman_Trend'] = xhat

# Preparar la matriz para el modelo de Regímenes
features_hmm = pd.DataFrame(index=df.index)
features_hmm['Vol_Ratio'] = df['Oro_Vol'] / df['VIX_Close']
features_hmm['Corr_DXY'] = df['Oro_Ret_Clean'].rolling(30).corr(df['DXY_Close'].pct_change()).fillna(0)
features_hmm = features_hmm.fillna(0)

print("=== 3. CLASIFICANDO REGÍMENES DE MERCADO ===")
# Usamos GaussianMixture que tiene las mismas funciones y no requiere compilar C++
model = GaussianMixture(n_components=3, random_state=42)
model.fit(features_hmm.to_numpy())

# Predecir el estado de la última barra (hoy)
last_row = features_hmm.iloc[[-1]].to_numpy()
current_regime = int(model.predict(last_row)[0])
confidence = float(model.predict_proba(last_row)[0][current_regime])

# Regla: Si la certeza es menor al 60%, no se opera por riesgo
allow_execution = confidence >= 0.60

print("\n=============================================")
print("             DIAGNÓSTICO K-AURUM             ")
print("=============================================")
print(f"Precio Actual del Oro: ${df['Oro_Close'].iloc[-1]:.2f}")
print(f"Tendencia Inteligente (Kalman): ${df['Kalman_Trend'].iloc[-1]:.2f}")
print(f"Estado del Mercado (ID Régimen): {current_regime}")
print(f"Certeza del Algoritmo: {confidence:.2%}")
print(f"¿Es seguro operar hoy?: {'SÍ, ADELANTE' if allow_execution else 'NO, MERCADO INESTABLE'}")

if allow_execution:
    print("\n=== 4. CALCULANDO RIESGO Y LOTAJE (CUENTA DE $10,000) ===")
    capital = 10000.0
    riesgo_dinero = capital * 0.01 # Arriesgar el 1% de la cuenta ($100)
    
    # Usamos la volatilidad actual para poner el stop loss
    atr_simulado = max(5.0, df['Oro_Vol'].iloc[-1] * 10) 
    distancia_sl = atr_simulado * 2.0
    
    precio_entrada = df['Oro_Close'].iloc[-1]
    stop_loss = precio_entrada - distancia_sl
    take_profit = precio_entrada + (distancia_sl * 2.0)
    
    # El lotaje exacto para perder SOLO $100 si toca el SL
    lotaje = riesgo_dinero / distancia_sl
    
    print(f"Dirección: COMPRA (LONG)")
    print(f"Lotaje Sugerido: {lotaje:.4f} unidades")
    print(f"Stop Loss (SL): ${stop_loss:.2f}")
    print(f"Take Profit (TP): ${take_profit:.2f}")
    print(f"Riesgo Máximo en USD: ${riesgo_dinero:.2f}")
print("=============================================")