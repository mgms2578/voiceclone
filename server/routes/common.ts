import type { Express } from "express";
import { storage } from "../storage";
import { insertSessionSchema } from "@shared/schema";
import { cloneVoice, deleteVoiceClone, getVoiceList } from "../services/minimax";
import { getEducationalResponse } from "../services/gemini";
import multer from "multer";

// Multer setup for audio file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

export function registerCommonRoutes(app: Express) {
  
  // Create new session
  app.post("/api/sessions", async (req, res) => {
    try {
      const sessionData = insertSessionSchema.parse(req.body);
      const session = await storage.createSession(sessionData);
      res.json(session);
    } catch (error) {
      res.status(400).json({ error: "세션 생성에 실패했습니다." });
    }
  });

  // Get session
  app.get("/api/sessions/:id", async (req, res) => {
    try {
      const session = await storage.getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }
      
      // Update last active time on access
      await storage.updateLastActive(req.params.id);
      
      res.json(session);
    } catch (error) {
      res.status(500).json({ error: "세션 조회에 실패했습니다." });
    }
  });

  // Upload audio and start voice cloning
  app.post("/api/sessions/:id/audio", upload.single('audio'), async (req: any, res) => {
    try {
      const sessionId = req.params.id;
      
      // Update session activity
      await storage.updateLastActive(sessionId);
      
      const session = await storage.getSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "오디오 파일이 필요합니다." });
      }

      // Check if session already has a cloned voice
      if (session.clonedVoiceId) {
        return res.json({ 
          success: true, 
          voiceId: session.clonedVoiceId,
          status: "ready"
        });
      }

      // Convert audio buffer to base64 for storage
      const audioBase64 = req.file.buffer.toString('base64');
      
      // Atomically try to start cloning (prevents race conditions)
      const canStartCloning = await storage.tryStartCloning(sessionId, audioBase64);
      if (!canStartCloning) {
        return res.status(409).json({ 
          error: "음성 클로닝이 이미 진행 중이거나 완료되었습니다. 잠시 후 다시 시도해주세요.",
          status: "cloning"
        });
      }

      try {
        // Start voice cloning with MiniMax (pass Buffer and sessionId)
        const cloneResult = await cloneVoice({ 
          audioBuffer: req.file.buffer, 
          sessionId 
        });
        
        if (cloneResult.success && cloneResult.voiceId) {
          await storage.updateSession(sessionId, {
            clonedVoiceId: cloneResult.voiceId,
            status: "ready"
          });
          
          res.json({ 
            success: true, 
            voiceId: cloneResult.voiceId,
            status: "ready"
          });
        } else {
          await storage.updateSession(sessionId, {
            status: "error"
          });
          
          res.status(500).json({ 
            error: cloneResult.error || "음성 클로닝에 실패했습니다." 
          });
        }
      } catch (cloneError) {
        // Ensure lock is released on any cloning error
        await storage.updateSession(sessionId, {
          status: "error"
        });
        console.error('Voice cloning error:', cloneError);
        res.status(500).json({ error: "음성 클로닝 처리 중 오류가 발생했습니다." });
      }
    } catch (error) {
      console.error('Audio upload error:', error);
      res.status(500).json({ error: "오디오 처리에 실패했습니다." });
    }
  });

  // Get messages for session
  app.get("/api/sessions/:id/messages", async (req, res) => {
    try {
      // Update session activity on message access
      await storage.updateLastActive(req.params.id);
      
      const messages = await storage.getMessagesBySession(req.params.id);
      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: "메시지 조회에 실패했습니다." });
    }
  });

  // Delete session and all data
  app.delete("/api/sessions/:id", async (req, res) => {
    try {
      const sessionId = req.params.id;
      
      // Get session to check for cloned voice
      const session = await storage.getSession(sessionId);
      
      // Delete cloned voice from MiniMax if exists (only voicedeepfake-created ones)
      if (session?.clonedVoiceId) {
        if (session.clonedVoiceId.startsWith('voicedeepfake')) {
          console.log(`세션 ${sessionId}의 클론 ${session.clonedVoiceId} 삭제 중...`);
          const voiceDeleted = await deleteVoiceClone(session.clonedVoiceId);
          if (voiceDeleted) {
            console.log(`클론 ${session.clonedVoiceId} 성공적으로 삭제됨`);
          } else {
            console.warn(`클론 ${session.clonedVoiceId} 삭제 실패, 계속 진행`);
          }
        } else {
          console.log(`⚠️ 다른 앱의 클론 음성으로 추정되어 MiniMax 삭제 건너뜀: ${session.clonedVoiceId}`);
        }
      }
      
      // Delete messages first
      await storage.deleteMessagesBySession(sessionId);
      
      // Delete session
      const deleted = await storage.deleteSession(sessionId);
      
      if (deleted) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: "세션을 찾을 수 없습니다." });
      }
    } catch (error) {
      console.error('세션 삭제 오류:', error);
      res.status(500).json({ error: "세션 삭제에 실패했습니다." });
    }
  });

  // Health checks and utility endpoints
  app.get("/api/health/gemini", async (req, res) => {
    try {
      const testResponse = await getEducationalResponse("테스트", []);
      res.json({ 
        status: "ok", 
        message: "Gemini API 정상 작동",
        response: testResponse ? "응답 생성 성공" : "응답 생성 실패"
      });
    } catch (error) {
      console.error("Gemini health check 오류:", error);
      res.status(500).json({ 
        status: "error", 
        message: "Gemini API 오류",
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/api/voices", async (req, res) => {
    try {
      const voiceList = await getVoiceList();
      res.json(voiceList);
    } catch (error) {
      console.error("Voice list 조회 오류:", error);
      res.status(500).json({ 
        error: "음성 목록 조회에 실패했습니다.",
        details: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/api/sessions", async (req, res) => {
    try {
      const sessions = await storage.getAllSessions();
      const sessionsWithVoices = sessions.filter(session => session.clonedVoiceId);
      res.json({
        total: sessions.length,
        withVoices: sessionsWithVoices.length,
        sessions: sessionsWithVoices.map(session => ({
          id: session.id,
          voiceId: session.clonedVoiceId,
          createdAt: session.createdAt,
          hasConsent: session.consentGiven
        }))
      });
    } catch (error) {
      console.error("Sessions 조회 오류:", error);
      res.status(500).json({ error: "세션 조회에 실패했습니다." });
    }
  });

  // Cleanup expired sessions and delete associated voices
  app.post("/api/cleanup", async (req, res) => {
    try {
      const TTL = 10 * 60 * 1000 + 1000; // 10분 1초
      
      console.log(`세션 정리 시작 (TTL: ${TTL}ms = ${TTL / 1000}초)`);
      
      const { deleted, voiceIdsToDelete } = await storage.cleanupExpiredSessions(TTL);
      
      console.log(`만료된 세션 ${deleted.length}개 발견, 삭제할 보이스 ${voiceIdsToDelete.length}개`);
      
      // Filter to only delete voices created by this app (prefix: 'voicedeepfake')
      const ownVoiceIds = voiceIdsToDelete.filter(id => id.startsWith('voicedeepfake'));
      const skippedVoiceIds = voiceIdsToDelete.filter(id => !id.startsWith('voicedeepfake'));
      
      if (skippedVoiceIds.length > 0) {
        console.log(`⚠️ 외부 보이스 ${skippedVoiceIds.length}개 건너뜀:`, skippedVoiceIds);
      }
      
      // Delete voices from MiniMax
      const deletionResults = await Promise.allSettled(
        ownVoiceIds.map(async (voiceId) => {
          console.log(`보이스 ${voiceId} 삭제 시도...`);
          const success = await deleteVoiceClone(voiceId);
          if (success) {
            console.log(`보이스 ${voiceId} 삭제 성공`);
          } else {
            console.warn(`보이스 ${voiceId} 삭제 실패`);
          }
          return { voiceId, success };
        })
      );
      
      const deletedVoices = deletionResults
        .filter((result): result is PromiseFulfilledResult<{ voiceId: string; success: boolean }> => 
          result.status === 'fulfilled' && result.value.success
        )
        .map(result => result.value.voiceId);
      
      const failedVoices = deletionResults
        .filter((result): result is PromiseFulfilledResult<{ voiceId: string; success: boolean }> => 
          result.status === 'fulfilled' && !result.value.success
        )
        .map(result => result.value.voiceId);
      
      console.log(`정리 완료: 세션 ${deleted.length}개, 보이스 삭제 성공 ${deletedVoices.length}개, 실패 ${failedVoices.length}개`);
      
      res.json({
        success: true,
        deletedSessions: deleted.length,
        deletedVoices: deletedVoices.length,
        failedVoices: failedVoices.length,
        details: {
          deletedSessionIds: deleted.map(s => s.id),
          deletedVoiceIds: deletedVoices,
          failedVoiceIds: failedVoices
        }
      });
    } catch (error) {
      console.error("세션 정리 오류:", error);
      res.status(500).json({ 
        error: "세션 정리에 실패했습니다.",
        details: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });
}