import type { NextRequest } from "next/server";
import { JUDGE_MODEL, parseJudgeVerdict, runJudge } from "@/lib/agents";
import { appendTurn, getSession, updateSession } from "@/lib/sessions";
import { jsonError, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/judge — body { sessionId } (consensus mode only).
 * Calls the Opus judge over the full transcript, parses a strict JudgeVerdict,
 * stores a judge turn (content = rationale, verdict = structured), and flips the
 * session to `converged` when the judge says so. A parse failure returns 502 with
 * the raw model text (it never crashes into an HTML 500).
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const { sessionId } = (body ?? {}) as { sessionId?: unknown };
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return jsonError("`sessionId` is required and must be a string.", 400);
  }

  let session;
  try {
    session = await getSession(sessionId);
  } catch (err) {
    return serverError(err);
  }
  if (session === null) return jsonError("Session not found.", 404);
  if (session.mode !== "consensus") {
    return jsonError("Judging only applies to consensus sessions.", 400);
  }

  // The round being judged = the latest round any participant has spoken in.
  const participantTurns = session.turns.filter((t) => t.role === "gemini" || t.role === "claude");
  if (participantTurns.length === 0) {
    return jsonError("No participant turns to judge yet.", 400);
  }
  const judgeRound = Math.max(...participantTurns.map((t) => t.round));
  const finalRound = session.maxRounds !== null && judgeRound >= session.maxRounds;

  // Call the judge, then parse strictly.
  let raw: string;
  try {
    raw = await runJudge(session.turns, finalRound);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Judge call failed.";
    console.error("[api/judge] model error:", err);
    return jsonError(`judge model error: ${message}`, 502);
  }

  const verdict = parseJudgeVerdict(raw);
  if (!verdict) {
    console.error("[api/judge] unparseable verdict:", raw);
    return Response.json({ error: "Judge returned unparseable output.", raw }, { status: 502 });
  }

  // Persist the judge turn (and converge the session if the judge says so).
  try {
    const turn = await appendTurn({
      sessionId,
      role: "judge",
      content: verdict.rationale,
      model: JUDGE_MODEL,
      round: judgeRound,
      verdict,
    });
    if (verdict.converged) await updateSession(sessionId, { status: "converged" });
    return Response.json({ verdict, turn }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
