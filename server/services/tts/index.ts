// Re-export interfaces and types
export type { ITtsService, IWebSocketTtsService, TtsMode } from './ITtsService';

// Re-export classes
export { HttpTtsService } from './HttpTtsService';
export { WebSocketTtsService } from './WebSocketTtsService';

// TTS 서비스 팩토리
import { HttpTtsService } from './HttpTtsService';
import { WebSocketTtsService } from './WebSocketTtsService';

export class TtsServiceFactory {
  static createHttpService(): HttpTtsService {
    return new HttpTtsService();
  }

  static createWebSocketService(): WebSocketTtsService {
    return new WebSocketTtsService();
  }
}