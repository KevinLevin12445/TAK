import numpy as np
import pandas as pd
import warnings
warnings.filterwarnings("ignore")

STATE_LABELS = {0: "TREND", 1: "MEAN_REVERSION", 2: "HIGH_VOLATILITY"}
STATE_COLORS = {0: "#00ff41", 1: "#ffd700", 2: "#ff4444"}

class HMMEngine:
    def __init__(self, n_components: int = 3, n_iter: int = 250, random_state: int = 42):
        self.n_components = n_components
        self.n_iter = n_iter
        self.random_state = random_state
        self.model = None
        self.states: np.ndarray = np.array([])
        self.state_probs: np.ndarray = np.array([])
        self.fitted = False
        self._use_hmmlearn = True

    def _build_obs(self, returns: pd.Series, vol: pd.Series) -> np.ndarray:
        df = pd.concat([returns.rename("ret"), vol.rename("vol")], axis=1).dropna()
        self._obs_index = df.index
        return df.values

    def fit(self, returns: pd.Series, vol: pd.Series):
        obs = self._build_obs(returns, vol)
        if len(obs) < 50:
            self.fitted = False
            return self

        try:
            # Intento de cargar HMM (Librería nativa de estados ocultos)
            from hmmlearn.hmm import GaussianHMM
            model = GaussianHMM(
                n_components=self.n_components,
                covariance_type="full",
                n_iter=self.n_iter,
                random_state=self.random_state,
            )
            model.fit(obs)
            self.model = model
            self.states = model.predict(obs)
            self.state_probs = model.predict_proba(obs)
            self._use_hmmlearn = True
        except Exception:
            # CORRECCIÓN: Si falla por compilación en Windows, entra un algoritmo matemático real (GMM)
            self._use_hmmlearn = False
            self._gmm_clustering_fallback(obs)

        self._relabel_states(returns)
        self.fitted = True
        return self

    def _gmm_clustering_fallback(self, obs: np.ndarray):
        """Alternativa matemática rigurosa usando Modelos de Mezclas Gaussianas."""
        from sklearn.mixture import GaussianMixture
        model = GaussianMixture(
            n_components=self.n_components,
            covariance_type="full",
            max_iter=self.n_iter,
            random_state=self.random_state
        )
        model.fit(obs)
        self.model = model
        self.states = model.predict(obs)
        self.state_probs = model.predict_proba(obs)

    def _relabel_states(self, returns: pd.Series):
        """Asigna etiquetas de forma consistente sin importar el orden de inicialización."""
        ret_vals = returns.reindex(self._obs_index).values
        n_states = self.n_components

        state_means = []
        state_vols = []
        for s in range(n_states):
            mask = self.states == s
            if mask.sum() == 0:
                state_means.append(-999)
                state_vols.append(999)
            else:
                state_means.append(np.abs(ret_vals[mask]).mean())
                state_vols.append(ret_vals[mask].std())

        hv_state = int(np.argmax(state_vols))
        remaining_for_trend = [s for s in range(n_states) if s != hv_state]
        trend_state = remaining_for_trend[int(np.argmax([state_means[s] for s in remaining_for_trend]))]
        mr_state = [s for s in range(n_states) if s not in [hv_state, trend_state]][0]

        mapping = {trend_state: 0, mr_state: 1, hv_state: 2}
        
        new_states = np.zeros_like(self.states)
        new_probs = np.zeros_like(self.state_probs)
        for old, new in mapping.items():
            new_states[self.states == old] = new
            new_probs[:, new] = self.state_probs[:, old]

        self.states = new_states
        self.state_probs = new_probs

    def current_state(self) -> int:
        if not self.fitted or len(self.states) == 0:
            return -1
        return int(self.states[-1])

    def current_label(self) -> str:
        state = self.current_state()
        return STATE_LABELS.get(state, "UNKNOWN")

    def current_probs(self) -> dict:
        if not self.fitted or len(self.state_probs) == 0:
            return {label: 0.0 for label in STATE_LABELS.values()}
        probs = self.state_probs[-1]
        return {STATE_LABELS[i]: float(probs[i]) for i in range(len(probs))}

    def state_series(self) -> pd.Series:
        if not self.fitted:
            return pd.Series(dtype=int)
        return pd.Series(self.states, index=self._obs_index, name="HMM_State")

    def is_safe_to_trade(self) -> bool:
        if not self.fitted: return False
        state = self.current_state()
        probs = self.current_probs()
        if state == 2: return False  # Bloquear si es HIGH_VOLATILITY
        if max(probs.values()) < 0.60: return False  # Bloquear si no hay consenso estadístico
        return True