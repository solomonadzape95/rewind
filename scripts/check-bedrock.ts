/** One-shot preflight: can this AWS account actually reach the models Rewind needs? */
import { chatJson, embedText, CHAT_MODEL } from "../src/lib/llm";

async function main() {
  try {
    const v = await embedText("hello");
    console.log(`embeddings OK — ${v.length} dims`);
  } catch (e) {
    console.log("embeddings FAILED:", (e as Error).message.slice(0, 200));
  }
  try {
    const d = await chatJson<{ ok: boolean }>({
      system: "You are a health check.",
      user: 'Reply with {"ok": true}',
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
      maxTokens: 64,
    });
    console.log(`chat OK — ${CHAT_MODEL} returned`, d);
  } catch (e) {
    console.log(`chat FAILED (${CHAT_MODEL}):`, (e as Error).message.slice(0, 300));
  }
}
main();
