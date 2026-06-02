/**
 * Institutional Risk Engine
 * Motor cuantitativo aislado para evaluación de esperanza matemática,
 * dimensionamiento de posiciones y modelado de colas pesadas.
 */

export interface SimulationResult {
    hitTP: number;
    hitSL: number;
    totalPaths: number;
    terminalPrices: Float64Array; // Precios al final de la simulación
}

export interface SetupEvaluation {
    approved: boolean;
    score: number;
    reason: string;
    metrics: {
        winRate: number;
        kellyFraction: number;
        ruinProbability: number;
        cVaR: number;
    };
}

export class RiskEngine {
    private readonly MAX_RUIN_TOLERANCE = 0.10; // Tolerancia máxima de ruina del 10%
    private readonly MIN_WIN_RATE = 0.35;       // Tasa de acierto mínima teórica
    private readonly MAX_KELLY_CAP = 0.25;      // Límite de apalancamiento (Half-Kelly o Quarter-Kelly en la práctica)

    /**
     * Calcula la fracción óptima de capital a arriesgar usando el Criterio de Kelly.
     * @param p Probabilidad de tocar Take Profit (TP)
     * @param riskDist Distancia al Stop Loss en USD
     * @param rewardDist Distancia al Take Profit en USD
     */
    public calculateKelly(p: number, riskDist: number, rewardDist: number): number {
        if (riskDist <= 0 || p <= 0 || p >= 1) return 0;
        const b = rewardDist / riskDist; // Ratio Beneficio/Riesgo
        const q = 1 - p;
        const f = (p * b - q) / b;
        
        // Retornamos el valor limitado para evitar sobreapalancamiento (práctica institucional común)
        return Math.max(0, Math.min(f, this.MAX_KELLY_CAP));
    }

    /**
     * Calcula la probabilidad matemática de perder un porcentaje específico del capital (Ruina).
     * Basado en el problema de la ruina del jugador con asimetría.
     */
    public calculateRuinProbability(p: number, riskDist: number, rewardDist: number, riskPerTradePct: number, ruinThreshold: number = 0.20): number {
        if (p <= 0 || riskDist <= 0 || rewardDist <= 0) return 1.0;
        
        const q = 1 - p;
        const rr = rewardDist / riskDist;
        
        // Ecuación característica generalizada
        const phi = Math.pow(q / p, 1 / rr);
        
        if (phi >= 1 || isNaN(phi)) return 1.0; // Esperanza negativa o nula
        
        // N = Número de operaciones perdedoras consecutivas para llegar al umbral de ruina
        const N = Math.round(ruinThreshold / riskPerTradePct);
        
        return Math.min(Math.pow(phi, N), 1.0);
    }

    /**
     * Cornish-Fisher Value at Risk (VaR)
     * Ajusta la distribución normal por asimetría (skewness) y curtosis (fat tails).
     */
    public calculateCornishFisherVaR(returns: Float64Array | number[], capital: number): number {
        const n = returns.length;
        if (n < 30) return 0;

        let sum = 0;
        for (let i = 0; i < n; i++) sum += returns[i];
        const mean = sum / n;

        let varSum = 0;
        let skewSum = 0;
        let kurtSum = 0;

        for (let i = 0; i < n; i++) {
            const dev = returns[i] - mean;
            const dev2 = dev * dev;
            varSum += dev2;
            skewSum += dev2 * dev;
            kurtSum += dev2 * dev2;
        }

        const variance = varSum / n;
        const std = Math.sqrt(variance);
        
        // Evitar divisiones por cero en arrays planos
        if (std === 0) return 0;

        const skew = skewSum / (n * Math.pow(std, 3));
        const kurt = kurtSum / (n * Math.pow(std, 4)) - 3; // Exceso de curtosis

        // Z-score para 99% de confianza
        const z = 2.326; 
        
        // Expansión de Cornish-Fisher
        const zCF = z + (1/6)*(Math.pow(z, 2) - 1)*skew + (1/24)*(Math.pow(z, 3) - 3*z)*kurt - (1/36)*(2*Math.pow(z, 3) - 5*z)*Math.pow(skew, 2);
        
        return capital * (mean - zCF * std);
    }

    /**
     * Veredicto Final del Setup: Circuit Breaker y Scoring
     */
    public evaluateSetup(
        sim: SimulationResult,
        riskDist: number,
        rewardDist: number,
        capital: number,
        riskPerTradePct: number = 0.01, // 1% por defecto
        hurst: number = 0.5,
        flowScore: number = 0
    ): SetupEvaluation {
        
        const pTP = sim.hitTP / sim.totalPaths;
        const kelly = this.calculateKelly(pTP, riskDist, rewardDist);
        const probRuin = this.calculateRuinProbability(pTP, riskDist, rewardDist, riskPerTradePct, 0.20);
        
        // Convertimos los precios terminales a retornos para el cálculo de VaR
        // Asumiendo que el índice 0 del arreglo es representativo del precio inicial S0 (simplificación para el motor)
        const dummyS0 = sim.terminalPrices.length > 0 ? sim.terminalPrices[0] : 1; 
        const returns = new Float64Array(sim.terminalPrices.length);
        for(let i = 0; i < sim.terminalPrices.length; i++) {
            // Retorno logarítmico aproximado
            returns[i] = Math.log(sim.terminalPrices[i] / dummyS0); 
        }
        const cVaR = this.calculateCornishFisherVaR(returns, capital);

        // 1. CIRCUIT BREAKERS (Filtros duros)
        if (pTP < this.MIN_WIN_RATE) {
            return this.reject(pTP, kelly, probRuin, cVaR, `Probabilidad de TP (${(pTP*100).toFixed(1)}%) inferior al mínimo teórico.`);
        }
        if (kelly <= 0) {
            return this.reject(pTP, kelly, probRuin, cVaR, "Esperanza matemática (EV) negativa. Criterio de Kelly exige rechazo.");
        }
        if (probRuin > this.MAX_RUIN_TOLERANCE) {
            return this.reject(pTP, kelly, probRuin, cVaR, `Riesgo de ruina inaceptable (${(probRuin*100).toFixed(1)}% > 10%).`);
        }

        // 2. SISTEMA DE SCORING (Combinación lineal)
        // Normalizamos los inputs a una escala de 0-100
        const wKelly = 0.50; // El motor principal del score es la esperanza matemática
        const wPersistence = 0.25; // Hurst
        const wFlow = 0.25; // Liquidez / Order Flow

        const kellyScore = (kelly / this.MAX_KELLY_CAP) * 100;
        const persistenceScore = Math.min(Math.max((Math.abs(hurst - 0.5) * 2), 0), 1) * 100;
        const flowNormalized = (Math.max(-100, Math.min(100, flowScore)) + 100) / 2;

        const finalScore = (kellyScore * wKelly) + (persistenceScore * wPersistence) + (flowNormalized * wFlow);

        if (finalScore < 60) {
            return this.reject(pTP, kelly, probRuin, cVaR, `Score global (${finalScore.toFixed(1)}) por debajo del umbral institucional (60).`);
        }

        return {
            approved: true,
            score: finalScore,
            reason: "Setup robusto. Esperanza matemática positiva y riesgo de colas controlado.",
            metrics: { winRate: pTP, kellyFraction: kelly, ruinProbability: probRuin, cVaR }
        };
    }

    private reject(winRate: number, kelly: number, ruin: number, cVaR: number, reason: string): SetupEvaluation {
        return {
            approved: false,
            score: 0,
            reason: `RECHAZADO: ${reason}`,
            metrics: { winRate, kellyFraction: kelly, ruinProbability: ruin, cVaR }
        };
    }
}