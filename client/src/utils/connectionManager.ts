// ✅ 전역 싱글톤 + 락 (중복 연결 완전 차단)
let ws: WebSocket | null = null;
let connecting = false;

export async function getOrConnectWS(url: string): Promise<WebSocket> {
  try {
    // 이미 OPEN 상태면 바로 반환
    if (ws && ws.readyState === WebSocket.OPEN) {
      return ws;
    }
    
    // 다른 곳에서 연결 중이면 대기
    if (connecting) {
      return new Promise((res, rej) => {
        const timeout = setTimeout(() => rej(new Error('Wait timeout')), 5000);
        const t = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) { 
            clearTimeout(timeout);
            clearInterval(t); 
            res(ws); 
          }
        }, 50);
      });
    }

    // 새 연결 생성
    connecting = true;
    const s = new WebSocket(url);
    s.binaryType = 'arraybuffer';
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        connecting = false;
        reject(new Error('WebSocket connection timeout'));
      }, 10000);
      
      s.onopen = () => { 
        clearTimeout(timeout);
        ws = s; 
        connecting = false;
        console.log('✅ WebSocket OPEN 완료');
        resolve(s);
      };
      
      s.onclose = () => { 
        if (ws === s) ws = null; 
      };
      
      s.onerror = (err) => { 
        clearTimeout(timeout);
        connecting = false;
        reject(err);
      };
    });
  } catch (err) {
    connecting = false;
    throw err;
  }
}

export function currentWS(): WebSocket | null {
  return ws;
}

export function closeConnection(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
  ws = null;
  connecting = false;
}
