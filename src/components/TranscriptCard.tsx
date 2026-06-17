import type { Agent, Mode, Turn } from "@/lib/types";

const ROLE = {
  user: { label: "You", text: "text-user", accent: "border-l-user" },
  gemini: { label: "Gemini", text: "text-gemini", accent: "border-l-gemini" },
  claude: { label: "Claude", text: "text-claude", accent: "border-l-claude" },
  judge: { label: "Judge", text: "text-judge", accent: "border-l-judge" },
} as const;

export function TranscriptCard({
  turn,
  mode,
  starter,
}: {
  turn: Turn;
  mode: Mode;
  starter: Agent;
}) {
  const meta = ROLE[turn.role];
  // In critique mode the non-starter participant is the critic; tag its turns.
  const isCritic =
    mode === "critique" &&
    (turn.role === "gemini" || turn.role === "claude") &&
    turn.role !== starter;
  const label = isCritic ? `${meta.label} · critique` : meta.label;

  return (
    <article className={`rounded-lg border-l-4 bg-card ring-1 ring-border ${meta.accent}`}>
      <header className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs font-medium uppercase tracking-wider ${meta.text}`}>
            {label}
          </span>
          {turn.role !== "user" && turn.round > 0 && (
            <span className="font-mono text-[10px] text-muted">R{turn.round}</span>
          )}
          {turn.role === "judge" && turn.verdict && (
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                turn.verdict.converged
                  ? "bg-converged/15 text-converged"
                  : "bg-muted/15 text-muted"
              }`}
            >
              {turn.verdict.converged ? "converged" : "not yet"}
            </span>
          )}
        </div>
        {turn.model && <span className="font-mono text-[10px] text-muted">{turn.model}</span>}
      </header>

      <div className="whitespace-pre-wrap px-4 pb-4 pt-1 font-mono text-[13px] leading-relaxed text-foreground/90">
        {turn.content}
      </div>

      {turn.role === "judge" && turn.verdict && turn.verdict.divergences.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Remaining divergences
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {turn.verdict.divergences.map((d, i) => (
              <li key={i} className="font-mono text-[12px] leading-relaxed text-foreground/80">
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
