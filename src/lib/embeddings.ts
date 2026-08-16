export const EMBED_DIM = Number(process.env.REWIND_EMBED_DIM ?? 768);

export function isOffline(): boolean {
  return process.env.REWIND_OFFLINE === "1";
}

/**
 * Embed text for semantic recall.
 *
 * Defaults to a local Ollama model — free, no credentials, no account. The
 * offline fallback below is for development without even that; it is crude
 * lexical overlap, not a semantic model, and nothing demoed may come from it.
 */
export async function embed(text: string): Promise<number[]> {
  if (isOffline()) return devEmbed(text);
  const { embedText } = await import("./llm");
  return embedText(text);
}

/** DEV ONLY. Deterministic hashed bag-of-words. See the caveat above. */
function devEmbed(text: string): number[] {
  const v = new Float64Array(EMBED_DIM);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
    }
    v[Math.abs(h) % EMBED_DIM] += 1;
    v[Math.abs(h >> 8) % EMBED_DIM] += 0.5;
  }
  let norm = Math.hypot(...v);
  if (norm === 0) norm = 1;
  return Array.from(v, (x) => x / norm);
}
