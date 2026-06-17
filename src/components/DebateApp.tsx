"use client";

import { useEffect, useRef, useState } from "react";
import type { Agent, JudgeVerdict, Mode, ResponseLength, SessionMeta, Turn } from "@/lib/types";
import { MAX_PROMPT_LENGTH } from "@/lib/constants";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  patchSession,
  postJudge,
  postTurn,
} from "@/lib/api";
import { TranscriptCard } from "./TranscriptCard";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { SessionList } from "./SessionList";

type Phase =
  | "idle"
  | "geminiThinking"
  | "claudeThinking"
  | "awaitingDecision" // critique: user gate
  | "roundRunning" // consensus: participants in flight
  | "judging" // consensus: judge in flight
  | "stopped"
  | "converged"
  | "maxrounds";

const CRITIQUE_ROUND: Agent[] = ["gemini", "claude"];
const DEFAULT_MAX_ROUNDS = 5;
const MAX_ROUNDS_LIMIT = 20;

const LENGTHS: { value: ResponseLength; label: string }[] = [
  { value: "brief", label: "Brief" },
  { value: "standard", label: "Standard" },
  { value: "detailed", label: "Detailed" },
];

function messageFrom(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

// Map common upstream/API failures to a friendly sentence; fall back to the raw message.
function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("503") || m.includes("unavailable") || m.includes("high demand") || m.includes("overloaded")) {
    return "The model is temporarily busy (high demand). Please retry in a moment.";
  }
  if (m.includes("429") || m.includes("rate limit")) {
    return "Rate limited by the model provider. Please wait a few seconds and retry.";
  }
  if (m.includes("api key") || m.includes("authentication") || m.includes("x-api-key")) {
    return "The server's API key is missing or invalid. Check the server configuration.";
  }
  if (m.includes("unparseable")) {
    return "The judge returned malformed output. Please retry.";
  }
  return msg;
}

function mergeTurns(prev: Turn[], add: Turn[]): Turn[] {
  const map = new Map(prev.map((t) => [t.id, t]));
  for (const t of add) map.set(t.id, t);
  return [...map.values()].sort((a, b) => a.index - b.index);
}

function hasTurn(turns: Turn[], role: Turn["role"], round: number): boolean {
  return turns.some((t) => t.role === role && t.round === round);
}

/** The round to work on next in a consensus session (finishing a partial round, else the next). */
function nextConsensusRound(turns: Turn[]): number {
  const maxParticipant = turns
    .filter((t) => t.role === "gemini" || t.role === "claude")
    .reduce((m, t) => Math.max(m, t.round), 0);
  if (maxParticipant === 0) return 1;
  return hasTurn(turns, "judge", maxParticipant) ? maxParticipant + 1 : maxParticipant;
}

/** The most recent judge verdict in the transcript, or null. */
function lastVerdict(turns: Turn[]): JudgeVerdict | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const v = turns[i]!.verdict;
    if (v) return v;
  }
  return null;
}

export function DebateApp() {
  // Creation form
  const [prompt, setPrompt] = useState("");
  const [formMode, setFormMode] = useState<Mode>("critique");
  const [formLength, setFormLength] = useState<ResponseLength>("standard");
  const [formMaxRounds, setFormMaxRounds] = useState(DEFAULT_MAX_ROUNDS);

  // Active session
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("critique");
  const [responseLength, setResponseLength] = useState<ResponseLength>("standard");
  const [maxRounds, setMaxRounds] = useState<number | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [currentRound, setCurrentRound] = useState(0);

  // UX
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [pendingOp, setPendingOp] = useState(false);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false); // hard guard against concurrent rounds/loops
  const stopRef = useRef(false); // cooperative stop for the consensus loop
  const turnsRef = useRef<Turn[]>([]); // mirror of `turns` for closures inside the loop
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const busy = running || loadingSession || pendingOp;
  const showForm = sessionId === null && !loadingSession;
  const promptTooLong = prompt.length > MAX_PROMPT_LENGTH;
  const terminal = phase === "stopped" || phase === "converged" || phase === "maxrounds";

  function applyTurns(next: Turn[]) {
    turnsRef.current = next;
    setTurns(next);
  }

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
  }, [turns, phase, error, loadingSession]);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // ── Critique mode: sequential gemini → claude, user-gated ──────────────────
  async function runCritique(agents: Agent[], sid: string) {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i]!;
        setError(null);
        setRetry(null);
        setPhase(agent === "gemini" ? "geminiThinking" : "claudeThinking");
        try {
          const turn = await postTurn(sid, agent);
          applyTurns(mergeTurns(turnsRef.current, [turn]));
        } catch (e) {
          setError(messageFrom(e));
          const remaining = agents.slice(i);
          setRetry(() => () => runCritique(remaining, sid));
          await refreshSessions();
          return;
        }
      }
      setPhase("awaitingDecision");
      await refreshSessions();
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  // ── Consensus mode: parallel round → judge → auto-loop until converged/cap ─
  async function runConsensus(sid: string, cap: number) {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    stopRef.current = false;
    setError(null);
    setRetry(null);
    try {
      while (true) {
        if (stopRef.current) return;
        const round = nextConsensusRound(turnsRef.current);

        // Resume edge: the final round was judged without convergence.
        if (round > cap) {
          await patchSession(sid, { status: "maxrounds" });
          setPhase("maxrounds");
          await refreshSessions();
          return;
        }

        // Participants — run the missing ones (both, in parallel, in the normal case).
        const needG = !hasTurn(turnsRef.current, "gemini", round);
        const needC = !hasTurn(turnsRef.current, "claude", round);
        if (needG || needC) {
          setCurrentRound(round);
          setPhase("roundRunning");
          const calls: Promise<Turn>[] = [];
          if (needG) calls.push(postTurn(sid, "gemini"));
          if (needC) calls.push(postTurn(sid, "claude"));
          try {
            const results = await Promise.all(calls);
            applyTurns(mergeTurns(turnsRef.current, results));
          } catch (e) {
            setError(messageFrom(e));
            setRetry(() => () => runConsensus(sid, cap));
            await refreshSessions();
            return;
          }
        }

        if (stopRef.current) return;

        // Judge the completed round.
        setCurrentRound(round);
        setPhase("judging");
        let verdict: JudgeVerdict;
        try {
          const res = await postJudge(sid);
          verdict = res.verdict;
          applyTurns(mergeTurns(turnsRef.current, [res.turn]));
        } catch (e) {
          setError(messageFrom(e));
          setRetry(() => () => runConsensus(sid, cap));
          await refreshSessions();
          return;
        }

        // If the user pressed Stop while the judge was running, honor it — keep the
        // judge turn (already persisted) but don't drive into a terminal verdict state.
        if (stopRef.current) return;

        if (verdict.converged) {
          setPhase("converged");
          await refreshSessions();
          return;
        }
        if (round >= cap) {
          await patchSession(sid, { status: "maxrounds" });
          setPhase("maxrounds");
          await refreshSessions();
          return;
        }
        // Otherwise loop to the next round.
      }
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
    setRetry(null);
    const optimisticUser: Turn = {
      id: "local-user-0",
      index: 0,
      round: 0,
      role: "user",
      content: text,
      model: null,
      createdAt: new Date().toISOString(),
    };
    applyTurns([optimisticUser]);
    setMode(formMode);
    setResponseLength(formLength);
    setMaxRounds(formMode === "consensus" ? formMaxRounds : null);
    setCurrentRound(formMode === "consensus" ? 1 : 0);
    setPhase(formMode === "consensus" ? "roundRunning" : "geminiThinking");

    try {
      const sid = await createSession({
        initialPrompt: text,
        mode: formMode,
        responseLength: formLength,
        maxRounds: formMode === "consensus" ? formMaxRounds : null,
      });
      setSessionId(sid);
      setPrompt("");
      await refreshSessions();
      if (formMode === "consensus") await runConsensus(sid, formMaxRounds);
      else await runCritique(CRITIQUE_ROUND, sid);
    } catch (err) {
      setError(messageFrom(err));
      applyTurns([]);
      setSessionId(null);
      setPhase("idle");
    }
  }

  async function handleContinue() {
    if (!sessionId || busy) return;
    await runCritique(CRITIQUE_ROUND, sessionId);
  }

  async function handleStop() {
    if (!sessionId) return;
    stopRef.current = true; // cooperative halt for the consensus loop
    setPendingOp(true);
    try {
      await patchSession(sessionId, { status: "stopped" });
      setPhase("stopped");
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
      setError(null);
      await refreshSessions();
    } catch (err) {
      showToast(friendlyError(messageFrom(err)));
      setPendingOp(false);
      return;
    }
    setPendingOp(false);
    // Resume from where we left off.
    if (mode === "consensus") {
      await runConsensus(sessionId, maxRounds ?? DEFAULT_MAX_ROUNDS);
    } else {
      setPhase("awaitingDecision");
    }
  }

  async function selectSession(id: string) {
    if (busy || id === sessionId) return;
    setError(null);
    setRetry(null);
    setLoadingSession(true);
    setSessionId(id);
    try {
      const s = await getSession(id);
      setMode(s.mode);
      setResponseLength(s.responseLength);
      setMaxRounds(s.maxRounds);
      applyTurns(s.turns);
      setCurrentRound(nextConsensusRound(s.turns));
      setLoadingSession(false);

      if (s.status === "stopped") setPhase("stopped");
      else if (s.status === "converged") setPhase("converged");
      else if (s.status === "maxrounds") setPhase("maxrounds");
      else if (s.mode === "consensus") {
        await runConsensus(id, s.maxRounds ?? DEFAULT_MAX_ROUNDS);
      } else {
        setPhase("awaitingDecision");
      }
    } catch (err) {
      showToast(friendlyError(messageFrom(err)));
      setSessionId(null);
      applyTurns([]);
      setPhase("idle");
      setLoadingSession(false);
    }
  }

  function handleNew() {
    if (busy) return;
    setPhase("idle");
    setPrompt("");
    setSessionId(null);
    applyTurns([]);
    setError(null);
    setRetry(null);
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

  async function changeLength(next: ResponseLength) {
    if (!sessionId || busy || next === responseLength) return;
    const prev = responseLength;
    setResponseLength(next); // optimistic
    setPendingOp(true);
    try {
      await patchSession(sessionId, { responseLength: next });
      await refreshSessions();
    } catch (err) {
      setResponseLength(prev);
      showToast(friendlyError(messageFrom(err)));
    } finally {
      setPendingOp(false);
    }
  }

  const verdict = lastVerdict(turns);

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
          <header className="flex items-center justify-between gap-4 py-6">
            <div>
              <h1 className="font-serif text-2xl tracking-tight text-foreground">Dialectic</h1>
              <p className="font-serif text-sm text-muted">
                {showForm
                  ? "Gemini and Claude debate — you choose how."
                  : mode === "consensus"
                    ? "Consensus · Gemini and Claude negotiate, a judge decides convergence"
                    : "Critique · Gemini answers, Claude critiques"}
              </p>
            </div>
            {!showForm && (
              <div className="flex items-center gap-3">
                {mode === "consensus" && !terminal && (
                  <span className="font-mono text-xs text-muted">Round {currentRound}</span>
                )}
                <LengthControl value={responseLength} disabled={busy} onChange={changeLength} />
              </div>
            )}
          </header>

          {loadingSession ? (
            <div className="flex flex-1 items-center justify-center pb-24">
              <span className="font-mono text-xs text-muted">Loading debate…</span>
            </div>
          ) : showForm ? (
            <CreationForm
              prompt={prompt}
              setPrompt={setPrompt}
              mode={formMode}
              setMode={setFormMode}
              length={formLength}
              setLength={setFormLength}
              maxRounds={formMaxRounds}
              setMaxRounds={setFormMaxRounds}
              busy={busy}
              promptTooLong={promptTooLong}
              error={error}
              onStart={handleStart}
            />
          ) : (
            <main className="flex flex-1 flex-col gap-4 pb-32">
              {turns.map((t) => (
                <TranscriptCard key={t.id} turn={t} mode={mode} />
              ))}

              {phase === "geminiThinking" && !error && (
                <ThinkingIndicator role="gemini" verb={mode === "critique" ? "is answering" : undefined} />
              )}
              {phase === "claudeThinking" && !error && (
                <ThinkingIndicator role="claude" verb="is critiquing" />
              )}
              {phase === "roundRunning" && !error && (
                <div className="flex flex-col gap-3">
                  <ThinkingIndicator role="gemini" verb="is drafting" />
                  <ThinkingIndicator role="claude" verb="is drafting" />
                </div>
              )}
              {phase === "judging" && !error && <ThinkingIndicator role="judge" />}

              {error && (
                <div className="rounded-lg border-l-4 border-l-red-500 bg-red-500/5 px-4 py-3 ring-1 ring-red-500/20">
                  <p className="font-mono text-xs uppercase tracking-wider text-red-300">Error</p>
                  <p className="mt-1 font-mono text-[13px] leading-relaxed text-red-200/90">
                    {friendlyError(error)}
                  </p>
                  {retry && (
                    <button
                      onClick={() => retry()}
                      disabled={busy}
                      className="mt-3 rounded-md bg-foreground px-3 py-1.5 font-mono text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}

              {/* Critique gate */}
              {phase === "awaitingDecision" && (
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

              {/* Consensus: Stop is available while a round/judge is in flight */}
              {(phase === "roundRunning" || phase === "judging") && (
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={handleStop}
                    disabled={pendingOp}
                    className="rounded-md px-4 py-2 font-mono text-sm text-muted ring-1 ring-border transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Stop
                  </button>
                  <span className="font-mono text-xs text-muted">
                    Auto-looping until the judge declares consensus or round {maxRounds}.
                  </span>
                </div>
              )}

              {/* Terminal: converged */}
              {phase === "converged" && verdict?.consensusStatement && (
                <ConsensusBanner
                  tone="converged"
                  title="Consensus reached"
                  statement={verdict.consensusStatement}
                  divergences={[]}
                />
              )}

              {/* Terminal: maxrounds */}
              {phase === "maxrounds" && (
                <ConsensusBanner
                  tone="maxrounds"
                  title={`Stopped at the round cap (${maxRounds}) without full consensus`}
                  statement={verdict?.consensusStatement ?? null}
                  divergences={verdict?.divergences ?? []}
                />
              )}

              {/* Terminal: stopped */}
              {phase === "stopped" && (
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

// ── Sub-components ────────────────────────────────────────────────────────────

function LengthControl({
  value,
  disabled,
  onChange,
}: {
  value: ResponseLength;
  disabled: boolean;
  onChange: (v: ResponseLength) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md bg-card p-0.5 ring-1 ring-border">
      {LENGTHS.map((l) => (
        <button
          key={l.value}
          onClick={() => onChange(l.value)}
          disabled={disabled}
          title={`Response length: ${l.label}`}
          className={`rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            value === l.value ? "bg-foreground text-background" : "text-muted hover:text-foreground"
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

function CreationForm({
  prompt,
  setPrompt,
  mode,
  setMode,
  length,
  setLength,
  maxRounds,
  setMaxRounds,
  busy,
  promptTooLong,
  error,
  onStart,
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  length: ResponseLength;
  setLength: (l: ResponseLength) => void;
  maxRounds: number;
  setMaxRounds: (n: number) => void;
  busy: boolean;
  promptTooLong: boolean;
  error: string | null;
  onStart: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onStart} className="flex flex-1 flex-col justify-center gap-5 pb-24">
      {/* Mode toggle */}
      <div className="flex gap-2">
        {(["critique", "consensus"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-lg px-4 py-3 text-left ring-1 transition-colors ${
              mode === m ? "bg-card ring-foreground/40" : "ring-border hover:ring-foreground/20"
            }`}
          >
            <span className="font-mono text-sm text-foreground">
              {m === "critique" ? "Critique loop" : "Consensus"}
            </span>
            <span className="mt-1 block font-mono text-[11px] leading-snug text-muted">
              {m === "critique"
                ? "Gemini answers, Claude critiques. You gate each round."
                : "Both answer in parallel, then revise toward a judged consensus."}
            </span>
          </button>
        ))}
      </div>

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
            onStart(e);
          }
        }}
        rows={5}
        autoFocus
        maxLength={MAX_PROMPT_LENGTH}
        placeholder="e.g. Should governments implement a universal basic income?"
        className="w-full resize-none rounded-lg bg-card px-4 py-3 font-mono text-sm text-foreground ring-1 ring-border placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-gemini/50"
      />

      {/* Response length + (consensus) round cap */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">Length</span>
          <LengthControl value={length} disabled={busy} onChange={setLength} />
        </div>
        {mode === "consensus" && (
          <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
            Max rounds
            <input
              type="number"
              min={1}
              max={MAX_ROUNDS_LIMIT}
              value={maxRounds}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) setMaxRounds(Math.min(MAX_ROUNDS_LIMIT, Math.max(1, n)));
              }}
              className="w-16 rounded-md bg-card px-2 py-1 text-center font-mono text-sm text-foreground ring-1 ring-border focus:outline-none focus:ring-2 focus:ring-gemini/50"
            />
          </label>
        )}
      </div>

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
  );
}

function ConsensusBanner({
  tone,
  title,
  statement,
  divergences,
}: {
  tone: "converged" | "maxrounds";
  title: string;
  statement: string | null;
  divergences: string[];
}) {
  const accent = tone === "converged" ? "border-l-converged" : "border-l-claude";
  const titleColor = tone === "converged" ? "text-converged" : "text-claude";
  return (
    <div className={`rounded-lg border-l-4 bg-card px-5 py-4 ring-1 ring-border ${accent}`}>
      <p className={`font-mono text-xs font-medium uppercase tracking-wider ${titleColor}`}>
        {title}
      </p>
      {statement ? (
        <p className="mt-3 whitespace-pre-wrap font-serif text-base leading-relaxed text-foreground">
          {statement}
        </p>
      ) : (
        <p className="mt-3 font-mono text-xs text-muted">No consensus statement was produced.</p>
      )}
      {divergences.length > 0 && (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Remaining divergences
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {divergences.map((d, i) => (
              <li key={i} className="font-mono text-[12px] leading-relaxed text-foreground/80">
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
