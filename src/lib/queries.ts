import { pool, asOf, type Hlc } from "./db";
import { TENANT } from "./tenant";

export interface DecisionRow {
  decision_id: string;
  actor: string;
  input: string;
  action: string;
  action_args: { amount: number; currency: string };
  rationale: string | null;
  memory_hlc: string;
  created_at: string;
  retrieved_ids: string[];
}

export async function listDecisions(): Promise<DecisionRow[]> {
  const { rows } = await pool.query<DecisionRow>(
    `SELECT decision_id, actor, input, action, action_args, rationale,
            memory_hlc::STRING AS memory_hlc,
            created_at::STRING AS created_at, retrieved_ids
     FROM decision WHERE tenant_id = $1 ORDER BY created_at`,
    [TENANT],
  );
  return rows;
}

export async function getDecision(id: string): Promise<DecisionRow | null> {
  const { rows } = await pool.query<DecisionRow>(
    `SELECT decision_id, actor, input, action, action_args, rationale,
            memory_hlc::STRING AS memory_hlc,
            created_at::STRING AS created_at, retrieved_ids
     FROM decision WHERE tenant_id = $1 AND decision_id = $2`,
    [TENANT, id],
  );
  return rows[0] ?? null;
}

export interface MemoryAt {
  memory_id: string;
  subject: string;
  content: string;
  kind: string;
  uri: string | null;
  trust_score: number | null;
}

/**
 * The agent's entire belief state at a past moment.
 *
 * This is the timeline scrubber's query, and it is the whole pitch in one
 * statement: no snapshot table, no reconstruction, one clause.
 */
export async function memoryAt(hlc: Hlc): Promise<MemoryAt[]> {
  return asOf<MemoryAt>(
    hlc,
    `SELECT m.memory_id, m.subject, m.content, m.kind,
            s.uri, s.trust_score
     FROM memory m
     LEFT JOIN ingestion_source s ON s.source_id = m.source_id
     {AS_OF}
     WHERE m.tenant_id = $1 AND m.valid
     ORDER BY m.kind, m.subject`,
    [TENANT],
  );
}

/** Bounds for the scrubber: the window over which we have decisions. */
export async function timelineBounds(): Promise<{ from: string; to: string } | null> {
  const { rows } = await pool.query<{ from: string; to: string }>(
    `SELECT min(memory_hlc)::STRING AS from, max(memory_hlc)::STRING AS to
     FROM decision WHERE tenant_id = $1`,
    [TENANT],
  );
  return rows[0]?.from ? rows[0] : null;
}
