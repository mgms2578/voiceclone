// 동시성 제어 제거 - 키오스크에서는 단순한 순차 처리로 충분

// 심플한 재시도 로직 (3번 시도, 1초 대기)
async function simpleRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 2
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (attempt === maxRetries) {
        throw error;
      }
      console.log(`재시도 ${attempt + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Max retries exceeded');
}

// Create session-based voice ID
function generateSessionBasedVoiceId(sessionId: string): string {
  const randomChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomSuffix = '';
  for (let i = 0; i < 6; i++) {
    randomSuffix += randomChars.charAt(Math.floor(Math.random() * randomChars.length));
  }
  
  // Use first 8 chars of session ID + random suffix
  const sessionPrefix = sessionId.replace(/-/g, '').substring(0, 8);
  return `voicedeepfake-${sessionPrefix}-${randomSuffix}`;
}

interface MinimaxResponse {
  success: boolean;
  voiceId?: string;
  displayName?: string;
  error?: string;
}

interface CloneVoiceOptions {
  audioBuffer: Buffer;
  sessionId: string;
}

export async function cloneVoice({ audioBuffer, sessionId }: CloneVoiceOptions): Promise<MinimaxResponse> {
  // semaphore 제거 - 단순한 순차 처리
  
  try {
    return await simpleRetry(async () => {
      const apiKey = process.env.MINIMAX_API_KEY;
      const groupId = process.env.MINIMAX_GROUP_ID;
      
      if (!apiKey) {
        throw new Error('MiniMax API 키가 설정되지 않았습니다.');
      }
      
      if (!groupId) {
        throw new Error('MiniMax Group ID가 설정되지 않았습니다.');
      }

      // Step 1: Upload audio file to get file_id
      const uploadFormData = new FormData();
      const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
      uploadFormData.append('file', audioBlob, 'audio.wav');
      uploadFormData.append('purpose', 'voice_clone');

      const uploadResponse = await fetch(`https://api.minimax.io/v1/files/upload?GroupId=${groupId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        body: uploadFormData,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error('Upload response:', errorText);
        const error: any = new Error(`파일 업로드 실패: ${uploadResponse.status}`);
        error.status = uploadResponse.status;
        throw error;
      }

      const uploadData = await uploadResponse.json();
      console.log('MiniMax upload response:', JSON.stringify(uploadData, null, 2));
      
      const fileId = uploadData.file?.file_id;
      
      if (!fileId) {
        console.error('Upload data structure:', uploadData);
        throw new Error('파일 업로드에서 file_id를 받지 못했습니다.');
      }

      // Step 2: Clone voice using session-based voice ID
      const voiceId = generateSessionBasedVoiceId(sessionId);
      const cloneResponse = await fetch(`https://api.minimax.io/v1/voice_clone?GroupId=${groupId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_id: fileId,
          voice_id: voiceId,
          noise_reduction: true,
          need_volume_normalization: true,
          text: "안녕하세요. 음성 클로닝 테스트입니다.",
          model: "speech-2.5-hd-preview",
          accuracy: 0.8
        }),
      });

      if (!cloneResponse.ok) {
        const errorText = await cloneResponse.text();
        console.error('Clone response:', errorText);
        const error: any = new Error(`음성 클로닝 실패: ${cloneResponse.status}`);
        error.status = cloneResponse.status;
        throw error;
      }

      const cloneData = await cloneResponse.json();
      console.log('MiniMax clone response:', cloneData);
      
      if (cloneData.base_resp?.status_code !== 0) {
        throw new Error(`음성 클로닝 오류: ${cloneData.base_resp?.status_msg || '알 수 없는 오류'}`);
      }
      
      // Use the returned voice_id or fallback to our generated one
      const actualVoiceId = cloneData.voice_id || cloneData.data?.voice_id || voiceId;
      
      return {
        success: true,
        voiceId: actualVoiceId,
      };
    });
  } catch (error) {
    console.error('음성 클로닝 오류:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.',
    };
  }
}

export async function deleteVoiceClone(voiceId: string): Promise<boolean> {
  try {
    return await simpleRetry(async () => {
      const apiKey = process.env.MINIMAX_API_KEY;
      const groupId = process.env.MINIMAX_GROUP_ID;
      
      if (!apiKey) {
        console.error('MiniMax API 키가 설정되지 않았습니다.');
        return false;
      }
      
      if (!groupId) {
        console.error('MiniMax Group ID가 설정되지 않았습니다.');
        return false;
      }
      
      const deleteResponse = await fetch(`https://api.minimax.io/v1/delete_voice`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          voice_type: "voice_cloning",
          voice_id: voiceId
        }),
      });

      if (!deleteResponse.ok) {
        const errorText = await deleteResponse.text();
        console.error(`클론 삭제 실패: ${deleteResponse.status} ${errorText}`);
        const error: any = new Error(`클론 삭제 실패: ${deleteResponse.status}`);
        error.status = deleteResponse.status;
        throw error;
      }

      const deleteData = await deleteResponse.json();
      console.log('MiniMax 클론 삭제 성공:', deleteData);
      return true;
    });
  } catch (error) {
    console.error('클론 삭제 오류:', error);
    return false;
  }
}

export async function getVoiceList(): Promise<any> {
  try {
    return await simpleRetry(async () => {
      const apiKey = process.env.MINIMAX_API_KEY;
      const groupId = process.env.MINIMAX_GROUP_ID;
      
      if (!apiKey) {
        throw new Error('MiniMax API 키가 설정되지 않았습니다.');
      }
      
      if (!groupId) {
        throw new Error('MiniMax Group ID가 설정되지 않았습니다.');
      }

      // Try get-voice endpoint first
      const getVoiceUrl = `https://api.minimax.io/v1/get-voice?GroupId=${groupId}`;
      console.log('Trying get-voice API with type: all, URL:', getVoiceUrl);
      
      try {
        const getVoiceResponse = await fetch(getVoiceUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            'voice_type': 'all'
          }),
        });

        console.log(`get-voice response status: ${getVoiceResponse.status}`);
        
        if (getVoiceResponse.ok) {
          const data = await getVoiceResponse.json();
          console.log('MiniMax get-voice response:', JSON.stringify(data, null, 2));
          
          if (data.base_resp && data.base_resp.status_code === 1004) {
            console.log('API authentication failed - valid MINIMAX_API_KEY required');
            return { voices: [], cloned_voices: [] };
          }
          
          return data;
        } else {
          const errorText = await getVoiceResponse.text();
          console.log(`get-voice API failed: ${getVoiceResponse.status} - ${errorText}`);
          const error: any = new Error(`get-voice API failed: ${getVoiceResponse.status}`);
          error.status = getVoiceResponse.status;
          throw error;
        }
      } catch (error: any) {
        console.log('get-voice API error:', error);
        
        // Fallback to query-voice-clone endpoint
        const queryUrl = `https://api.minimax.io/v1/query-voice-clone?GroupId=${groupId}`;
        console.log('Falling back to query-voice-clone API, URL:', queryUrl);
        
        const response = await fetch(queryUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('Voice list response:', errorText);
          const fallbackError: any = new Error(`MiniMax Voice List 오류: ${response.status}`);
          fallbackError.status = response.status;
          throw fallbackError;
        }

        const data = await response.json();
        console.log('MiniMax voice list response:', JSON.stringify(data, null, 2));
        
        return data;
      }
    });
  } catch (error) {
    console.error('음성 목록 조회 오류:', error);
    return { error: error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.' };
  }
}

export async function generateSpeech(text: string, voiceId: string, model: string = "speech-02-turbo"): Promise<string | null> {
  // semaphore 제거 - 단순한 순차 처리
  
  try {
    return await simpleRetry(async () => {
      const apiKey = process.env.MINIMAX_API_KEY;
      const groupId = process.env.MINIMAX_GROUP_ID;
      
      if (!apiKey) {
        throw new Error('MiniMax API 키가 설정되지 않았습니다.');
      }
      
      if (!groupId) {
        throw new Error('MiniMax Group ID가 설정되지 않았습니다.');
      }

      const response = await fetch(`https://api.minimax.io/v1/t2a_v2?GroupId=${groupId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          text: text,
          stream: false,
          voice_setting: {
            voice_id: voiceId,
            speed: 1.0,
            vol: 1,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: "mp3",
            channel: 2,
          },
          language_boost: "Korean",
          emotion: "auto"
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('TTS response:', errorText);
        const error: any = new Error(`MiniMax TTS 오류: ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const data = await response.json();
      console.log('TTS response:', JSON.stringify(data, null, 2));
      
      if (data.base_resp?.status_code !== 0) {
        throw new Error(`음성 생성 오류: ${data.base_resp?.status_msg || '알 수 없는 오류'}`);
      }

      if (data.data?.audio) {
        // Convert hex audio to base64
        const audioHex = data.data.audio;
        const audioBuffer = Buffer.from(audioHex, 'hex');
        const base64Audio = audioBuffer.toString('base64');
        return `data:audio/mp3;base64,${base64Audio}`;
      }
      
      return null;
    });
  } catch (error) {
    console.error('음성 생성 오류:', error);
    return null;
  }
}

// Export for backward compatibility (update cloneVoice usage in routes)
export async function cloneVoiceCompat(audioBuffer: Buffer): Promise<MinimaxResponse> {
  // This is a compatibility wrapper - routes should be updated to pass sessionId
  console.warn('cloneVoice called without sessionId - using random session ID');
  const randomSessionId = Math.random().toString(36).substring(2, 15);
  return cloneVoice({ audioBuffer, sessionId: randomSessionId });
}