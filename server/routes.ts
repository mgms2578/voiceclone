import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerCommonRoutes } from "./routes/common";
import { registerDownloadRoutes } from "./routes/download";
import { registerWebSocketRoutes } from "./routes/websocket";
import { setupWebSocketServer } from "./websocket";
import { testWebSocketRouter } from "./test-websocket";

export async function registerRoutes(app: Express): Promise<Server> {
  
  // Register common routes (shared functionality)
  registerCommonRoutes(app);
  
  // Register download routes (HTTP TTS)
  registerDownloadRoutes(app);
  
  // Register websocket routes (text only, TTS via WebSocket)
  registerWebSocketRoutes(app);
  
  // Register test WebSocket TTS page
  app.use(testWebSocketRouter);
  
  // Legacy routes for backward compatibility (redirect to download)
  app.post("/api/sessions/:id/welcome", (req, res) => {
    res.redirect(307, `/api/download/sessions/${req.params.id}/welcome`);
  });
  
  app.post("/api/sessions/:id/messages", (req, res) => {
    res.redirect(307, `/api/download/sessions/${req.params.id}/messages`);
  });

  const httpServer = createServer(app);
  
  // Setup WebSocket server
  setupWebSocketServer(httpServer);
  
  return httpServer;
}
