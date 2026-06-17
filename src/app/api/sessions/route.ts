import type { NextRequest } from "next/server";
import { createSession, listSessions } from "@/lib/sessions";
import { jsonError, serverError } from "@/lib/http";
import { MAX_PROMPT_LENGTH } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/sessions — create a session from { initialPrompt, title? }. */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const { initialPrompt, title } = (body ?? {}) as {
    initialPrompt?: unknown;
    title?: unknown;
  };

  if (typeof initialPrompt !== "string" || initialPrompt.trim().length === 0) {
    return jsonError("`initialPrompt` is required and must be a non-empty string.", 400);
  }
  if (initialPrompt.length > MAX_PROMPT_LENGTH) {
    return jsonError(`\`initialPrompt\` must be at most ${MAX_PROMPT_LENGTH} characters.`, 400);
  }
  if (title !== undefined && typeof title !== "string") {
    return jsonError("`title` must be a string.", 400);
  }

  try {
    const sessionId = await createSession(initialPrompt, title);
    return Response.json({ sessionId }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}

/** GET /api/sessions — list sessions (id, title, status, updatedAt), newest first. */
export async function GET(): Promise<Response> {
  try {
    const sessions = await listSessions();
    return Response.json({ sessions });
  } catch (err) {
    return serverError(err);
  }
}
