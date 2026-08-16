import { pool, now, type Hlc } from "./db";
import { embed } from "./embeddings";
import { remember, recallLive } from "./memory";
import { decide } from "./model";
import { blastRadius, type Affected } from "./blast";

/**
 * Correct a poisoned belief, and record who corrected it.
 *
 * The correction is an ordinary in-place `UPDATE`, exactly like the poisoning
 * was — Rewind does not get a privileged write path. That is the point: the
 * remediation becomes another MVCC version, so six months from now the same
 * bisection that found the attack will also find the fix, and an auditor can
 * see both. A "repair" that bypassed the memory layer would leave the record
 * showing the belief was never wrong.
 *
 * The returned HLC closes the bad window: every decision between the poisoning
 * and this instant read the wrong value, and none after it did.
 */
export async function remediate(params: {
  tenantId: string;
  subject: string;
  content: string;
  operator: string;
}): Promise<{ fixedAt: Hlc; sourceId: string }> {
  const { rows } = await pool.query<{ source_id: string }>(
    `INSERT INTO ingestion_source (tenant_id, kind, uri, excerpt, trust_score)
     VALUES ($1, 'human', $2, $3, 1.0)
     RETURNING source_id`,
    [
      params.tenantId,
      `human://${params.operator}`,
      `Manual correction during incident response: "${params.content}"`,
    ],
  );
  const sourceId = rows[0].source_id;

  await remember({
    tenantId: params.tenantId,
    kind: "policy",
    subject: params.subject,
    content: params.content,
    embedding: await embed(params.content),
    sourceId,
    confidence: 1.0,
  });

  // Read the clock AFTER the write so the returned timestamp is guaranteed to
  // observe it. Capturing it first would hand back a coordinate at which the
  // correction is not yet visible, and a blast-radius query bounded by it would
  // silently include the very decision that proves the fix worked.
  return { fixedAt: await now(), sourceId };
}

export interface Recheck {
  decision: Affected;
  recordedAction: string;
  recordedAmount: number;
  replayedAction: string;
  replayedAmount: number;
  /** True when the corrected memory yields a different, non-approving outcome. */
  flipped: boolean;
}

/**
 * Replay every decision in the blast radius against the corrected memory.
 *
 * The blast-radius count says how much damage was done. This says whether the
 * fix actually works — the difference between an incident report and a closed
 * incident. It is also memory regression testing in the plainest possible form:
 * a corpus of real past decisions, re-run against a memory change, with the
 * outcomes that move called out.
 *
 * Replay here is against memory as of NOW rather than a pinned HLC, because the
 * question is not "what did it do" (we know) but "what would it do today".
 */
export async function recheck(
  tenantId: string,
  memoryId: string,
  fromHlc: Hlc,
  toHlc: Hlc | null,
): Promise<{ results: Recheck[]; flipped: number; recovered: number }> {
  const blast = await blastRadius(tenantId, memoryId, fromHlc, toHlc);

  const results: Recheck[] = [];
  for (const d of blast.decisions) {
    const memories = await recallLive(tenantId, await embed(d.input));
    const replayed = await decide({ input: d.input, memories });
    const recordedAmount = d.action_args?.amount ?? 0;
    results.push({
      decision: d,
      recordedAction: d.action,
      recordedAmount,
      replayedAction: replayed.action,
      replayedAmount: replayed.amount,
      flipped: replayed.action !== d.action || replayed.amount !== recordedAmount,
    });
  }

  // "Recovered" is the money the corrected memory would not have approved —
  // the only number in this tool that a finance team cares about.
  const recovered = results
    .filter((r) => r.recordedAction === "approve_refund")
    .reduce((sum, r) => sum + Math.max(0, r.recordedAmount - r.replayedAmount), 0);

  return { results, flipped: results.filter((r) => r.flipped).length, recovered };
}
