import type { NextRequest } from "next/server";
import { type Agent, modelIdFor, runAgent } from "@/lib/agents";
import { appendTurn, getSession } from "@/lib/sessions";
import { jsonError, serverError } from "@/lib/http";
import type { Turn } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENTS: readonly Agent[] = ["gemini", "claude"];

/**
 * POST /api/turn — body { sessionId, agent: 'gemini' | 'claude' }.
 *
 * Round derivation: a new turn's round = (count of that agent's existing turns) + 1.
 * That holds for both modes — critique alternates gemini→claude within a round;
 * consensus runs gemini and claude in parallel within the same round.
 *
 * Context:
 *   - critique           → the full ordered transcript.
 *   - consensus          → only turns from earlier rounds (round < newRound). This
 *     enforces round-1 independence (each sees just the user prompt) and, in later
 *     rounds, prevents either participant from seeing the other's same-round answer.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const { sessionId, agent } = (body ?? {}) as { sessionId?: unknown; agent?: unknown };

  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return jsonError("`sessionId` is required and must be a string.", 400);
  }
  if (typeof agent !== "string" || !AGENTS.includes(agent as Agent)) {
    return jsonError("`agent` must be 'gemini' or 'claude'.", 400);
  }
  const chosen = agent as Agent;

  // 1. Read session meta + ordered transcript.
  let session;
  try {
    session = await getSession(sessionId);
  } catch (err) {
    return serverError(err);
  }
  if (session === null) return jsonError("Session not found.", 404);
  if (session.turns.length === 0) return jsonError("Session has no turns to respond to.", 400);

  // 2. Derive this turn's round and the context the agent is allowed to see.
  const newRound = session.turns.filter((t) => t.role === chosen).length + 1;
  const contextTurns: Turn[] =
    session.mode === "consensus"
      ? session.turns.filter((t) => t.round < newRound)
      : session.turns;

  // 3. Call the model (with the session's response-length preset).
  //    Model failures surface as 502 with a message (not a 500 HTML page).
  let content: string;
  try {
    content = await runAgent(chosen, contextTurns, {
      mode: session.mode,
      responseLength: session.responseLength,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Model call failed.";
    console.error(`[api/turn] ${chosen} model error:`, err);
    return jsonError(`${chosen} model error: ${message}`, 502);
  }

  // 4. Append the new turn and return it.
  try {
    const turn = await appendTurn({
      sessionId,
      role: chosen,
      content,
      model: modelIdFor(chosen),
      round: newRound,
    });
    return Response.json({ turn }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
