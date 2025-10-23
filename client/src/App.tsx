import { useEffect } from "react";
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
  useEffect(() => {
    // ✅ 스마트폰(세로 1800px 미만)만 --vh 적용, 키오스크(FHD 이상)는 무시
    const isKiosk = window.innerHeight >= 1800;
    if (isKiosk) return;

    const setVh = () => {
      document.documentElement.style.setProperty(
        "--vh",
        `${window.innerHeight * 0.01}px`,
      );
    };
    setVh();
    window.addEventListener("resize", setVh);
    return () => window.removeEventListener("resize", setVh);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        {/* ✅ 전역 레이아웃 래퍼 */}
        <div className="app">
          <main className="main">
            <Router />
          </main>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
