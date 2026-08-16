import { pool, assertHlc, type Hlc } from "./db";

export interface Affected {
  decision_id: string;
  actor: string;
  input: string;
  action: string;
  action_args: { amount: number; currency: string };
  created_at: string;
}

export interface BlastRadius {
  memoryId: string;
  window: { from: Hlc; to: Hlc | null };
  decisions: Affected[];
  exposure: number; // total USD approved by decisions that read the bad belief
}

/**
 * Every other decision that read a belief while it was wrong.
 *
 * This is what turns forensics into a product. Finding the one bad decision
 * someone happened to notice is debugging; enumerating the twenty-three nobody
 * noticed — and pricing them — is incident response.
 *
 * The query is cheap because `memory_hlc` is indexed and is a real MVCC
 * coordinate: "which decisions read memory during this window" is an index
 * range scan, not a reconstruction.
 */
export async function blastRadius(
  tenantId: string,
  memoryId: string,
  fromHlc: Hlc,
  toHlc: Hlc | null,
): Promise<BlastRadius> {
  assertHlc(fromHlc);
  if (toHlc) assertHlc(toHlc);

  // The upper bound is appended rather than passed as a nullable placeholder:
  // CockroachDB cannot infer a type for a NULL compared against DECIMAL and
  // rejects the whole statement (42P18).
  const params: unknown[] = [tenantId, fromHlc, memoryId];
  let upper = "";
  if (toHlc) {
    params.push(toHlc);
    upper = `AND memory_hlc <= $${params.length}::DECIMAL`;
  }

  const { rows } = await pool.query<Affected>(
    `SELECT decision_id, actor, input, action, action_args,
            created_at::STRING AS created_at
     FROM decision
     WHERE tenant_id = $1::UUID
       AND memory_hlc >= $2::DECIMAL
       AND $3::UUID = ANY(retrieved_ids)
       ${upper}
     ORDER BY created_at`,
    params,
  );

  const exposure = rows
    .filter((r) => r.action === "approve_refund")
    .reduce((sum, r) => sum + (r.action_args?.amount ?? 0), 0);

  return {
    memoryId,
    window: { from: fromHlc, to: toHlc },
    decisions: rows,
    exposure,
  };
}
