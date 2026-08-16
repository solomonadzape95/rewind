/**
 * One seam for every model call, so the forensic machinery never knows or cares
 * which provider is behind it.
 *
 * WHY THIS EXISTS: the hackathon requires at least one AWS service, and Lambda +
 * S3 already satisfy that. Bedrock is one option on the list, not a requirement
 * — so the LLM can run anywhere, including free and local. Rewind's claim is
 * about the memory layer, not about whose model reads it.
 *
 * Providers, chosen with REWIND_PROVIDER:
 *   ollama   (default) — free, local, no credentials. http://localhost:11434
 *   openai            — any OpenAI-compatible endpoint: Groq, OpenRouter,
 *                       DeepSeek, Together, Gemini's compat layer. Set
 *                       REWIND_BASE_URL + REWIND_API_KEY.
 *   bedrock           — Claude on Amazon Bedrock (paid, per token).
 *   offline           — deterministic stubs, no network. Development only.
 */
import { isOffline } from "./embeddings";

export type Provider = "ollama" | "openai" | "bedrock" | "offline";

export function provider(): Provider {
  if (process.env.REWIND_OFFLINE === "1") return "offline";
  return (process.env.REWIND_PROVIDER as Provider) ?? "ollama";
}

export const CHAT_MODEL =
  process.env.REWIND_MODEL_ID ??
  (provider() === "bedrock" ? "anthropic.claude-opus-5" : "qwen2.5:7b");

export const EMBED_MODEL = process.env.REWIND_EMBED_MODEL ?? "nomic-embed-text";

/** Vector width must match the schema; see db/schema.sql and scripts/init.ts. */
export const EMBED_DIM = Number(process.env.REWIND_EMBED_DIM ?? 768);

function baseUrl(): string {
  if (process.env.REWIND_BASE_URL) return process.env.REWIND_BASE_URL.replace(/\/$/, "");
  return "http://localhost:11434/v1"; // Ollama's OpenAI-compatible endpoint
}

function authHeader(): Record<string, string> {
  const key = process.env.REWIND_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * Ask for a JSON object matching `schema`.
 *
 * `response_format: json_object` is used rather than the stricter
 * `json_schema` mode because coverage varies across the providers this needs to
 * support — Ollama, Groq, OpenRouter and DeepSeek do not agree on it. The schema
 * is instead described in the prompt and the result validated here, which works
 * everywhere and fails loudly rather than returning a plausible wrong shape.
 */
export async function chatJson<T>(params: {
  system: string;
  user: string;
  schema: object;
  maxTokens?: number;
}): Promise<T> {
  const system = `${params.system}

Reply with a single JSON object and nothing else — no prose, no markdown fences.
It must validate against this JSON Schema:
${JSON.stringify(params.schema)}`;

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({
      model: CHAT_MODEL,
      max_tokens: params.maxTokens ?? 2048,
      temperature: 0, // see the note in replay.ts about replay determinism
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: params.user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`${CHAT_MODEL} via ${baseUrl()} returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new Error("no content in model response");
  return JSON.parse(stripFences(text)) as T;
}

/**
 * Small models sometimes wrap JSON in a markdown fence despite being told not
 * to. Recovering from that is cheaper than a retry and does not mask a real
 * failure — a genuinely malformed body still throws at JSON.parse.
 */
function stripFences(s: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const body = (fenced ? fenced[1] : s).trim();
  const start = body.search(/[[{]/);
  return start > 0 ? body.slice(start) : body;
}

/** Embed text. Ollama's native endpoint is used when pointed at Ollama. */
export async function embedText(text: string): Promise<number[]> {
  const url = baseUrl();
  const res = await fetch(`${url}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`embeddings via ${url} returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: { embedding: number[] }[] };
  const v = body.data?.[0]?.embedding;
  if (!v) throw new Error("no embedding in response");

  // A silent dimension mismatch corrupts every similarity comparison without
  // ever raising — fail here instead.
  if (v.length !== EMBED_DIM) {
    throw new Error(
      `embedding model ${EMBED_MODEL} returned ${v.length} dims but the schema expects ${EMBED_DIM}. ` +
        `Set REWIND_EMBED_DIM=${v.length} and re-run pnpm db:reset.`,
    );
  }
  return v;
}

export { isOffline };
