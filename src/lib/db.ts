import { Pool, type PoolClient } from "pg";

// CockroachDB speaks the Postgres wire protocol, so `pg` works unchanged.
// Local dev: postgresql://root@localhost:26257/rewind?sslmode=disable
// Cloud:     the connection string from `ccloud cluster sql <name>`
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://root@localhost:26257/rewind?sslmode=disable";

export const pool = new Pool({ connectionString, max: 10 });

// Without a listener, an idle client whose connection dies (node restarted,
// network blipped) raises an unhandled 'error' event, which takes the process
// down in Node. Logging it lets the pool discard that client and dial a fresh
// one on the next query, so the console survives a database restart instead of
// serving 500s until someone notices and restarts the dev server.
pool.on("error", (err) => {
  console.error("[db] idle client error, discarding:", err.message);
});

export type Hlc = string; // DECIMAL — kept as a string; never parse to a JS number.

/**
 * The cluster's hybrid-logical-clock timestamp, right now.
 *
 * Returned as a string because it is a high-precision DECIMAL. Passing it
 * through `Number` silently truncates it, which quietly destroys the precision
 * that makes replay exact rather than approximate.
 */
export async function now(client: PoolClient | Pool = pool): Promise<Hlc> {
  const { rows } = await client.query<{ hlc: string }>(
    "SELECT cluster_logical_timestamp()::STRING AS hlc",
  );
  return rows[0].hlc;
}

/**
 * Run a query against the state of the database as of a past HLC timestamp.
 *
 * AS OF SYSTEM TIME does not accept a bind parameter, so the timestamp is
 * interpolated. `assertHlc` below is what keeps that from being an injection
 * hole — every historical read in this codebase goes through here.
 */
export async function asOf<T>(
  hlc: Hlc,
  sql: string,
  params: unknown[] = [],
  client: PoolClient | Pool = pool,
): Promise<T[]> {
  assertHlc(hlc);
  // `{AS_OF}` marks where the clause belongs — it must follow the FROM list,
  // which varies per query, so callers place it explicitly.
  const withClause = sql.replace(/\{AS_OF\}/g, `AS OF SYSTEM TIME ${hlc}`);
  if (withClause === sql) {
    throw new Error("asOf() query is missing its {AS_OF} placeholder");
  }
  const { rows } = await client.query(withClause, params);
  return rows as T[];
}

const HLC_RE = /^\d+(\.\d+)?$/;

export function assertHlc(hlc: string): void {
  if (!HLC_RE.test(hlc)) {
    throw new Error(`refusing to interpolate a non-numeric HLC: ${hlc}`);
  }
}

/** Format a vector for CockroachDB's VECTOR type: '[0.1,0.2,...]'. */
export function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
