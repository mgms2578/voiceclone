import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Waveform } from '@/components/waveform';
import { useRecording } from '@/hooks/use-recording';
import { useSpeech } from '@/hooks/use-speech';
import { useTTS } from '@/hooks/use-tts';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { 
  Mic, 
  MicOff, 
  User, 
  Bot, 
  Shield, 
  Clock, 
  TriangleAlert, 
  Check, 
  Send,
  Hand,
  X,
  ScrollText,
  CircleOff,
  Loader2,
  LogOut,
  MessageCircle,
  Volume2,
  VolumeX,
  Home,
  Settings
} from 'lucide-react';

// 전역 오디오 추적을 위한 배열
const globalAudioInstances: HTMLAudioElement[] = [];

// 전역 오디오 추가 함수
function addGlobalAudio(audio: HTMLAudioElement) {
  globalAudioInstances.push(audio);
}

// 전역 오디오 제거 함수
function removeGlobalAudio(audio: HTMLAudioElement) {
  const index = globalAudioInstances.indexOf(audio);
  if (index !== -1) {
    globalAudioInstances.splice(index, 1);
  }
}

// 모든 전역 오디오 중단 함수
function stopAllGlobalAudio() {
  globalAudioInstances.forEach(audio => {
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.src = '';
    } catch (e) {
      console.log('오디오 중단 오류:', e);
    }
  });
  // 배열 비우기
  globalAudioInstances.length = 0;
}

type Step = 'intro' | 'consent' | 'recording' | 'cloning' | 'chat';

interface Session {
  id: string;
  status: string;
  clonedVoiceId?: string;
}

interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  audioUrl?: string;
}

const SCRIPT_TEXT = `안녕하세요! 지금은 음성 클로닝을 체험하고 계십니다. 이 짧은 대본을 읽어주시면, 내 목소리를 바탕으로 새로운 음성이 만들어집니다. 잠시 후, 나와 똑같은 목소리가 재생된다면 어떤 기분일까요?`;

type TTSModel = 'speech-2.5-hd-preview' | 'speech-2.5-turbo-preview' | 'speech-02-hd' | 'speech-02-turbo';

const TTS_MODELS: { value: TTSModel; label: string }[] = [
  { value: 'speech-2.5-hd-preview', label: 'Speech 2.5 HD Preview' },
  { value: 'speech-2.5-turbo-preview', label: 'Speech 2.5 Turbo Preview' },
  { value: 'speech-02-hd', label: 'Speech 02 HD' },
  { value: 'speech-02-turbo', label: 'Speech 02 Turbo' },
];

export default function KioskPage() {
  const [currentStep, setCurrentStep] = useState<Step>('intro');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [cloningProgress, setCloningProgress] = useState(0);
  const [showEndDialog, setShowEndDialog] = useState(false);
  const [showTTSSettings, setShowTTSSettings] = useState(false);
  const [selectedTTSModel, setSelectedTTSModel] = useState<TTSModel>(() => {
    const saved = localStorage.getItem('tts-model');
    return (saved as TTSModel) || 'speech-02-turbo';
  });
  const [ttsSpeed, setTtsSpeed] = useState<number>(() => {
    const saved = localStorage.getItem('tts-speed');
    return saved ? parseFloat(saved) : 1.1;
  });
  // 초기화 상태는 현재 불필요하므로 제거됨

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recording = useRecording();
  const speech = useSpeech();
  const tts = useTTS({ mode: 'websocket', sessionId: sessionId || undefined });

  // TTS WebSocket 연결 상태 디버깅
  useEffect(() => {
    console.log('KioskPage TTS 상태:', {
      sessionId,
      ttsState: tts,
      error: tts.error,
      isPlaying: tts.isPlaying
    });
  }, [sessionId, tts.error, tts.isPlaying]);

  // Create session mutation
  const createSessionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/sessions', { consentGiven: true });
      return response.json();
    },
    onSuccess: (session: Session) => {
      // 동의 취소된 경우 세션 생성 완료되어도 이동하지 않음
      if (currentStep === 'consent') {
        setSessionId(session.id);
        setCurrentStep('recording'); // 세션 생성 완료 후 녹음 화면으로 이동
      }
    },
    onError: () => {
      toast({
        title: "오류",
        description: "세션 생성에 실패했습니다.",
        variant: "destructive",
      });
    },
  });

  // Upload audio mutation
  const uploadAudioMutation = useMutation({
    mutationFn: async (audioBlob: Blob) => {
      if (!sessionId) throw new Error('세션이 없습니다.');

      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const response = await fetch(`/api/sessions/${sessionId}/audio`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('오디오 업로드에 실패했습니다.');
      }

      return response.json();
    },
    onSuccess: () => {
      setCurrentStep('chat');

      // 음성 클로닝 완료 후 WebSocket refresh (ready 상태로 전환)
      console.log('🔄 음성 클로닝 완료, WebSocket refresh 호출');
      setTimeout(() => {
        tts.refresh();
      }, 500); // 500ms 후 refresh (서버가 DB 업데이트 완료할 시간 확보)
    },
    onError: (error: Error) => {
      toast({
        title: "오류",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Send message mutation
  const sendMessageMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('세션이 없습니다.');

      const response = await apiRequest('POST', `/api/websocket/sessions/${sessionId}/messages`, {
        content,
        role: 'user',
      });
      return response.json();
    },
    onSuccess: (data: { userMessage: Message; aiMessage: Message }) => {
      // Only add AI message since user message was already added
      setMessages(prev => [...prev, data.aiMessage]);

      // WebSocket TTS로 AI 응답 재생
      console.log('WebSocket TTS로 AI 응답 재생:', data.aiMessage.content);
      console.log('현재 TTS 상태:', { error: tts.error, isPlaying: tts.isPlaying });

      tts.speak(data.aiMessage.content).then(() => {
        console.log('AI 응답 TTS 완료');
        speech.setTTSActive(false);
      }).catch((error) => {
        console.error('AI 응답 TTS 오류:', error);
        speech.setTTSActive(false);
      });
    },
    onError: (error: Error) => {
      // 세션이 삭제된 경우는 정상적인 상황이므로 에러 토스트를 표시하지 않음
      if (error.message.includes('세션이 삭제되었습니다') || error.message.includes('404')) {
        console.log('세션이 종료되어 메시지 전송을 중단했습니다.');
        return;
      }

      // 작은 토스트로 1.5초만 표시
      toast({
        description: error.message,
        variant: "destructive",
        duration: 1500,
        className: "text-sm",
      });
    },
  });

  // Delete session mutation
  const deleteSessionMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) return;
      await apiRequest('DELETE', `/api/sessions/${sessionId}`);
    },
    onSuccess: () => {
      setSessionId(null);
      setMessages([]);
      setCurrentStep('intro');

      // localStorage 사용하지 않음 (각 탭 완전 독립)

      // 채팅 입력창 초기화
      const textarea = document.querySelector('textarea[data-testid="input-message"]') as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = '';
        textarea.style.height = 'auto';
      }
      toast({
        title: "완료",
        description: "모든 데이터가 안전하게 삭제되었습니다.",
        duration: 2000,
      });
    },
  });

  // 심플한 세션 관리 (메모리에만 저장)

  // 세션 복원 없음 - 각 탭/새로고침은 항상 처음부터 시작

  // localStorage 사용하지 않음 - 완전한 탭 독립성

  // 활동 추적 제거 - 심플한 키오스크에서는 불필요

  // keepalive 시스템 제거 - 60분 TTL로 자동 정리됨

  // Handle recording completion
  useEffect(() => {
    if (recording.audioBlob && currentStep === 'recording' && !uploadAudioMutation.isPending) {
      // 녹음 화면에서 바로 클로닝 시작 (중복 실행 방지)
      uploadAudioMutation.mutate(recording.audioBlob);
    }
  }, [recording.audioBlob, currentStep]);

  // Load welcome message when entering chat
  useEffect(() => {
    if (currentStep === 'chat' && messages.length === 0 && sessionId) {
      // Request welcome message from server (WebSocket version)
      fetch(`/api/websocket/sessions/${sessionId}/welcome`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
          if (data.message) {
            const welcomeMessage: Message = {
              id: 'welcome-' + Date.now(),
              role: 'assistant',
              content: data.message.content
            };
            setMessages([welcomeMessage]);

            // WebSocket TTS로 환영 메시지 재생
            console.log('WebSocket TTS로 환영 메시지 재생:', data.message.content);
            console.log('현재 TTS 상태:', { error: tts.error, isPlaying: tts.isPlaying });

            // TTS 시작 - 마이크 비활성화
            speech.setTTSActive(true);

            // WebSocket TTS 사용하여 음성 재생
            tts.speak(data.message.content, data.voiceId).then(() => {
              console.log('환영 메시지 TTS 완료');
              speech.setTTSActive(false);
            }).catch((error) => {
              console.error('환영 메시지 TTS 오류:', error);
              speech.setTTSActive(false);
            });
          }
        })
        .catch(console.error);
    }
  }, [currentStep, messages.length, sessionId]);

  // Listen for toast events from speech hook
  useEffect(() => {
    const handleToast = (event: CustomEvent) => {
      const { title, description, variant } = event.detail;
      toast({ title, description, variant });
    };

    window.addEventListener('showToast', handleToast as EventListener);
    return () => window.removeEventListener('showToast', handleToast as EventListener);
  }, []);

  // Update input message from speech
  useEffect(() => {
    if (speech.transcript && currentStep === 'chat') {
      setInputMessage(speech.transcript);
    }
  }, [speech.transcript, currentStep]);

  // Auto scroll to bottom when new messages are added
  useEffect(() => {
    if (currentStep === 'chat') {
      const chatContainer = document.querySelector('[data-testid="chat-container"]');
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }
  }, [messages, currentStep]);

  // Auto-send message handler
  useEffect(() => {
    const handleAutoSend = (event: CustomEvent) => {
      const { transcript } = event.detail;
      console.log('자동 전송 이벤트 수신:', transcript, 'currentStep:', currentStep, 'isPending:', sendMessageMutation.isPending, 'ttsActive:', speech.ttsActive);

      // Don't auto-send if TTS is active
      if (transcript && currentStep === 'chat' && !sendMessageMutation.isPending && !speech.ttsActive) {
        console.log('자동 전송 진행:', transcript);
        setInputMessage('');
        speech.resetTranscript();

        // Stop speech recognition when auto-sending message
        speech.stopListening();

        // 메시지 전송 시점부터 TTS 활성화 (AI 응답 완료까지 마이크 차단)
        speech.setTTSActive(true);

        // Add user message immediately to UI (same as manual send)
        const userMessage: Message = {
          id: 'user-' + Date.now(),
          role: 'user',
          content: transcript,
        };
        setMessages(prev => [...prev, userMessage]);

        sendMessageMutation.mutate(transcript);
      } else {
        console.log('자동 전송 차단됨 - transcript:', transcript, 'step:', currentStep, 'pending:', sendMessageMutation.isPending, 'tts:', speech.ttsActive);
      }
    };

    window.addEventListener('autoSendMessage', handleAutoSend as EventListener);
    return () => {
      window.removeEventListener('autoSendMessage', handleAutoSend as EventListener);
    };
  }, [currentStep, sendMessageMutation.isPending, speech.ttsActive]);

  // Cleanup expired sessions when entering home screen
  useEffect(() => {
    if (currentStep === 'intro') {
      console.log('홈 화면 진입 → 만료된 세션 정리 시작');

      apiRequest('POST', '/api/cleanup')
        .then(response => response.json())
        .then(result => {
          console.log('세션 정리 완료:', result);
          if (result.deletedSessions > 0 || result.deletedVoices > 0) {
            console.log(`정리됨: 세션 ${result.deletedSessions}개, 보이스 ${result.deletedVoices}개`);
          }
        })
        .catch(error => {
          console.error('세션 정리 오류:', error);
        });
    }
  }, [currentStep]);

  // Inactivity timer: 10분 동안 사용자 액션이 없으면 홈 화면으로 이동
  useEffect(() => {
    // 홈 화면에서는 타이머 동작하지 않음
    if (currentStep === 'intro') {
      return;
    }

    const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10분
    let inactivityTimer: NodeJS.Timeout;

    const resetTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        console.log('10분 비활성으로 홈 화면으로 이동');

        const currentSessionId = sessionId;

        // 즉시 UI를 홈으로 변경 (백엔드 응답을 기다리지 않음)
        setSessionId(null);
        setCurrentStep('intro');
        setMessages([]);
        setInputMessage('');

        // 백그라운드에서 세션 삭제 (실패해도 UI는 이미 홈으로 이동됨)
        if (currentSessionId) {
          apiRequest('DELETE', `/api/sessions/${currentSessionId}`)
            .then(() => console.log('비활성 세션 삭제 완료'))
            .catch(err => console.error('비활성 세션 삭제 실패 (무시):', err));
        }
      }, INACTIVITY_TIMEOUT);
    };

    // 초기 타이머 시작
    resetTimer();

    // 사용자 액션 감지
    const events = ['click', 'keydown', 'touchstart', 'mousemove'];
    events.forEach(event => {
      window.addEventListener(event, resetTimer);
    });

    // Cleanup
    return () => {
      clearTimeout(inactivityTimer);
      events.forEach(event => {
        window.removeEventListener(event, resetTimer);
      });
    };
  }, [currentStep, sessionId]);

  const handleStartExperience = () => {
    setCurrentStep('consent');
  };

  const handleConsent = () => {
    // 이전 세션의 데이터 초기화
    recording.clearRecording();
    setMessages([]); // 이전 채팅 메시지 초기화
    setInputMessage(''); // 입력 메시지 초기화

    createSessionMutation.mutate();
    // 세션 생성 완료 후 자동으로 recording 화면으로 이동 (onSuccess에서 처리)
  };

  const handleDeclineConsent = () => {
    setCurrentStep('intro');
  };

  const handleSendMessage = () => {
    if (inputMessage.trim() && !sendMessageMutation.isPending) {
      const messageToSend = inputMessage.trim();
      setInputMessage('');
      speech.resetTranscript();

      // Stop speech recognition when sending message
      speech.stopListening();

      // 메시지 전송 시점부터 TTS 활성화 (AI 응답 완료까지 마이크 차단)
      speech.setTTSActive(true);

      // Add user message immediately to UI
      const userMessage: Message = {
        id: 'user-' + Date.now(),
        role: 'user',
        content: messageToSend,
      };
      setMessages(prev => [...prev, userMessage]);

      sendMessageMutation.mutate(messageToSend);
    }
  };

  const handleVoiceInput = () => {
    if (speech.isListening) {
      speech.stopListening();
    } else {
      tts.stop(); // Stop any current TTS
      speech.setTTSActive(false); // Clear TTS state immediately
      speech.startListening();
    }
  };

  const handleEndExperience = () => {
    setShowEndDialog(true);
  };

  const handleConfirmEnd = () => {
    setShowEndDialog(false);

    // 진행중인 API 요청들 취소
    queryClient.cancelQueries();

    // 진행중인 뮤테이션 강제 정지
    if (sendMessageMutation.isPending) {
      // React Query의 뮤테이션은 직접 취소할 수 없으므로 상태를 리셋
      queryClient.setMutationDefaults(['sendMessage'], {
        mutationFn: () => Promise.resolve(),
      });
    }

    // 강력한 오디오 중단 - 모든 종류의 오디오 재생 중단
    try {
      // 0. 전역 오디오 객체들 중단 (가장 중요!)
      stopAllGlobalAudio();

      // 1. DOM의 모든 audio 태그 중단
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        audio.pause();
        audio.currentTime = 0;
        audio.src = ''; // 소스 제거로 완전히 정지
      });

      // 2. 전역 window에 있을 수 있는 현재 재생 중인 Audio 객체들 중단
      // HTML5 Audio API 전체 중단
      if (typeof Audio !== 'undefined') {
        // 현재 재생 중인 모든 오디오 컨텍스트 중단 시도
        window.dispatchEvent(new CustomEvent('stopAllAudio'));
      }

      // 3. Web Audio API 컨텍스트 중단
      if (window.AudioContext || (window as any).webkitAudioContext) {
        // AudioContext suspend 시도 (가능한 경우)
        const audioContexts = (window as any).audioContexts || [];
        audioContexts.forEach((ctx: AudioContext) => {
          if (ctx.state === 'running') {
            ctx.suspend();
          }
        });
      }

      // 4. MediaRecorder 중단
      const mediaRecorders = document.querySelectorAll('*');
      mediaRecorders.forEach((element: any) => {
        if (element.mediaRecorder && typeof element.mediaRecorder.stop === 'function') {
          element.mediaRecorder.stop();
        }
      });

    } catch (e) {
      console.log('오디오 중단 중 오류:', e);
    }

    // TTS 상태 초기화
    speech.setTTSActive(false);
    speech.stopListening();

    deleteSessionMutation.mutate();
  };

  const handleCancelEnd = () => {
    setShowEndDialog(false);
  };

  const handleGoHome = () => {
    if (sessionId) {
      deleteSessionMutation.mutate();
    } else {
      setCurrentStep('intro');
    }
  };

  const handleTTSModelChange = (model: TTSModel) => {
    setSelectedTTSModel(model);
    localStorage.setItem('tts-model', model);
  };

  const handleTTSSpeedChange = (speed: number) => {
    setTtsSpeed(speed);
    localStorage.setItem('tts-speed', speed.toString());
  };

  const handleCloseSettings = () => {
    setShowTTSSettings(false);

    // WebSocket 연결 재초기화하여 새 설정 적용
    if (sessionId && currentStep === 'chat') {
      console.log('🔄 설정 변경으로 인한 WebSocket 재연결:', { model: selectedTTSModel, speed: ttsSpeed });
      tts.refresh();
    }

    toast({
      title: "설정 저장됨",
      description: `모델: ${TTS_MODELS.find(m => m.value === selectedTTSModel)?.label}, 속도: ${ttsSpeed}x`,
    });
  };

  if (currentStep === 'intro') {
    // 인트로 화면
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-600 to-purple-700 text-white kiosk-intro relative">
        {/* 오른쪽 상단 시크릿 버튼 */}
        <button
          onClick={() => setShowTTSSettings(true)}
          className="absolute top-4 right-4 p-3 opacity-40 hover:opacity-100 transition-opacity duration-300"
          data-testid="button-tts-settings"
          aria-label="TTS 설정"
        >
          <Settings className="w-8 h-8" />
        </button>

        <div className="text-center max-w-4xl mx-auto px-4">
          <div className="mb-8">
            <Mic className="w-32 h-32 mx-auto mb-6 opacity-90 float-animation kiosk-icon" />
          </div>

          <h1 className="text-4xl md:text-6xl font-bold mb-6 kiosk-title">음성 딥페이크 체험</h1>
          <h2 className="text-2xl md:text-3xl font-medium mb-8 opacity-90 kiosk-subtitle">AI 딥페이크 위험성 교육 서비스</h2>

          <div className="mb-8 md:mb-12">
            <p className="text-lg md:text-xl leading-relaxed mb-4 kiosk-description">
              나의 목소리를 AI가 학습하고 복제하는 과정을 직접 체험해보세요.
            </p>
            <p className="text-base md:text-lg opacity-80 kiosk-description">
              복제된 목소리로 AI와 딥페이크의 위험성에 관해 대화하는 교육 프로그램입니다.
            </p>
          </div>

          <Button
            onClick={handleStartExperience}
            size="lg"
            className="bg-white text-blue-600 text-2xl md:text-3xl font-bold py-8 md:py-10 px-12 md:px-16 rounded-3xl shadow-2xl hover:shadow-3xl transform hover:scale-110 transition-all duration-500 glow-animation hover:animate-none min-h-[100px] md:min-h-[120px] border-4 border-white/20 active:scale-95 kiosk-button"
            data-testid="button-start"
          >
            <Hand className="mr-4 md:mr-6 w-8 md:w-10 h-8 md:h-10 animate-bounce" />
            화면을 터치하여 시작하기
          </Button>

          <div className="mt-6 md:mt-8 text-base md:text-lg opacity-80">
            체험 시간: 약 5분
          </div>
        </div>

        {/* TTS Settings Dialog */}
        {showTTSSettings && (
          <div 
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-80"
            onClick={() => setShowTTSSettings(false)}
          >
            <div 
              className="bg-white p-8 rounded-lg shadow-xl max-w-2xl w-full mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-center text-2xl font-bold text-gray-800 mb-6">
                TTS 설정
              </h2>

              {/* TTS Model Selection */}
              <div className="mb-8">
                <h3 className="text-lg font-semibold text-gray-700 mb-3">모델 선택</h3>
                <div className="space-y-3">
                  {TTS_MODELS.map((model) => (
                    <button
                      key={model.value}
                      onClick={() => handleTTSModelChange(model.value)}
                      className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                        selectedTTSModel === model.value
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                      }`}
                      data-testid={`button-tts-model-${model.value}`}
                    >
                      <div className="font-semibold text-gray-800">{model.label}</div>
                      {selectedTTSModel === model.value && (
                        <div className="mt-2 text-blue-600 text-sm font-medium">✓ 선택됨</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* TTS Speed Control */}
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-gray-700 mb-3">속도 조절</h3>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={ttsSpeed}
                    onChange={(e) => handleTTSSpeedChange(parseFloat(e.target.value))}
                    className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    data-testid="slider-tts-speed"
                  />
                  <span className="text-lg font-semibold text-gray-800 min-w-[60px] text-right" data-testid="text-tts-speed">
                    {ttsSpeed.toFixed(1)}x
                  </span>
                </div>
                <div className="flex justify-between text-sm text-gray-500 mt-2">
                  <span>느림 (0.5x)</span>
                  <span>빠름 (2.0x)</span>
                </div>
              </div>

              <div className="flex justify-center">
                <button
                  onClick={handleCloseSettings}
                  className="px-8 py-3 text-white bg-blue-600 rounded-lg hover:bg-blue-700 text-lg font-medium transition-colors"
                  data-testid="button-close-tts-settings"
                >
                  저장
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (currentStep === 'consent') {
    return (
      <div className="h-screen bg-white p-8">
        <div className="max-w-4xl mx-auto h-full flex flex-col">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-800 mb-4">개인정보 수집 및 이용 동의</h1>
            <div className="flex items-center justify-center text-blue-600">
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-semibold mr-4">1</div>
              <div className="w-16 h-1 bg-blue-600 mr-4"></div>
              <div className="w-8 h-8 rounded-full bg-gray-300 text-gray-600 flex items-center justify-center text-sm font-semibold">2</div>
            </div>
          </div>

          <div className="flex-1 bg-gray-50 rounded-xl p-6 mb-8 overflow-y-auto">
            <div className="space-y-6">
              <Card>
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold text-gray-800 mb-3 flex items-center">
                    <Shield className="text-green-600 mr-3 w-6 h-6" />
                    수집하는 개인정보
                  </h3>
                  <ul className="text-gray-600 space-y-2">
                    <li>• 음성 데이터 (10-20초 분량)</li>
                    <li>• 체험 진행 로그 (익명 처리)</li>
                  </ul>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <h3 className="text-xl font-semibold text-gray-800 mb-3 flex items-center">
                    <Clock className="text-purple-600 mr-3 w-6 h-6" />
                    이용 목적 및 보유 기간
                  </h3>
                  <ul className="text-gray-600 space-y-2">
                    <li>• 목적: AI 음성 클로닝 체험 및 딥페이크 교육</li>
                    <li>• 보유 기간: 체험 완료 후 즉시 삭제</li>
                    <li>• 외부 전송: MiniMax AI 서비스 (일시적 처리 후 삭제)</li>
                  </ul>
                </CardContent>
              </Card>

            </div>
          </div>

          {/* 버튼들을 위로 이동 */}
          <div className="flex gap-4 justify-center mb-6">
            <Button
              onClick={handleDeclineConsent}
              variant="outline"
              size="lg"
              className="text-xl font-semibold py-4 px-8"
              disabled={createSessionMutation.isPending}
              data-testid="button-decline"
            >
              <X className="mr-3 w-5 h-5" />
              동의하지 않음
            </Button>
            <Button
              onClick={handleConsent}
              size="lg"
              className="bg-blue-600 text-xl font-semibold py-4 px-12"
              disabled={createSessionMutation.isPending}
              data-testid="button-agree"
            >
              {createSessionMutation.isPending ? (
                <>
                  <div className="mr-3 w-5 h-5 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                  세션 생성 중...
                </>
              ) : (
                <>
                  <Check className="mr-3 w-5 h-5" />
                  동의하고 계속하기
                </>
              )}
            </Button>
          </div>

          {/* 안내 문구를 아래로 이동 */}
          <div className="bg-red-50 border border-red-200 p-4 rounded-lg">
            <p className="text-red-600 font-medium text-center">
              <TriangleAlert className="inline mr-2 w-5 h-5" />
              본 동의는 체험을 위한 것이며, 언제든지 체험을 중단할 수 있습니다.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (currentStep === 'recording') {
    return (
      <div className="h-screen bg-white p-8 relative">
        {/* Home button */}
        <Button
          onClick={handleGoHome}
          variant="outline"
          size="lg"
          className="absolute top-8 left-8 w-16 h-16 rounded-full p-0 bg-white border-2 border-gray-300 hover:border-blue-500 hover:bg-blue-50 transition-all duration-300 shadow-lg"
          data-testid="button-home"
        >
          <Home className="w-8 h-8 text-gray-600 hover:text-blue-600" />
        </Button>

        <div className="max-w-5xl mx-auto h-full flex flex-col">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-800 mb-4">음성 녹음하기</h1>
            <div className="flex items-center justify-center text-blue-600">
              <div className="w-8 h-8 rounded-full bg-gray-300 text-gray-600 flex items-center justify-center text-sm font-semibold mr-4">1</div>
              <div className="w-16 h-1 bg-gray-300 mr-4"></div>
              <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-sm font-semibold mr-4">2</div>
              <div className="w-16 h-1 bg-gray-300 mr-4"></div>
              <div className="w-8 h-8 rounded-full bg-gray-300 text-gray-600 flex items-center justify-center text-sm font-semibold">3</div>
            </div>
          </div>

          <Card className="mb-8">
            <CardContent className="p-8">
              <h2 className="text-2xl font-semibold text-gray-800 mb-4 text-center flex items-center justify-center">
                <ScrollText className="text-purple-600 mr-3 w-6 h-6" />
                다음 대본을 읽어주세요
              </h2>
              <div className="bg-white p-6 rounded-lg shadow-sm border-l-4 border-blue-600">
                <p className="text-xl leading-relaxed text-gray-700 text-center">
                  {SCRIPT_TEXT}
                </p>
              </div>
              <div className="text-center mt-4 text-gray-600">
                <CircleOff className="inline mr-2 w-4 h-4" />
                예상 읽기 시간: 10-15초 | 최대 30초까지 녹음됩니다
              </div>
            </CardContent>
          </Card>

          <div className="flex-1 flex flex-col items-center justify-center">
            {/* 클로닝 진행 중일 때 */}
            {recording.audioBlob && uploadAudioMutation.isPending && (
              <div className="text-center">
                <div className="mb-8">
                  <div className="relative">
                    <div className="w-24 h-24 border-6 border-blue-200 rounded-full"></div>
                    <div className="absolute top-0 left-0 w-24 h-24 border-6 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Bot className="w-12 h-12 text-blue-600" />
                    </div>
                  </div>
                </div>
                <h2 className="text-3xl font-bold text-gray-800 mb-4">음성 클로닝 진행 중</h2>
                <p className="text-lg text-gray-600 mb-6">MiniMax AI가 당신의 목소리를 학습하고 있습니다...</p>
                <div className="space-y-3">
                  <div className="flex items-center justify-center text-base text-gray-700">
                    <Check className="w-5 h-5 text-green-600 mr-3" />
                    음성 파일 업로드 완료
                  </div>
                  <div className="flex items-center justify-center text-base text-gray-700">
                    <Loader2 className="w-5 h-5 text-blue-600 mr-3 animate-spin" />
                    AI 음성 모델 생성 중...
                  </div>
                </div>
              </div>
            )}

            {/* 클로닝 실패 시 재시도 */}
            {recording.audioBlob && uploadAudioMutation.isError && (
              <div className="text-center">
                <div className="mb-6">
                  <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <X className="w-8 h-8 text-red-600" />
                  </div>
                  <h2 className="text-2xl font-bold text-gray-800 mb-2">음성 클로닝 실패</h2>
                  <p className="text-gray-600 mb-6">다시 시도해주세요.</p>
                  <Button
                    onClick={() => {
                      // 녹음 상태 초기화하고 녹음 화면으로 돌아가기
                      recording.clearRecording();
                      uploadAudioMutation.reset();
                    }}
                    size="lg"
                    className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3"
                  >
                    다시 시도하기
                  </Button>
                </div>
              </div>
            )}

            {/* 일반 녹음 상태 */}
            {!uploadAudioMutation.isPending && !uploadAudioMutation.isError && (
              <>
                {recording.isRecording && (
                  <Waveform isRecording={recording.isRecording} />
                )}

                {recording.isRecording && (
                  <div className="text-6xl font-mono font-bold text-blue-600 mb-8" data-testid="text-timer">
                    {Math.floor(recording.recordingTime / 60).toString().padStart(2, '0')}:
                    {(recording.recordingTime % 60).toString().padStart(2, '0')}
                  </div>
                )}

                <Button
                  onClick={recording.isRecording ? recording.stopRecording : recording.startRecording}
                  size="lg"
                  className={`text-2xl font-semibold py-8 px-16 rounded-full shadow-xl hover:shadow-2xl transform hover:scale-105 transition-all duration-300 ${
                    recording.isRecording 
                      ? 'bg-red-600 hover:bg-red-700 animate-pulse' 
                      : recording.audioBlob 
                        ? 'bg-green-600 hover:bg-green-700'
                        : 'bg-red-600 hover:bg-red-700'
                  }`}
                  data-testid="button-record"
                >
                  {recording.isRecording ? (
                    <>
                      <MicOff className="mr-4 w-6 h-6" />
                      녹음 중지하기
                    </>
                  ) : recording.audioBlob ? (
                    <>
                      <Check className="mr-4 w-6 h-6" />
                      녹음 완료!
                    </>
                  ) : (
                    <>
                      <Mic className="mr-4 w-6 h-6" />
                      녹음 시작하기
                    </>
                  )}
                </Button>
              </>
            )}

            {recording.error && (
              <div className="mt-4 text-red-600 text-center">
                {recording.error}
              </div>
            )}

            <div className="mt-6 text-gray-600 text-center">
              <p>녹음 시작하기 버튼을 누르고 위의 대본을 자연스럽게 읽어주세요</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 사용하지 않는 cloning 화면 제거됨 (recording 화면에서 진행상황 표시)

  if (currentStep === 'chat') {
    return (
      <div className="h-screen bg-white flex flex-col">
        <div className="bg-blue-600 text-white p-6">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold mb-2">AI와 대화하기</h1>
            </div>
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 bg-white bg-opacity-20 rounded-full flex items-center justify-center">
                <User className="w-6 h-6" />
              </div>
              <div className="text-2xl">🔄</div>
              <div className="w-12 h-12 bg-white bg-opacity-20 rounded-full flex items-center justify-center">
                <Bot className="w-6 h-6" />
              </div>
              {/* 설정 버튼 */}
              <button
                onClick={() => setShowTTSSettings(true)}
                className="w-12 h-12 bg-white bg-opacity-20 rounded-full flex items-center justify-center hover:bg-opacity-30 transition-all"
                data-testid="button-chat-settings-header"
                aria-label="TTS 설정"
              >
                <Settings className="w-6 h-6" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 max-w-6xl mx-auto w-full p-6 overflow-y-auto" data-testid="chat-container">

          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex items-start space-x-4 mb-6 ${
                message.role === 'user' ? 'justify-end' : ''
              }`}
              data-testid={`message-${message.role}-${message.id}`}
            >
              {message.role === 'assistant' && (
                <div 
                  className="w-12 h-12 bg-purple-600 rounded-full flex items-center justify-center text-white cursor-pointer hover:bg-purple-700 transition-colors"
                  onClick={() => {
                    if (message.audioUrl) {
                      const audio = new Audio(message.audioUrl);
                      audio.play().catch(console.error);
                    }
                  }}
                  title="클릭하여 음성 재생"
                  data-testid="button-play-audio"
                >
                  <Bot className="w-6 h-6" />
                </div>
              )}

              <div className={`flex-1 ${message.role === 'user' ? 'text-right' : ''}`}>
                <div className={`rounded-2xl p-4 max-w-2xl ${
                  message.role === 'user' 
                    ? 'bg-blue-600 text-white rounded-tr-none ml-auto' 
                    : 'bg-gray-100 rounded-tl-none'
                }`}>
                  <p className={message.role === 'user' ? 'text-white' : 'text-gray-800'}>
                    {message.content}
                  </p>
                </div>
                <div className={`text-xs text-gray-500 mt-1 ${
                  message.role === 'user' ? 'mr-4' : 'ml-4'
                }`}>
                  {message.role === 'user' ? '사용자' : '복제된 음성'}
                </div>

              </div>

              {message.role === 'user' && (
                <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center text-white">
                  <User className="w-6 h-6" />
                </div>
              )}
            </div>
          ))}

          {sendMessageMutation.isPending && (
            <div className="flex items-start space-x-4 mb-6">
              <div className="w-12 h-12 bg-purple-600 rounded-full flex items-center justify-center text-white">
                <Bot className="w-6 h-6" />
              </div>
              <div className="flex-1">
                <div className="bg-gray-100 rounded-2xl rounded-tl-none p-4 max-w-2xl">
                  <div className="flex items-center space-x-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-gray-600">AI가 답변을 생성하고 있습니다...</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-t bg-gray-50 p-6">
          <div className="max-w-6xl mx-auto space-y-4">

            {/* 메시지 입력창과 전송 버튼 */}
            <div className="flex items-center space-x-4">
              <div className="flex-1 relative">
                <input
                  type="text"
                  placeholder={speech.isListening ? "듣고 있습니다..." : "메시지를 입력하거나 아래 음성 버튼을 눌러 말해보세요..."}
                  className={`w-full py-4 px-6 border rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent text-lg ${
                    speech.isListening ? 'border-red-300 bg-red-50' : 'border-gray-300'
                  }`}
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                  data-testid="input-message"
                />
                {speech.error && (
                  <div className="absolute -bottom-6 left-6 text-red-500 text-sm">
                    {speech.error}
                  </div>
                )}
              </div>

              <Button
                onClick={handleSendMessage}
                size="lg"
                className="w-14 h-14 bg-blue-600 text-white rounded-full hover:bg-blue-700"
                disabled={!inputMessage.trim() || sendMessageMutation.isPending}
                data-testid="button-send"
              >
                <Send className="w-5 h-5" />
              </Button>
            </div>

            {/* 마이크 버튼과 자동 전송 체크박스 */}
            <div className="flex justify-center items-center space-x-4">
              <Button
                onClick={handleVoiceInput}
                size="lg"
                className={`w-16 h-16 text-white rounded-full transition-colors ${
                  speech.isListening 
                    ? 'bg-red-600 hover:bg-red-700 animate-pulse' 
                    : 'bg-gray-600 hover:bg-gray-700'
                }`}
                disabled={sendMessageMutation.isPending}
                data-testid="button-voice-input"
              >
                {speech.isListening ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
              </Button>

              {/* 자동 전송 체크박스 */}
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="autoSend"
                  checked={speech.autoSend}
                  onChange={(e) => speech.setAutoSend(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                  data-testid="checkbox-auto-send"
                />
                <label htmlFor="autoSend" className="text-sm text-gray-600">
                  2.2초 후 자동 전송
                </label>
              </div>
            </div>

          </div>
        </div>

        <div className="bg-gray-100 p-4 text-center">
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleEndExperience();
            }}
            className="bg-red-600 text-white px-8 py-3 hover:bg-red-700 cursor-pointer rounded-md flex items-center mx-auto"
            disabled={deleteSessionMutation.isPending}
            data-testid="button-end"
          >
            <LogOut className="mr-2 w-4 h-4" />
            체험 종료하기 {deleteSessionMutation.isPending ? '(처리중...)' : ''}
          </button>
        </div>

        {/* TTS Settings Dialog */}
        {showTTSSettings && (
          <div 
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-80"
            onClick={() => setShowTTSSettings(false)}
          >
            <div 
              className="bg-white p-8 rounded-lg shadow-xl max-w-2xl w-full mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-center text-2xl font-bold text-gray-800 mb-6">
                TTS 설정
              </h2>

              {/* TTS Model Selection */}
              <div className="mb-8">
                <h3 className="text-lg font-semibold text-gray-700 mb-3">모델 선택</h3>
                <div className="space-y-3">
                  {TTS_MODELS.map((model) => (
                    <button
                      key={model.value}
                      onClick={() => handleTTSModelChange(model.value)}
                      className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                        selectedTTSModel === model.value
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                      }`}
                      data-testid={`button-tts-model-${model.value}`}
                    >
                      <div className="font-semibold text-gray-800">{model.label}</div>
                      {selectedTTSModel === model.value && (
                        <div className="mt-2 text-blue-600 text-sm font-medium">✓ 선택됨</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* TTS Speed Control */}
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-gray-700 mb-3">속도 조절</h3>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={ttsSpeed}
                    onChange={(e) => handleTTSSpeedChange(parseFloat(e.target.value))}
                    className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    data-testid="slider-tts-speed"
                  />
                  <span className="text-lg font-semibold text-gray-800 min-w-[60px] text-right" data-testid="text-tts-speed">
                    {ttsSpeed.toFixed(1)}x
                  </span>
                </div>
                <div className="flex justify-between text-sm text-gray-500 mt-2">
                  <span>느림 (0.5x)</span>
                  <span>빠름 (2.0x)</span>
                </div>
              </div>

              <div className="flex justify-center">
                <button
                  onClick={handleCloseSettings}
                  className="px-8 py-3 text-white bg-blue-600 rounded-lg hover:bg-blue-700 text-lg font-medium transition-colors"
                  data-testid="button-close-tts-settings"
                >
                  저장
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Confirmation Modal */}
        {showEndDialog && (
          <div 
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-80"
            style={{ 
              position: 'fixed', 
              top: 0, 
              left: 0, 
              right: 0, 
              bottom: 0, 
              backgroundColor: 'rgba(0,0,0,0.8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            onClick={handleCancelEnd}
          >
            <div 
              className="bg-white p-8 rounded-lg shadow-xl max-w-md w-full mx-4"
              style={{ 
                backgroundColor: 'white', 
                padding: '32px', 
                borderRadius: '12px',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-center text-2xl font-bold text-gray-800 mb-6">
                체험 종료
              </h2>
              <p className="text-center text-gray-600 mb-8 text-lg leading-relaxed">
                체험을 종료하시겠습니까?<br />
                모든 데이터가 삭제됩니다.
              </p>
              <div className="flex gap-4 justify-center">
                <button
                  onClick={handleCancelEnd}
                  className="px-8 py-3 text-gray-600 bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 text-lg font-medium transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleConfirmEnd}
                  className="px-8 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 text-lg font-medium transition-colors"
                  disabled={deleteSessionMutation.isPending}
                >
                  {deleteSessionMutation.isPending ? '종료 중...' : '확인'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // This fallback return should never be reached due to step-based rendering
  return null;
}
