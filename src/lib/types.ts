import type { Timestamp } from "firebase-admin/firestore";

export type Role = "user" | "gemini" | "claude";
export type SessionStatus = "active" | "stopped";
export type Agent = "gemini" | "claude";

/** Firestore document shapes (server-side; timestamps are Firestore Timestamps on read). */
export interface SessionDoc {
  title: string;
  status: SessionStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TurnDoc {
  index: number;
  role: Role;
  content: string;
  model: string | null;
  createdAt: Timestamp;
}

/** Serialized DTOs returned by the API (timestamps as ISO-8601 strings). */
export interface SessionMeta {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  id: string;
  index: number;
  role: Role;
  content: string;
  model: string | null;
  createdAt: string;
}

export interface SessionDetail extends SessionMeta {
  turns: Turn[];
}
