import type { Agent, SessionDetail, SessionMeta, SessionStatus, Turn } from "./types";

/**
 * Browser-side helpers for the app's own API routes. These hit same-origin
 * endpoints — no API keys or Firebase credentials are ever present here.
 */

async function parse<T>(res: Response): Promise<T> {
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data as { error?: string }).error ?? `Request failed (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return data as T;
}

export async function createSession(initialPrompt: string, title?: string): Promise<string> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initialPrompt, title }),
  });
  const { sessionId } = await parse<{ sessionId: string }>(res);
  return sessionId;
}

export async function postTurn(sessionId: string, agent: Agent): Promise<Turn> {
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, agent }),
  });
  const { turn } = await parse<{ turn: Turn }>(res);
  return turn;
}

export async function patchSession(
  id: string,
  updates: { title?: string; status?: SessionStatus },
): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updates),
  });
  await parse<unknown>(res);
}

export async function listSessions(): Promise<SessionMeta[]> {
  const res = await fetch("/api/sessions", { cache: "no-store" });
  const { sessions } = await parse<{ sessions: SessionMeta[] }>(res);
  return sessions;
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await fetch(`/api/sessions/${id}`, { cache: "no-store" });
  const { session } = await parse<{ session: SessionDetail }>(res);
  return session;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  await parse<unknown>(res);
}
