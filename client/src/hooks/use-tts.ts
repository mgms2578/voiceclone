import { useState, useRef, useCallback, useEffect } from "react";
import { getOrConnectWS } from "@/utils/connectionManager";
import { buildWsUrl } from "@/utils/websocket-url";

interface UseTtsProps {
  mode: "download" | "websocket";
  sessionId?: string;
}

interface TtsState {
  isPlaying: boolean;
  error: string | null;
}

export function useTTS({ mode, sessionId }: UseTtsProps) {
  const [state, setState] = useState<TtsState>({
    isPlaying: false,
    error: null,
  });

  // MediaSource API 기반 실시간 스트리밍 refs
  const wsRef = useRef<WebSocket | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const startedRef = useRef<boolean>(false);
  const taskCompleteRef = useRef<boolean>(false);
  const stoppedRef = useRef<boolean>(false); // ✅ 추가: 사용자 stop 여부

  // Web Worker 기반 MP3 처리
  const workerRef = useRef<Worker | null>(null);
  const appendQueueRef = useRef<Uint8Array[]>([]);
  const lastAppendEndRef = useRef<number>(performance.now()); // 🚨 워치독용
  const lastBatchRef = useRef<Uint8Array>(new Uint8Array(0)); // 🚨 에러 롤백용
  const recoveringRef = useRef<boolean>(false); // 🚨 복구 중 플래그

  // 동적 버퍼링 설정 (더 굵은 배치)
  const bufferGoalMsRef = useRef<number>(1150); // 선버퍼링 1150ms
  const LOW_WATER_MS = 400; // 400ms 아래로 떨어지면 동적 조정
  const HIGH_WATER_MS = 1800;

  // Sparse logging (800ms 간격)
  const lastLogRef = useRef<number>(0);
  const totalBytesRef = useRef<number>(0);
  const sparseLog = useCallback((msg: string) => {
    const now = performance.now();
    if (now - lastLogRef.current > 800) {
      console.log(msg);
      lastLogRef.current = now;
    }
  }, []);

  // Web Worker 초기화
  const initWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(
      new URL("../workers/mp3-worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e) => {
      const { type, data, batchBytes } = e.data; // ✅ frames → data
      if (type === "batch") {
        if (stoppedRef.current) {
          console.log("🧹 stop 이후 Worker 배치 무시");
          return;
        }
        // Worker에서 처리된 배치를 큐에 추가
        appendQueueRef.current.push(new Uint8Array(data)); // ✅ frames → data
        totalBytesRef.current += batchBytes || data.byteLength;

        // 집계 로그 (800ms 간격)
        const bufferedMs = bufferedAheadMs();
        sparseLog(
          `📡 수신: ${Math.round(totalBytesRef.current / 1024)}KB | 버퍼: ${Math.round(bufferedMs)}ms`,
        );

        pumpAppendQueue();
        maybeStartPlayback();
        maybeEmergencyFlush(); // 🚨 데이터 도착 시마다 긴급 플러시 체크
      }
    };

    worker.onerror = (error) => {
      console.error("MP3 Worker 오류:", error);
      setState((prev) => ({ ...prev, error: "MP3 처리 오류" }));
    };

    workerRef.current = worker;
    return worker;
  }, []);

  // 🚨 안전장치 3: 안전한 endOfStream (200ms 여유 남기기)
  const tryEndOfStream = useCallback(() => {
    const ms = mediaSourceRef.current;
    const sb = sourceBufferRef.current;
    const audio = audioElementRef.current;

    if (!ms || ms.readyState !== "open" || !sb || sb.updating) return;

    const queuesEmpty = appendQueueRef.current.length === 0;
    if (!queuesEmpty) return;

    // 버퍼 끝이 현재시간보다 200ms 이상 뒤일 때만 EOS
    const b = sb.buffered;
    if (b.length && audio) {
      const end = b.end(b.length - 1);
      if (end - audio.currentTime < 0.2) {
        console.log("⏰ EOS 대기: 200ms 여유 부족");
        return; // 200ms 여유 전엔 EOS 금지
      }
    }

    try {
      console.log("🏁 안전한 MediaSource 스트림 종료");
      ms.endOfStream();
    } catch (e) {
      console.warn("endOfStream 실패:", e);
    }
  }, []);

  // 🚨 append 직전 배치 저장 (에러 롤백용)
  const beforeAppend = useCallback((batch: Uint8Array) => {
    lastBatchRef.current = batch;
  }, []);

  // append 큐 처리 (최적화됨)
  const pumpAppendQueue = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    if (!sourceBuffer || sourceBuffer.updating || recoveringRef.current) return;

    if (appendQueueRef.current.length === 0) {
      // 큐가 비었고 task_complete 상태면 endOfStream 시도
      if (taskCompleteRef.current) {
        tryEndOfStream();
      }
      return;
    }

    const batch = appendQueueRef.current.shift()!;
    try {
      beforeAppend(batch); // 🚨 append 직전에 배치 저장
      sourceBuffer.appendBuffer(batch);
      lastAppendEndRef.current = performance.now(); // 🚨 워치독용 타임스탬프 업데이트
    } catch (e) {
      if ((e as Error).name === "QuotaExceededError") {
        try {
          const buf = sourceBuffer.buffered;
          if (buf.length) {
            const removeEnd = buf.start(0) + 1.0;
            sourceBuffer.remove(buf.start(0), removeEnd);
          }
        } catch {}
      }
    }
  }, [tryEndOfStream, beforeAppend]);

  // 버퍼 상태 확인
  const bufferedAheadMs = useCallback((): number => {
    if (!sourceBufferRef.current || !audioElementRef.current) return 0;
    const b = sourceBufferRef.current.buffered;
    if (!b.length) return 0;
    const end = b.end(b.length - 1);
    return Math.max(0, (end - audioElementRef.current.currentTime) * 1000);
  }, []);

  // 🚨 안전장치 1: 초저수위 긴급 플러시 (Hard Low-Water Bailout)
  const HARD_LOW_MS = 250; // 250ms 이하면 배치 무시하고 즉시 플러시
  const maybeEmergencyFlush = useCallback(() => {
    const ahead = bufferedAheadMs();
    if (ahead <= HARD_LOW_MS) {
      console.log(`🚨 초저수위 긴급 플러시! ahead=${Math.round(ahead)}ms`);

      // Worker에게 즉시 플러시 명령
      if (workerRef.current) {
        workerRef.current.postMessage({ type: "flush" });
      }

      // 현재 큐도 즉시 처리
      pumpAppendQueue();
    }
  }, [bufferedAheadMs, pumpAppendQueue]);

  // initWorker 의존성 추가
  const initWorkerMemo = useCallback(initWorker, [
    sparseLog,
    bufferedAheadMs,
    pumpAppendQueue,
    maybeEmergencyFlush,
  ]);

  // 재생 시작 여부 확인 (동적 버퍼링) - play() 단 한 번만!
  const maybeStartPlayback = useCallback(() => {
    // ✅ stop 상태면 자동 재생 금지
    if (stoppedRef.current) {
      // console.log('▶️ 재생 요청 무시 (stoppedRef = true)');
      return;
    }

    if (
      startedRef.current ||
      !sourceBufferRef.current ||
      !audioElementRef.current
    )
      return;

    const msAhead = bufferedAheadMs();
    if (msAhead >= bufferGoalMsRef.current) {
      startedRef.current = true; // ✅ 꼭 먼저 true 설정
      console.log("🎵 재생 시작! (단 한 번만)");
      audioElementRef.current.play().catch(() => {});
    }
  }, [bufferedAheadMs]);

  // 🎯 동적 컨테이너 판별용 상태 (첨부 파일 해결책 적용)
  const firstChunkSeenRef = useRef<boolean>(false);
  const sourceReadyRef = useRef<boolean>(false);
  const firstChunkBufferRef = useRef<Uint8Array | null>(null);

  // 🎯 첫 청크에서 컨테이너 판별 후 SourceBuffer 생성
  const tryCreateSourceBuffer = useCallback(() => {
    const ms = mediaSourceRef.current;
    if (!ms || ms.readyState !== "open" || sourceBufferRef.current) return;
    if (!firstChunkSeenRef.current || !firstChunkBufferRef.current) return;

    const chunk = firstChunkBufferRef.current;
    const isWebM =
      chunk.length >= 4 &&
      chunk[0] === 0x1a &&
      chunk[1] === 0x45 &&
      chunk[2] === 0xdf &&
      chunk[3] === 0xa3;
    const isOgg =
      chunk.length >= 4 &&
      chunk[0] === 0x4f &&
      chunk[1] === 0x67 &&
      chunk[2] === 0x67 &&
      chunk[3] === 0x53;

    let codecType: string;
    if (isWebM) {
      codecType = "audio/webm; codecs=opus";
      console.log("🎯 WebM 컨테이너 감지 → WebM/Opus SourceBuffer 생성");
    } else if (isOgg) {
      codecType = "audio/ogg; codecs=opus";
      console.log(
        "🎯 Ogg 컨테이너 감지 → Ogg/Opus SourceBuffer 생성 (브라우저 미지원 가능성 있음)",
      );
    } else {
      const sig = Array.from(chunk.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      setState((prev) => ({
        ...prev,
        error: `알 수 없는 컨테이너 시그니처: ${sig}`,
      }));
      return;
    }

    if (!MediaSource.isTypeSupported(codecType)) {
      setState((prev) => ({
        ...prev,
        error: `지원하지 않는 코덱: ${codecType}`,
      }));
      return;
    }

    try {
      const sb = ms.addSourceBuffer(codecType);
      sb.mode = "sequence";
      sourceBufferRef.current = sb;

      console.log(`✅ SourceBuffer 생성 완료: ${codecType}`);

      // 첫 청크를 큐에 추가하고 처리 시작
      appendQueueRef.current.push(chunk);
      setupSourceBufferHandlers(sb);
      pumpAppendQueue();
    } catch (error) {
      console.error("SourceBuffer 생성 실패:", error);
      setState((prev) => ({ ...prev, error: "SourceBuffer 생성 실패" }));
    }
  }, [pumpAppendQueue]);

  // SourceBuffer 이벤트 핸들러 설정 분리
  const setupSourceBufferHandlers = useCallback(
    (sb: SourceBuffer) => {
      sb.addEventListener("updateend", () => {
        lastAppendEndRef.current = performance.now();
        pumpAppendQueue();
        maybeEmergencyFlush();
      });

      sb.addEventListener("error", (e: Event) => {
        console.error("🔥 SourceBuffer error:", e);
        if (recoveringRef.current) return;
        recoveringRef.current = true;

        if (sb.updating) {
          try {
            sb.abort();
          } catch {}
        }

        try {
          const b = sb.buffered;
          if (b.length) {
            const end = b.end(b.length - 1);
            sb.remove(Math.max(0, end - 0.25), end);
          }
        } catch {}

        if (lastBatchRef.current && lastBatchRef.current.length) {
          const take = Math.min(2048, lastBatchRef.current.length);
          const tail = lastBatchRef.current.slice(
            lastBatchRef.current.length - take,
          );
          console.log(`🔧 재동기화: 마지막 배치 ${take}바이트 재주입`);
          appendQueueRef.current.unshift(tail);
        }

        setTimeout(() => {
          recoveringRef.current = false;
          pumpAppendQueue();
        }, 0);
      });

      sb.addEventListener("abort", () => {
        console.warn("🚨 SourceBuffer abort");
      });

      // Append 워치독
      const watchdogInterval = setInterval(() => {
        if (!sb) return;
        const idle = performance.now() - lastAppendEndRef.current;
        if (!sb.updating && appendQueueRef.current.length > 0 && idle > 50) {
          console.log(
            `🔧 워치독 작동: ${Math.round(idle)}ms idle, 큐 ${appendQueueRef.current.length}개`,
          );
          pumpAppendQueue();
        }
      }, 50);

      const ms = mediaSourceRef.current;
      if (ms) {
        ms.addEventListener("sourceclose", () => {
          clearInterval(watchdogInterval);
        });
      }
    },
    [pumpAppendQueue, maybeEmergencyFlush],
  );

  // MediaSource 초기화 (동적 컨테이너 판별)
  const initMediaSource = useCallback(() => {
    if (!("MediaSource" in window)) {
      setState((prev) => ({ ...prev, error: "MediaSource 미지원" }));
      return;
    }

    // 🔧 이전 MediaSource와 Audio 정리
    if (audioElementRef.current) {
      try {
        audioElementRef.current.pause();
        audioElementRef.current.src = "";
        audioElementRef.current.load();
      } catch (e) {
        console.log("이전 Audio 정리 실패:", e);
      }
    }

    if (mediaSourceRef.current) {
      try {
        if (mediaSourceRef.current.readyState === "open") {
          mediaSourceRef.current.endOfStream();
        }
      } catch (e) {
        console.log("이전 MediaSource 정리 실패:", e);
      }
    }

    // SourceBuffer 초기화
    sourceBufferRef.current = null;

    const ms = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(ms);

    mediaSourceRef.current = ms;
    audioElementRef.current = audio;
    firstChunkSeenRef.current = false;
    sourceReadyRef.current = false;
    firstChunkBufferRef.current = null;

    ms.addEventListener("error", (e: Event) =>
      console.error("🔥 MediaSource error:", e),
    );
    audio.addEventListener("error", (e: Event) =>
      console.error("🔥 Audio error:", audio.error),
    );

    ms.addEventListener("sourceopen", () => {
      console.log("🔧 MediaSource 준비 완료 (동적 컨테이너 판별 대기)");
      sourceReadyRef.current = true;
      tryCreateSourceBuffer();
    });

    audio.addEventListener("ended", () => {
      setState((prev) => ({ ...prev, isPlaying: false }));
    });

    audio.addEventListener("play", () => {
      setState((prev) => ({ ...prev, isPlaying: true }));
    });

    audio.addEventListener("pause", () => {
      setState((prev) => ({ ...prev, isPlaying: false }));
    });

    // 동적 버퍼링 조절 (더 굵은 배치 대응)
    audio.addEventListener("timeupdate", () => {
      const msAhead = bufferedAheadMs();
      maybeEmergencyFlush(); // 🚨 timeupdate 시마다 긴급 플러시 체크

      if (msAhead < LOW_WATER_MS) {
        // 버퍼 부족 → 버퍼 목표 증가 + Worker에게 긴급 모드 활성화
        bufferGoalMsRef.current = 1200;

        // Worker에게 더 작은 배치로 처리하라고 알림 (긴급 모드)
        if (workerRef.current) {
          workerRef.current.postMessage({
            type: "urgent_mode",
            enabled: true,
            targetMs: 100, // 100ms 작은 배치
            maxBytes: 32 * 1024, // 32KB 작은 배치
          });
        }
      } else if (msAhead > HIGH_WATER_MS) {
        // 버퍼 충분 → 버퍼 목표 정상화 + Worker 긴급 모드 해제
        bufferGoalMsRef.current = 1150;

        // Worker 긴급 모드 해제
        if (workerRef.current) {
          workerRef.current.postMessage({
            type: "urgent_mode",
            enabled: false,
          });
        }
      }
    });
  }, [pumpAppendQueue, bufferedAheadMs]);

  // TTS 실행
  const speak = useCallback(
    async (text: string, voiceId?: string) => {
      setState((prev) => ({ ...prev, error: null }));

      // ✅ 새 TTS 요청 시작 → "이제 재생해도 됨"
      stoppedRef.current = false;

      if (mode === "download") {
        // HTTP TTS 방식 (기존)
        try {
          const response = await fetch(
            `/api/download/sessions/${sessionId}/tts`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text, voiceId }),
            },
          );

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "TTS 요청 실패");
          }

          const audioBlob = await response.blob();
          const audioUrl = URL.createObjectURL(audioBlob);
          const audio = new Audio(audioUrl);

          await audio.play();
        } catch (error) {
          setState((prev) => ({
            ...prev,
            error: error instanceof Error ? error.message : "TTS 실패",
          }));
        }
      } else if (mode === "websocket") {
        // MediaSource WebSocket TTS 방식 (Worker 기반)
        try {
          // 초기화
          appendQueueRef.current = [];
          startedRef.current = false;
          taskCompleteRef.current = false; // ✅ task_complete 플래그 리셋
          totalBytesRef.current = 0; // 바이트 카운터 리셋
          recoveringRef.current = false; // 🚨 복구 플래그 리셋
          lastBatchRef.current = new Uint8Array(0); // 🚨 배치 버퍼 리셋

          // Worker 및 MediaSource 초기화
          const worker = initWorker();
          worker.postMessage({ type: "reset" }); // Worker 상태 리셋

          // 🎯 동적 컨테이너 판별을 위해 MediaSource 항상 새로 초기화
          initMediaSource();

          // WebSocket 연결 확인
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            setState((prev) => ({
              ...prev,
              error: "WebSocket 연결이 준비되지 않았습니다.",
            }));
            return;
          }

          const synthesizeMessage = {
            type: "speak",
            text,
            voiceId: voiceId || "Korean_PowerfulGirl",
          };

          sparseLog(
            `🚀 TTS 요청: "${text.substring(0, 30)}..." (${text.length}자)`,
          );
          ws.send(JSON.stringify(synthesizeMessage));
        } catch (error) {
          console.error("MediaSource WebSocket TTS 오류:", error);
          setState((prev) => ({ ...prev, error: "WebSocket TTS 실패" }));
        }
      }
    },
    [mode, sessionId, initWorker, initMediaSource],
  );

  // 정지
  const stop = useCallback(() => {
    console.log("🛑 TTS stop 호출");

    // 이제부터 들어오는 오디오는 전부 무시
    stoppedRef.current = true;

    // 재생 중인 오디오 바로 정지
    if (audioElementRef.current) {
      try {
        audioElementRef.current.pause();
        audioElementRef.current.currentTime = 0;
      } catch (e) {
        console.log("오디오 정지 중 오류:", e);
      }
    }

    // 🔥 큐에 쌓여 있던 배치도 싹 비우기
    appendQueueRef.current = [];
    taskCompleteRef.current = false;

    // 필요하다면 버퍼도 비우기 (선택)
    const sb = sourceBufferRef.current;
    if (sb) {
      try {
        if (sb.updating) sb.abort();
        const b = sb.buffered;
        if (b.length) {
          sb.remove(0, b.end(b.length - 1));
        }
      } catch (e) {
        console.log("SourceBuffer clear 중 오류:", e);
      }
    }

    startedRef.current = false;
    setState((prev) => ({ ...prev, isPlaying: false }));
  }, []);

  // WebSocket 연결을 위한 세션 상태 확인
  const checkSessionReady = useCallback(async () => {
    if (!sessionId) return false;

    try {
      const response = await fetch(`/api/websocket/sessions/${sessionId}`);
      if (!response.ok) return false;

      const session = await response.json();
      return session.clonedVoiceId ? true : false;
    } catch (error) {
      console.error("세션 상태 확인 오류:", error);
      return false;
    }
  }, [sessionId]);

  // 초기화 (StrictMode 대응)
  useEffect(() => {
    let cancelled = false;

    if (mode === "websocket" && sessionId) {
      // 안전한 WebSocket URL 생성 (동일 오리진 기반)
      const wsUrl = buildWsUrl("/ws/tts");

      console.log("🔌 WebSocket TTS 연결 시작:", wsUrl);

      getOrConnectWS(wsUrl)
        .then((ws) => {
          if (cancelled) return;

          wsRef.current = ws;

          // Worker 초기화
          const worker = initWorker();

          // 🎯 첨부 파일 해결책: 완전한 WebSocket 메시지 핸들러 교체
          ws.binaryType = "arraybuffer"; // 🔧 필수 설정!

          ws.onmessage = async (e) => {
            // 제어 메시지 (JSON)
            if (typeof e.data === "string") {
              const m = JSON.parse(e.data);
              // 🎯 첨부 파일 해결책: stats 실제 값 찍기
              if (m.type === "stats") {
                console.log("[STATS]", m.stats); // ← 숫자 4개가 보여야 함
              } else if (m.type === "ready") {
                console.log("🔗 WebSocket TTS 준비 완료");
              } else if (m.type === "task_complete") {
                sparseLog(
                  `✅ TTS 완료 | 총수신: ${Math.round(totalBytesRef.current / 1024)}KB`,
                );
                taskCompleteRef.current = true;
                tryEndOfStream(); // 🎯 즉시 EOS 시도
              } else if (m.type === "error") {
                setState((prev) => ({ ...prev, error: m.message }));
              }
              return;
            }

            // 🎯 바이너리 수용 (Blob/ArrayBuffer 모두) - 첨부 파일 해결책 핵심!
            let ab: ArrayBuffer | null = null;
            if (e.data instanceof ArrayBuffer) {
              ab = e.data;
            } else if (e.data instanceof Blob) {
              ab = await e.data.arrayBuffer();
              console.log("🔄 Blob을 ArrayBuffer로 변환 완료");
            }

            if (!ab || ab.byteLength === 0) {
              console.warn("⚠️ 유효하지 않은 바이너리 데이터, 무시");
              return;
            }

            if (stoppedRef.current) {
              console.log("🧹 stop 이후 도착한 오디오 청크 무시");
              return;
            }

            // 🎯 첫 청크에서 컨테이너 판별 후 SourceBuffer 생성
            if (!sourceBufferRef.current) {
              firstChunkBufferRef.current = new Uint8Array(ab);

              const u = new Uint8Array(ab, 0, Math.min(4, ab.byteLength));
              const isEBML =
                u[0] === 0x1a &&
                u[1] === 0x45 &&
                u[2] === 0xdf &&
                u[3] === 0xa3;
              const isOggS =
                u[0] === 0x4f &&
                u[1] === 0x67 &&
                u[2] === 0x67 &&
                u[3] === 0x53;
              const isMP3 =
                (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) ||
                (u[0] === 0xff && (u[1] & 0xe0) === 0xe0);

              let mime: string | null = null;
              if (isEBML) {
                mime = "audio/webm; codecs=opus";
                console.log(
                  "🎯 WebM 컨테이너 감지 → WebM/Opus SourceBuffer 생성",
                );
              } else if (isMP3) {
                mime = "audio/mpeg";
                console.log("🎯 MP3 컨테이너 감지 → MP3 SourceBuffer 생성");
              } else if (isOggS) {
                mime = "audio/ogg; codecs=opus"; // Chrome MSE는 종종 미지원
                console.log(
                  "🎯 Ogg 컨테이너 감지 → Ogg/Opus SourceBuffer 생성 (브라우저 미지원 가능성)",
                );
              }

              if (!mime || !MediaSource.isTypeSupported(mime)) {
                const sig = Array.from(u)
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(" ");
                setState((prev) => ({
                  ...prev,
                  error: `지원 불가 MIME: ${mime}, 시그니처: ${sig}`,
                }));
                return;
              }

              try {
                const ms = mediaSourceRef.current;
                if (!ms || ms.readyState !== "open") {
                  console.warn("MediaSource가 준비되지 않음, 첫 청크 대기");
                  return;
                }

                const sb = ms.addSourceBuffer(mime);
                sb.mode = "sequence";
                sourceBufferRef.current = sb;

                console.log(`✅ SourceBuffer 생성 완료: ${mime}`);

                // 첫 청크를 큐에 추가하고 핸들러 설정
                appendQueueRef.current.push(new Uint8Array(ab));
                setupSourceBufferHandlers(sb);
                pumpAppendQueue();
                maybeStartPlayback();
              } catch (error) {
                console.error("SourceBuffer 생성 실패:", error);
                setState((prev) => ({
                  ...prev,
                  error: "SourceBuffer 생성 실패",
                }));
              }
            } else {
              // 🎯 일반 청크는 큐에 추가
              appendQueueRef.current.push(new Uint8Array(ab));
              totalBytesRef.current += ab.byteLength;

              const bufferedMs = bufferedAheadMs();
              sparseLog(
                `📡 수신: ${Math.round(totalBytesRef.current / 1024)}KB | 버퍼: ${Math.round(bufferedMs)}ms`,
              );

              pumpAppendQueue();
              maybeStartPlayback();
              maybeEmergencyFlush();
            }
          };

          // init 메시지 전송
          if (ws.readyState === WebSocket.OPEN) {
            const savedModel =
              localStorage.getItem("tts-model") || "speech-02-turbo";
            const savedSpeed = localStorage.getItem("tts-speed") || "1.1";
            const initMessage = {
              type: "init",
              sessionId,
              voiceId: "Korean_PowerfulGirl",
              model: savedModel,
              speed: parseFloat(savedSpeed),
            };
            console.log("📤 WebSocket init 메시지 전송:", initMessage);
            ws.send(JSON.stringify(initMessage));
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.error("WebSocket 연결 실패:", err);
            setState((prev) => ({ ...prev, error: "WebSocket 연결 실패" }));
          }
        });

      // MediaSource 초기화
      initMediaSource();
    }

    return () => {
      cancelled = true;
    };
  }, [mode, sessionId, initWorker, initMediaSource]);

  // WebSocket 재확인 (음성 클로닝 완료 후 호출 또는 설정 변경 시 호출)
  const refresh = useCallback(() => {
    if (
      mode === "websocket" &&
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN
    ) {
      const savedModel = localStorage.getItem("tts-model") || "speech-02-turbo";
      const savedSpeed = localStorage.getItem("tts-speed") || "1.1";

      console.log("🔄 WebSocket refresh 요청 (설정 업데이트 포함)");
      wsRef.current.send(
        JSON.stringify({
          type: "refresh",
          model: savedModel,
          speed: parseFloat(savedSpeed),
        }),
      );
    }
  }, [mode]);

  return {
    ...state,
    speak,
    stop,
    refresh,
    isSpeaking: state.isPlaying, // Backward compatibility
  };
}
