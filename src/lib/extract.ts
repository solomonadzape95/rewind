import { isOffline } from "./embeddings";
import { chatJson } from "./llm";

export interface BeliefUpdate {
  subject: string;
  content: string;
  confidence: number;
}

/**
 * Trust is a property of the ingestion channel, not of the document.
 *
 * A PDF that arrives in an inbound bucket from an unauthenticated sender is
 * low-trust no matter how official it reads — which is exactly the property the
 * injected document exploits, and exactly what lets the verdict engine accuse
 * the resulting write later. Set `x-amz-meta-trust` on the object to override.
 */
export function trustForKey(key: string, override?: string): number {
  const explicit = Number(override);
  if (Number.isFinite(explicit) && explicit >= 0 && explicit <= 1) return explicit;
  if (key.startsWith("policies/") || key.startsWith("internal/")) return 1.0;
  if (key.startsWith("inbound/") || key.startsWith("email/")) return 0.2;
  return 0.5;
}

const BELIEF_SCHEMA = {
  type: "object",
  properties: {
    beliefs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description:
              "Stable dotted key for the fact, e.g. policy.refund_limit.enterprise. " +
              "Reuse the existing key when updating a known fact.",
          },
          content: {
            type: "string",
            description: "The fact as a single self-contained sentence.",
          },
          confidence: { type: "number", description: "0 to 1." },
        },
        required: ["subject", "content", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["beliefs"],
  additionalProperties: false,
} as const;

const EXTRACTOR_PROMPT = `You maintain an agent's long-term memory of company policy.

Read the document and extract the durable facts it asserts. Each fact becomes one
memory, keyed by a stable dotted subject so that later documents about the same
topic update the same memory rather than creating a duplicate.

Known subjects already in memory (reuse these keys where the document speaks to them):
- policy.refund_limit.enterprise
- policy.refund_window
- policy.escalation
- policy.currency

Extract only durable policy or account facts. Ignore pleasantries, formatting, and
one-off transactional details.`;

/**
 * Turn a document into belief updates.
 *
 * This is the attack surface the whole demo is about: the extractor is doing its
 * job correctly and faithfully: text in the document says the limit is $5,000, so
 * it writes that the limit is $5,000. Nothing here is broken. The failure is that
 * a low-trust document was allowed to overwrite a high-trust belief, and nothing
 * downstream noticed until money moved.
 */
export async function extractBeliefs(text: string): Promise<BeliefUpdate[]> {
  if (isOffline()) return devExtract(text);

  const out = await chatJson<{ beliefs: BeliefUpdate[] }>({
    system: EXTRACTOR_PROMPT,
    user: text.slice(0, 100_000),
    schema: BELIEF_SCHEMA,
    maxTokens: 4096,
  });
  return (out.beliefs ?? []).filter((b) => b.subject && b.content);
}

/** DEV ONLY — see the caveat on devDecide in model.ts. */
function devExtract(text: string): BeliefUpdate[] {
  const limit = /refund limit is (\$[\d,]+)/i.exec(text);
  if (!limit) return [];
  return [
    {
      subject: "policy.refund_limit.enterprise",
      content: `Enterprise refund limit is ${limit[1]} per incident.`,
      confidence: 0.9,
    },
  ];
}

/** Plain text and Markdown inline; PDF via pdf-parse. */
export async function extractText(key: string, body: Buffer): Promise<string> {
  if (/\.(txt|md|json|csv)$/i.test(key)) return body.toString("utf8");
  if (/\.pdf$/i.test(key)) {
    // pdf-parse v2 exports a PDFParse class, not the v1 default function.
    // `destroy()` releases the worker — without it a Lambda container leaks one
    // per invocation and eventually runs out of memory on a warm start.
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: body });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  // Unknown types are read as UTF-8 rather than rejected — a mislabelled
  // extension should not silently drop a document from the audit trail.
  return body.toString("utf8");
}
