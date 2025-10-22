// WebM/Opus 순수 배치 처리 Web Worker
// ✅ 프레임 스캔/쪼개기 금지 - 받은 바이트를 그대로 배치만

// 배치 처리 상수 (동적 조정 가능)
let APPEND_TARGET_MS = 280; // 기본 280ms 배치
let APPEND_MAX_BYTES = 80 * 1024; // 기본 80KB 배치

// 긴급 모드 설정 (저버퍼 상황에서 더 작은 배치)
const URGENT_TARGET_MS = 100; // 긴급 모드: 100ms 배치
const URGENT_MAX_BYTES = 32 * 1024; // 긴급 모드: 32KB 배치
let urgentMode = false;

// 상태 관리 (순수 바이트 배치)
let batchChunks: Uint8Array[] = [];
let batchBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// ✅ WebM 청크 순수 배치 처리 (프레임 파싱 절대 금지)
function addChunkToBatch(chunk: Uint8Array) {
  batchChunks.push(chunk);
  batchBytes += chunk.byteLength;

  // 배치 조건 충족 시 메인으로 전송
  if (batchBytes >= APPEND_MAX_BYTES) {
    flushBatch();
  }
}

// 배치 강제 플러시
function flushBatch() {
  if (batchChunks.length === 0) return;
  
  // 타이머 클리어
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  
  const totalLen = batchBytes;
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  
  for (const chunk of batchChunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  
  // 메인으로 전송 (Transferable)
  self.postMessage({
    type: 'batch',
    data: merged,  // ✅ frames → data (프레임 개념 제거)
    batchBytes: totalLen
  }, { transfer: [merged.buffer] });
  
  // 배치 리셋
  batchChunks = [];
  batchBytes = 0;
}

// 시간 기반 플러시 스케줄링
function scheduleFlush() {
  if (flushTimer) return;
  
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBatch();
  }, APPEND_TARGET_MS);
}

// 메시지 처리
self.onmessage = (e) => {
  const { type, chunk, enabled, targetMs, maxBytes } = e.data;
  
  if (type === 'chunk') {
    // WebM 청크 배치 처리 (Transferable로 받음)
    const webmChunk = new Uint8Array(chunk);
    addChunkToBatch(webmChunk);
    
    // 시간 기반 플러시 스케줄링
    scheduleFlush();
  } else if (type === 'flush') {
    // 남은 데이터 즉시 플러시
    flushBatch();
  } else if (type === 'reset') {
    // 상태 초기화
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    batchChunks = [];
    batchBytes = 0;
    urgentMode = false; // 긴급 모드도 초기화
  } else if (type === 'urgent_mode') {
    // 긴급 모드 토글 (저버퍼 상황에서 더 작은 배치)
    urgentMode = enabled;
    
    if (urgentMode) {
      // 긴급 모드: 더 작은 배치로 전환
      APPEND_TARGET_MS = targetMs || URGENT_TARGET_MS;
      APPEND_MAX_BYTES = maxBytes || URGENT_MAX_BYTES;
      console.log(`🚨 Worker 긴급 모드 활성화: ${APPEND_TARGET_MS}ms/${Math.round(APPEND_MAX_BYTES/1024)}KB`);
    } else {
      // 일반 모드: 기본 배치로 복귀
      APPEND_TARGET_MS = 280;
      APPEND_MAX_BYTES = 80 * 1024;
      console.log(`✅ Worker 일반 모드 복귀: ${APPEND_TARGET_MS}ms/${Math.round(APPEND_MAX_BYTES/1024)}KB`);
    }
  }
};