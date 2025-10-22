export interface ITtsService {
  synthesize(text: string, voiceId: string): Promise<string | null>;
}

export interface IWebSocketTtsService {
  streamSynthesize(ws: any, text: string, voiceId: string): Promise<void>;
}

export type TtsMode = 'download' | 'websocket';

// Re-export for convenience
export type { ITtsService as ITTSService };
export type { IWebSocketTtsService as IWebSocketTTSService };