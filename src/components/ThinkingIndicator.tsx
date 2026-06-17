type IndicatorRole = "gemini" | "claude" | "judge";

const META: Record<IndicatorRole, { label: string; text: string; accent: string; verb: string }> = {
  gemini: { label: "Gemini", text: "text-gemini", accent: "border-l-gemini", verb: "is thinking" },
  claude: { label: "Claude", text: "text-claude", accent: "border-l-claude", verb: "is thinking" },
  judge: { label: "Judge", text: "text-judge", accent: "border-l-judge", verb: "is deliberating" },
};

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
      style={{ animationDelay: delay }}
    />
  );
}

export function ThinkingIndicator({ role, verb }: { role: IndicatorRole; verb?: string }) {
  const meta = META[role];
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border-l-4 bg-card px-4 py-3 ring-1 ring-border ${meta.accent}`}
      aria-live="polite"
    >
      <span className={`font-mono text-xs font-medium uppercase tracking-wider ${meta.text}`}>
        {meta.label}
      </span>
      <span className={`flex items-center gap-1 ${meta.text}`}>
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </span>
      <span className="font-mono text-xs text-muted">{verb ?? meta.verb}…</span>
    </div>
  );
}
