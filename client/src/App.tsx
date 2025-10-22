import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import KioskDownloadPage from "./pages/kiosk-download";
import KioskWebSocketPage from "./pages/kiosk-websocket";
import KioskHomePage from "./pages/kiosk-home";

function Router() {
  return (
    <Switch>
      <Route path="/" component={KioskWebSocketPage} />
      <Route path="/kiosk" component={KioskHomePage} />
      <Route path="/kiosk/home" component={KioskHomePage} />
      <Route path="/kiosk/download" component={KioskDownloadPage} />
      <Route path="/kiosk/websocket" component={KioskWebSocketPage} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
