/** Small JSON-response helpers shared across API routes. */

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/** Logs the underlying error and returns a 500 with a readable message (never an HTML page). */
export function serverError(err: unknown): Response {
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  console.error("[api]", err);
  return jsonError(message, 500);
}
