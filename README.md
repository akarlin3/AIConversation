# Dialectic

A structured-debate app with **two modes** over a question you pose:

- **Critique loop** — one model answers and the other critiques, with *you* deciding whether the debate continues. You pick **who answers first** (Gemini or Claude) when starting the debate; the other model becomes the critic. On _Continue_, the answerer responds to the critique, the critic critiques again, and so on (user-gated each round).
- **Consensus** — Gemini and Claude answer the prompt **independently and in parallel** in round 1 (neither sees the other). Each later round, both revise against the full transcript. After every round a separate **judge** (Claude Opus) decides whether they've converged. It auto-loops until converged or `maxRounds`; a **Stop** button halts at any time.

Both modes have a **response-length control** (brief / standard / detailed), editable mid-session. Every debate is saved and resumable.

- **Stack:** Next.js (App Router) · TypeScript (strict) · Tailwind v4 · dark-mode-only UI (Newsreader for prose, JetBrains Mono for the transcript).
- **Three model roles:**
  - Gemini participant — `gemini-3.5-flash` (`@google/genai`)
  - Claude participant — `claude-sonnet-4-6` (`@anthropic-ai/sdk`)
  - Judge (consensus convergence ruling) — `claude-opus-4-8`
  - In critique mode either participant can be the answerer or the critic (set per session); in consensus both negotiate.
- **Persistence:** Firebase Firestore via the **Admin SDK**, used **only inside API routes**.

---

## Security model

**The browser never touches Firestore or any API key.**

- `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and the Firebase Admin credentials are read **only** in server-side API routes (`src/app/api/**`) via `process.env`. They are never imported into client components and never prefixed with `NEXT_PUBLIC_`, so they are not in the client bundle. (`src/lib/types.ts` does `import type { Timestamp }` from `firebase-admin` — a type-only import, fully erased at compile time.)
- All Firestore reads/writes go through the Firebase **Admin SDK** (`src/lib/firebaseAdmin.ts`), which runs server-side only. The client talks exclusively to this app's own `/api/*` routes.
- `firestore.rules` denies all client access (`allow read, write: if false`). The Admin SDK bypasses rules; the deny-all rule ensures that even if a client obtained config, it could not read or write the database directly.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.local.example .env.local
```

Fill in `.env.local`:

```
GEMINI_API_KEY=...        # https://aistudio.google.com/apikey
ANTHROPIC_API_KEY=...     # https://console.anthropic.com/settings/keys

# Firebase Admin (service-account JSON: Firebase console → Project settings → Service accounts)
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

The private key is stored on one line with literal `\n` escapes; the app restores real newlines at runtime.

### 3. Run

```bash
npm run dev      # http://localhost:3000
```

### Local development with the Firestore emulator (no cloud project needed)

Instead of real Firebase Admin credentials, point the Admin SDK at the local emulator. Add to `.env.local`:

```
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_PROJECT_ID=demo-dialectic
```

Then, in a separate terminal (requires the Firebase CLI and a JRE):

```bash
firebase emulators:start --only firestore --project demo-dialectic
```

When `FIRESTORE_EMULATOR_HOST` is set, `src/lib/firebaseAdmin.ts` initializes without service-account credentials.

---

## Architecture

### Data model (Firestore)

- `sessions/{sessionId}` → `{ title, mode: 'critique' | 'consensus', responseLength: 'brief' | 'standard' | 'detailed', maxRounds: number | null, starter: 'gemini' | 'claude', status: 'active' | 'stopped' | 'converged' | 'maxrounds', createdAt, updatedAt }`
  - `maxRounds` is set only for consensus sessions.
  - `starter` is the participant that answers first in critique mode (the other critiques); irrelevant for consensus and defaults to `gemini`.
- `sessions/{sessionId}/turns/{turnId}` → `{ index, round, role: 'user' | 'gemini' | 'claude' | 'judge', content, model, verdict?, createdAt }`
  - `index` is monotonic (global ordering); `round` groups a negotiation cycle (0 = user prompt). Turns are a subcollection to avoid the 1 MB document cap on long debates.
  - `verdict` (judge turns only) is a `JudgeVerdict`: `{ converged, rationale, divergences[], consensusStatement | null }`.

### Response-length presets

Each preset maps to (a) an instruction injected into the participant system prompt and (b) an output-token cap. Thinking is disabled on participant calls so the cap bounds visible prose directly.

| Preset | Instruction | Token cap |
| --- | --- | --- |
| `brief` | ~150 words, tight | 256 |
| `standard` | ~400 words | 700 |
| `detailed` | ~800+ words, thorough | 1400 |

### API routes (all server-side, Node runtime)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/sessions` | Create from `{ initialPrompt, mode, responseLength, maxRounds?, starter?, title? }`; writes the index-0 / round-0 `user` turn. `starter` (`gemini`\|`claude`, default `gemini`) sets who answers first in critique mode. |
| `GET` | `/api/sessions` | List sessions (newest-updated first). |
| `GET` | `/api/sessions/[id]` | Session meta + all turns ordered by `index`. |
| `PATCH` | `/api/sessions/[id]` | Rename / set status / set `responseLength`. |
| `DELETE` | `/api/sessions/[id]` | Delete the session and its turns. |
| `POST` | `/api/turn` | Body `{ sessionId, agent }`: derive the round, build the context, call the participant model, append the turn. Model errors return **502** (with a message), never an HTML 500. |
| `POST` | `/api/judge` | Body `{ sessionId }` (consensus only): call the Opus judge over the full transcript, parse a strict `JudgeVerdict`, store a `judge` turn, and flip the session to `converged` when applicable. Unparseable output returns **502** with the raw text. |

**Round derivation & context (`/api/turn`):** a new turn's round = (count of that agent's existing turns) + 1. Context is the **full transcript** in critique mode; in consensus mode it is restricted to **earlier rounds** (`round < newRound`), which enforces round-1 independence (each participant sees only the user prompt) and, in later rounds, prevents either participant from seeing the other's same-round answer. The judge always sees the complete transcript.

### Prompt construction

Each agent receives a **system prompt** (its role + the length instruction; editable constants in `src/lib/agents.ts`) plus a single user message containing the flattened transcript followed by a trailing instruction. In critique mode the prompts are role-based (answerer vs critic) rather than model-bound, so the `starter`/critic assignment is filled in per call:

```
[USER PROMPT]
{content}

[GEMINI]
{content}

[CLAUDE]
{content}

[JUDGE]
{rationale}
...
```

### Frontend state machines

- **Critique:** `idle → answererThinking → criticThinking → awaitingDecision`, plus `stopped`. The thinking phases are the per-model `geminiThinking`/`claudeThinking` states, ordered by the session's `starter` (answerer first, critic second). Continue re-runs the answerer→critic pair; Stop sets `status=stopped` (read-only, with Reopen).
- **Consensus:** `idle → roundRunning (gemini + claude in parallel) → judging (POST /api/judge) → evaluate`:
  - `verdict.converged` → `converged` (renders the `consensusStatement` prominently).
  - else `round === maxRounds` → `maxrounds` (renders the judge's final `consensusStatement` + remaining `divergences`).
  - else → next `roundRunning` (auto-loop).
  - **Stop** is available throughout → `PATCH status=stopped`. A `runningRef` guard prevents the auto-loop from double-firing a round; a cooperative `stopRef` halts the loop at the next checkpoint.

A failed turn/round surfaces an inline error with **Retry** that resumes without duplicating completed turns. v1 is non-streaming, with per-agent "thinking" indicators and (consensus) a round counter.

### Resume

The sidebar lists every session (title, mode badge, status, updated-at). Loading a session restores the full transcript and:

- `active` critique → resume at Continue/Stop.
- `active` consensus → resume the auto-loop from the next (or partially-completed) round.
- `converged` / `maxrounds` → read-only, showing the judge's consensus statement.
- `stopped` → read-only, with Reopen.

---

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build
npm run start    # serve the production build
npm run lint     # ESLint
npx tsc --noEmit # type-check
```

## Project layout

```
src/
  app/
    api/sessions/route.ts        # POST, GET
    api/sessions/[id]/route.ts   # GET, PATCH, DELETE
    api/turn/route.ts            # POST (gemini | claude) — round derivation + context
    api/judge/route.ts           # POST — Opus judge, strict JudgeVerdict
    layout.tsx, page.tsx, globals.css
  components/
    DebateApp.tsx                # client state machines (both modes) + layout
    SessionList.tsx              # sidebar (load / rename / delete, mode badge)
    TranscriptCard.tsx           # role-distinct cards incl. judge verdict
    ThinkingIndicator.tsx
  lib/
    firebaseAdmin.ts             # Admin SDK singleton (server only)
    agents.ts                    # model IDs, system prompts, length presets, judge + parser
    sessions.ts                  # Firestore data access
    api.ts                       # browser → /api helpers
    types.ts, http.ts, constants.ts
firestore.rules                  # deny-all (client has no Firestore access)
firebase.json                    # Firestore emulator config
```
