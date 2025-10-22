import { Router } from 'express';

const router = Router();

// 🎯 실시간 스트리밍 TTS 테스트 페이지
router.get('/streaming-test', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎵 실시간 스트리밍 TTS 테스트</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
        }
        .container {
            background: rgba(255,255,255,0.1);
            padding: 30px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }
        h1 {
            text-align: center;
            margin-bottom: 30px;
        }
        .test-section {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            margin: 20px 0;
            border-radius: 10px;
        }
        textarea {
            width: 100%;
            height: 80px;
            padding: 10px;
            border-radius: 5px;
            border: none;
            resize: vertical;
            box-sizing: border-box;
        }
        button {
            background: #4CAF50;
            color: white;
            padding: 12px 20px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            margin: 5px;
            font-size: 16px;
        }
        button:hover {
            background: #45a049;
        }
        button:disabled {
            background: #cccccc;
            cursor: not-allowed;
        }
        .status {
            padding: 10px;
            border-radius: 5px;
            margin: 10px 0;
            font-weight: bold;
        }
        .status.success { background: rgba(76, 175, 80, 0.3); }
        .status.error { background: rgba(244, 67, 54, 0.3); }
        .status.info { background: rgba(33, 150, 243, 0.3); }
        .log {
            background: rgba(0,0,0,0.3);
            padding: 15px;
            border-radius: 5px;
            max-height: 300px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎵 실시간 스트리밍 TTS 테스트 <small style="font-size: 14px; color: #ddd;">(v2025-10-14 14:10:00 speech-02-turbo)</small></h1>
        
        <div class="test-section">
            <h3>연결 상태</h3>
            <div id="connectionStatus" class="status info">연결 대기 중...</div>
            <button id="connectBtn" onclick="connectWebSocket()">WebSocket 연결</button>
            <button id="disconnectBtn" onclick="disconnectWebSocket()" disabled>연결 끊기</button>
        </div>

        <div class="test-section">
            <h3>🚄 실시간 스트리밍 TTS (안정판 Turbo) <span style="font-size: 12px; color: #90EE90;">✓ 수정됨 2025-10-14 14:10:00</span></h3>
            <p>⚡ speech-02-turbo (안정판) | 타이밍 측정 | 저지연 최적화<br>
               <strong>프로덕션 안정판 Turbo 모델 테스트!</strong></p>
            <audio id="audioPlayer" style="width: 100%; margin: 10px 0;"></audio>
            <textarea id="textInput" placeholder="음성으로 변환할 텍스트를 입력하세요...">안녕하세요! 이것은 실시간 스트리밍 TTS 테스트입니다. 이제 음성이 생성되자마자 바로바로 재생됩니다. 지연시간이 획기적으로 단축되었습니다!</textarea>
            <br>
            <button id="speakBtn" onclick="testStreamingTTS()" disabled>🎵 실시간 음성 재생</button>
            <button id="stopBtn" onclick="stopAudio()" disabled>⏹️ 정지</button>
        </div>

        <div class="test-section">
            <h3>📊 실시간 로그</h3>
            <div id="logArea" class="log"></div>
            <button onclick="clearLog()">로그 지우기</button>
        </div>
    </div>

    <script>
        let ws = null;
        let chunkCount = 0;
        
        // MSE 관련 변수
        let mediaSource = null;
        let sourceBuffer = null;
        let audioElement = null;
        let pendingChunks = [];
        let isAppending = false;
        
        // 최적화 설정 (32kHz, 128kbps MP3 기준)
        const CHUNK_THRESHOLD = 2; // 2개 청크 = 256ms
        const INITIAL_BUFFER_MS = 200; // 초기 지터 버퍼: 200ms (속도 우선)
        const UNDERRUN_BUFFER_MS = 350; // underrun 시 확장: 350ms
        const MAX_APPEND_SIZE = 15360; // 15KB ≈ 300ms 최대 append 크기
        let hasStartedPlayback = false;
        let underrunDetected = false;
        let firstChunkTime = null;

        function log(message) {
            const timestamp = new Date().toLocaleTimeString();
            const logArea = document.getElementById('logArea');
            logArea.textContent += \`[\${timestamp}] \${message}\\n\`;
            logArea.scrollTop = logArea.scrollHeight;
            console.log(\`[\${timestamp}] \${message}\`);
        }

        function clearLog() {
            document.getElementById('logArea').textContent = '';
        }

        function updateConnectionStatus(status, type = 'info') {
            const statusDiv = document.getElementById('connectionStatus');
            statusDiv.textContent = status;
            statusDiv.className = \`status \${type}\`;
        }

        function connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = \`\${protocol}//\${window.location.host}/ws/tts\`;
            
            log(\`WebSocket 연결 시도: \${wsUrl}\`);
            
            ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';
            
            ws.onopen = () => {
                log('✅ WebSocket 연결 성공!');
                updateConnectionStatus('연결됨', 'success');
                document.getElementById('connectBtn').disabled = true;
                document.getElementById('disconnectBtn').disabled = false;
                document.getElementById('speakBtn').disabled = false;
                
                // 초기화 메시지 전송
                const initMessage = {
                    type: 'init',
                    sessionId: 'test-streaming-' + Date.now()
                };
                ws.send(JSON.stringify(initMessage));
                log('📤 초기화 메시지 전송: ' + JSON.stringify(initMessage));
            };

            ws.onmessage = async (event) => {
                // MP3 청크 수신
                if (event.data instanceof ArrayBuffer) {
                    chunkCount++;
                    const now = Date.now();
                    
                    // 첫 청크 수신 시간 기록
                    if (!firstChunkTime) {
                        firstChunkTime = now;
                        const elapsed = (performance.now() - window.ttsRequestStartTime).toFixed(0);
                        log(\`🎵 첫 청크 수신 [T=\${elapsed}ms]: \${event.data.byteLength} bytes (지터 버퍼 시작)\`);
                    } else {
                        const elapsed = (performance.now() - window.ttsRequestStartTime).toFixed(0);
                        log(\`🎵 청크 \${chunkCount} 수신 [T=\${elapsed}ms]: \${event.data.byteLength} bytes\`);
                    }
                    
                    // MP3 프레임 경계 검증 (경고만, 청크는 계속 사용)
                    const chunk = new Uint8Array(event.data);
                    // MiniMax는 프레임 경계로 청크를 보내지 않으므로 검증만 수행
                    
                    pendingChunks.push(chunk);
                    
                    // 초기 지터 버퍼: 280ms 대기
                    const elapsed = now - firstChunkTime;
                    const bufferThreshold = underrunDetected ? UNDERRUN_BUFFER_MS : INITIAL_BUFFER_MS;
                    
                    if (!hasStartedPlayback && elapsed < bufferThreshold) {
                        log(\`⏳ 지터 버퍼링 중... (\${elapsed}ms / \${bufferThreshold}ms)\`);
                        return;
                    }
                    
                    // 임계점 도달하거나 이미 재생 중이면 바로 추가
                    const shouldAppend = hasStartedPlayback 
                        ? pendingChunks.length >= 1  // 재생 시작 후엔 1개씩
                        : pendingChunks.length >= CHUNK_THRESHOLD; // 처음엔 2개
                    
                    if (shouldAppend && sourceBuffer && !sourceBuffer.updating) {
                        appendPendingChunks();
                    }
                    
                    return;
                }

                // JSON 메시지 처리
                if (typeof event.data === 'string') {
                    let message;
                    try {
                        message = JSON.parse(event.data);
                    } catch (e) {
                        log(\`⚠️ JSON 파싱 실패: \${event.data}\`);
                        return;
                    }

                    log(\`📨 JSON 메시지: \${message.type}\`);
                    
                    if (message.type === 'ready') {
                        log(\`🎯 TTS 준비 완료! Voice ID: \${message.voiceId}\`);
                    } else if (message.type === 'task_complete') {
                        log('🏁 스트리밍 완료! 남은 청크 처리 중...');
                        // 남은 청크 강제로 모두 추가 (임계값 무시)
                        if (pendingChunks.length > 0) {
                            setTimeout(() => {
                                if (sourceBuffer && !sourceBuffer.updating) {
                                    appendPendingChunks();
                                }
                            }, 50);
                        }
                    } else if (message.type === 'error') {
                        log(\`❌ 오류: \${message.message}\`);
                    }
                }
            };

            ws.onerror = (error) => {
                log(\`❌ WebSocket 오류: \${error}\`);
                updateConnectionStatus('연결 오류', 'error');
            };

            ws.onclose = (event) => {
                log(\`🔌 WebSocket 종료: \${event.code} \${event.reason}\`);
                updateConnectionStatus('연결 끊김', 'error');
                document.getElementById('connectBtn').disabled = false;
                document.getElementById('disconnectBtn').disabled = true;
                document.getElementById('speakBtn').disabled = true;
            };
        }

        function disconnectWebSocket() {
            if (ws) {
                ws.close();
                ws = null;
            }
        }

        function initMediaSource() {
            audioElement = document.getElementById('audioPlayer');
            
            // MSE 지원 확인
            if (!window.MediaSource) {
                log('❌ MediaSource API를 지원하지 않는 브라우저입니다!');
                return false;
            }
            
            mediaSource = new MediaSource();
            audioElement.src = URL.createObjectURL(mediaSource);
            
            mediaSource.addEventListener('sourceopen', () => {
                log('✅ MediaSource 열림');
                
                try {
                    // MP3 코덱으로 SourceBuffer 생성
                    sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
                    
                    sourceBuffer.addEventListener('updateend', () => {
                        isAppending = false;
                        
                        // 재생 시작 (처음만)
                        if (audioElement.paused && sourceBuffer.buffered.length > 0) {
                            audioElement.play().then(() => {
                                hasStartedPlayback = true;
                                const latency = Date.now() - firstChunkTime;
                                const totalElapsed = (performance.now() - window.ttsRequestStartTime).toFixed(0);
                                log(\`🔊 MSE 재생 시작! [T=\${totalElapsed}ms] (지터버퍼: \${latency}ms)\`);
                                document.getElementById('stopBtn').disabled = false;
                                
                                // underrun 감지 시작
                                monitorUnderrun();
                            }).catch(err => {
                                log(\`❌ 재생 실패: \${err.message}\`);
                            });
                        }
                        
                        // 남은 청크 계속 추가
                        if (pendingChunks.length > 0) {
                            appendPendingChunks();
                        }
                    });
                    
                    sourceBuffer.addEventListener('error', (e) => {
                        log(\`❌ SourceBuffer 오류: \${e}\`);
                    });
                    
                    log('✅ SourceBuffer 생성 완료 (audio/mpeg)');
                } catch (e) {
                    log(\`❌ SourceBuffer 생성 실패: \${e.message}\`);
                }
            });
            
            mediaSource.addEventListener('sourceclose', () => {
                log('🔌 MediaSource 닫힘');
            });
            
            return true;
        }
        
        function isValidMP3Frame(chunk) {
            // MP3 프레임 헤더 검증 (0xFF, 0xE0-0xFF로 시작)
            if (chunk.length < 2) return false;
            return chunk[0] === 0xFF && (chunk[1] & 0xE0) === 0xE0;
        }
        
        function monitorUnderrun() {
            if (!audioElement || !sourceBuffer) return;
            
            setInterval(() => {
                if (!audioElement.paused && sourceBuffer.buffered.length > 0) {
                    const currentTime = audioElement.currentTime;
                    const bufferedEnd = sourceBuffer.buffered.end(0);
                    const bufferRemaining = bufferedEnd - currentTime;
                    
                    // 버퍼가 100ms 이하로 떨어지면 underrun
                    if (bufferRemaining < 0.1 && !underrunDetected) {
                        underrunDetected = true;
                        log(\`⚠️ Underrun 감지! 버퍼 확장 (\${INITIAL_BUFFER_MS}ms → \${UNDERRUN_BUFFER_MS}ms)\`);
                    }
                }
            }, 100);
        }
        
        function appendPendingChunks() {
            if (!sourceBuffer || isAppending || pendingChunks.length === 0) return;
            if (sourceBuffer.updating) return;
            
            isAppending = true;
            
            // 최대 15KB(300ms)로 제한하여 append
            let totalLen = 0;
            const chunksToAppend = [];
            
            for (const chunk of pendingChunks) {
                if (totalLen + chunk.length > MAX_APPEND_SIZE) {
                    break; // 15KB 초과하면 중단
                }
                chunksToAppend.push(chunk);
                totalLen += chunk.length;
            }
            
            // 사용한 청크 제거
            pendingChunks = pendingChunks.slice(chunksToAppend.length);
            
            // 결합
            const combined = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunksToAppend) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            
            const segmentMs = (totalLen * 8 / 128000 * 1000).toFixed(0);
            log(\`📦 \${chunksToAppend.length}개 청크 → SourceBuffer 추가 (\${totalLen} bytes, ~\${segmentMs}ms) [남은: \${pendingChunks.length}개]\`);
            
            try {
                sourceBuffer.appendBuffer(combined);
            } catch (e) {
                log(\`❌ appendBuffer 실패: \${e.message}\`);
                isAppending = false;
            }
        }

        function testStreamingTTS() {
            const text = document.getElementById('textInput').value.trim();
            if (!text) {
                alert('텍스트를 입력하세요!');
                return;
            }

            if (!ws || ws.readyState !== WebSocket.OPEN) {
                alert('WebSocket이 연결되지 않았습니다!');
                return;
            }

            const requestStartTime = performance.now();
            window.ttsRequestStartTime = requestStartTime;
            log(\`\n🎯 TTS 요청 시작 [T=0ms]: "\${text.substring(0, 30)}..."\`);
            
            // MSE 초기화
            if (!initMediaSource()) {
                alert('MediaSource API를 지원하지 않는 브라우저입니다!');
                return;
            }
            
            // 초기화
            pendingChunks = [];
            isAppending = false;
            chunkCount = 0;
            hasStartedPlayback = false;
            underrunDetected = false;
            firstChunkTime = null;
            
            const ttsMessage = {
                type: 'speak',
                text: text,
                voiceId: 'Korean_PowerfulGirl'
            };
            
            ws.send(JSON.stringify(ttsMessage));
            const elapsed = (performance.now() - requestStartTime).toFixed(0);
            log(\`📤 TTS 요청 전송 완료 [T=\${elapsed}ms]\`);
            
            document.getElementById('speakBtn').disabled = true;
            setTimeout(() => {
                document.getElementById('speakBtn').disabled = false;
            }, 2000);
        }

        function stopAudio() {
            if (audioElement) {
                audioElement.pause();
                audioElement.currentTime = 0;
            }
            pendingChunks = [];
            isAppending = false;
            document.getElementById('stopBtn').disabled = true;
            log('⏹️ 오디오 재생 중지');
        }

        // 페이지 로드 시 자동 연결
        window.onload = () => {
            log('🚀 페이지 로드 완료');
            setTimeout(() => {
                log('🔄 자동 WebSocket 연결 시도...');
                connectWebSocket();
            }, 1000);
        };
    </script>
</body>
</html>`;
  res.send(html);
});

router.get('/test-websocket-tts', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebSocket TTS 테스트</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            text-align: center;
        }
        .test-area {
            margin: 20px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 8px;
        }
        input, button {
            padding: 10px;
            margin: 5px;
            border: 1px solid #ddd;
            border-radius: 5px;
        }
        button {
            background: #007bff;
            color: white;
            cursor: pointer;
            border: none;
        }
        button:hover {
            background: #0056b3;
        }
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .status {
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            font-weight: bold;
        }
        .status.success { background: #d4edda; color: #155724; }
        .status.error { background: #f8d7da; color: #721c24; }
        .status.info { background: #d1ecf1; color: #0c5460; }
        .log {
            background: #f8f9fa;
            border: 1px solid #e9ecef;
            padding: 10px;
            border-radius: 5px;
            max-height: 200px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>WebSocket TTS 직접 테스트</h1>
        
        <div class="test-area">
            <h3>연결 상태</h3>
            <div id="connectionStatus" class="status info">연결 대기 중...</div>
            <button id="connectBtn" onclick="connectWebSocket()">WebSocket 연결</button>
            <button id="disconnectBtn" onclick="disconnectWebSocket()" disabled>연결 끊기</button>
        </div>

        <div class="test-area">
            <h3>TTS 테스트</h3>
            <input type="text" id="sessionId" placeholder="세션 ID" value="test-session-123" style="width: 200px;">
            <input type="text" id="voiceId" placeholder="Voice ID (옵션)" value="Korean_PowerfulGirl" style="width: 200px;">
            <br>
            <textarea id="textInput" placeholder="음성으로 변환할 텍스트를 입력하세요..." 
                     style="width: 100%; height: 80px; margin: 10px 0;">안녕하세요! 이것은 WebSocket TTS 테스트입니다.</textarea>
            <br>
            <button id="speakBtn" onclick="testTTS()" disabled>음성 재생</button>
            <button id="stopBtn" onclick="stopAudio()" disabled>정지</button>
        </div>

        <div class="test-area">
            <h3>오디오 상태</h3>
            <div id="audioStatus" class="status info">대기 중...</div>
            <div>수신된 청크: <span id="chunkCount">0</span></div>
            <div>재생 시간: <span id="playTime">0초</span></div>
        </div>

        <div class="test-area">
            <h3>실시간 로그</h3>
            <div id="logContainer" class="log"></div>
            <button onclick="clearLog()">로그 지우기</button>
        </div>
    </div>

    <script>
        let ws = null;
        let audioContext = null;
        let currentAudioSource = null;
        let audioChunks = [];
        let chunkCount = 0;
        let startTime = 0;

        function log(message) {
            const timestamp = new Date().toLocaleTimeString();
            const logDiv = document.getElementById('logContainer');
            logDiv.innerHTML += \`[\${timestamp}] \${message}\\n\`;
            logDiv.scrollTop = logDiv.scrollHeight;
            console.log(message);
        }

        function updateStatus(elementId, message, type = 'info') {
            const element = document.getElementById(elementId);
            element.textContent = message;
            element.className = \`status \${type}\`;
        }

        function clearLog() {
            document.getElementById('logContainer').innerHTML = '';
        }

        async function connectWebSocket() {
            try {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${protocol}//\${window.location.host}/ws/tts\`;
                
                log(\`WebSocket 연결 시도: \${wsUrl}\`);
                updateStatus('connectionStatus', '연결 중...', 'info');
                
                ws = new WebSocket(wsUrl);
                ws.binaryType = 'arraybuffer'; // LLM 조언: 바이너리 수신 설정
                
                ws.onopen = function() {
                    log('WebSocket 연결 성공!');
                    updateStatus('connectionStatus', '연결됨', 'success');
                    document.getElementById('connectBtn').disabled = true;
                    document.getElementById('disconnectBtn').disabled = false;
                    document.getElementById('speakBtn').disabled = false;
                };
                
                ws.onmessage = async function(event) {
                    // 🚫 절대 여기 바깥에서 JSON.parse 하지 말 것!
                    
                    // --- 바이너리(Blob/ArrayBuffer) 먼저 처리하고 즉시 return ---
                    if (event.data instanceof ArrayBuffer) {
                        const audioData = new Uint8Array(event.data);
                        audioChunks.push(audioData);
                        log(\`✓ ArrayBuffer 청크 수집: \${audioChunks.length}개 (\${audioData.length} bytes)\`);
                        return;
                    }
                    if (event.data instanceof Blob) {
                        const ab = await event.data.arrayBuffer();
                        const audioData = new Uint8Array(ab);
                        audioChunks.push(audioData);
                        log(\`✓ Blob→ArrayBuffer 청크 수집: \${audioChunks.length}개 (\${audioData.length} bytes)\`);
                        return;
                    }

                    // --- 여기까지 왔다면 '문자열' 프레임 ---
                    if (typeof event.data === 'string') {
                        let data;
                        try {
                            data = JSON.parse(event.data);
                        } catch {
                            log(\`문자열이지만 JSON이 아님: \${event.data.slice(0, 50)}\`);
                            return;
                        }
                        
                        log(\`메시지 수신: \${data.type}\`);
                        
                        if (data.type === 'ready') {
                            log(\`연결 초기화 완료, voiceId: \${data.voiceId}\`);
                            isInitialized = true;
                            
                            // 대기 중인 텍스트가 있다면 synthesize 요청 전송
                            if (window.pendingText) {
                                sendSynthesizeRequest(window.pendingText);
                                window.pendingText = null;
                            }
                        } else if (data.type === 'task_complete' || data.type === 'audio_complete') {
                            log('오디오 스트림 완료');
                            playAllChunks();
                        } else if (data.type === 'error') {
                            log(\`오류: \${data.message}\`);
                            updateStatus('audioStatus', \`오류: \${data.message}\`, 'error');
                            isInitialized = false;
                        }
                        return;
                    }

                    // 다른 타입은 무시
                    log(\`알 수 없는 데이터 타입: \${typeof event.data}\`);
                };
                
                ws.onclose = function(event) {
                    log(\`WebSocket 연결 종료: \${event.code} \${event.reason}\`);
                    updateStatus('connectionStatus', '연결 끊김', 'error');
                    document.getElementById('connectBtn').disabled = false;
                    document.getElementById('disconnectBtn').disabled = true;
                    document.getElementById('speakBtn').disabled = true;
                    isInitialized = false;
                    window.pendingText = null;
                };
                
                ws.onerror = function(error) {
                    log(\`WebSocket 오류: \${error}\`);
                    updateStatus('connectionStatus', 'WebSocket 오류', 'error');
                };
                
            } catch (error) {
                log(\`연결 실패: \${error.message}\`);
                updateStatus('connectionStatus', \`연결 실패: \${error.message}\`, 'error');
            }
        }

        function disconnectWebSocket() {
            if (ws) {
                ws.close();
                ws = null;
            }
        }

        async function initAudioContext() {
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                log('AudioContext 초기화됨');
            }
            
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
                log('AudioContext 재개됨');
            }
        }

        function handleAudioChunk(base64Audio) {
            try {
                chunkCount++;
                document.getElementById('chunkCount').textContent = chunkCount;
                
                // Base64 디코딩
                const binaryString = atob(base64Audio);
                const audioData = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    audioData[i] = binaryString.charCodeAt(i);
                }
                
                // MiniMax 패딩 데이터 필터링
                if (/^[5a]+$/i.test(base64Audio.slice(0, 20))) {
                    log(\`패딩 데이터 무시: \${base64Audio.slice(0, 20)}\`);
                    return;
                }
                
                // MP3 헤더 확인
                if (audioData.length >= 2 && audioData[0] === 0xFF && (audioData[1] & 0xE0) === 0xE0) {
                    audioChunks.push(audioData);
                    log(\`유효한 MP3 청크 저장 (\${audioData.length} bytes)\`);
                } else {
                    const audioHex = Array.from(audioData.slice(0, 10))
                        .map(b => b.toString(16).padStart(2, '0')).join('');
                    log(\`잘못된 MP3 헤더 무시: \${audioHex}\`);
                }
                
            } catch (error) {
                log(\`오디오 청크 처리 오류: \${error.message}\`);
            }
        }

        async function playAllChunks() {
            try {
                if (audioChunks.length === 0) {
                    log('재생할 오디오 청크가 없음');
                    return;
                }
                
                await initAudioContext();
                
                // 모든 청크를 하나의 배열로 합치기
                const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const combinedArray = new Uint8Array(totalLength);
                let offset = 0;
                
                for (const chunk of audioChunks) {
                    combinedArray.set(chunk, offset);
                    offset += chunk.length;
                }
                
                log(\`통합된 오디오 데이터 크기: \${totalLength} bytes\`);
                
                // MP3 디코딩 및 재생
                const audioBuffer = await audioContext.decodeAudioData(combinedArray.buffer);
                const source = audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioContext.destination);
                
                currentAudioSource = source;
                startTime = Date.now();
                
                source.onended = function() {
                    log('오디오 재생 완료');
                    updateStatus('audioStatus', '재생 완료', 'success');
                    document.getElementById('stopBtn').disabled = true;
                    currentAudioSource = null;
                };
                
                source.start(0);
                updateStatus('audioStatus', '재생 중...', 'info');
                document.getElementById('stopBtn').disabled = false;
                
                // 재생 시간 추적
                const updateTime = () => {
                    if (currentAudioSource) {
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        document.getElementById('playTime').textContent = \`\${elapsed}초\`;
                        setTimeout(updateTime, 100);
                    }
                };
                updateTime();
                
            } catch (error) {
                log(\`오디오 재생 오류: \${error.message}\`);
                updateStatus('audioStatus', \`재생 실패: \${error.message}\`, 'error');
            }
        }

        function stopAudio() {
            if (currentAudioSource) {
                currentAudioSource.stop();
                currentAudioSource = null;
                log('오디오 재생 중단');
                updateStatus('audioStatus', '중단됨', 'info');
                document.getElementById('stopBtn').disabled = true;
            }
        }

        let isInitialized = false;

        function testTTS() {
            const sessionId = document.getElementById('sessionId').value;
            const voiceId = document.getElementById('voiceId').value;
            const text = document.getElementById('textInput').value;
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                log('WebSocket이 연결되지 않음');
                return;
            }
            
            if (!text.trim()) {
                log('텍스트를 입력하세요');
                return;
            }
            
            // 초기화
            audioChunks = [];
            chunkCount = 0;
            document.getElementById('chunkCount').textContent = '0';
            document.getElementById('playTime').textContent = '0초';
            updateStatus('audioStatus', 'TTS 요청 중...', 'info');
            
            if (!isInitialized) {
                // 먼저 init 메시지 전송
                log(\`연결 초기화 중... sessionId: \${sessionId}\`);
                const initMessage = {
                    type: 'init',
                    sessionId: sessionId
                };
                ws.send(JSON.stringify(initMessage));
                
                // init 완료 후 synthesize 요청을 위해 텍스트 저장
                window.pendingText = text;
            } else {
                // 이미 초기화된 경우 바로 synthesize 전송
                sendSynthesizeRequest(text);
            }
        }

        function sendSynthesizeRequest(text) {
            const message = {
                type: 'synthesize',
                text: text
            };
            
            log(\`TTS 요청 전송: "\${text}"\`);
            ws.send(JSON.stringify(message));
        }

        // 페이지 로드 시 자동 연결
        window.onload = function() {
            log('페이지 로드 완료');
        };
    </script>
</body>
</html>
  `;
  
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

export { router as testWebSocketRouter };