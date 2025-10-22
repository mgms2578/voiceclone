import { ITtsService } from './ITtsService';
import { generateSpeech } from '../minimax';

export class HttpTtsService implements ITtsService {
  async synthesize(text: string, voiceId: string): Promise<string | null> {
    return generateSpeech(text, voiceId);
  }
}