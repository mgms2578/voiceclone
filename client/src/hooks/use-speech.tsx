import { useState, useRef, useCallback, useEffect } from "react";

interface UseSpeechReturn {
  isListening: boolean;
  transcript: string;
  startListening: () => void;
  stopListening: () => void;
  resetTranscript: () => void;
  error: string | null;
  isSupported: boolean;
  autoSend: boolean;
  setAutoSend: (value: boolean) => void;
  setTTSActive: (active: boolean) => void;
  ttsActive: boolean;
}

export function useSpeech(): UseSpeechReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [autoSend, setAutoSend] = useState(true);
  const [ttsActive, setTTSActive] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoSendRef = useRef(autoSend);
  const forceStopRef = useRef(false);
  const ttsActiveRef = useRef(ttsActive);

  const isSupported =
    "SpeechRecognition" in window || "webkitSpeechRecognition" in window;

  // Update refs when values change
  useEffect(() => {
    autoSendRef.current = autoSend;
  }, [autoSend]);

  useEffect(() => {
    ttsActiveRef.current = ttsActive;
  }, [ttsActive]);

  useEffect(() => {
    if (!isSupported) return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "ko-KR";

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      const fullTranscript = finalTranscript + interimTranscript;
      setTranscript(fullTranscript);

      // Auto-send after 2.2 seconds of any result (final or interim)
      const fullText = (finalTranscript + interimTranscript).trim();
      if (fullText && autoSendRef.current) {
        console.log(
          "자동 전송 준비:",
          fullText,
          "autoSend:",
          autoSendRef.current,
          "final:",
          !!finalTranscript,
        );
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = setTimeout(() => {
          console.log("자동 전송 이벤트 발생:", fullText);
          // Trigger custom event for auto-send with full transcript
          window.dispatchEvent(
            new CustomEvent("autoSendMessage", {
              detail: { transcript: fullText },
            }),
          );
        }, 2200);
      } else {
        console.log(
          "자동 전송 건너뜀 - fullText:",
          fullText,
          "autoSend:",
          autoSendRef.current,
        );
      }
    };

    recognition.onerror = (event) => {
      setError(`음성 인식 오류: ${event.error}`);
      setIsListening(false);
    };

    recognition.onend = () => {
      // Only auto-restart if we didn't manually stop and TTS is not active
      if (isListening && !forceStopRef.current && !ttsActiveRef.current) {
        // Auto-restart for continuous listening
        try {
          recognition.start();
        } catch (e) {
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [isSupported]);

  const startListening = useCallback(() => {
    if (!isSupported || !recognitionRef.current) {
      setError("음성 인식이 지원되지 않습니다.");
      return;
    }

    // ✅ TTS 체크 로직 제거 - 음성 출력 중에도 음성 입력 가능하도록
    setError(null);
    setTranscript("");
    forceStopRef.current = false;
    recognitionRef.current.start();
  }, [isSupported]);

  const stopListening = useCallback(() => {
    forceStopRef.current = true;
    setIsListening(false);

    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }

    // Clear autosend timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const setAutoSendWithCleanup = useCallback((value: boolean) => {
    setAutoSend(value);
    // Clear timeout when turning off auto-send
    if (!value && timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // ✅ 자동 stopListening 제거 - TTS 활성화 시 음성 인식을 자동으로 중단하지 않음
  const setTTSActiveWithCleanup = useCallback((active: boolean) => {
    setTTSActive(active);
    // 더 이상 TTS 시작 시 자동으로 음성 인식을 중단하지 않음
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return {
    isListening,
    transcript,
    startListening,
    stopListening,
    resetTranscript,
    error,
    isSupported,
    autoSend,
    setAutoSend: setAutoSendWithCleanup,
    setTTSActive: setTTSActiveWithCleanup,
    ttsActive,
  };
}

// Text-to-Speech hook
interface UseTTSReturn {
  speak: (text: string) => void;
  stop: () => void;
  isSpeaking: boolean;
}

export function useTTS(): UseTTSReturn {
  const [isSpeaking, setIsSpeaking] = useState(false);

  const speak = useCallback((text: string) => {
    if ("speechSynthesis" in window) {
      // Stop any current speech
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ko-KR";
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);

      window.speechSynthesis.speak(utterance);
    }
  }, []);

  const stop = useCallback(() => {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    }
  }, []);

  return { speak, stop, isSpeaking };
}

// Extend Window interface for TypeScript
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }

  interface SpeechRecognitionEvent {
    resultIndex: number;
    results: SpeechRecognitionResultList;
  }

  interface SpeechRecognitionErrorEvent {
    error: string;
  }
}
