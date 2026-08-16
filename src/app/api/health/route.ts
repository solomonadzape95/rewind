import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { mcpEnabled } from "@/lib/mcp";
import { provider, CHAT_MODEL } from "@/lib/llm";

export const dynamic = "force-dynamic";

/**
 * Liveness, plus the one configuration value that silently breaks this product.
 *
 * `gc.ttlseconds` is not a tuning knob here — it is the retention window, and
 * therefore the maximum age of any question Rewind can answer. A cluster
 * running the default 4h TTL looks completely healthy and will fail every
 * forensic query about yesterday, with an error that reads like a bug rather
 * than a policy. Surfacing it on /api/health means the failure is visible
 * before an incident rather than during one.
 */
export async function GET() {
  const started = Date.now();
  try {
    // Read through SHOW ZONE CONFIGURATION rather than crdb_internal: the
    // internal tables are blocked on CockroachDB Cloud (42501), so a health
    // check built on them passes locally and 503s in the only environment that
    // matters. The raw SQL is a string, hence the regex.
    const { rows } = await pool.query<{ raw_config_sql: string }>(
      `SHOW ZONE CONFIGURATION FROM DATABASE ${quoteIdent(currentDatabase())}`,
    );
    const dbTtl = ttlOf(rows[0]?.raw_config_sql);

    // The number that actually matters. Historical queries resolve object names
    // as of the read timestamp, so they read the system descriptor tables at
    // that past timestamp too — and those ranges keep their own zone config,
    // stuck at the 4h default unless someone widened it. A database set to 7
    // days on top of 4h system ranges has a 4h forensic horizon and reports a
    // healthy-looking 7 days everywhere else. Report the binding constraint.
    const { rows: sysRows } = await pool.query<{ raw_config_sql: string }>(
      `SHOW ZONE CONFIGURATION FROM RANGE default`,
    );
    const systemTtl = ttlOf(sysRows[0]?.raw_config_sql);
    const ttlSeconds = Math.min(dbTtl || Infinity, systemTtl || Infinity);

    return NextResponse.json({
      ok: true,
      latencyMs: Date.now() - started,
      retention: {
        databaseTtlSeconds: dbTtl || null,
        systemRangeTtlSeconds: systemTtl || null,
        // The horizon is the tighter of the two, never the database's alone.
        forensicHorizonDays: Number.isFinite(ttlSeconds)
          ? +(ttlSeconds / 86400).toFixed(2)
          : null,
        warning:
          systemTtl && dbTtl && systemTtl < dbTtl
            ? `The rewind database keeps ${dbTtl}s of history, but historical queries also resolve object names against the system ranges, which keep only ${systemTtl}s. The real forensic horizon is ${systemTtl}s. Widen it with ALTER RANGE default CONFIGURE ZONE USING gc.ttlseconds — on managed tiers this may be the provider's to set.`
            : Number.isFinite(ttlSeconds) && ttlSeconds <= 14400
              ? "gc.ttlseconds is at or below the 4h default — forensic replay cannot see beyond it, and widening it now will not recover already-collected history."
              : null,
      },
      memoryAccess: mcpEnabled() ? "cockroachdb-cloud-mcp" : "direct-sql",
      model: { provider: provider(), id: CHAT_MODEL },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}

/** The zone config comes back as a raw SQL string; there is no structured accessor on Cloud. */
function ttlOf(rawConfigSql: string | undefined): number {
  return Number(/gc\.ttlseconds\s*=\s*(\d+)/.exec(rawConfigSql ?? "")?.[1] ?? 0);
}

/** SHOW ZONE CONFIGURATION takes an identifier, not a bind parameter. */
function currentDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "rewind";
  return new URL(url).pathname.replace(/^\//, "").split("?")[0] || "rewind";
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`refusing to interpolate a non-identifier database name: ${name}`);
  }
  return name;
}
