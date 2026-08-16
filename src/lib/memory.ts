import { pool, asOf, toVector, type Hlc } from "./db";

export interface Memory {
  memory_id: string;
  kind: string;
  subject: string;
  content: string;
  confidence: number;
  source_id: string | null;
  distance: number;
}

/**
 * LIVE recall — what the agent uses in normal operation.
 *
 * Approximate nearest neighbour via the C-SPANN distributed vector index.
 * Fast, scales to billions of vectors, and is the correct tool for serving.
 */
export async function recallLive(
  tenantId: string,
  queryEmbedding: number[],
  k = 8,
): Promise<Memory[]> {
  const { rows } = await pool.query<Memory>(
    `SELECT memory_id, kind, subject, content, confidence, source_id,
            embedding <=> $2 AS distance
     FROM memory
     WHERE tenant_id = $1 AND valid
     ORDER BY embedding <=> $2
     LIMIT $3`,
    [tenantId, toVector(queryEmbedding), k],
  );
  return rows;
}

/**
 * FORENSIC recall — what the agent believed at a past HLC timestamp.
 *
 * Deliberately uses exact brute-force cosine distance rather than the C-SPANN
 * index. Two reasons, and both belong in the README:
 *
 *  1. Correctness. An approximate index is maintained in the background and
 *     makes no guarantee about what a historical read returns. Replay evidence
 *     must be provably identical to what the agent saw, not approximately
 *     identical. Approximation is fine for recall; it is not fine for evidence.
 *  2. Scale. Forensics runs over one tenant's working set, not the whole
 *     corpus. Exact search over a few thousand vectors is milliseconds.
 */
export async function recallAsOf(
  tenantId: string,
  queryEmbedding: number[],
  hlc: Hlc,
  k = 8,
): Promise<Memory[]> {
  return asOf<Memory>(
    hlc,
    `SELECT memory_id, kind, subject, content, confidence, source_id,
            cosine_distance(embedding, $2) AS distance
     FROM memory {AS_OF}
     WHERE tenant_id = $1 AND valid
     ORDER BY distance
     LIMIT $3`,
    [tenantId, toVector(queryEmbedding), k],
  );
}

/** A single belief as of a past timestamp, by its stable subject key. */
export async function subjectAsOf(
  tenantId: string,
  subject: string,
  hlc: Hlc,
): Promise<{ content: string; source_id: string | null; confidence: number } | null> {
  const rows = await asOf<{ content: string; source_id: string | null; confidence: number }>(
    hlc,
    `SELECT content, source_id, confidence
     FROM memory {AS_OF}
     WHERE tenant_id = $1 AND subject = $2`,
    [tenantId, subject],
  );
  return rows[0] ?? null;
}

/**
 * Write a belief.
 *
 * DESIGN RULE: existing beliefs are mutated IN PLACE. We never append a new
 * version row. The history this project is built on is MVCC's, not ours — the
 * moment we keep our own version table, CockroachDB stops being load-bearing
 * and the whole thesis collapses.
 */
export async function remember(params: {
  tenantId: string;
  kind: string;
  subject: string;
  content: string;
  embedding: number[];
  sourceId: string | null;
  confidence?: number;
}): Promise<void> {
  const { tenantId, kind, subject, content, embedding, sourceId } = params;
  const confidence = params.confidence ?? 1.0;

  const updated = await pool.query(
    `UPDATE memory
     SET content = $3, embedding = $4, source_id = $5,
         confidence = $6, updated_at = now()
     WHERE tenant_id = $1 AND subject = $2`,
    [tenantId, subject, content, toVector(embedding), sourceId, confidence],
  );
  if (updated.rowCount && updated.rowCount > 0) return;

  await pool.query(
    `INSERT INTO memory (tenant_id, kind, subject, content, embedding, source_id, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, kind, subject, content, toVector(embedding), sourceId, confidence],
  );
}
