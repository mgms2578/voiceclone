import { type Session, type InsertSession, type Message, type InsertMessage, sessions, messages } from "@shared/schema";
import { randomUUID } from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, lt, and, isNull, ne } from "drizzle-orm";
import { Pool } from "pg";

export interface IStorage {
  // Session management
  createSession(session: InsertSession): Promise<Session>;
  getSession(id: string): Promise<Session | undefined>;
  updateSession(id: string, updates: Partial<Pick<Session, 'status' | 'audioData' | 'clonedVoiceId'>>): Promise<Session | undefined>;
  deleteSession(id: string): Promise<boolean>;
  getAllSessions(): Promise<Session[]>;
  
  // Session lifecycle
  updateLastActive(id: string): Promise<Session | undefined>;
  cleanupExpiredSessions(maxAgeMs: number): Promise<{deleted: Session[], voiceIdsToDelete: string[]}>;
  
  // Message management
  createMessage(message: InsertMessage): Promise<Message>;
  getMessagesBySession(sessionId: string): Promise<Message[]>;
  deleteMessagesBySession(sessionId: string): Promise<boolean>;
  
  // Atomic operations
  tryStartCloning(id: string, audioData: string): Promise<boolean>;
}

export class MemStorage implements IStorage {
  private sessions: Map<string, Session>;
  private messages: Map<string, Message>;
  private cloningLocks: Set<string>; // Track sessions currently cloning

  constructor() {
    this.sessions = new Map();
    this.messages = new Map();
    this.cloningLocks = new Set();
  }

  async createSession(insertSession: InsertSession): Promise<Session> {
    const id = randomUUID();
    const now = new Date();
    const session: Session = {
      id,
      audioData: null,
      clonedVoiceId: null,
      consentGiven: insertSession.consentGiven ?? false,
      status: "created",
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async updateSession(id: string, updates: Partial<Pick<Session, 'status' | 'audioData' | 'clonedVoiceId'>>): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    
    // Explicitly whitelist allowed fields for safety
    const safeUpdates: Partial<Session> = {};
    if (updates.status !== undefined) safeUpdates.status = updates.status;
    if (updates.audioData !== undefined) safeUpdates.audioData = updates.audioData;
    if (updates.clonedVoiceId !== undefined) safeUpdates.clonedVoiceId = updates.clonedVoiceId;
    
    // Safe update with auto-refresh lastActiveAt
    const updatedSession = { 
      ...session, 
      ...safeUpdates,
      lastActiveAt: new Date()
    };
    this.sessions.set(id, updatedSession);
    
    // Clear cloning lock when status changes away from cloning
    if (updates.status && updates.status !== "cloning") {
      this.cloningLocks.delete(id);
    }
    
    return updatedSession;
  }

  async deleteSession(id: string): Promise<boolean> {
    const deleted = this.sessions.delete(id);
    
    // Clean up associated data
    this.cloningLocks.delete(id);
    await this.deleteMessagesBySession(id);
    
    return deleted;
  }

  async getAllSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values());
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = randomUUID();
    const message: Message = {
      ...insertMessage,
      id,
      audioUrl: null,
      createdAt: new Date(),
    };
    this.messages.set(id, message);
    
    // Update parent session's lastActiveAt
    await this.updateLastActive(insertMessage.sessionId);
    
    return message;
  }

  async getMessagesBySession(sessionId: string): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter(message => message.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async deleteMessagesBySession(sessionId: string): Promise<boolean> {
    const messagesToDelete = Array.from(this.messages.entries())
      .filter(([_, message]) => message.sessionId === sessionId);
    
    messagesToDelete.forEach(([id]) => this.messages.delete(id));
    return true;
  }

  async updateLastActive(id: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    
    const updatedSession = { ...session, lastActiveAt: new Date() };
    this.sessions.set(id, updatedSession);
    return updatedSession;
  }

  async cleanupExpiredSessions(maxAgeMs: number): Promise<{deleted: Session[], voiceIdsToDelete: string[]}> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const expired: Session[] = [];
    const voiceIdsToDelete: string[] = [];
    
    // Use Array.from to avoid iterator issues
    const entries = Array.from(this.sessions.entries());
    
    for (const [id, session] of entries) {
      if (session.lastActiveAt < cutoff) {
        expired.push(session);
        
        // Collect voice IDs for deletion
        if (session.clonedVoiceId && session.clonedVoiceId.startsWith('voicedeepfake')) {
          voiceIdsToDelete.push(session.clonedVoiceId);
        }
        
        // Delete session and associated messages
        this.sessions.delete(id);
        this.cloningLocks.delete(id);
        await this.deleteMessagesBySession(id);
      }
    }
    
    return { deleted: expired, voiceIdsToDelete };
  }

  async tryStartCloning(id: string, audioData: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    
    // Check if already cloned or currently cloning
    if (session.clonedVoiceId || session.status === "cloning" || this.cloningLocks.has(id)) {
      return false;
    }
    
    // Atomically set cloning lock and update session
    this.cloningLocks.add(id);
    const updatedSession = { 
      ...session, 
      audioData, 
      status: "cloning" as const,
      lastActiveAt: new Date()
    };
    this.sessions.set(id, updatedSession);
    return true;
  }
  
}

// DB Storage using PostgreSQL with Drizzle ORM
export class DbStorage implements IStorage {
  private db;
  private cloningLocks: Set<string>; // In-memory locks for atomic cloning

  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL not found");
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    this.db = drizzle(pool);
    this.cloningLocks = new Set();
  }

  async createSession(insertSession: InsertSession): Promise<Session> {
    const id = randomUUID();
    const now = new Date();
    const [session] = await this.db.insert(sessions).values({
      id,
      audioData: null,
      clonedVoiceId: null,
      consentGiven: insertSession.consentGiven ?? false,
      status: "created",
      createdAt: now,
      lastActiveAt: now,
    }).returning();
    return session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const [session] = await this.db.select().from(sessions).where(eq(sessions.id, id));
    return session;
  }

  async updateSession(id: string, updates: Partial<Pick<Session, 'status' | 'audioData' | 'clonedVoiceId'>>): Promise<Session | undefined> {
    const safeUpdates: any = {
      lastActiveAt: new Date()
    };
    if (updates.status !== undefined) safeUpdates.status = updates.status;
    if (updates.audioData !== undefined) safeUpdates.audioData = updates.audioData;
    if (updates.clonedVoiceId !== undefined) safeUpdates.clonedVoiceId = updates.clonedVoiceId;

    const [updated] = await this.db.update(sessions)
      .set(safeUpdates)
      .where(eq(sessions.id, id))
      .returning();

    // Clear cloning lock when status changes away from cloning
    if (updates.status && updates.status !== "cloning") {
      this.cloningLocks.delete(id);
    }

    return updated;
  }

  async deleteSession(id: string): Promise<boolean> {
    // Clean up associated data
    this.cloningLocks.delete(id);
    await this.deleteMessagesBySession(id);
    
    const result = await this.db.delete(sessions).where(eq(sessions.id, id));
    return result.rowCount ? result.rowCount > 0 : false;
  }

  async getAllSessions(): Promise<Session[]> {
    return await this.db.select().from(sessions);
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = randomUUID();
    const [message] = await this.db.insert(messages).values({
      id,
      ...insertMessage,
      audioUrl: null,
      createdAt: new Date(),
    }).returning();

    // Update parent session's lastActiveAt
    await this.updateLastActive(insertMessage.sessionId);

    return message;
  }

  async getMessagesBySession(sessionId: string): Promise<Message[]> {
    return await this.db.select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt);
  }

  async deleteMessagesBySession(sessionId: string): Promise<boolean> {
    await this.db.delete(messages).where(eq(messages.sessionId, sessionId));
    return true;
  }

  async updateLastActive(id: string): Promise<Session | undefined> {
    const [updated] = await this.db.update(sessions)
      .set({ lastActiveAt: new Date() })
      .where(eq(sessions.id, id))
      .returning();
    return updated;
  }

  async cleanupExpiredSessions(maxAgeMs: number): Promise<{deleted: Session[], voiceIdsToDelete: string[]}> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    
    // Find expired sessions
    const expired = await this.db.select()
      .from(sessions)
      .where(lt(sessions.lastActiveAt, cutoff));
    
    const voiceIdsToDelete: string[] = [];
    const actuallyDeleted: Session[] = [];
    
    for (const session of expired) {
      // Delete session ONLY IF still expired (prevent race condition)
      const result = await this.db.delete(sessions)
        .where(and(
          eq(sessions.id, session.id),
          lt(sessions.lastActiveAt, cutoff)
        ));
      
      // Only collect voiceId and cleanup if session was actually deleted
      if (result.rowCount && result.rowCount > 0) {
        actuallyDeleted.push(session);
        
        // Collect voice IDs ONLY for actually deleted sessions
        if (session.clonedVoiceId && session.clonedVoiceId.startsWith('voicedeepfake')) {
          voiceIdsToDelete.push(session.clonedVoiceId);
        }
        
        this.cloningLocks.delete(session.id);
        await this.deleteMessagesBySession(session.id);
      }
    }
    
    return { deleted: actuallyDeleted, voiceIdsToDelete };
  }

  async tryStartCloning(id: string, audioData: string): Promise<boolean> {
    // Atomic DB update - only succeed if not already cloning or cloned
    // This is safe for multi-instance deployments
    const result = await this.db.update(sessions)
      .set({ 
        audioData, 
        status: "cloning",
        lastActiveAt: new Date()
      })
      .where(and(
        eq(sessions.id, id),
        ne(sessions.status, "cloning"),
        isNull(sessions.clonedVoiceId)
      ))
      .returning();
    
    // If update succeeded, add to local lock set
    if (result.length > 0) {
      this.cloningLocks.add(id);
      return true;
    }
    
    return false;
  }
}

// Use DB storage instead of memory storage
export const storage = new DbStorage();
