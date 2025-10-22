import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || "" 
});

export async function getEducationalResponse(userMessage: string, conversationHistory: Array<{role: string, content: string}>): Promise<string> {
  try {
    const systemPrompt = `당신은 친근한 대화 상대이면서, 딥페이크와 AI 음성 클로닝의 위험성을 자연스럽게 교육하는 안내자입니다.

**대화 원칙:**
- 사용자의 질문에 먼저 자연스럽고 친근하게 답변하세요
- 억지로 모든 질문을 딥페이크로 연결하지 마세요  
- 적절한 타이밍에만 딥페이크 관련 교육을 자연스럽게 연결하세요
- 일반적인 질문(날씨, 동물, 일상 등)은 그냥 일반적으로 답변해도 됩니다

**딥페이크 교육 시기:**
- 전화, 음성, 영상, 사기, 보안 관련 질문일 때
- 사용자가 딥페이크에 대해 궁금해할 때
- 자연스러운 대화 흐름에서 교육이 필요한 순간

**답변 규칙:**
- 200자 이내로 자연스럽게 작성
- 완전한 문장으로 끝내기 (예: ~세요, ~니다, ~어요)
- 억지스럽거나 어색한 연결은 피하기
- 친근하고 자연스러운 톤 유지

좋은 예: "까마귀는 '까악까악' 하고 울어요! 새소리는 참 다양하죠."
나쁜 예: "까마귀 울음소리를 흉내낸 딥페이크 음성도 나올 수 있어요..." (억지스러운 연결)`;  

    // Build conversation context
    const conversationContext = conversationHistory
      .map(msg => `${msg.role === 'user' ? '사용자' : '안내자'}: ${msg.content}`)
      .join('\n');

    const fullPrompt = `${systemPrompt}\n\n대화 기록:\n${conversationContext}\n\n사용자의 새 메시지: ${userMessage}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: fullPrompt,
    });

    let responseText = response.text || "죄송합니다. 응답을 생성할 수 없습니다.";
    
    // Remove any "AI:" prefix that Gemini might add despite system prompt
    responseText = responseText.replace(/^AI:\s*/gi, '');
    responseText = responseText.replace(/^안내자:\s*/gi, '');
    responseText = responseText.replace(/^Assistant:\s*/gi, '');
    responseText = responseText.replace(/^Bot:\s*/gi, '');
    
    // Remove role prefixes at the beginning of response
    responseText = responseText.replace(/^[^:]+:\s*/, '');
    
    return responseText;
  } catch (error) {
    console.error('Gemini API 오류:', error);
    throw new Error('AI 응답 생성에 실패했습니다.');
  }
}
