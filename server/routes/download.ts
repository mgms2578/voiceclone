import type { Express } from "express";
import { storage } from "../storage";
import { insertMessageSchema } from "@shared/schema";
import { getEducationalResponse } from "../services/gemini";
import { HttpTtsService } from "../services/tts";

const httpTtsService = new HttpTtsService();

export function registerDownloadRoutes(app: Express) {
  
  // Create welcome message with cloned voice (HTTP TTS)
  app.post("/api/download/sessions/:id/welcome", async (req, res) => {
    await storage.updateLastActive(req.params.id);
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }

      if (!session.clonedVoiceId) {
        return res.status(400).json({ error: "음성 클로닝이 완료되지 않았습니다." });
      }

      const welcomeText = "안녕하세요! 음성 클로닝이 성공적으로 완료되었습니다. 이제 당신의 복제된 목소리를 사용해서 대화할 수 있어요. 딥페이크 기술에 대해 어떤 것이 궁금하신가요?";
      
      // Create welcome message
      const welcomeMessage = await storage.createMessage({
        sessionId,
        content: welcomeText,
        role: "assistant"
      });

      // Generate speech with HTTP TTS
      let audioUrl = null;
      if (session.clonedVoiceId) {
        audioUrl = await httpTtsService.synthesize(welcomeText, session.clonedVoiceId);
      }

      res.json({ 
        message: {
          ...welcomeMessage,
          audioUrl
        }, 
        audioUrl 
      });
    } catch (error) {
      console.error('Welcome message error:', error);
      res.status(500).json({ error: "환영 메시지 생성에 실패했습니다." });
    }
  });

  // Send message and get AI response with HTTP TTS
  app.post("/api/download/sessions/:id/messages", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const messageData = insertMessageSchema.parse({
        ...req.body,
        sessionId
      });

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }

      // Save user message
      const userMessage = await storage.createMessage(messageData);

      // Get conversation history
      const messages = await storage.getMessagesBySession(sessionId);
      const conversationHistory = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      // Get AI response from Gemini
      const aiResponse = await getEducationalResponse(messageData.content, conversationHistory);

      // Check if session still exists before saving AI message
      const sessionCheck = await storage.getSession(sessionId);
      if (!sessionCheck) {
        console.log(`세션 ${sessionId}이 AI 응답 처리 중에 삭제되어 메시지 저장을 중단합니다.`);
        return res.status(404).json({ error: "세션이 삭제되었습니다." });
      }

      // Save AI message
      const aiMessage = await storage.createMessage({
        sessionId,
        content: aiResponse,
        role: "assistant"
      });

      // Generate speech for AI response with HTTP TTS
      let audioUrl = null;
      if (sessionCheck.clonedVoiceId) {
        audioUrl = await httpTtsService.synthesize(aiResponse, sessionCheck.clonedVoiceId);
        if (audioUrl) {
          // Update message with audio URL
          aiMessage.audioUrl = audioUrl;
        }
      }

      res.json({
        userMessage,
        aiMessage: {
          ...aiMessage,
          audioUrl
        }
      });
    } catch (error) {
      console.error('Message handling error:', error);
      res.status(500).json({ error: "메시지 처리에 실패했습니다." });
    }
  });
}