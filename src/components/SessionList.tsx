import { useState } from "react";
import type { SessionMeta } from "@/lib/types";

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

type Handlers = {
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
};

type Props = Handlers & {
  sessions: SessionMeta[];
  activeId: string | null;
  busy: boolean;
  onNew: () => void;
};

export function SessionList({
  sessions,
  activeId,
  busy,
  onNew,
  onSelect,
  onRename,
  onDelete,
}: Props) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card/30 sm:w-64">
      <div className="flex items-center justify-between px-4 py-4">
        <span className="font-serif text-lg text-foreground">Debates</span>
        <button
          onClick={onNew}
          disabled={busy}
          className="rounded-md px-2 py-1 font-mono text-xs text-muted ring-1 ring-border transition-colors hover:text-foreground disabled:opacity-40"
        >
          + New
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 font-mono text-xs text-muted">No debates yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={s.id === activeId}
                busy={busy}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

function SessionItem({
  session,
  active,
  busy,
  onSelect,
  onRename,
  onDelete,
}: Handlers & { session: SessionMeta; active: boolean; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function saveRename() {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== session.title) onRename(session.id, title);
    else setDraft(session.title);
  }

  return (
    <li
      className={`rounded-md ${active ? "bg-card ring-1 ring-border" : "hover:bg-card/60"}`}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={saveRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveRename();
            if (e.key === "Escape") {
              setDraft(session.title);
              setEditing(false);
            }
          }}
          className="w-full rounded-md bg-background px-2 py-2 font-mono text-xs text-foreground ring-1 ring-gemini/50 focus:outline-none"
        />
      ) : (
        <button
          onClick={() => onSelect(session.id)}
          disabled={busy}
          className="flex w-full flex-col gap-1 px-2 py-2 text-left disabled:cursor-not-allowed"
        >
          <span className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                session.status === "active"
                  ? "bg-gemini"
                  : session.status === "converged"
                    ? "bg-converged"
                    : "bg-muted"
              }`}
            />
            <span className="truncate font-mono text-xs text-foreground">{session.title}</span>
          </span>
          <span className="flex items-center gap-1.5 pl-3.5 font-mono text-[10px] text-muted">
            <span
              className={`rounded px-1 py-0.5 uppercase tracking-wider ${
                session.mode === "consensus" ? "bg-claude/15 text-claude" : "bg-gemini/15 text-gemini"
              }`}
            >
              {session.mode === "consensus" ? "consensus" : "critique"}
            </span>
            <span>· {session.status} · {timeAgo(session.updatedAt)}</span>
          </span>
        </button>
      )}

      {!editing && (
        <div className="flex items-center gap-2 px-2 pb-2 pl-3.5">
          {confirmDelete ? (
            <>
              <span className="font-mono text-[10px] text-red-300">Delete?</span>
              <button
                onClick={() => {
                  setConfirmDelete(false);
                  onDelete(session.id);
                }}
                className="font-mono text-[10px] text-red-300 hover:text-red-200"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="font-mono text-[10px] text-muted hover:text-foreground"
              >
                No
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setDraft(session.title);
                  setEditing(true);
                }}
                disabled={busy}
                className="font-mono text-[10px] text-muted transition-colors hover:text-foreground disabled:opacity-40"
              >
                Rename
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="font-mono text-[10px] text-muted transition-colors hover:text-red-300 disabled:opacity-40"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
