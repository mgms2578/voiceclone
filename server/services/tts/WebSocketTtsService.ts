import { IWebSocketTtsService } from './ITtsService';
import WebSocket from 'ws';
import { spawn } from 'child_process';

export class WebSocketTtsService implements IWebSocketTtsService {
  private readonly CHUNK_BUFFER_SIZE = 12 * 1024; // 12KB 청크로 버퍼링
  private readonly CHUNK_FLUSH_INTERVAL = 35; // 35ms마다 플러시 (이벤트 루프 지터 완화)
  private sessionSockets = new Map<string, WebSocket>(); // sessionId -> 단일 WebSocket (중복 방지)

  // 새 클라이언트 연결 등록 (중복 연결 선점)
  registerClient(ws: WebSocket, sessionId: string): void {
    const existingWs = this.sessionSockets.get(sessionId);
    if (existingWs && existingWs !== ws && existingWs.readyState === ws.OPEN) {
      console.log(`세션 ${sessionId}: 기존 연결 선점 해제`);
      try {
        existingWs.close(4000, 'superseded-by-new-connection');
      } catch (e) {
        console.warn('기존 연결 닫기 실패:', e);
      }
    }
    
    console.log(`세션 ${sessionId}: 새 WebSocket 연결 등록`);
    this.sessionSockets.set(sessionId, ws);

    ws.on('close', () => {
      if (this.sessionSockets.get(sessionId) === ws) {
        console.log(`세션 ${sessionId}: WebSocket 연결 해제`);
        this.sessionSockets.delete(sessionId);
      }
    });
  }
  
  async streamSynthesize(clientWs: WebSocket, text: string, voiceId: string, sessionId?: string): Promise<void> {
    console.log(`🎯 TTS 시작: sessionId=${sessionId}, 등록된 세션=${Array.from(this.sessionSockets.keys()).join(', ')}, 소켓 상태=${this.sessionSockets.get(sessionId || '')?.readyState || 'N/A'}`);
    const apiKey = process.env.MINIMAX_API_KEY;
    const groupId = process.env.MINIMAX_GROUP_ID;
    
    if (!apiKey || !groupId) {
      throw new Error('MiniMax API 키 또는 Group ID가 설정되지 않았습니다.');
    }

    // MiniMax WebSocket TTS URL 
    const wsUrl = `wss://api.minimax.io/ws/v1/t2a_v2`;
    
    return new Promise((resolve, reject) => {
      const minimaxWs = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      let sessionId: string | null = null;
      let taskStarted = false;
      let isCompleted = false;
      
      // 🎯 수정된 ffmpeg 명령어 (Replit 호환)
      const ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin',

        // ⬇️ 입력: MP3를 파이프로 받는다 (핵심!)
        '-f', 'mp3', '-i', 'pipe:0',

        // ⬇️ Opus(WebM) 실시간용 - Replit 호환 옵션만 사용
        '-ac', '1',                // mono 권장
        '-ar', '48000',            // Opus 내부 샘플레이트
        '-c:a', 'libopus',         // ★ libopus 사용 (정확한 인코더)
        '-b:a', '48k',
        '-f', 'webm',              // WebM 컨테이너

        'pipe:1'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // 🚨 즉시 전송 시스템 (서버 배치/타이밍 완전 제거)
      let pendingFinalFlush = false;
      let lastAudioCallback: (() => void) | null = null;

      // 🎯 ffmpeg stderr 완전 로깅 (첨부 파일 해결책)
      ffmpeg.stderr.setEncoding('utf8');
      ffmpeg.stderr.on('data', (s) => {
        console.warn('[ffmpeg]', s.trim());   // 실제 에러 원인 확인
      });

      ffmpeg.on('error', (error) => {
        console.error('ffmpeg 프로세스 오류:', error);
        handleError(error);
      });

      ffmpeg.on('close', (code, signal) => {
        console.log(`🔴 ffmpeg 종료: code=${code}, signal=${signal}`);
        if (code !== 0) {
          console.error(`❌ ffmpeg 실행 실패! exit code: ${code}`);
        }
        sendStats(); // 종료시 통계 전송
      });

      // 🎯 안전한 MP3 hex 쓰기 함수 (첨부 파일 해결책)
      function writeMp3Hex(hex: string) {
        // ① MiniMax → 서버 (hex 수신)
        mmBytesIn += hex.length / 2;
        
        if (ffmpeg.stdin.destroyed) {
          console.warn('⚠️ ffmpeg stdin 이미 닫힘, hex 쓰기 스킵');
          return;
        }
        const buf = Buffer.from(hex, 'hex');
        if (buf.length === 0) {
          console.warn('⚠️ 0바이트 MP3 청크, 스킵');
          return;
        }
        
        // ② ffmpeg stdin.write
        ffInBytes += buf.length;
        console.log(`MP3 청크 수신: ${buf.length}바이트 → ffmpeg (총 입력: ${ffInBytes})`);
        
        const ok = ffmpeg.stdin.write(buf);
        if (!ok) {
          // 백프레셰 대기
          ffmpeg.stdin.once('drain', () => {
            console.log('🔄 ffmpeg stdin drain 완료');
          });
        }
      }

      // 🎯 MiniMax 종료 시에만 stdin 종료
      function finalizeTranscode() {
        try { 
          console.log('🏁 MiniMax 완료, ffmpeg stdin 종료');
          ffmpeg.stdin.end(); 
        } catch (e) {
          console.warn('stdin.end() 실패:', e);
        }
      }

      // 🎯 4지점 바이트 계측 (첨부 파일 해결책)
      let mmBytesIn = 0, ffInBytes = 0, ffOutBytes = 0, wsSentBytes = 0;

      const sendStats = () => {
        const stats = { mmBytesIn, ffInBytes, ffOutBytes, wsSentBytes };
        console.log('🎯 바이트 통계:', stats);
        const activeWs = sessionId ? self.sessionSockets.get(sessionId) : clientWs;
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({ type: 'stats', stats }));
        }
      };

      const self = this;

      // ✅ 활성 소켓만 송신 가드 (중복 연결 바이트 혼재 방지)
      const sendChunk = (buf: Buffer, callback?: () => void) => {
        // 0바이트 방지
        if (buf.length === 0) {
          console.warn('⚠️ 0바이트 청크 전송 시도, 무시');
          return;
        }
        
        // sessionId가 있으면 활성 소켓만 조회
        const activeWs = sessionId ? self.sessionSockets.get(sessionId) : clientWs;
        
        if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
          console.warn(`🚫 활성 소켓 없음, 전송 스킵 (sessionId: ${sessionId}, hasSocket: ${!!activeWs}, readyState: ${activeWs?.readyState})`);
          console.warn(`📊 현재 등록된 세션들:`, Array.from(self.sessionSockets.keys()));
          if (callback) callback();
          return;
        }
        
        // ④ ws.send 콜백 (바이트 계측)
        activeWs.send(buf, { binary: true }, (err) => {
          if (!err) {
            wsSentBytes += buf.length;
            console.log(`🎯 WebSocket 전송: ${buf.length}바이트 (총 전송: ${wsSentBytes})`);
          } else {
            console.error('WebSocket 전송 실패:', err);
          }
          if (callback) callback();
        });
      };

      // ③ ffmpeg stdout.on('data')
      ffmpeg.stdout.on('data', (webmChunk: Buffer) => {
        ffOutBytes += webmChunk.length;
        console.log(`🎯 ffmpeg stdout: ${webmChunk.length}바이트 (총 출력: ${ffOutBytes})`);
        
        // ✅ 0바이트 전송 절대 금지
        if (webmChunk.length === 0) {
          console.warn('⚠️ 0바이트 청크 감지, 전송 스킵');
          return;
        }
        
        sendChunk(webmChunk, () => {
          // 🚨 마지막 실제 오디오 청크의 콜백 저장
          lastAudioCallback = () => {
            const activeWs = sessionId ? self.sessionSockets.get(sessionId) : clientWs;
            if (activeWs && activeWs.readyState === WebSocket.OPEN) {
              activeWs.send(JSON.stringify({
                type: 'task_complete'
              }));
            }
            handleComplete();
          };
        });
      });

      // 🎯 스트림 종료 시 통계 전송 (첨부 파일 해결책)
      ffmpeg.stdout.on('end', () => {
        console.log(`[send] end; ffOutBytes=${ffOutBytes} wsSentBytes=${wsSentBytes}`);
        sendStats();
      });

      // cleanup 함수 (배치 로직 제거)
      let cleanup = () => {
        // ffmpeg 정리
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.end();
        }
        ffmpeg.kill('SIGTERM');
        
        if (minimaxWs.readyState === WebSocket.OPEN) {
          minimaxWs.close();
        }
      };


      const handleError = (error: Error) => {
        console.error('WebSocket TTS 오류:', error);
        cleanup();
        if (!isCompleted) {
          isCompleted = true;
          reject(error);
        }
      };

      const handleComplete = () => {
        cleanup();
        if (!isCompleted) {
          isCompleted = true;
          resolve();
        }
      };

      // Client WebSocket 연결 상태 확인
      if (clientWs.readyState !== WebSocket.OPEN) {
        handleError(new Error('클라이언트 WebSocket 연결이 닫혔습니다.'));
        return;
      }

      // MiniMax WebSocket 이벤트 핸들러
      minimaxWs.on('open', () => {
        console.log('MiniMax WebSocket 연결 완료, connected_success 대기 중...');
      });

      minimaxWs.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          console.log('MiniMax WebSocket 메시지 수신:', message);
          
          // 1. 연결 성공 확인
          if (message.event === 'connected_success') {
            console.log('MiniMax WebSocket 연결 성공, session_id:', message.session_id);
            sessionId = message.session_id;
            
            // task_start 이벤트 전송
            const taskStartMessage = {
              event: 'task_start',
              model: 'speech-02-turbo',
              voice_setting: {
                voice_id: voiceId,
                speed: 1.0,
                vol: 1,
                pitch: 0
              },
              audio_setting: {
                sample_rate: 32000,
                bitrate: 128000,
                format: 'mp3',
                channel: 1
              },
              language_boost: 'Korean'
            };
            
            console.log('task_start 이벤트 전송:', taskStartMessage);
            minimaxWs.send(JSON.stringify(taskStartMessage));
            return;
          }
          
          // 2. 작업 시작 확인
          if (message.event === 'task_started') {
            console.log('MiniMax TTS 작업 시작됨');
            taskStarted = true;
            
            // task_continue 이벤트로 실제 텍스트 전송
            const taskContinueMessage = {
              event: 'task_continue',
              text: text
            };
            
            console.log('task_continue 이벤트 전송:', taskContinueMessage);
            minimaxWs.send(JSON.stringify(taskContinueMessage));
            return;
          }
          
          // 3. 오디오 데이터 처리 (MP3 → ffmpeg → WebM)
          if (message.event === 'task_continued' && message.data) {
            if (message.data.audio) {
              // 🎯 첨부 파일 해결책: 안전한 MP3 hex 쓰기
              writeMp3Hex(message.data.audio);
            }
            
            // 최종 청크인지 확인 (오디오 데이터 유무와 관계없이)
            if (message.is_final) {
              console.log('TTS 합성 완료 (is_final)');
              
              // 🎯 첨부 파일 해결책: MiniMax 종료 시에만 stdin 종료
              finalizeTranscode();
              
              // 통계 전송
              sendStats();
              
              // 🚨 ffmpeg가 모든 WebM 데이터를 출력할 때까지 대기
              ffmpeg.on('close', (code) => {
                console.log(`ffmpeg 프로세스 종료 (code: ${code})`);
                
                if (pendingFinalFlush) return; // 중복 방지
                pendingFinalFlush = true;
                
                // ✅ 마지막 실제 오디오 청크의 콜백에서 완료 신호 (0바이트 전송 없음)
                if (lastAudioCallback) {
                  lastAudioCallback();
                } else {
                  // 오디오 데이터가 없었다면 즉시 완료
                  const activeWs = sessionId ? self.sessionSockets.get(sessionId) : clientWs;
                  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
                    activeWs.send(JSON.stringify({
                      type: 'task_complete'
                    }));
                  }
                  handleComplete();
                }
              });
            }
            return;
          }
          
          // 4. 작업 완료 확인 (더 이상 사용하지 않음 - is_final에서 즉시 처리)
          if (message.event === 'task_finished') {
            console.log('MiniMax task_finished 수신 (이미 처리됨)');
            return;
          }
          
          // 5. 오류 처리
          if (message.event === 'task_failed' || message.base_resp?.status_code !== 0) {
            const errorMsg = message.base_resp?.status_msg || '알 수 없는 오류';
            handleError(new Error(`MiniMax 오류 (${message.base_resp?.status_code}): ${errorMsg}`));
            return;
          }
          
        } catch (error) {
          console.error('WebSocket 메시지 파싱 오류:', error);
          handleError(new Error('메시지 파싱 실패'));
        }
      });

      minimaxWs.on('error', (error) => {
        handleError(new Error(`MiniMax WebSocket 오류: ${error.message}`));
      });

      minimaxWs.on('close', (code, reason) => {
        console.log(`MiniMax WebSocket 종료: ${code} ${reason}`);
        if (sessionId && !isCompleted) {
          handleComplete();
        }
      });

      // 클라이언트 WebSocket 종료 처리
      clientWs.on('close', () => {
        console.log('클라이언트 WebSocket 연결 종료');
        cleanup();
      });

      clientWs.on('error', (error) => {
        console.error('클라이언트 WebSocket 오류:', error);
        cleanup();
      });

      // 타임아웃 설정 (30초)
      let timeoutId = setTimeout(() => {
        if (!isCompleted) {
          handleError(new Error('WebSocket TTS 타임아웃'));
        }
      }, 30000);
      
      // 정리 함수에서 타임아웃 클리어
      const originalCleanup = cleanup;
      const enhancedCleanup = () => {
        clearTimeout(timeoutId);
        originalCleanup();
      };
      
      // cleanup 함수 대체
      cleanup = enhancedCleanup;
    });
  }
}