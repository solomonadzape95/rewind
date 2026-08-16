/**
 * Seed T+0: correct memory, and a run of legitimate support decisions.
 *
 * Run this FIRST, then `pnpm poison` a while later. The gap between them is
 * real elapsed time — the incident timeline is compressed into hours, never
 * backdated. A judge who knows MVCC can check that `updated_at` and the MVCC
 * timestamp agree, and they will.
 */
import { pool } from "../src/lib/db";
import { embed } from "../src/lib/embeddings";
import { remember } from "../src/lib/memory";
import { runDecision } from "../src/lib/agent";
import { TENANT, REFUND_POLICY } from "../src/lib/tenant";

const PLAYBOOK: [string, string][] = [
  ["policy.refund_window", "Refunds may be issued within 30 days of the invoice date."],
  ["policy.escalation", "Any request above the refund limit must be escalated to a human manager."],
  ["policy.currency", "All refunds are issued in USD."],
  ["account.acme.tier", "Acme Corp is on the Enterprise plan, invoiced annually."],
  ["account.acme.history", "Acme Corp has had two prior refunds, both under $200."],
];

const REQUESTS = [
  "Acme Corp is requesting a $120 refund for a duplicate charge on invoice 4471.",
  "Customer reports being billed twice in March and asks for a $340 refund.",
  "Requesting a $95 refund for an unused seat added in error last week.",
  "Acme Corp asks for a $480 refund after a failed migration cost them a week.",
  "Customer wants a $210 refund for an overage they say was miscalculated.",
];

async function main() {
  const human = await source({
    kind: "human",
    uri: "internal://policy-handbook/2026-q1",
    excerpt: "Enterprise refund limit is $500 per incident.",
    trust: 1.0,
  });

  await remember({
    tenantId: TENANT,
    kind: "policy",
    subject: REFUND_POLICY,
    content: "Enterprise refund limit is $500 per incident.",
    embedding: await embed("Enterprise refund limit is $500 per incident."),
    sourceId: human,
  });
  for (const [subject, content] of PLAYBOOK) {
    await remember({
      tenantId: TENANT,
      kind: "fact",
      subject,
      content,
      embedding: await embed(content),
      sourceId: human,
    });
  }
  console.log(`seeded ${PLAYBOOK.length + 1} memories. Refund limit: $500.\n`);

  for (const input of REQUESTS) {
    const d = await runDecision({
      tenantId: TENANT,
      actor: "support-agent-v1",
      input,
    });
    console.log(`  ${d.action.padEnd(15)} $${String(d.amount).padStart(6)}  ${d.decisionId}`);
  }

  console.log(
    "\nT+0 complete. Let real time pass, then run `pnpm poison` to ingest the malicious document.",
  );
  await pool.end();
}

async function source(s: {
  kind: string;
  uri: string;
  excerpt: string;
  trust: number;
}): Promise<string> {
  const { rows } = await pool.query<{ source_id: string }>(
    `INSERT INTO ingestion_source (tenant_id, kind, uri, excerpt, trust_score)
     VALUES ($1, $2, $3, $4, $5) RETURNING source_id`,
    [TENANT, s.kind, s.uri, s.excerpt, s.trust],
  );
  return rows[0].source_id;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
