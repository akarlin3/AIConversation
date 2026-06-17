"use client";

import { useEffect, useRef, useState } from "react";
import type { Agent, SessionMeta, Turn } from "@/lib/types";
import { MAX_PROMPT_LENGTH } from "@/lib/constants";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  patchSession,
  postTurn,
} from "@/lib/api";
import { TranscriptCard } from "./TranscriptCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { SessionList } from "./SessionList";

type Status = "idle" | "geminiThinking" | "claudeThinking" | "awaitingDecision" | "stopped";

const ROUND: Agent[] = ["gemini", "claude"];

function messageFrom(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

// Map common upstream/API failures to a friendly sentence; fall back to the raw message.
function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (
    m.includes("503") ||
    m.includes("unavailable") ||
    m.includes("high demand") ||
    m.includes("overloaded")
  ) {
    return "The model is temporarily busy (high demand). Please retry in a moment.";
  }
  if (m.includes("429") || m.includes("rate limit")) {
    return "Rate limited by the model provider. Please wait a few seconds and retry.";
  }
  if (m.includes("api key") || m.includes("authentication") || m.includes("x-api-key")) {
    return "The server's API key is missing or invalid. Check the server configuration.";
  }
  return msg;
}

export function DebateApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryAgents, setRetryAgents] = useState<Agent[] | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [pendingOp, setPendingOp] = useState(false);
  const [running, setRunning] = useState(false); // a round is actively in flight
  const [toast, setToast] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false); // hard guard against concurrent rounds
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const thinking = status === "geminiThinking" || status === "claudeThinking";
  // `busy` reflects work actually in flight — NOT the (possibly stale) thinking
  // status, which lingers after a failed turn so the error card can stay put.
  const busy = running || loadingSession || pendingOp;
  const showForm = status === "idle" && turns.length === 0 && !loadingSession;
  const promptTooLong = prompt.length > MAX_PROMPT_LENGTH;

  function showToast(message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }

  async function refreshSessions() {
    try {
      setSessions(await listSessions());
    } catch {
      // A failed list refresh shouldn't break the active debate.
    }
  }

  // Load the session list on mount. setState runs only after the await.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await listSessions();
        if (active) setSessions(list);
      } catch {
        // ignore initial list load failure
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, status, error, loadingSession]);

  // Clear any pending toast timer on unmount.
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Run agents in order. On failure, stop and remember the remaining steps
  // (failed agent first) so Retry resumes without duplicating completed turns.
  async function runAgents(agents: Agent[], sid: string) {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i]!;
        setError(null);
        setRetryAgents(null);
        setStatus(agent === "gemini" ? "geminiThinking" : "claudeThinking");
        try {
          const turn = await postTurn(sid, agent);
          setTurns((prev) => [...prev, turn]);
        } catch (e) {
          setError(messageFrom(e));
          setRetryAgents(agents.slice(i));
          await refreshSessions();
          return;
        }
      }
      setStatus("awaitingDecision");
      await refreshSessions();
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || busy || promptTooLong) return;

    setError(null);
    setTurns([
      {
        id: "local-user-0",
        index: 0,
        role: "user",
        content: text,
        model: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setStatus("geminiThinking");
    try {
      const sid = await createSession(text);
      setSessionId(sid);
      setPrompt("");
      await refreshSessions();
      await runAgents(ROUND, sid);
    } catch (err) {
      setError(messageFrom(err));
      setTurns([]);
      setSessionId(null);
      setStatus("idle");
    }
  }

  async function handleContinue() {
    if (!sessionId || busy) return;
    await runAgents(ROUND, sessionId);
  }

  async function handleRetry() {
    if (!sessionId || !retryAgents || busy) return;
    await runAgents(retryAgents, sessionId);
  }

  async function handleStop() {
    if (!sessionId || busy) return;
    setPendingOp(true);
    try {
      await patchSession(sessionId, { status: "stopped" });
      setStatus("stopped");
      await refreshSessions();
    } catch (err) {
      showToast(friendlyError(messageFrom(err)));
    } finally {
      setPendingOp(false);
    }
  }

  async function handleReopen() {
    if (!sessionId || busy) return;
    setPendingOp(true);
    try {
      await patchSession(sessionId, { status: "active" });
      setStatus("awaitingDecision");
      setError(null);
      await refreshSessions();
    } catch (err) {
      showToast(friendlyError(messageFrom(err)));
    } finally {
      setPendingOp(false);
    }
  }

  async function selectSession(id: string) {
    if (busy || id === sessionId) return;
    setError(null);
    setRetryAgents(null);
    setLoadingSession(true);
    setSessionId(id);
    try {
      const s = await getSession(id);
      setTurns(s.turns);
      setStatus(s.status === "stopped" ? "stopped" : "awaitingDecision");
    } catch (err) {
      showToast(friendlyError(messageFrom(err)));
      setSessionId(null);
      setTurns([]);
      setStatus("idle");
    } finally {
      setLoadingSession(false);
    }
  }

  function handleNew() {
    if (busy) return;
    setStatus("idle");
    setPrompt("");
    setSessionId(null);
    setTurns([]);
    setError(null);
    setRetryAgents(null);
  }

  async function handleRename(id: string, title: string) {
    setPendingOp(true);
    try {
      await patchSession(id, { title });
      await refreshSessions();
    } catch (err) {
      showToast(friendlyError(messageFrom(err)));
    } finally {
      setPendingOp(false);
    }
  }

  async function handleDelete(id: string) {
    setPendingOp(true);
    try {
      await deleteSession(id);
      if (id === sessionId) handleNew();
      await refreshSessions();
    } catch (err) {
      showToast(friendlyError(messageFrom(err)));
    } finally {
      setPendingOp(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full">
      <SessionList
        sessions={sessions}
        activeId={sessionId}
        busy={busy}
        onNew={handleNew}
        onSelect={selectSession}
        onRename={handleRename}
        onDelete={handleDelete}
      />

      <div className="flex flex-1 flex-col overflow-x-hidden">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 sm:px-6">
          <header className="py-6">
            <h1 className="font-serif text-2xl tracking-tight text-foreground">Dialectic</h1>
            <p className="font-serif text-sm text-muted">Gemini answers · Claude critiques</p>
          </header>

          {loadingSession ? (
            <div className="flex flex-1 items-center justify-center pb-24">
              <span className="font-mono text-xs text-muted">Loading debate…</span>
            </div>
          ) : showForm ? (
            <form onSubmit={handleStart} className="flex flex-1 flex-col justify-center gap-4 pb-24">
              <label htmlFor="prompt" className="font-serif text-xl text-foreground">
                What should they debate?
              </label>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleStart(e);
                  }
                }}
                rows={5}
                autoFocus
                maxLength={MAX_PROMPT_LENGTH}
                placeholder="e.g. Should governments implement a universal basic income?"
                className="w-full resize-none rounded-lg bg-card px-4 py-3 font-mono text-sm text-foreground ring-1 ring-border placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-gemini/50"
              />
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={!prompt.trim() || busy || promptTooLong}
                  className="rounded-md bg-foreground px-4 py-2 font-mono text-sm text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Start debate
                </button>
                <span className="font-mono text-[10px] text-muted">⌘/Ctrl+Enter</span>
                <span className="ml-auto font-mono text-[10px] text-muted">
                  {prompt.length.toLocaleString()}/{MAX_PROMPT_LENGTH.toLocaleString()}
                </span>
              </div>
              {error && <span className="font-mono text-xs text-red-300">{friendlyError(error)}</span>}
            </form>
          ) : (
            <main className="flex flex-1 flex-col gap-4 pb-32">
              {turns.map((t) => (
                <TranscriptCard key={t.id} turn={t} />
              ))}

              {thinking && !error && (
                <ThinkingIndicator agent={status === "geminiThinking" ? "gemini" : "claude"} />
              )}

              {error && (
                <div className="rounded-lg border-l-4 border-l-red-500 bg-red-500/5 px-4 py-3 ring-1 ring-red-500/20">
                  <p className="font-mono text-xs uppercase tracking-wider text-red-300">Error</p>
                  <p className="mt-1 font-mono text-[13px] leading-relaxed text-red-200/90">
                    {friendlyError(error)}
                  </p>
                  {retryAgents && (
                    <button
                      onClick={handleRetry}
                      disabled={busy}
                      className="mt-3 rounded-md bg-foreground px-3 py-1.5 font-mono text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}

              {status === "awaitingDecision" && (
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    onClick={handleContinue}
                    disabled={busy}
                    className="rounded-md bg-foreground px-4 py-2 font-mono text-sm text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Continue
                  </button>
                  <button
                    onClick={handleStop}
                    disabled={busy}
                    className="rounded-md px-4 py-2 font-mono text-sm text-muted ring-1 ring-border transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Stop
                  </button>
                  <span className="font-mono text-xs text-muted">
                    Continue → Gemini answers Claude, then Claude critiques again.
                  </span>
                </div>
              )}

              {status === "stopped" && (
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <span className="rounded-lg bg-card px-4 py-2 font-mono text-xs text-muted ring-1 ring-border">
                    This debate is stopped (read-only).
                  </span>
                  <button
                    onClick={handleReopen}
                    disabled={busy}
                    className="rounded-md bg-foreground px-4 py-2 font-mono text-sm text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Reopen
                  </button>
                </div>
              )}

              <div ref={bottomRef} />
            </main>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border-l-4 border-l-red-500 bg-card px-4 py-3 shadow-lg ring-1 ring-border">
          <p className="font-mono text-xs leading-relaxed text-red-200/90">{toast}</p>
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="font-mono text-xs text-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
