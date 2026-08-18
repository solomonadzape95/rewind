/**
 * T+2h: a document lands in the inbound channel, and a belief silently changes.
 *
 * This runs the SAME pipeline as the Lambda — extract text, extract beliefs,
 * write them in place — against a local file instead of an S3 object. The local
 * demo and the deployed one must not diverge, or the thing you rehearse is not
 * the thing you record.
 *
 * Note what does not happen: no error, no alert, no log line, no new row. One
 * UPDATE rewrites one belief, and from the table's point of view the $500 policy
 * never existed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/lib/db";
import { embed } from "../src/lib/embeddings";
import { remember } from "../src/lib/memory";
import { extractBeliefs, extractText, trustForKey } from "../src/lib/extract";
import { runDecision } from "../src/lib/agent";
import { TENANT } from "../src/lib/tenant";

const KEY = "inbound/q3-vendor-policy-update.md";

// The recorded source URI must match the bucket the deployed Lambda writes from,
// or the console shows a document path that never existed. Same default as
// infra/deploy-lambda.sh.
const BUCKET = process.env.REWIND_BUCKET ?? "rewind-demo";

const REQUESTS = [
  "Acme Corp is requesting a $1,800 refund for a service outage last month.",
  "Customer is asking for a $2,400 refund citing repeated downtime.",
  "Requesting a $3,100 refund for a botched data import.",
  "Acme Corp wants a $900 refund for seats they say were never provisioned.",
  "Customer requests a $4,200 refund to close out their account.",
];

async function main() {
  const body = readFileSync(join(import.meta.dirname, "../docs", KEY));
  const text = await extractText(KEY, body);
  const trust = trustForKey(KEY);

  const beliefs = await extractBeliefs(text);
  console.log(`extracted ${beliefs.length} belief(s) from ${KEY} (trust ${trust})\n`);

  const { rows } = await pool.query<{ source_id: string }>(
    `INSERT INTO ingestion_source (tenant_id, kind, uri, excerpt, trust_score)
     VALUES ($1, 'md', $2, $3, $4) RETURNING source_id`,
    [TENANT, `s3://${BUCKET}/${KEY}`, text.slice(0, 2000), trust],
  );

  for (const b of beliefs) {
    await remember({
      tenantId: TENANT,
      kind: b.subject.startsWith("policy.") ? "policy" : "fact",
      subject: b.subject,
      content: b.content,
      embedding: await embed(b.content),
      sourceId: rows[0].source_id,
      confidence: b.confidence,
    });
    console.log(`  ${b.subject}\n    ${b.content}`);
  }

  console.log("\nNo error was raised. Now the agent works from the new belief.\n");

  for (const input of REQUESTS) {
    const d = await runDecision({ tenantId: TENANT, actor: "support-agent-v1", input });
    const flag = d.action === "approve_refund" && d.amount > 500 ? "  <-- over the real policy" : "";
    console.log(
      `  ${d.action.padEnd(15)} $${String(d.amount).padStart(6)}  ${d.decisionId}${flag}`,
    );
  }

  console.log("\nRun `pnpm rewind verdict <decision-id>` on the last one.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
