/**
 * Create the database, widen the GC window, then apply the schema.
 *
 * Ordering matters and is not cosmetic: gc.ttlseconds must be raised before a
 * single row is written. Raising it later does not bring back history that has
 * already been garbage collected.
 *
 * AND IT IS NOT ENOUGH TO WIDEN THE DATABASE. This cost us a demo, so it is
 * worth stating precisely: CockroachDB resolves object names AS OF THE READ
 * TIMESTAMP, which means every historical query also reads the descriptor
 * tables in `system` at that same past timestamp. Those live in ranges with
 * their own zone configuration, and it stays at the 4h default no matter what
 * you set on your database.
 *
 * The failure is nasty because it does not look like a retention problem:
 *
 *   batch timestamp ... must be after replica GC threshold (r10: /Table/{5-6})
 *
 * The user table still holds seven days of history, perfectly readable, and the
 * query fails anyway because the *name* can no longer be resolved that far
 * back. So the effective forensic horizon is the MINIMUM of the database's TTL
 * and the system ranges' TTL — and widening one without the other buys nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgresql://root@localhost:26257/rewind?sslmode=disable";

async function main() {
  const bootstrapUrl = url.replace(/\/rewind(\?|$)/, "/defaultdb$1");
  const bootstrap = new Client({ connectionString: bootstrapUrl });
  await bootstrap.connect();
  await bootstrap.query("CREATE DATABASE IF NOT EXISTS rewind");
  await widenSystemRanges(bootstrap);
  await bootstrap.end();

  const db = new Client({ connectionString: url });
  await db.connect();
  // The vector width is substituted rather than hardcoded: different embedding
  // models emit different dimensions (nomic-embed-text 768, Titan V2 1024), and
  // a mismatch between schema and model is rejected by CockroachDB on insert.
  const dim = Number(process.env.REWIND_EMBED_DIM ?? 768);
  if (!Number.isInteger(dim) || dim < 1 || dim > 4096) {
    throw new Error(`REWIND_EMBED_DIM must be an integer in 1..4096, got ${dim}`);
  }
  const sql = readFileSync(join(import.meta.dirname, "../db/schema.sql"), "utf8")
    .replaceAll("${EMBED_DIM}", String(dim));
  await db.query(sql);

  const { rows } = await db.query("SHOW ZONE CONFIGURATION FROM DATABASE rewind");
  console.log(`schema applied (VECTOR(${dim})).\n`);
  console.log(rows[0]?.raw_config_sql ?? rows[0]);
  await db.end();
}

/**
 * Widen the ranges that descriptor resolution reads, to match the database.
 *
 * Best-effort by design. On CockroachDB Cloud Basic these statements can be
 * refused — zone configuration on system ranges is the operator's, not the
 * tenant's. That is not a fatal error: it is a fact about the deployment that
 * caps the forensic horizon at whatever the provider set, and the right
 * response is to print it loudly so nobody discovers it mid-incident. Failing
 * hard here would block a demo that otherwise works fine within four hours.
 */
async function widenSystemRanges(client: Client): Promise<void> {
  const ttl = Number(process.env.REWIND_GC_TTL ?? 604800);
  const targets = ["RANGE default", "RANGE meta", "RANGE liveness", "DATABASE system"];

  const refused: string[] = [];
  for (const target of targets) {
    try {
      await client.query(`ALTER ${target} CONFIGURE ZONE USING gc.ttlseconds = ${ttl}`);
    } catch (e) {
      refused.push(`${target} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (refused.length === 0) {
    console.log(`system ranges widened to ${ttl}s — historical name resolution reaches that far back.\n`);
    return;
  }
  console.warn(
    `\nWARNING: could not widen ${refused.length} system zone(s):\n` +
      refused.map((r) => `  - ${r}`).join("\n") +
      `\n\nHistorical queries resolve object names as of the read timestamp, so they` +
      `\nalso read the system descriptor tables at that past timestamp. Wherever those` +
      `\nranges' gc.ttlseconds sits (4h by default) is your REAL forensic horizon,` +
      `\nregardless of what the rewind database is set to. Verify with /api/health.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
