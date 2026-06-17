import type { Timestamp } from "firebase-admin/firestore";

export type Role = "user" | "gemini" | "claude" | "judge";
/** Participant agents that can be asked to take a turn via /api/turn. */
export type Agent = "gemini" | "claude";

export type Mode = "critique" | "consensus";
export type ResponseLength = "brief" | "standard" | "detailed";

/**
 * Lifecycle:
 *  - `active`     — accepting turns (both modes).
 *  - `stopped`    — halted by the user (both modes); reopenable.
 *  - `converged`  — judge declared consensus (consensus only); terminal.
 *  - `maxrounds`  — hit the round cap without converging (consensus only); terminal.
 */
export type SessionStatus = "active" | "stopped" | "converged" | "maxrounds";

/** The judge's structured ruling, stored on the judge turn (consensus only). */
export interface JudgeVerdict {
  converged: boolean;
  rationale: string;
  divergences: string[];
  consensusStatement: string | null;
}

/** Firestore document shapes (server-side; timestamps are Firestore Timestamps on read). */
export interface SessionDoc {
  title: string;
  mode: Mode;
  responseLength: ResponseLength;
  /** Round cap for consensus mode; null for critique (user-gated, uncapped). */
  maxRounds: number | null;
  /**
   * Critique mode: which participant answers first (the other becomes the critic).
   * Irrelevant for consensus (both answer in parallel); defaults to "gemini".
   */
  starter: Agent;
  status: SessionStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TurnDoc {
  /** Monotonic global ordering. */
  index: number;
  /** Negotiation cycle: 0 = user prompt, 1 = first round, etc. */
  round: number;
  role: Role;
  content: string;
  model: string | null;
  /** Present only on judge turns. */
  verdict?: JudgeVerdict;
  createdAt: Timestamp;
}

/** Serialized DTOs returned by the API (timestamps as ISO-8601 strings). */
export interface SessionMeta {
  id: string;
  title: string;
  mode: Mode;
  responseLength: ResponseLength;
  maxRounds: number | null;
  /** Critique mode: which participant answers first. Defaults to "gemini". */
  starter: Agent;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  id: string;
  index: number;
  round: number;
  role: Role;
  content: string;
  model: string | null;
  verdict?: JudgeVerdict;
  createdAt: string;
}

export interface SessionDetail extends SessionMeta {
  turns: Turn[];
}
