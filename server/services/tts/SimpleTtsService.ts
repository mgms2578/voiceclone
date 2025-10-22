import WebSocket from 'ws';

/**
 * 🎯 MiniMax MP3 직접 스트리밍 TTS 서비스
 * ffmpeg 없이 원본 MP3 품질 유지
 */
export class SimpleTtsService {
  async synthesize(
    clientWs: WebSocket,
    text: string, 
    voiceId: string,
    model: string = 'speech-02-turbo',
    speed: number = 1.1
  ): Promise<void> {
    console.log(`🎵 MiniMax MP3 직접 스트리밍 시작: "${text.substring(0, 30)}..." voice: ${voiceId}, model: ${model}, speed: ${speed}`);
    
    return new Promise((resolve, reject) => {
      let isCompleted = false;
      
      // 🎯 MiniMax MP3 직접 스트리밍 (ffmpeg 없음)
      let wsSentBytes = 0;
      let frameBuffer = Buffer.alloc(0); // 프레임 경계 버퍼
      const FRAME_CHUNK_SIZE = 6144; // 6KB ≈ 10프레임 ≈ 360ms (프레임 경계 단위)

      // 🎯 MiniMax TTS API 연결 (올바른 URL)
      const minimaxWs = new WebSocket('wss://api.minimax.io/ws/v1/t2a_v2', {
        headers: {
          'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
        },
      });

      minimaxWs.on('open', () => {
        console.log('🔗 MiniMax 연결 성공');
      });

      minimaxWs.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          console.log('MiniMax WebSocket 메시지 수신:', message);
          
          // 1. 연결 성공 → 작업 시작
          if (message.event === 'connected_success') {
            const taskStart = {
              event: 'task_start',
              model: model,
              voice_setting: { voice_id: voiceId, speed: speed, vol: 1, pitch: 0 },
              audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
              language_boost: 'Korean'
            };
            console.log('📤 task_start 전송:', taskStart);
            minimaxWs.send(JSON.stringify(taskStart));
            return;
          }

          // 2. 작업 시작 확인 → 텍스트 전송
          if (message.event === 'task_started') {
            const taskContinue = { event: 'task_continue', text: text };
            console.log('📤 task_continue 전송:', taskContinue);
            minimaxWs.send(JSON.stringify(taskContinue));
            return;
          }

          // 3. 🎵 MiniMax MP3 → 프레임 경계로 재구성 후 전송
          if (message.event === 'task_continued' && message.data?.audio) {
            const hexData = message.data.audio;
            const mp3Buffer = Buffer.from(hexData, 'hex');
            
            // 버퍼에 추가
            frameBuffer = Buffer.concat([frameBuffer, mp3Buffer]);
            
            // 6KB(프레임 경계) 이상이면 전송
            while (frameBuffer.length >= FRAME_CHUNK_SIZE && clientWs.readyState === WebSocket.OPEN) {
              const chunk = frameBuffer.slice(0, FRAME_CHUNK_SIZE);
              frameBuffer = frameBuffer.slice(FRAME_CHUNK_SIZE);
              
              clientWs.send(chunk, { binary: true }, (err) => {
                if (!err) {
                  wsSentBytes += chunk.length;
                  console.log(`📤 프레임 경계 청크 전송: ${chunk.length}B (총전송: ${wsSentBytes})`);
                }
              });
            }
          }

          // 4. 🏁 완료 신호
          if (message.is_final) {
            console.log('🏁 MiniMax TTS 완료!');
            
            // 남은 버퍼 전송 (마지막 청크)
            if (frameBuffer.length > 0 && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(frameBuffer, { binary: true }, (err) => {
                if (!err) {
                  wsSentBytes += frameBuffer.length;
                  console.log(`📤 마지막 청크 전송: ${frameBuffer.length}B (총전송: ${wsSentBytes})`);
                }
              });
              frameBuffer = Buffer.alloc(0);
            }
            
            console.log(`📊 총 전송량: ${wsSentBytes}바이트`);
            
            // 작업 완료 신호
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'task_complete' }));
            }
            
            minimaxWs.close();
            
            if (!isCompleted) {
              isCompleted = true;
              resolve();
            }
          }
          
        } catch (error) {
          console.error('MiniMax 메시지 파싱 오류:', error);
        }
      });

      minimaxWs.on('error', (error) => {
        console.error('MiniMax WebSocket 오류:', error);
        if (!isCompleted) {
          isCompleted = true;
          reject(error);
        }
      });

      minimaxWs.on('close', () => {
        console.log('🔌 MiniMax 연결 종료');
      });

      // 타임아웃
      setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          console.error('⏰ TTS 타임아웃');
          minimaxWs.close();
          reject(new Error('TTS 타임아웃'));
        }
      }, 30000);
    });
  }
}