import type { NextRequest } from "next/server";
import { deleteSession, getSession, updateSession } from "@/lib/sessions";
import { jsonError, serverError } from "@/lib/http";
import type { SessionStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const VALID_STATUSES: readonly SessionStatus[] = ["active", "stopped"];

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

/** PATCH /api/sessions/[id] — rename and/or set status. */
export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const { title, status } = (body ?? {}) as { title?: unknown; status?: unknown };
  const updates: { title?: string; status?: SessionStatus } = {};

  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) {
      return jsonError("`title` must be a non-empty string.", 400);
    }
    updates.title = title.trim();
  }
  if (status !== undefined) {
    if (typeof status !== "string" || !VALID_STATUSES.includes(status as SessionStatus)) {
      return jsonError("`status` must be 'active' or 'stopped'.", 400);
    }
    updates.status = status as SessionStatus;
  }
  if (updates.title === undefined && updates.status === undefined) {
    return jsonError("Provide at least one of `title` or `status`.", 400);
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
