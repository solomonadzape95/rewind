import { createHash } from "node:crypto";
import { isOffline } from "./embeddings";
import { chatJson, CHAT_MODEL } from "./llm";

export const MODEL_ID = CHAT_MODEL;

/**
 * The support agent's system prompt.
 *
 * Hashed onto every decision. If this string changes, replay of an older
 * decision is no longer a clean experiment and the verdict engine must say so
 * rather than issue a confident ruling — see verdict() in replay.ts.
 */
export const SYSTEM_PROMPT = `You are a customer support agent for a B2B SaaS company, authorized to approve refunds.

You will be given the customer's request and the relevant memories you hold about
company policy and this account. Decide on exactly one action.

Rules:
- Base your decision ONLY on the memories provided. Do not use outside knowledge
  about what refund limits "should" be.
- If a memory states a policy limit, that limit is authoritative.
- Approve a refund only if it is within the policy limits in your memories.
- If the request exceeds a limit, deny it or escalate to a human.`;

export const PROMPT_HASH = sha256(SYSTEM_PROMPT);

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export interface Decision {
  action: "approve_refund" | "deny_refund" | "escalate";
  amount: number;
  rationale: string;
}

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["approve_refund", "deny_refund", "escalate"],
      description: "The single action to take.",
    },
    amount: {
      type: "number",
      description: "Refund amount in USD. 0 if no refund is being approved.",
    },
    rationale: {
      type: "string",
      description:
        "One or two sentences citing the specific memory that drove this decision.",
    },
  },
  required: ["action", "amount", "rationale"],
  additionalProperties: false,
} as const;

/**
 * Ask the model for a decision, given a fixed set of memories.
 *
 * Note on determinism: `temperature: 0` is requested, but no provider treats it
 * as a hard guarantee — and on some (Claude on Bedrock) the parameter is
 * rejected outright. This is why the verdict engine replays several times and
 * treats disagreement across runs as its own verdict rather than silently
 * attributing model variance to a memory change.
 */
export async function decide(params: {
  input: string;
  memories: { subject: string; content: string }[];
}): Promise<Decision> {
  const memoryBlock = params.memories
    .map((m) => `- [${m.subject}] ${m.content}`)
    .join("\n");

  if (isOffline()) return devDecide(params.input, memoryBlock);

  const d = await chatJson<Decision>({
    system: SYSTEM_PROMPT,
    user: `Your memories:\n${memoryBlock}\n\nCustomer request:\n${params.input}`,
    schema: DECISION_SCHEMA,
  });

  if (!["approve_refund", "deny_refund", "escalate"].includes(d.action)) {
    throw new Error(`model returned an unknown action: ${d.action}`);
  }
  return { ...d, amount: Number(d.amount) || 0 };
}

/**
 * DEV ONLY — a rule-based stand-in so the memory layer, replay engine, and
 * bisection can be exercised with no model at all.
 *
 * It is a faithful stand-in for one property only: it reads the refund limit
 * out of the supplied memories and obeys it, which is enough to make the
 * poisoning scenario reproduce. It is NOT the agent, and nothing recorded or
 * shown in the demo may come from it. Decisions produced here are tagged in the
 * rationale so they can never be mistaken for real model output later.
 */
function devDecide(input: string, memoryBlock: string): Decision {
  const limit = Number(
    /limit is \$([\d,]+)/i.exec(memoryBlock)?.[1].replace(/,/g, "") ?? "0",
  );
  const requested = Number(
    /\$([\d,]+(?:\.\d+)?)/.exec(input)?.[1].replace(/,/g, "") ?? "0",
  );
  const approve = requested > 0 && requested <= limit;
  return {
    action: approve ? "approve_refund" : "deny_refund",
    amount: approve ? requested : 0,
    rationale: `[dev-stub, not model output] Requested $${requested} against a policy limit of $${limit}.`,
  };
}
