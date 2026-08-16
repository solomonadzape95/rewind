/**
 * The sentinel — live poison detection over a CHANGEFEED.
 *
 * Everything else in Rewind is forensics: it explains an incident after someone
 * has noticed. The gap that closes an incident from six hours to six seconds is
 * noticing. CockroachDB emits every committed mutation on a changefeed, so the
 * same MVCC machinery that answers "what did it believe" also answers "what is
 * changing right now, and should it be".
 *
 * The rule is deliberately narrow, because a noisy detector is an ignored one:
 *
 *   alert when a HIGH-CONFIDENCE POLICY belief is overwritten by a source
 *   LESS TRUSTED than the one that wrote the value being replaced.
 *
 * That is exactly the shape of the attack in the demo — an `inbound/` document
 * at trust 0.2 overwriting a belief a trust-1.0 policy document had written —
 * and it is not the shape of legitimate operations, where policy beliefs are
 * updated by the policy channel or by a human.
 *
 * NOTE THE ORDER OF EVENTS. The sentinel does not prevent the write; the write
 * has already committed by the time it is emitted. That is honest and it is
 * also the correct design: a gate in the ingestion path would have to be right
 * in real time about a document it has just met, and being wrong there means
 * dropping a legitimate policy update. Detecting in seconds and handing the
 * responder a pre-built blast radius is achievable; perfect prevention is not.
 *
 *   pnpm sentinel                 # watch (uses core changefeeds, no licence)
 *   pnpm sentinel --install-sql   # print the enterprise CHANGEFEED INTO ... form
 */
import { Query } from "pg";
import { pool } from "../src/lib/db";
import { TENANT } from "../src/lib/tenant";

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * The enterprise form, for a real deployment: a changefeed INTO a sink, with a
 * Lambda on the other end. Printed rather than executed because it needs an
 * enterprise licence and a sink that exists; the watcher below does the same
 * job for the demo with no licence at all.
 */
const INSTALL_SQL = `
-- Requires an enterprise licence and an existing sink.
CREATE CHANGEFEED FOR TABLE memory
  INTO 'kafka://broker:9092?topic_name=rewind-memory'
  WITH diff, updated, resolved = '10s';

-- 'diff' is the load-bearing option: it carries the PREVIOUS row alongside the
-- new one, which is what lets the sentinel compare trust scores without a
-- second query. Without it every event costs a round trip back to the database
-- at exactly the moment the database is busy.
`.trim();

interface Row {
  memory_id: string;
  subject: string;
  kind: string;
  content: string;
  confidence: number;
  source_id: string | null;
}

async function main() {
  if (process.argv.includes("--install-sql")) {
    console.log(INSTALL_SQL);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  console.log("sentinel watching memory for low-trust policy overwrites  (ctrl-c to stop)\n");

  // Core changefeeds stream to the SQL session itself — no licence, no sink,
  // no Kafka. The trade-off is that the feed dies with the connection, which is
  // fine for a watcher you run during an incident and wrong for production;
  // that is what --install-sql is for.
  // A changefeed never returns, so it cannot go through pool.query(), which
  // buffers to completion. `pg.Query` is the row-at-a-time interface: results
  // arrive as 'row' events and the statement stays open indefinitely.
  const feed = client.query(
    new Query(`EXPERIMENTAL CHANGEFEED FOR TABLE memory WITH diff, updated`),
  ) as unknown as NodeJS.EventEmitter;

  feed.on("row", (row: { key: string; value: string }) => {
    void inspect(row).catch((e) => console.error("[sentinel]", e.message));
  });
  feed.on("error", (e: Error) => {
    console.error("[sentinel] feed error:", e.message);
    process.exit(1);
  });
}

async function inspect(row: { key: string; value: string }) {
  if (!row?.value) return;
  const payload = JSON.parse(row.value) as { after: Row | null; before: Row | null };
  const { after, before } = payload;
  if (!after || !before) return; // creation or deletion, not an overwrite
  if (after.content === before.content) return;

  // Only policy beliefs held with high confidence are worth guarding. An
  // episodic memory changing is the system working.
  if (after.kind !== "policy" || before.confidence < 0.9) return;

  const trustAfter = await trustOf(after.source_id);
  const trustBefore = await trustOf(before.source_id);
  if (trustAfter >= trustBefore) return; // rewritten, but not downhill

  const exposure = await liveExposure(after.memory_id);

  console.log("─".repeat(72));
  console.log(`ALERT  low-trust overwrite of a policy belief`);
  console.log("─".repeat(72));
  console.log(`  subject : ${after.subject}`);
  console.log(`  was     : ${before.content}   (source trust ${trustBefore})`);
  console.log(`  now     : ${after.content}   (source trust ${trustAfter})`);
  console.log(`  memory  : ${after.memory_id}`);
  console.log(`\n  ${exposure.count} decisions have already read this belief; ${money(exposure.total)} approved.`);
  console.log(`  investigate: pnpm rewind trace ${after.subject}\n`);
}

async function trustOf(sourceId: string | null): Promise<number> {
  if (!sourceId) return 0.5;
  const { rows } = await pool.query<{ trust_score: number }>(
    `SELECT trust_score FROM ingestion_source WHERE source_id = $1`,
    [sourceId],
  );
  return rows[0]?.trust_score ?? 0.5;
}

/** How much has already been approved on this belief, ever. */
async function liveExposure(memoryId: string): Promise<{ count: number; total: number }> {
  const { rows } = await pool.query<{ count: string; total: string | null }>(
    `SELECT count(*)::STRING AS count,
            sum((action_args->>'amount')::FLOAT8)::STRING AS total
     FROM decision
     WHERE tenant_id = $1 AND $2::UUID = ANY(retrieved_ids)
       AND action = 'approve_refund'`,
    [TENANT, memoryId],
  );
  return { count: Number(rows[0]?.count ?? 0), total: Number(rows[0]?.total ?? 0) };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
