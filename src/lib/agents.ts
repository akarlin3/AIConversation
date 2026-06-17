import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { Agent, JudgeVerdict, Mode, ResponseLength, Role, Turn } from "./types";

export type { Agent };

/**
 * Agent configuration: model IDs, system prompts (editable constants), the
 * response-length map, the transcript flattener, and the three model callers
 * (Gemini participant, Claude participant, Opus judge). API keys are read from
 * env inside the callers and never leave the server.
 *
 * Three distinct model roles (do not conflate):
 *   - Gemini participant  → gemini-3.5-flash
 *   - Claude participant  → claude-sonnet-4-6   (Mode-A critic / Mode-B negotiator)
 *   - Judge               → claude-opus-4-8     (consensus convergence ruling)
 */

export const GEMINI_MODEL = "gemini-3.5-flash";
export const CLAUDE_PARTICIPANT_MODEL = "claude-sonnet-4-6";
export const JUDGE_MODEL = "claude-opus-4-8";

// ── Response-length presets ─────────────────────────────────────────────────
// Each preset maps to an instruction injected into the participant system
// prompt and a hard output-token cap. Thinking is disabled on participant calls
// so the cap bounds visible prose directly. Judge length is fixed (concise).
interface LengthPreset {
  instruction: string;
  maxTokens: number;
}
export const LENGTH_PRESETS: Record<ResponseLength, LengthPreset> = {
  brief: { instruction: "Keep it brief — about 150 words, tight and focused.", maxTokens: 256 },
  standard: { instruction: "Aim for about 400 words.", maxTokens: 700 },
  detailed: { instruction: "Be thorough — about 800 or more words.", maxTokens: 1400 },
};

// ── System prompts (default, editable) ──────────────────────────────────────
export const GEMINI_SYSTEM_PROMPT =
  "You are Gemini in a structured dialogue. {length} In Critique mode, answer the " +
  "prompt and, when Claude has critiqued you, address the critique honestly — concede, " +
  "defend, or revise. In Consensus mode, work toward a genuinely shared answer with " +
  "Claude: state your position, then converge where the evidence supports it without " +
  "capitulating on substance. Produce only your next contribution.";

export const CLAUDE_CRITIC_SYSTEM_PROMPT =
  "You are Claude, a rigorous non-sycophantic critic of Gemini's most recent response. " +
  "{length} Evaluate correctness, reasoning, completeness, and hidden assumptions. Name " +
  "concrete weaknesses and what would improve them. Do not rewrite Gemini's answer — " +
  "critique it. Produce only your critique.";

export const CLAUDE_NEGOTIATOR_SYSTEM_PROMPT =
  "You are Claude negotiating a consensus answer with Gemini. {length} Give your own best " +
  "answer; in later rounds, integrate Gemini's valid points and flag remaining " +
  "disagreements explicitly. Converge on substance, not by deferring. Produce only your " +
  "next contribution.";

export const JUDGE_SYSTEM_PROMPT =
  "You are an impartial judge deciding whether Gemini and Claude have converged on a " +
  "consensus answer to the user's prompt. Superficial similarity is not consensus; require " +
  "substantive agreement on the key claims. Return ONLY valid JSON, no prose, no code " +
  'fences: {"converged": boolean, "rationale": string, "divergences": string[], ' +
  '"consensusStatement": string|null}. Set consensusStatement to the merged answer when ' +
  "converged is true OR when this is the final round; otherwise null.";

const ROLE_LABEL: Record<Role, string> = {
  user: "[USER PROMPT]",
  gemini: "[GEMINI]",
  claude: "[CLAUDE]",
  judge: "[JUDGE]",
};

/** Render the ordered turns into one labeled transcript block. */
export function flattenTranscript(turns: Turn[]): string {
  return turns.map((t) => `${ROLE_LABEL[t.role]}\n${t.content}`).join("\n\n");
}

function trailingInstruction(agent: Agent, mode: Mode): string {
  if (mode === "critique") {
    return agent === "gemini"
      ? "Produce your next response."
      : "Produce your critique of Gemini's most recent response.";
  }
  return "Produce your next contribution toward a shared answer.";
}

/** Pick the participant system prompt for (agent, mode) and inject the length instruction. */
function systemPromptFor(agent: Agent, mode: Mode, length: ResponseLength): string {
  const base =
    agent === "gemini"
      ? GEMINI_SYSTEM_PROMPT
      : mode === "critique"
        ? CLAUDE_CRITIC_SYSTEM_PROMPT
        : CLAUDE_NEGOTIATOR_SYSTEM_PROMPT;
  return base.replace("{length}", LENGTH_PRESETS[length].instruction);
}

/** Flattened transcript + the agent's trailing instruction = the single user message. */
function buildUserMessage(turns: Turn[], agent: Agent, mode: Mode): string {
  return `${flattenTranscript(turns)}\n\n${trailingInstruction(agent, mode)}`;
}

export interface TurnOptions {
  mode: Mode;
  responseLength: ResponseLength;
}

async function runGemini(turns: Turn[], opts: TurnOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildUserMessage(turns, "gemini", opts.mode),
    config: {
      systemInstruction: systemPromptFor("gemini", opts.mode, opts.responseLength),
      maxOutputTokens: LENGTH_PRESETS[opts.responseLength].maxTokens,
      // Disable thinking so maxOutputTokens bounds the visible answer, not silent reasoning.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

async function runClaudeParticipant(turns: Turn[], opts: TurnOptions): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: CLAUDE_PARTICIPANT_MODEL,
    max_tokens: LENGTH_PRESETS[opts.responseLength].maxTokens,
    // Thinking off: the length cap then bounds the visible response directly.
    thinking: { type: "disabled" },
    system: systemPromptFor("claude", opts.mode, opts.responseLength),
    messages: [{ role: "user", content: buildUserMessage(turns, "claude", opts.mode) }],
  });

  const text = textOf(response);
  if (!text) throw new Error("Claude returned an empty response.");
  return text;
}

/** Collect all text blocks from an Anthropic message into a single trimmed string. */
function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Call the chosen participant over the given context turns and return its contribution. */
export function runAgent(agent: Agent, turns: Turn[], opts: TurnOptions): Promise<string> {
  return agent === "gemini" ? runGemini(turns, opts) : runClaudeParticipant(turns, opts);
}

export function modelIdFor(agent: Agent): string {
  return agent === "gemini" ? GEMINI_MODEL : CLAUDE_PARTICIPANT_MODEL;
}

// ── Judge (Opus) ────────────────────────────────────────────────────────────

/** Call the judge over the full transcript. Returns the raw model text (JSON expected). */
export async function runJudge(turns: Turn[], finalRound: boolean): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const client = new Anthropic({ apiKey });
  const instruction = finalRound
    ? "This is the final round. Decide whether they converged, and provide your best merged consensusStatement regardless. Return ONLY the JSON object."
    : "Decide whether Gemini and Claude have converged. Return ONLY the JSON object.";

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2000,
    thinking: { type: "disabled" },
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `${flattenTranscript(turns)}\n\n${instruction}` }],
  });

  const text = textOf(response);
  if (!text) throw new Error("Judge returned an empty response.");
  return text;
}

/**
 * Robustly parse a JudgeVerdict from raw model text: strip code fences, then take
 * the first balanced `{…}` object. Returns null on any failure (caller returns 502).
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict | null {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const candidate = extractFirstObject(stripped);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const o = parsed as Record<string, unknown>;
  if (typeof o.converged !== "boolean") return null;
  if (typeof o.rationale !== "string") return null;

  const divergences = Array.isArray(o.divergences)
    ? o.divergences.filter((d): d is string => typeof d === "string")
    : [];
  const consensusStatement =
    typeof o.consensusStatement === "string" ? o.consensusStatement : null;

  return { converged: o.converged, rationale: o.rationale, divergences, consensusStatement };
}

/** Return the first balanced {…} substring, or null if there isn't one. */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
