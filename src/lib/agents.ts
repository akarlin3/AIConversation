import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { Agent, Role, Turn } from "./types";

export type { Agent };

/**
 * Agent configuration: model IDs, system prompts (editable constants), the
 * transcript flattener, and the two model callers. Keys are read from env
 * inside the callers and never leave the server.
 */

export const GEMINI_MODEL = "gemini-3.5-flash";
export const CLAUDE_MODEL = "claude-opus-4-8";

// ── System prompts (default, editable) ──────────────────────────────────────
export const GEMINI_SYSTEM_PROMPT =
  "You are Gemini, a capable assistant participating in a structured dialogue. " +
  "Answer the user's prompt directly and thoroughly. When Claude has critiqued your " +
  "previous response, address the critique honestly — concede valid points, defend or " +
  "revise as warranted. Produce only your next contribution.";

export const CLAUDE_SYSTEM_PROMPT =
  "You are Claude, acting as a rigorous, non-sycophantic critic of Gemini's most recent " +
  "response in this dialogue. Evaluate correctness, reasoning, completeness, and unstated " +
  "assumptions. Be specific and direct; name concrete weaknesses and what would improve the " +
  "answer. Do not rewrite Gemini's answer — critique it. Produce only your critique.";

// Trailing instruction appended to the flattened transcript.
const TRAILING_INSTRUCTION: Record<Agent, string> = {
  gemini: "Produce your next response.",
  claude: "Produce your critique of Gemini's most recent response.",
};

const ROLE_LABEL: Record<Role, string> = {
  user: "[USER PROMPT]",
  gemini: "[GEMINI]",
  claude: "[CLAUDE — critique]",
};

/** Render the ordered turns into one labeled transcript block. */
export function flattenTranscript(turns: Turn[]): string {
  return turns.map((t) => `${ROLE_LABEL[t.role]}\n${t.content}`).join("\n\n");
}

/** Flattened transcript + the agent's trailing instruction = the single user message. */
function buildUserMessage(turns: Turn[], agent: Agent): string {
  return `${flattenTranscript(turns)}\n\n${TRAILING_INSTRUCTION[agent]}`;
}

async function runGemini(turns: Turn[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildUserMessage(turns, "gemini"),
    config: {
      systemInstruction: GEMINI_SYSTEM_PROMPT,
      maxOutputTokens: 8192,
    },
  });

  const text = response.text?.trim();
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

async function runClaude(turns: Turn[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" }, // sharper critique; thinking blocks are not surfaced
    system: CLAUDE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(turns, "claude") }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude returned an empty response.");
  return text;
}

/** Call the chosen agent over the full transcript and return its text contribution. */
export function runAgent(agent: Agent, turns: Turn[]): Promise<string> {
  return agent === "gemini" ? runGemini(turns) : runClaude(turns);
}

export function modelIdFor(agent: Agent): string {
  return agent === "gemini" ? GEMINI_MODEL : CLAUDE_MODEL;
}
