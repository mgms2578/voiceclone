import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { storage } from './storage';
import { SimpleTtsService } from './services/tts/SimpleTtsService';

const simpleTtsService = new SimpleTtsService();

// WebSocket TTS 연결 관리
interface TtsConnection {
  ws: WebSocket;
  sessionId: string;
  isProcessing: boolean;
  model?: string;
  speed?: number;
}

const activeConnections = new Map<string, TtsConnection>();

export function setupWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ 
    server: httpServer,
    path: '/ws/tts',
    perMessageDeflate: false  // 압축 비활성화 (오디오 바이너리에 의미 없고 딜레이만 큼)
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log('WebSocket TTS 연결 시작');
    
    // Nagle 알고리즘 끄기 (TCP 지연 제거)
    if ((ws as any)._socket?.setNoDelay) {
      (ws as any)._socket.setNoDelay(true);
    }
    
    let connectionInfo: TtsConnection | null = null;

    ws.on('message', async (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'init') {
          // 연결 초기화
          const { sessionId, model, speed } = message;
          console.log('🔗 WebSocket init 메시지 수신, sessionId:', sessionId, 'model:', model, 'speed:', speed);
          
          // 단순화된 연결 (복잡한 세션 매칭 제거)
          console.log('✅ 단순 TTS 서비스 연결 완료, sessionId:', sessionId);
          
          if (!sessionId) {
            console.log('WebSocket 오류: 세션 ID 없음');
            ws.send(JSON.stringify({
              type: 'error',
              message: '세션 ID가 필요합니다.'
            }));
            ws.close();
            return;
          }

          // 세션 유효성 검증
          let session = await storage.getSession(sessionId);
          let voiceId = session?.clonedVoiceId;
          
          // 테스트 세션 허용 (test-streaming-, test-session-으로 시작하는 모든 세션)
          if (sessionId === 'test-session-123' || sessionId.startsWith('test-streaming-') || sessionId.startsWith('test-session-')) {
            console.log('테스트 세션 허용:', sessionId);
            voiceId = 'Korean_PowerfulGirl';
            session = { id: sessionId, clonedVoiceId: voiceId } as any;
          }
          
          console.log('세션 검증 결과:', session ? { id: session.id, hasVoiceId: !!session.clonedVoiceId } : 'null');
          
          if (!session) {
            console.log('WebSocket 오류: 유효하지 않은 세션');
            ws.send(JSON.stringify({
              type: 'error',
              message: '유효하지 않은 세션입니다.'
            }));
            ws.close();
            return;
          }

          // 기존 연결이 있다면 종료
          const existingConnection = activeConnections.get(sessionId);
          if (existingConnection) {
            existingConnection.ws.close();
            activeConnections.delete(sessionId);
          }

          // 새 연결 등록
          connectionInfo = {
            ws,
            sessionId,
            isProcessing: false,
            model: model || 'speech-02-turbo',
            speed: speed || 1.1
          };
          activeConnections.set(sessionId, connectionInfo);

          // 음성 클로닝 완료 여부에 따라 다른 응답
          if (voiceId) {
            console.log('WebSocket 연결 준비 완료, voiceId:', voiceId);
            ws.send(JSON.stringify({
              type: 'ready',
              voiceId: voiceId
            }));
          } else {
            console.log('WebSocket 연결됨, 음성 클로닝 대기 중');
            ws.send(JSON.stringify({
              type: 'pending',
              message: '음성 클로닝이 완료되면 사용할 수 있습니다.'
            }));
          }

        } else if (message.type === 'refresh') {
          // 음성 클로닝 완료 후 재확인 또는 설정 변경 후 업데이트
          if (!connectionInfo) {
            ws.send(JSON.stringify({
              type: 'error',
              message: '연결이 초기화되지 않았습니다.'
            }));
            return;
          }

          // 설정 업데이트 (모델과 속도)
          if (message.model !== undefined) {
            connectionInfo.model = message.model;
            console.log('🔄 TTS 모델 업데이트:', message.model);
          }
          if (message.speed !== undefined) {
            connectionInfo.speed = message.speed;
            console.log('🔄 TTS 속도 업데이트:', message.speed);
          }

          const session = await storage.getSession(connectionInfo.sessionId);
          const voiceId = session?.clonedVoiceId;

          if (voiceId) {
            console.log('🔄 음성 클로닝 완료 확인, voiceId:', voiceId);
            ws.send(JSON.stringify({
              type: 'ready',
              voiceId: voiceId
            }));
          } else {
            console.log('🔄 음성 클로닝 아직 진행 중');
            ws.send(JSON.stringify({
              type: 'pending',
              message: '음성 클로닝이 완료되면 사용할 수 있습니다.'
            }));
          }

        } else if (message.type === 'synthesize' || message.type === 'speak') {
          // TTS 요청 처리
          console.log(`${message.type} 요청 수신:`, { text: message.text, voiceId: message.voiceId, sessionId: connectionInfo?.sessionId });
          
          if (!connectionInfo) {
            console.log('연결 정보가 없어 요청 거부');
            ws.send(JSON.stringify({
              type: 'error',
              message: '연결이 초기화되지 않았습니다.'
            }));
            return;
          }

          if (connectionInfo.isProcessing) {
            ws.send(JSON.stringify({
              type: 'error',
              message: '다른 TTS 작업이 진행 중입니다.'
            }));
            return;
          }

          const { text } = message;
          if (!text) {
            ws.send(JSON.stringify({
              type: 'error',
              message: '텍스트가 필요합니다.'
            }));
            return;
          }

          // 세션 정보 다시 확인
          let session = await storage.getSession(connectionInfo.sessionId);
          let voiceId = session?.clonedVoiceId;
          
          // 테스트 세션 허용
          if (connectionInfo.sessionId === 'test-session-123' || connectionInfo.sessionId.startsWith('test-streaming-') || connectionInfo.sessionId.startsWith('test-session-')) {
            voiceId = 'Korean_PowerfulGirl';
            session = { id: connectionInfo.sessionId, clonedVoiceId: voiceId } as any;
          }
          
          if (!session || !voiceId) {
            ws.send(JSON.stringify({
              type: 'error',
              message: '세션이 삭제되었거나 음성이 없습니다.'
            }));
            ws.close();
            return;
          }

          connectionInfo.isProcessing = true;

          try {
            // 🎯 단순화된 TTS 실행 (직접 스트리밍)
            const model = connectionInfo.model || 'speech-02-turbo';
            const speed = connectionInfo.speed || 1.1;
            await simpleTtsService.synthesize(ws, text, voiceId, model, speed);
          } catch (error) {
            console.error('WebSocket TTS 오류:', error);
            ws.send(JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'TTS 처리 중 오류가 발생했습니다.'
            }));
          } finally {
            if (connectionInfo) {
              connectionInfo.isProcessing = false;
            }
          }
        }

      } catch (error) {
        console.error('WebSocket 메시지 처리 오류:', error);
        ws.send(JSON.stringify({
          type: 'error',
          message: '메시지 처리 중 오류가 발생했습니다.'
        }));
      }
    });

    ws.on('close', () => {
      console.log('WebSocket TTS 연결 종료');
      if (connectionInfo) {
        activeConnections.delete(connectionInfo.sessionId);
      }
    });

    ws.on('error', (error: Error) => {
      console.error('WebSocket 오류:', error);
      if (connectionInfo) {
        activeConnections.delete(connectionInfo.sessionId);
      }
    });
  });

  console.log('WebSocket TTS 서버가 /ws/tts 경로에서 시작되었습니다.');
}

// 세션 정리 시 WebSocket 연결도 종료
export function closeSessionWebSocket(sessionId: string) {
  const connection = activeConnections.get(sessionId);
  if (connection) {
    connection.ws.close();
    activeConnections.delete(sessionId);
  }
}