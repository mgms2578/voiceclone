import type { Express } from "express";
import { storage } from "../storage";
import { insertMessageSchema } from "@shared/schema";
import { getEducationalResponse } from "../services/gemini";

export function registerWebSocketRoutes(app: Express) {
  // 세션 상태 확인 (WebSocket 연결 전 준비 상태 확인용)
  app.get("/api/websocket/sessions/:id", async (req, res) => {
    try {
      const { id: sessionId } = req.params;
      const session = await storage.getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }

      res.json({
        id: session.id,
        clonedVoiceId: session.clonedVoiceId,
        ready: !!session.clonedVoiceId,
      });
    } catch (error) {
      console.error("세션 상태 확인 오류:", error);
      res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
  });

  // Create welcome message without TTS (text only)
  app.post("/api/websocket/sessions/:id/welcome", async (req, res) => {
    await storage.updateLastActive(req.params.id);
    try {
      const sessionId = req.params.id;
      const session = await storage.getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }

      if (!session.clonedVoiceId) {
        return res
          .status(400)
          .json({ error: "음성 클로닝이 완료되지 않았습니다." });
      }

      const welcomeText =
        "안녕하세요. 제 목소리인데 뭔가 조금 다르게 들리죠? 크크, 놀라지 마세요. 저는 당신의 목소리로 만들어진 하마터면 인공지능이에요. 요즘 보이스피싱이랑 딥페이크가 진짜 많아요. 우리 그 이야기부터 해볼까요?";

      // Create welcome message (text only)
      const welcomeMessage = await storage.createMessage({
        sessionId,
        content: welcomeText,
        role: "assistant",
      });

      res.json({
        message: welcomeMessage,
        voiceId: session.clonedVoiceId, // Client will use this for WebSocket TTS
      });
    } catch (error) {
      console.error("Welcome message error:", error);
      res.status(500).json({ error: "환영 메시지 생성에 실패했습니다." });
    }
  });

  // Send message and get AI response without TTS (text only)
  app.post("/api/websocket/sessions/:id/messages", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const messageData = insertMessageSchema.parse({
        ...req.body,
        sessionId,
      });

      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }

      // Save user message
      const userMessage = await storage.createMessage(messageData);

      // Get conversation history
      const messages = await storage.getMessagesBySession(sessionId);
      const conversationHistory = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Get AI response from Gemini
      const aiResponse = await getEducationalResponse(
        messageData.content,
        conversationHistory,
      );

      // Check if session still exists before saving AI message
      const sessionCheck = await storage.getSession(sessionId);
      if (!sessionCheck) {
        console.log(
          `세션 ${sessionId}이 AI 응답 처리 중에 삭제되어 메시지 저장을 중단합니다.`,
        );
        return res.status(404).json({ error: "세션이 삭제되었습니다." });
      }

      // Save AI message (text only)
      const aiMessage = await storage.createMessage({
        sessionId,
        content: aiResponse,
        role: "assistant",
      });

      res.json({
        userMessage,
        aiMessage,
        voiceId: sessionCheck.clonedVoiceId, // Client will use this for WebSocket TTS
      });
    } catch (error) {
      console.error("Message handling error:", error);
      res.status(500).json({ error: "메시지 처리에 실패했습니다." });
    }
  });
}
