// src/quant/workers/MonteCarloWorker.ts

self.onmessage = (e: MessageEvent) => {
    const { s0, mu, sigma, dt, steps, paths, tp, sl } = e.data;
    
    let hitTP = 0;
    let hitSL = 0;
    const terminalPrices = new Float64Array(paths);
    
    // Usamos el 50% de las rutas requeridas gracias a Variables Antitéticas (Reducción de varianza)
    const n = Math.floor(paths / 2); 
    
    for (let i = 0; i < n; i++) {
        let S1 = s0;
        let S2 = s0; // Camino opuesto matemáticamente
        let active1 = true;
        let active2 = true;

        for (let t = 0; t < steps; t++) {
            let u = 0, v = 0;
            while(u === 0) u = Math.random();
            while(v === 0) v = Math.random();
            const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

            const drift = (mu - 0.5 * sigma * sigma) * dt;
            const vol = sigma * Math.sqrt(dt);

            if (active1) {
                S1 = S1 * Math.exp(drift + vol * z);
                if (S1 >= tp) { hitTP++; active1 = false; }
                else if (S1 <= sl) { hitSL++; active1 = false; }
            }
            if (active2) {
                S2 = S2 * Math.exp(drift + vol * (-z)); 
                if (S2 >= tp) { hitTP++; active2 = false; }
                else if (S2 <= sl) { hitSL++; active2 = false; }
            }
            if (!active1 && !active2) break;
        }
        terminalPrices[i] = S1;
        terminalPrices[i + n] = S2;
    }

    self.postMessage({ hitTP, hitSL, totalPaths: paths, terminalPrices });
};