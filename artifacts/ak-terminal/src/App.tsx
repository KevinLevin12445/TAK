import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Terminal from "@/pages/Terminal";
import NotFound from "@/pages/not-found";

// AQUÍ ESTÁ LA CORRECCIÓN DE LA RUTA.
// Asegúrate de que apunte a "tabs/TradeCalc" 
import { TradeCalc } from "@/components/tabs/TradeCalc";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      {/* Si quieres aislar momentáneamente la calcu en "/" descomenta la siguiente línea */}
      {/* <Route path="/" component={TradeCalc} /> */}
      
      {/* Tu ruta original */}
      <Route path="/" component={Terminal} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;