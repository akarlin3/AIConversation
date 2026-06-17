import type { NextRequest } from "next/server";
import { deleteSession, getSession, updateSession, type SessionUpdates } from "@/lib/sessions";
import { jsonError, serverError } from "@/lib/http";
import type { ResponseLength, SessionStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const VALID_STATUSES: readonly SessionStatus[] = ["active", "stopped", "converged", "maxrounds"];
const VALID_LENGTHS: readonly ResponseLength[] = ["brief", "standard", "detailed"];

/** GET /api/sessions/[id] — session meta + all turns ordered by index. */
export async function GET(_request: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;
  try {
    const session = await getSession(id);
    if (!session) return jsonError("Session not found.", 404);
    return Response.json({ session });
  } catch (err) {
    return serverError(err);
  }
}

/** PATCH /api/sessions/[id] — rename / set status / set responseLength. */
export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const { title, status, responseLength } = (body ?? {}) as {
    title?: unknown;
    status?: unknown;
    responseLength?: unknown;
  };
  const updates: SessionUpdates = {};

  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      return jsonError("`title` must be a non-empty string.", 400);
    }
    updates.title = title.trim();
  }
  if (status !== undefined) {
    if (typeof status !== "string" || !VALID_STATUSES.includes(status as SessionStatus)) {
      return jsonError("`status` must be 'active', 'stopped', 'converged', or 'maxrounds'.", 400);
    }
    updates.status = status as SessionStatus;
  }
  if (responseLength !== undefined) {
    if (typeof responseLength !== "string" || !VALID_LENGTHS.includes(responseLength as ResponseLength)) {
      return jsonError("`responseLength` must be 'brief', 'standard', or 'detailed'.", 400);
    }
    updates.responseLength = responseLength as ResponseLength;
  }
  if (
    updates.title === undefined &&
    updates.status === undefined &&
    updates.responseLength === undefined
  ) {
    return jsonError("Provide at least one of `title`, `status`, or `responseLength`.", 400);
  }

  try {
    const session = await updateSession(id, updates);
    if (!session) return jsonError("Session not found.", 404);
    return Response.json({ session });
  } catch (err) {
    return serverError(err);
  }
}

/** DELETE /api/sessions/[id] — delete session + turns. */
export async function DELETE(_request: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;
  try {
    const ok = await deleteSession(id);
    if (!ok) return jsonError("Session not found.", 404);
    return Response.json({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
