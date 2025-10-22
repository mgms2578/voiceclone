import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const sessions = pgTable("sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  audioData: text("audio_data"), // base64 encoded audio
  clonedVoiceId: text("cloned_voice_id"), // MiniMax voice ID
  consentGiven: boolean("consent_given").notNull().default(false),
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
  lastActiveAt: timestamp("last_active_at").notNull().default(sql`now()`),
  status: text("status").notNull().default("created"), // created, cloning, ready, active, ended, expired, error
});

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sessionId: varchar("session_id").notNull(),
  content: text("content").notNull(),
  role: text("role").notNull(), // user, assistant
  audioUrl: text("audio_url"), // for cloned voice responses
  createdAt: timestamp("created_at").notNull().default(sql`now()`),
});

export const insertSessionSchema = createInsertSchema(sessions).pick({
  consentGiven: true,
});

export const insertMessageSchema = createInsertSchema(messages).pick({
  sessionId: true,
  content: true,
  role: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;
