import { pool, toVector, type Hlc } from "./db";
import { embed } from "./embeddings";
import { mcpEnabled, mcpRecall } from "./mcp";
import { decide, MODEL_ID, PROMPT_HASH, type Decision } from "./model";
import type { Memory } from "./memory";

export interface DecisionRecord extends Decision {
  decisionId: string;
  memoryHlc: Hlc;
  retrievedIds: string[];
  /** How memory was reached: through the MCP tool surface, or directly. */
  via: "mcp" | "sql";
}

/**
 * Run one support decision end to end, and record the forensic anchor.
 *
 * The critical mechanic is the transaction. `cluster_logical_timestamp()` and
 * the recall query run inside the SAME read-only transaction, so both observe
 * exactly one MVCC snapshot — the recorded HLC is not "roughly when the agent
 * read memory", it is precisely the coordinate the agent read at. That is what
 * makes replay evidence rather than reconstruction.
 *
 * Capturing the timestamp outside the transaction would leave a window in which
 * a concurrent ingestion could land between the clock read and the recall, and
 * replay would then reproduce a memory state the agent never actually saw.
 */
export async function runDecision(params: {
  tenantId: string;
  actor: string;
  input: string;
}): Promise<DecisionRecord> {
  const queryEmbedding = await embed(params.input);

  // Production path: the agent has no database connection, only tools. Both
  // paths must produce an HLC drawn from the same snapshot as the recall —
  // see mcp.ts for how that invariant survives the loss of a session.
  if (mcpEnabled()) {
    const r = await mcpRecall(params.tenantId, queryEmbedding);
    return record(params, r.memories as Memory[], r.hlc, "mcp");
  }

  const client = await pool.connect();

  let hlc: Hlc;
  let memories: Memory[];
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const { rows: clock } = await client.query<{ hlc: string }>(
      "SELECT cluster_logical_timestamp()::STRING AS hlc",
    );
    hlc = clock[0].hlc;

    // Live path: C-SPANN approximate search, inside the pinned snapshot.
    const { rows } = await client.query<Memory>(
      `SELECT memory_id, kind, subject, content, confidence, source_id,
              embedding <=> $2 AS distance
       FROM memory
       WHERE tenant_id = $1 AND valid
       ORDER BY embedding <=> $2
       LIMIT 8`,
      [params.tenantId, toVector(queryEmbedding)],
    );
    memories = rows;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return record(params, memories, hlc, "sql");
}

/**
 * Ask the model, then write the decision with its forensic anchor.
 *
 * Split out because the two recall paths differ only in how they obtain the
 * (memories, hlc) pair — everything downstream must be identical, or a decision
 * made over MCP would not be replayable by the same machinery as one made over
 * SQL, and the forensics would only work for half the fleet.
 */
async function record(
  params: { tenantId: string; actor: string; input: string },
  memories: Memory[],
  hlc: Hlc,
  via: "mcp" | "sql",
): Promise<DecisionRecord> {
  const decision = await decide({ input: params.input, memories });

  const { rows: saved } = await pool.query<{ decision_id: string }>(
    `INSERT INTO decision
       (tenant_id, actor, input, action, action_args, rationale,
        retrieved_ids, memory_hlc, model_id, prompt_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING decision_id`,
    [
      params.tenantId,
      params.actor,
      params.input,
      decision.action,
      JSON.stringify({ amount: decision.amount, currency: "USD" }),
      decision.rationale,
      memories.map((m) => m.memory_id),
      hlc,
      MODEL_ID,
      PROMPT_HASH,
    ],
  );

  return {
    ...decision,
    decisionId: saved[0].decision_id,
    memoryHlc: hlc,
    retrievedIds: memories.map((m) => m.memory_id),
    via,
  };
}
