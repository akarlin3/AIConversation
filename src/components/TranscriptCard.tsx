import type { Turn } from "@/lib/types";

const ROLE = {
  user: { label: "You", text: "text-user", accent: "border-l-user" },
  gemini: { label: "Gemini", text: "text-gemini", accent: "border-l-gemini" },
  claude: { label: "Claude · critique", text: "text-claude", accent: "border-l-claude" },
} as const;

export function TranscriptCard({ turn }: { turn: Turn }) {
  const meta = ROLE[turn.role];
  return (
    <article className={`rounded-lg border-l-4 bg-card ring-1 ring-border ${meta.accent}`}>
      <header className="flex items-center justify-between px-4 pb-1 pt-3">
        <span className={`font-mono text-xs font-medium uppercase tracking-wider ${meta.text}`}>
          {meta.label}
        </span>
        {turn.model && <span className="font-mono text-[10px] text-muted">{turn.model}</span>}
      </header>
      <div className="whitespace-pre-wrap px-4 pb-4 pt-1 font-mono text-[13px] leading-relaxed text-foreground/90">
        {turn.content}
      </div>
    </article>
  );
}
