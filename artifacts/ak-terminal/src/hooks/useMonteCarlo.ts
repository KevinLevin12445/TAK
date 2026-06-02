// src/hooks/useMonteCarlo.ts
import { useState, useCallback } from 'react';

export function useMonteCarlo() {
  const [result, setResult] = useState<any>(null);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);

  const runSimulation = useCallback((params: any) => {
    setIsSimulating(true);
    
    // Instanciación del worker (Esta sintaxis funciona de forma nativa en Vite)
    const worker = new Worker(new URL('../quant/workers/MonteCarloWorker.ts', import.meta.url), { 
      type: 'module' 
    });

    worker.onmessage = (e) => {
      setResult(e.data);
      setIsSimulating(false);
      worker.terminate(); // Destruye el hilo para liberar RAM
    };

    worker.onerror = (err) => {
      console.error("Fallo crítico en Worker:", err);
      setIsSimulating(false);
      worker.terminate();
    };

    // Despacha los datos al hilo paralelo
    worker.postMessage(params);
  }, []);

  return { runSimulation, result, isSimulating };
}