import type { Express } from "express";
import { createServer, type Server } from "http";
import { registerCommonRoutes } from "./routes/common";
import { registerWebSocketRoutes } from "./routes/websocket";
import { setupWebSocketServer } from "./websocket";

export async function registerRoutes(app: Express): Promise<Server> {
  
  // Register common routes (shared functionality)
  registerCommonRoutes(app);
  
  // Register websocket routes (text only, TTS via WebSocket)
  registerWebSocketRoutes(app);

  const httpServer = createServer(app);
  
  // Setup WebSocket server
  setupWebSocketServer(httpServer);
  
  return httpServer;
}
