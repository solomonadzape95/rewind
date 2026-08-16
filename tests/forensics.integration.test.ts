/**
 * The thesis, as an executable claim.
 *
 * Every other test in this repo checks a function. This one checks the premise
 * the whole project rests on: that CockroachDB alone — no audit table, no event
 * log, no snapshots — can answer what a belief was at a past instant, and that
 * bisection over MVCC can find the write that changed it.
 *
 * If this test fails, nothing else in Rewind is worth running. That is why it
 * asserts against the database rather than a mock: a mocked MVCC would prove
 * only that we can write a mock.
 *
 * Requires a database. Skipped without one, so `pnpm test` stays green on a
 * laptop with nothing running:
 *
 *   pnpm db:local && pnpm db:init && pnpm test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, now, asOf } from "../src/lib/db";
import { trace } from "../src/lib/bisect";

const TENANT = "00000000-0000-0000-0000-0000000000ee"; // test tenant, not the demo's
const SUBJECT = "test.policy.mvcc";

const live = await isReachable();
const suite = live ? describe : describe.skip;

async function isReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

suite("MVCC is the history", () => {
  let dim = 0;
  let beforeWrite: string;
  let afterFirst: string;

  beforeAll(async () => {
    // The vector width is fixed at init and varies with the embedding model, so
    // read it rather than assuming — a hardcoded 768 makes this test fail for
    // anyone using a different model, which is a false alarm about the thesis.
    const { rows } = await pool.query<{ dim: string }>(
      `SELECT vector_dims(embedding)::STRING AS dim FROM memory LIMIT 1`,
    );
    dim = Number(rows[0]?.dim ?? 768);

    await pool.query(`DELETE FROM memory WHERE tenant_id = $1`, [TENANT]);
    beforeWrite = await now();

    await pool.query(
      `INSERT INTO memory (tenant_id, kind, subject, content, embedding, confidence)
       VALUES ($1, 'policy', $2, 'Refund limit is $500.', $3, 1.0)`,
      [TENANT, SUBJECT, zeroVector(dim)],
    );
    afterFirst = await now();

    // A real second must elapse: bisection resolves to a tolerance of ~1s, and
    // two writes inside the same second are indistinguishable to it. This is a
    // property of the demo's tolerance setting, not of MVCC.
    await new Promise((r) => setTimeout(r, 1500));

    await pool.query(
      `UPDATE memory SET content = 'Refund limit is $5,000.', updated_at = now()
       WHERE tenant_id = $1 AND subject = $2`,
      [TENANT, SUBJECT],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.query(`DELETE FROM memory WHERE tenant_id = $1`, [TENANT]);
    await pool.end();
  });

  it("reads the pre-update value at a past timestamp with no history table", async () => {
    const then = await readAt(afterFirst);
    const current = await readAt(await now());
    expect(then).toBe("Refund limit is $500.");
    expect(current).toBe("Refund limit is $5,000.");
  });

  it("sees no row at all before the belief existed", async () => {
    const rows = await asOf<{ content: string }>(
      beforeWrite,
      `SELECT content FROM memory {AS_OF} WHERE tenant_id = $1 AND subject = $2`,
      [TENANT, SUBJECT],
    );
    expect(rows).toHaveLength(0);
  });

  it("bisects to the write that changed the belief", async () => {
    const t = await trace(TENANT, SUBJECT, { toleranceMs: 250, windowSeconds: 3600 });

    expect(t.currentContent).toBe("Refund limit is $5,000.");
    expect(t.priorContent).toBe("Refund limit is $500.");

    // The bracket must actually contain the transition: the belief holds its
    // prior value at `after` and its current value at `before`.
    expect(await readAt(t.flippedAt.after)).toBe("Refund limit is $500.");
    expect(await readAt(t.flippedAt.before)).toBe("Refund limit is $5,000.");

    // Logarithmic, not linear. An hour bisected to 250ms is ~24 probes; a
    // regression to a scan would be thousands and would show up here.
    expect(t.probes.length).toBeLessThan(60);
  }, 120_000);
});

async function readAt(hlc: string): Promise<string | undefined> {
  const rows = await asOf<{ content: string }>(
    hlc,
    `SELECT content FROM memory {AS_OF} WHERE tenant_id = $1 AND subject = $2`,
    [TENANT, SUBJECT],
  );
  return rows[0]?.content;
}

function zeroVector(dim: number): string {
  return `[${Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
}
