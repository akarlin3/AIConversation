import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getDb } from "./firebaseAdmin";
import type {
  Role,
  SessionDetail,
  SessionDoc,
  SessionMeta,
  SessionStatus,
  Turn,
  TurnDoc,
} from "./types";

const SESSIONS = "sessions";
const TURNS = "turns";
const TITLE_FROM_PROMPT_MAX = 80;

function tsToIso(value: Timestamp | null | undefined): string {
  // After a committed write, Firestore reads always return resolved Timestamps.
  return value instanceof Timestamp ? value.toDate().toISOString() : new Date(0).toISOString();
}

function toSessionMeta(id: string, data: SessionDoc): SessionMeta {
  return {
    id,
    title: data.title,
    status: data.status,
    createdAt: tsToIso(data.createdAt),
    updatedAt: tsToIso(data.updatedAt),
  };
}

function toTurn(id: string, data: TurnDoc): Turn {
  return {
    id,
    index: data.index,
    role: data.role,
    content: data.content,
    model: data.model ?? null,
    createdAt: tsToIso(data.createdAt),
  };
}

/** Create a session and its index-0 `user` turn atomically. Returns the new session id. */
export async function createSession(initialPrompt: string, title?: string): Promise<string> {
  const db = getDb();
  const ref = db.collection(SESSIONS).doc();
  const now = FieldValue.serverTimestamp();

  const derivedTitle =
    title?.trim() || initialPrompt.trim().slice(0, TITLE_FROM_PROMPT_MAX) || "Untitled debate";

  const batch = db.batch();
  batch.set(ref, {
    title: derivedTitle,
    status: "active" satisfies SessionStatus,
    createdAt: now,
    updatedAt: now,
  });
  batch.set(ref.collection(TURNS).doc(), {
    index: 0,
    role: "user" satisfies Role,
    content: initialPrompt,
    model: null,
    createdAt: now,
  });
  await batch.commit();

  return ref.id;
}

/** List session metadata, newest-updated first. */
export async function listSessions(): Promise<SessionMeta[]> {
  const db = getDb();
  const snap = await db.collection(SESSIONS).orderBy("updatedAt", "desc").get();
  return snap.docs.map((d) => toSessionMeta(d.id, d.data() as SessionDoc));
}

/** Fetch a session with its turns ordered by `index`, or null if it doesn't exist. */
export async function getSession(id: string): Promise<SessionDetail | null> {
  const db = getDb();
  const ref = db.collection(SESSIONS).doc(id);
  const doc = await ref.get();
  if (!doc.exists) return null;

  const turnsSnap = await ref.collection(TURNS).orderBy("index", "asc").get();
  const turns = turnsSnap.docs.map((t) => toTurn(t.id, t.data() as TurnDoc));

  return { ...toSessionMeta(doc.id, doc.data() as SessionDoc), turns };
}

/** Update title and/or status. Bumps updatedAt. Returns fresh meta, or null if not found. */
export async function updateSession(
  id: string,
  updates: { title?: string; status?: SessionStatus },
): Promise<SessionMeta | null> {
  const db = getDb();
  const ref = db.collection(SESSIONS).doc(id);
  const doc = await ref.get();
  if (!doc.exists) return null;

  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.status !== undefined) patch.status = updates.status;
  await ref.update(patch);

  const fresh = await ref.get();
  return toSessionMeta(fresh.id, fresh.data() as SessionDoc);
}

/** Delete a session and its `turns` subcollection. Returns false if not found. */
export async function deleteSession(id: string): Promise<boolean> {
  const db = getDb();
  const ref = db.collection(SESSIONS).doc(id);
  const doc = await ref.get();
  if (!doc.exists) return false;

  await db.recursiveDelete(ref);
  return true;
}

/** Ordered turns for a session (ascending index), or null if the session doesn't exist. */
export async function getOrderedTurns(sessionId: string): Promise<Turn[] | null> {
  const db = getDb();
  const ref = db.collection(SESSIONS).doc(sessionId);
  const doc = await ref.get();
  if (!doc.exists) return null;

  const snap = await ref.collection(TURNS).orderBy("index", "asc").get();
  return snap.docs.map((t) => toTurn(t.id, t.data() as TurnDoc));
}

/** Append a turn at maxIndex+1 and bump the session's updatedAt. Returns the created Turn. */
export async function appendTurn(
  sessionId: string,
  role: Role,
  content: string,
  model: string | null,
): Promise<Turn> {
  const db = getDb();
  const sessionRef = db.collection(SESSIONS).doc(sessionId);
  const turnsCol = sessionRef.collection(TURNS);

  const lastSnap = await turnsCol.orderBy("index", "desc").limit(1).get();
  const nextIndex = lastSnap.empty ? 0 : (lastSnap.docs[0]!.data() as TurnDoc).index + 1;

  const turnRef = turnsCol.doc();
  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(turnRef, { index: nextIndex, role, content, model, createdAt: now });
  batch.update(sessionRef, { updatedAt: now });
  await batch.commit();

  // Read back so the returned turn carries the resolved server timestamp.
  const created = await turnRef.get();
  return toTurn(created.id, created.data() as TurnDoc);
}
