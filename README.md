# Dialectic

A structured debate app: you pose a question, **Gemini** answers it, **Claude** critiques the answer, and you decide whether the debate continues. On _Continue_, Gemini responds to Claude's critique, Claude critiques again, and so on. Every debate is saved and resumable.

- **Stack:** Next.js (App Router) · TypeScript (strict) · Tailwind v4 · dark-mode-only UI (Newsreader for prose, JetBrains Mono for the transcript).
- **Models:** Gemini `gemini-3.5-flash` (`@google/genai`) · Claude `claude-opus-4-8` (`@anthropic-ai/sdk`, adaptive thinking).
- **Persistence:** Firebase Firestore via the **Admin SDK**, used **only inside API routes**.

---

## Security model

**The browser never touches Firestore or any API key.**

- `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and the Firebase Admin credentials are read **only** in server-side API routes (`src/app/api/**`) via `process.env`. They are never imported into client components and never prefixed with `NEXT_PUBLIC_`, so they are not in the client bundle.
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

Instead of real Firebase Admin credentials, you can point the Admin SDK at the local emulator. Add to `.env.local`:

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

- `sessions/{sessionId}` → `{ title, status: 'active' | 'stopped', createdAt, updatedAt }`
- `sessions/{sessionId}/turns/{turnId}` → `{ index, role: 'user' | 'gemini' | 'claude', content, model, createdAt }`
  - `index` is monotonic and used for ordering. Turns are a subcollection to avoid the 1 MB document cap on long debates.

### API routes (all server-side, Node runtime)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/sessions` | Create a session from `{ initialPrompt, title? }`; writes the index-0 `user` turn. |
| `GET` | `/api/sessions` | List sessions (newest-updated first). |
| `GET` | `/api/sessions/[id]` | Session meta + all turns ordered by `index`. |
| `PATCH` | `/api/sessions/[id]` | Rename and/or set status (`active` / `stopped`). |
| `DELETE` | `/api/sessions/[id]` | Delete the session and its turns. |
| `POST` | `/api/turn` | Body `{ sessionId, agent }`: read the ordered transcript → call the model → append the new turn → bump `updatedAt`. Model errors return **502** (with a message), never an HTML 500. |

### Prompt construction

Each agent receives a **system prompt** (its role, an editable constant in `src/lib/agents.ts`) plus a single user message containing the full flattened transcript followed by a trailing instruction:

```
[USER PROMPT]
{content}

[GEMINI]
{content}

[CLAUDE — critique]
{content}
...
```

### Frontend state machine

`idle → geminiThinking → claudeThinking → awaitingDecision`, plus `stopped`.

- Start → `POST /api/sessions` → `POST /api/turn {gemini}` → `POST /api/turn {claude}` → `awaitingDecision`.
- Continue → `POST /api/turn {gemini}` → `POST /api/turn {claude}` → `awaitingDecision`.
- Stop → `PATCH status=stopped` → read-only (with Reopen).

A failed turn surfaces an inline error with **Retry** that resumes the round from the failed step (no duplicate turns). v1 is non-streaming, with per-agent "thinking" indicators.

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
    api/turn/route.ts            # POST (gemini | claude)
    layout.tsx, page.tsx, globals.css
  components/
    DebateApp.tsx                # client state machine + layout
    SessionList.tsx              # sidebar (load / rename / delete)
    TranscriptCard.tsx, ThinkingIndicator.tsx
  lib/
    firebaseAdmin.ts             # Admin SDK singleton (server only)
    agents.ts                    # model IDs, system prompts, transcript flattener, callers
    sessions.ts                  # Firestore data access
    api.ts                       # browser → /api helpers
    types.ts, http.ts, constants.ts
firestore.rules                  # deny-all (client has no Firestore access)
firebase.json                    # Firestore emulator config
```
