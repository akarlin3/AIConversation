import type { NextRequest } from "next/server";
import { createSession, listSessions } from "@/lib/sessions";
import { jsonError, serverError } from "@/lib/http";
import { MAX_PROMPT_LENGTH } from "@/lib/constants";
import type { Agent, Mode, ResponseLength } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES: readonly Mode[] = ["critique", "consensus"];
const LENGTHS: readonly ResponseLength[] = ["brief", "standard", "detailed"];
const AGENTS: readonly Agent[] = ["gemini", "claude"];
const MAX_ROUNDS_LIMIT = 20;

/**
 * POST /api/sessions — create from
 * { initialPrompt, mode, responseLength, maxRounds?, starter?, title? }.
 * Writes the user turn (index 0, round 0). Returns { sessionId }.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const { initialPrompt, mode, responseLength, maxRounds, starter, title } = (body ?? {}) as {
    initialPrompt?: unknown;
    mode?: unknown;
    responseLength?: unknown;
    maxRounds?: unknown;
    starter?: unknown;
    title?: unknown;
  };

  if (typeof initialPrompt !== "string" || initialPrompt.trim().length === 0) {
    return jsonError("`initialPrompt` is required and must be a non-empty string.", 400);
  }
  if (initialPrompt.length > MAX_PROMPT_LENGTH) {
    return jsonError(`\`initialPrompt\` must be at most ${MAX_PROMPT_LENGTH} characters.`, 400);
  }
  if (typeof mode !== "string" || !MODES.includes(mode as Mode)) {
    return jsonError("`mode` must be 'critique' or 'consensus'.", 400);
  }
  if (typeof responseLength !== "string" || !LENGTHS.includes(responseLength as ResponseLength)) {
    return jsonError("`responseLength` must be 'brief', 'standard', or 'detailed'.", 400);
  }
  // `starter` only matters for critique (who answers first); optional, defaults to gemini.
  if (starter !== undefined && (typeof starter !== "string" || !AGENTS.includes(starter as Agent))) {
    return jsonError("`starter` must be 'gemini' or 'claude'.", 400);
  }
  if (title !== undefined && typeof title !== "string") {
    return jsonError("`title` must be a string.", 400);
  }

  // maxRounds only applies to consensus; required there, ignored for critique.
  let resolvedMaxRounds: number | null = null;
  if (mode === "consensus") {
    if (
      typeof maxRounds !== "number" ||
      !Number.isInteger(maxRounds) ||
      maxRounds < 1 ||
      maxRounds > MAX_ROUNDS_LIMIT
    ) {
      return jsonError(`\`maxRounds\` must be an integer between 1 and ${MAX_ROUNDS_LIMIT}.`, 400);
    }
    resolvedMaxRounds = maxRounds;
  }

  try {
    const sessionId = await createSession({
      initialPrompt,
      mode: mode as Mode,
      responseLength: responseLength as ResponseLength,
      maxRounds: resolvedMaxRounds,
      starter: (starter as Agent | undefined) ?? "gemini",
      title: typeof title === "string" ? title : undefined,
    });
    return Response.json({ sessionId }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

/** GET /api/sessions — list sessions (id, title, mode, status, updatedAt), newest first. */
export async function GET(): Promise<Response> {
  try {
    const sessions = await listSessions();
    return Response.json({ sessions });
  } catch (err) {
    return serverError(err);
  }
}
