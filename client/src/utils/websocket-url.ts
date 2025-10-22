// WebSocket URL 안전하게 생성하기
export function buildWsUrl(path = '/ws'): string {
  // .env에 VITE_WS_BASE가 있으면 우선 사용
  const base = import.meta?.env?.VITE_WS_BASE;
  if (base) {
    const u = new URL(path, base);
    u.protocol = u.protocol.replace('http', 'ws'); // http→ws, https→wss
    return u.toString();
  }
  
  // 현재 페이지 오리진 기반으로 생성
  const { protocol, host } = window.location; // host = domain[:port]
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}${path}`;
}
