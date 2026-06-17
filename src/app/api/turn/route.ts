import type { NextRequest } from "next/server";
import { type Agent, modelIdFor, runAgent } from "@/lib/agents";
import { appendTurn, getOrderedTurns } from "@/lib/sessions";
import { jsonError, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENTS: readonly Agent[] = ["gemini", "claude"];

/**
 * POST /api/turn — body { sessionId, agent: 'gemini' | 'claude' }.
 * Reads the ordered transcript, calls the chosen model, appends the new turn,
 * bumps updatedAt, and returns the created turn.
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

  // 1. Read the full ordered transcript.
  let turns;
  try {
    turns = await getOrderedTurns(sessionId);
  } catch (err) {
    return serverError(err);
  }
  if (turns === null) return jsonError("Session not found.", 404);
  if (turns.length === 0) return jsonError("Session has no turns to respond to.", 400);

  // 2. Call the model. Model failures surface as 502 with a message (not a 500 HTML page).
  let content: string;
  try {
    content = await runAgent(chosen, turns);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Model call failed.";
    console.error(`[api/turn] ${chosen} model error:`, err);
    return jsonError(`${chosen} model error: ${message}`, 502);
  }

  // 3. Append the new turn and return it.
  try {
    const turn = await appendTurn(sessionId, chosen, content, modelIdFor(chosen));
    return Response.json({ turn }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
