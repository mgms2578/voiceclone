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

  // SourceBuffer 핸들러 설정
  const setupSourceBufferHandlers = useCallback(
    (sb: SourceBuffer) => {
      sb.addEventListener("updateend", () => {
        pumpAppendQueue();
        maybeStartPlayback();
      });
      sb.addEventListener("error", (e) => {
        console.error("SourceBuffer 오류:", e);
        setState((prev) => ({ ...prev, error: "SourceBuffer 오류" }));
      });
    },
    [pumpAppendQueue, maybeStartPlayback],
  );

  // MediaSource 초기화
  const initMediaSource = useCallback(() => {
    if (mediaSourceRef.current) return;

    const ms = new MediaSource();
    mediaSourceRef.current = ms;

    const audio = new Audio();
    audio.src = URL.createObjectURL(ms);
    audioElementRef.current = audio;

    ms.addEventListener("sourceopen", () => {
      console.log("📺 MediaSource OPEN");
    });

    ms.addEventListener("sourceended", () => {
      console.log("🏁 MediaSource ENDED");
      setState((prev) => ({ ...prev, isPlaying: false }));
    });

    ms.addEventListener("sourceclose", () => {
      console.log("🔚 MediaSource CLOSED");
    });

    audio.addEventListener("ended", () => {
      console.log("🎵 Audio 재생 완료");
      setState((prev) => ({ ...prev, isPlaying: false }));
    });

    audio.addEventListener("error", (e) => {
      console.error("Audio 오류:", e);
      setState((prev) => ({ ...prev, error: "오디오 재생 오류" }));
    });
  }, []);

  // 🔧 **핵심 수정: speak() 함수에서 상태 초기화**
  const speak = useCallback(
    async (text: string, voiceId?: string): Promise<void> => {
      console.log("🎙️ TTS speak 호출");

      // ✅ **중요: 새로운 TTS 시작 시 stoppedRef 초기화**
      stoppedRef.current = false;
      startedRef.current = false;
      taskCompleteRef.current = false;

      // 이전 큐와 카운터 초기화
      appendQueueRef.current = [];
      totalBytesRef.current = 0;
      firstChunkSeenRef.current = false;
      firstChunkBufferRef.current = null;

      setState((prev) => ({ ...prev, isPlaying: true, error: null }));

      if (mode === "download") {
        // ... download 모드 로직 (생략)
      } else if (mode === "websocket") {
        try {
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket 연결이 없습니다");
          }

          // Worker 초기화
          const worker = initWorker();

          // MediaSource 초기화 (없는 경우만)
          if (!mediaSourceRef.current) {
            initMediaSource();
          }

          // 🔧 **SourceBuffer가 있다면 버퍼 완전히 비우기**
          const sb = sourceBufferRef.current;
          if (sb && !sb.updating) {
            try {
              const buffered = sb.buffered;
              if (buffered.length > 0) {
                const start = buffered.start(0);
                const end = buffered.end(buffered.length - 1);
                console.log(`🧹 기존 버퍼 제거: ${start}~${end}`);
                sb.remove(start, end);

                // remove가 완료될 때까지 대기
                await new Promise<void>((resolve) => {
                  const onUpdateEnd = () => {
                    sb.removeEventListener("updateend", onUpdateEnd);
                    resolve();
                  };
                  sb.addEventListener("updateend", onUpdateEnd);
                });
              }
            } catch (e) {
              console.warn("버퍼 제거 실패 (무시):", e);
            }
          }

          // 오디오 엘리먼트 초기화
          if (audioElementRef.current) {
            audioElementRef.current.pause();
            audioElementRef.current.currentTime = 0;
          }

          // TTS 합성 요청
          const synthesizeMessage = {
            type: "synthesize",
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

  // 🔧 **핵심 수정: stop() 함수 강화**
  const stop = useCallback(() => {
    console.log("🛑 TTS stop 호출");

    // ✅ 이제부터 들어오는 오디오는 전부 무시
    stoppedRef.current = true;

    // 오디오 중단
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.currentTime = 0;
    }

    // 🔧 **추가: 큐와 버퍼 완전히 비우기**
    appendQueueRef.current = [];
    totalBytesRef.current = 0;

    // SourceBuffer 버퍼 제거 시도
    const sb = sourceBufferRef.current;
    if (sb && !sb.updating) {
      try {
        const buffered = sb.buffered;
        if (buffered.length > 0) {
          const start = buffered.start(0);
          const end = buffered.end(buffered.length - 1);
          console.log(`🧹 stop: 버퍼 제거 ${start}~${end}`);
          sb.remove(start, end);
        }
      } catch (e) {
        console.warn("stop: 버퍼 제거 실패 (무시):", e);
      }
    }

    // 상태 플래그 리셋
    startedRef.current = false;
    taskCompleteRef.current = false;
    firstChunkSeenRef.current = false;
    firstChunkBufferRef.current = null;

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

            // 🔧 **중요: stop 상태 체크를 최우선으로**
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
  }, [
    mode,
    sessionId,
    initWorker,
    initMediaSource,
    setupSourceBufferHandlers,
    pumpAppendQueue,
    maybeStartPlayback,
    maybeEmergencyFlush,
    bufferedAheadMs,
    sparseLog,
    tryEndOfStream,
  ]);

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
