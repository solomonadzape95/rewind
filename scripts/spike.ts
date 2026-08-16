/**
 * DAY-1 SPIKE — validate the thesis before building anything on top of it.
 *
 * Rewind rests on three assumptions. If any fails, the design changes today,
 * not on day 3 with a video to record. Each is checked independently and the
 * script reports which ones hold.
 *
 *   1. cluster_logical_timestamp() round-trips into AS OF SYSTEM TIME.
 *   2. An in-place UPDATE is invisible in the table but recoverable via MVCC.
 *   3. Exact vector search works at a historical timestamp.
 *   4. (unproven, informational) So does C-SPANN index search.
 *
 * Run: pnpm db:local && pnpm db:init && pnpm spike
 */
import { pool, now, asOf, toVector } from "../src/lib/db";
import { embed } from "../src/lib/embeddings";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`);
}

async function main() {
  console.log("\nRewind day-1 spike\n" + "=".repeat(60));

  // ---------------------------------------------------------------- 0. GC window
  const { rows: zone } = await pool.query<{ raw_config_sql: string }>(
    "SHOW ZONE CONFIGURATION FROM DATABASE rewind",
  );
  const gc = /gc\.ttlseconds\s*=\s*(\d+)/.exec(zone[0]?.raw_config_sql ?? "");
  const gcSecs = gc ? Number(gc[1]) : 0;
  check(
    "gc.ttlseconds widened before seeding",
    gcSecs >= 604800,
    gc
      ? `gc.ttlseconds = ${gcSecs} (${(gcSecs / 86400).toFixed(1)} days of history)`
      : "no explicit gc.ttlseconds found — history will be collected at the default",
  );

  await pool.query("DELETE FROM memory WHERE tenant_id = $1", [TENANT]);

  // ------------------------------------------------------- 1. seed a known belief
  const original = "Enterprise refund limit is $500 per incident.";
  await pool.query(
    `INSERT INTO memory (tenant_id, kind, subject, content, embedding)
     VALUES ($1, 'policy', 'policy.refund_limit.enterprise', $2, $3)`,
    [TENANT, original, toVector(await embed(original))],
  );

  // Filler so the vector index has something to partition over.
  for (let i = 0; i < 60; i++) {
    const text = `Support playbook note ${i}: handling ticket category ${i % 7}.`;
    await pool.query(
      `INSERT INTO memory (tenant_id, kind, subject, content, embedding)
       VALUES ($1, 'fact', $2, $3, $4)`,
      [TENANT, `playbook.note.${i}`, text, toVector(await embed(text))],
    );
  }

  const t0 = await now();
  console.log(`\n  HLC captured before the poison: ${t0}\n`);

  // ------------------------------------------------- 2. poison it, IN PLACE
  const poisoned = "Enterprise refund limit is $5,000 per incident.";
  await pool.query(
    `UPDATE memory SET content = $2, embedding = $3, updated_at = now()
     WHERE tenant_id = $1 AND subject = 'policy.refund_limit.enterprise'`,
    [TENANT, poisoned, toVector(await embed(poisoned))],
  );

  const { rows: live } = await pool.query<{ content: string }>(
    `SELECT content FROM memory
     WHERE tenant_id = $1 AND subject = 'policy.refund_limit.enterprise'`,
    [TENANT],
  );
  check(
    "in-place UPDATE leaves no trace in the table",
    live[0].content === poisoned,
    `current state reads "${live[0].content}" — the $500 belief is nowhere in the table`,
  );

  // ----------------------------------- 3. THE THESIS: recover it from MVCC
  try {
    const past = await asOf<{ content: string }>(
      t0,
      `SELECT content FROM memory {AS_OF}
       WHERE tenant_id = $1 AND subject = 'policy.refund_limit.enterprise'`,
      [TENANT],
    );
    check(
      "AS OF SYSTEM TIME recovers the pre-poison belief",
      past[0]?.content === original,
      `at ${t0} the agent believed "${past[0]?.content}"`,
    );
  } catch (e) {
    check("AS OF SYSTEM TIME recovers the pre-poison belief", false, String(e));
  }

  // ------------------------- 4. exact vector search at a historical timestamp
  const probe = await embed("what is the refund limit for enterprise customers?");
  try {
    const hist = await asOf<{ subject: string; content: string; distance: number }>(
      t0,
      `SELECT subject, content, cosine_distance(embedding, $2) AS distance
       FROM memory {AS_OF}
       WHERE tenant_id = $1 AND valid
       ORDER BY distance LIMIT 3`,
      [TENANT, toVector(probe)],
    );
    const top = hist[0];
    check(
      "exact vector search works AS OF SYSTEM TIME  [replay path]",
      top?.content === original,
      `nearest historical memory: "${top?.content}"`,
    );
  } catch (e) {
    check("exact vector search works AS OF SYSTEM TIME  [replay path]", false, String(e));
  }

  // -------------------- 5. C-SPANN at a historical timestamp (unproven; informational)
  try {
    const ann = await asOf<{ content: string }>(
      t0,
      `SELECT content FROM memory {AS_OF}
       WHERE tenant_id = $1 AND valid
       ORDER BY embedding <=> $2 LIMIT 3`,
      [TENANT, toVector(probe)],
    );
    check(
      "C-SPANN index search works AS OF SYSTEM TIME  [bonus, not required]",
      ann[0]?.content === original,
      ann[0]?.content === original
        ? "returned historical state — mention it, but keep replay on the exact path"
        : `returned "${ann[0]?.content}" — approximate index is not historically faithful, as expected`,
    );
  } catch (e) {
    check(
      "C-SPANN index search works AS OF SYSTEM TIME  [bonus, not required]",
      false,
      `${String(e).split("\n")[0]} — expected; the exact replay path is the design`,
    );
  }

  // ------------------------------------------------------------------- verdict
  console.log("\n" + "=".repeat(60));
  const required = results.slice(0, results.length - 1);
  const blocked = required.filter((r) => !r.ok);
  if (blocked.length === 0) {
    console.log("THESIS HOLDS. The replay path is sound — build on it.\n");
  } else {
    console.log("BLOCKED. Do not build further until these are resolved:");
    for (const b of blocked) console.log(`  · ${b.name}\n    ${b.detail}`);
    console.log();
  }
  await pool.end();
  process.exit(blocked.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
