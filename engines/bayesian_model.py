
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
import warnings
warnings.filterwarnings("ignore")

class BayesianSignalModel:
    """
    Versión Sniper: Optimizada para máximo Winrate.
    Utiliza umbrales de confianza agresivos y ponderación de features insider.
    """

    def __init__(self, C=0.1, penalty='l2', solver='liblinear', random_state=42):
        # C=0.1 para mayor regularización (evitar ruido, solo señales fuertes)
        self.pipeline = Pipeline([
            ('scaler', StandardScaler()),
            ('logreg', LogisticRegression(
                C=C, 
                penalty=penalty, 
                solver=solver, 
                random_state=random_state, 
                class_weight='balanced'
            ))
        ])
        self.fitted = False
        self.sniper_threshold = 0.65 # Solo operar si la probabilidad es > 65%

    def fit(self, features: pd.DataFrame, returns_fwd: pd.Series):
        X = features.dropna()
        y = returns_fwd.reindex(X.index).dropna()
        X = X.reindex(y.index)
        y_binary = (y > 0).astype(int)

        if len(np.unique(y_binary)) < 2 or len(X) < 10:
            self.fitted = False
            return self

        try:
            self.pipeline.fit(X, y_binary)
            self.fitted = True
        except Exception:
            self.fitted = False
        return self

    def predict_proba(self, x: np.ndarray) -> dict:
        if not self.fitted:
            return {"P_long": 0.5, "P_short": 0.5, "signal": "NEUTRAL", "confidence": 0.0}

        x_input = x.reshape(1, -1) if x.ndim == 1 else x
        try:
            probas = self.pipeline.predict_proba(x_input)[0]
            p_long, p_short = probas[1], probas[0]

            # Modo Sniper: Umbral de confianza elevado para maximizar winrate
            if p_long > self.sniper_threshold:
                signal = "LONG"
            elif p_short > self.sniper_threshold:
                signal = "SHORT"
            else:
                signal = "NEUTRAL"

            confidence = float(abs(p_long - p_short))
            return {
                "P_long": float(p_long),
                "P_short": float(p_short),
                "signal": signal,
                "confidence": confidence,
            }
        except Exception:
            return {"P_long": 0.5, "P_short": 0.5, "signal": "NEUTRAL", "confidence": 0.0}

    def predict_series(self, features: pd.DataFrame) -> pd.DataFrame:
        if not self.fitted or features.empty: return pd.DataFrame()
        probas = self.pipeline.predict_proba(features)
        p_longs, p_shorts = probas[:, 1], probas[:, 0]
        
        signals = []
        for pl, ps in zip(p_longs, p_shorts):
            if pl > self.sniper_threshold: signals.append("LONG")
            elif ps > self.sniper_threshold: signals.append("SHORT")
            else: signals.append("NEUTRAL")

        return pd.DataFrame({
            "P_long": p_longs, "P_short": p_shorts,
            "signal": signals, "confidence": np.abs(p_longs - p_shorts),
        }, index=features.index)
