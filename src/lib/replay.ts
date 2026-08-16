import { pool, asOf, type Hlc } from "./db";
import { embed } from "./embeddings";
import { recallLive, recallAsOf } from "./memory";
import { trace } from "./bisect";
import { decide, MODEL_ID, PROMPT_HASH, type Decision } from "./model";

export type VerdictKind =
  | "REPLAY_UNSOUND"
  | "NON_DETERMINISTIC"
  | "BAD_MEMORY"
  | "BAD_REASONING"
  | "RESOLVED";

export interface Verdict {
  kind: VerdictKind;
  summary: string;
  recorded: { action: string; amount: number };
  historical: Decision[]; // one per replay run, against memory AS OF the decision
  current: Decision | null; // against memory as of now
  changedBeliefs: {
    subject: string;
    then: string;
    now: string;
    memory_id: string;
  }[];
}

const REPLAY_RUNS = 3;

/**
 * Answer the question the whole product exists for: was this a reasoning
 * failure or a memory failure?
 *
 * Three observations, one truth table:
 *   A — replay against memory AS OF the decision's HLC (run REPLAY_RUNS times)
 *   B — replay against memory as of now
 *   R — what the agent actually did
 *
 * Note that this refuses to rule in two cases rather than guessing. That is
 * deliberate: a forensics tool that returns a confident wrong verdict is worse
 * than one that says it cannot tell.
 */
export async function verdict(
  tenantId: string,
  decisionId: string,
): Promise<Verdict> {
  const { rows } = await pool.query<{
    input: string;
    action: string;
    action_args: { amount: number };
    retrieved_ids: string[];
    memory_hlc: string;
    model_id: string;
    prompt_hash: string;
  }>(
    `SELECT input, action, action_args, retrieved_ids, memory_hlc::STRING AS memory_hlc,
            model_id, prompt_hash
     FROM decision WHERE tenant_id = $1 AND decision_id = $2`,
    [tenantId, decisionId],
  );
  if (!rows[0]) throw new Error(`no such decision: ${decisionId}`);
  const d = rows[0];
  const recorded = { action: d.action, amount: d.action_args.amount };

  // Guard first. Replay is only evidence if the experiment is unchanged.
  if (d.prompt_hash !== PROMPT_HASH || d.model_id !== MODEL_ID) {
    return {
      kind: "REPLAY_UNSOUND",
      summary:
        d.prompt_hash !== PROMPT_HASH
          ? "The system prompt has changed since this decision. Replay would not reproduce the original conditions, so no verdict can be issued."
          : `The model has changed since this decision (was ${d.model_id}, now ${MODEL_ID}). No verdict can be issued.`,
      recorded,
      historical: [],
      current: null,
      changedBeliefs: [],
    };
  }

  const probe = await embed(d.input);
  const thenMem = await recallAsOf(tenantId, probe, d.memory_hlc as Hlc);
  const nowMem = await recallLive(tenantId, probe);

  const historical: Decision[] = [];
  for (let i = 0; i < REPLAY_RUNS; i++) {
    historical.push(await decide({ input: d.input, memories: thenMem }));
  }
  const changedBeliefs = await diffBeliefs(
    tenantId,
    d.retrieved_ids,
    d.memory_hlc as Hlc,
  );

  const actions = new Set<string>(historical.map((h) => h.action));
  if (actions.size > 1 || !actions.has(recorded.action)) {
    return {
      kind: "NON_DETERMINISTIC",
      summary:
        actions.size > 1
          ? `Replaying the identical memory state produced ${actions.size} different actions across ${REPLAY_RUNS} runs. This decision is model instability, not a memory fault — memory is exonerated.`
          : "Replaying the identical memory state did not reproduce the recorded action. The decision was not determined by memory alone; memory is exonerated.",
      recorded,
      historical,
      current: null,
      changedBeliefs,
    };
  }

  const current = await decide({ input: d.input, memories: nowMem });

  // Provenance check — the discriminator that works AT INCIDENT TIME.
  //
  // Comparing "then vs now" only detects a memory fault after somebody has
  // already corrected the memory. When the engineer opens this, the poisoned
  // belief is still live, so that comparison finds nothing changed and would
  // wrongly blame the model. What is knowable right now is where the belief the
  // agent read came from: if it was rewritten shortly before the decision, by a
  // source less trusted than the one it replaced, that write is the suspect.
  const suspect = await freshlyRewritten(tenantId, d.retrieved_ids, d.memory_hlc as Hlc);
  if (suspect) {
    return {
      kind: "BAD_MEMORY",
      summary:
        `The agent read a belief that had been rewritten shortly before this decision by a lower-trust source. ` +
        `"${suspect.subject}" changed from "${suspect.was}" to "${suspect.became}" via ${suspect.uri} ` +
        `(trust ${suspect.trustNow} vs ${suspect.trustBefore}).` +
        (suspect.alsoRewritten > 0
          ? ` The same ingestion also rewrote ${suspect.alsoRewritten} other belief${suspect.alsoRewritten > 1 ? "s" : ""} this decision read.`
          : "") +
        ` The model applied its memory correctly; the memory was wrong.`,
      recorded,
      historical,
      current,
      changedBeliefs,
    };
  }

  if (changedBeliefs.length === 0) {
    return {
      kind: "BAD_REASONING",
      summary:
        "Memory is byte-identical to what the agent read, and replaying it reproduces the same action. The memory was correct; the model misused it. Fix the prompt or the model, not the data.",
      recorded,
      historical,
      current,
      changedBeliefs,
    };
  }

  if (current.action !== recorded.action) {
    const worst = changedBeliefs[0];
    return {
      kind: "BAD_MEMORY",
      summary: `A belief the agent read has changed since the decision, and the agent reaches a different conclusion on the corrected memory. Root cause is the write to "${worst.subject}", not the model. Trace it to find the ingestion that did it.`,
      recorded,
      historical,
      current,
      changedBeliefs,
    };
  }

  return {
    kind: "BAD_REASONING",
    summary:
      "Memory has changed since the decision, but the agent still reaches the same conclusion on the corrected memory. The memory change is not what caused this outcome.",
    recorded,
    historical,
    current,
    changedBeliefs,
  };
}

interface Suspect {
  subject: string;
  was: string;
  became: string;
  uri: string;
  trustNow: number;
  trustBefore: number;
  /** Other beliefs this decision read that the same sweep also found rewritten. */
  alsoRewritten: number;
}

/**
 * Did any belief the agent read get rewritten by a less-trusted source shortly
 * before it was read?
 *
 * Two historical reads per belief: its state at the decision, and its state one
 * lookback window earlier. A difference means it was rewritten in between; a
 * drop in the source's trust score means the rewrite is worth accusing. Both
 * reads are ordinary `AS OF SYSTEM TIME` queries — no provenance table, no
 * write-ahead log, just MVCC read twice.
 */
async function freshlyRewritten(
  tenantId: string,
  memoryIds: string[],
  hlc: Hlc,
): Promise<Suspect | null> {
  if (memoryIds.length === 0) return null;

  // Ordered by the memory's position in `retrieved_ids`, which recall returns
  // nearest-first. Without the ORDER BY the scan is nondeterministic, so a
  // document that poisoned several beliefs would accuse a different one each
  // run. Nearest-first also picks the belief the agent weighted most heavily,
  // which is the one worth naming.
  const subjects = await asOf<{ subject: string; trust_score: number }>(
    hlc,
    `SELECT m.subject, COALESCE(s.trust_score, 0.5) AS trust_score
     FROM memory m
     LEFT JOIN ingestion_source s ON s.source_id = m.source_id
     {AS_OF}
     WHERE m.tenant_id = $1 AND m.memory_id = ANY($2)
     ORDER BY array_position($2::UUID[], m.memory_id)`,
    [tenantId, memoryIds],
  );

  const found: Suspect[] = [];
  for (const s of subjects) {
    const t = await trace(tenantId, s.subject, { upTo: hlc, toleranceMs: 250 });
    // No prior version inside the window means the belief was created, not
    // rewritten — a first write is not evidence of tampering.
    if (t.priorContent === null) continue;

    const trustBefore = (await sourceTrustAt(tenantId, s.subject, t.flippedAt.after)) ?? 0.5;
    if (s.trust_score >= trustBefore) continue; // rewritten, but not by a worse source

    found.push({
      subject: s.subject,
      was: t.priorContent,
      became: t.currentContent,
      uri: t.source?.uri ?? "(unknown)",
      trustNow: s.trust_score,
      trustBefore,
      alsoRewritten: 0,
    });
  }
  if (found.length === 0) return null;
  // One document commonly rewrites several beliefs at once; surface that rather
  // than reporting a single edit and understating the blast.
  return { ...found[0], alsoRewritten: found.length - 1 };
}

async function sourceTrustAt(
  tenantId: string,
  subject: string,
  hlc: Hlc,
): Promise<number | null> {
  const rows = await asOf<{ trust_score: number }>(
    hlc,
    `SELECT COALESCE(s.trust_score, 0.5) AS trust_score
     FROM memory m
     LEFT JOIN ingestion_source s ON s.source_id = m.source_id
     {AS_OF}
     WHERE m.tenant_id = $1 AND m.subject = $2`,
    [tenantId, subject],
  );
  return rows[0]?.trust_score ?? null;
}

/** Which of the memories this decision actually read have changed since? */
async function diffBeliefs(
  tenantId: string,
  memoryIds: string[],
  hlc: Hlc,
): Promise<Verdict["changedBeliefs"]> {
  if (memoryIds.length === 0) return [];

  const then = await asOf<{ memory_id: string; subject: string; content: string }>(
    hlc,
    `SELECT memory_id, subject, content FROM memory {AS_OF}
     WHERE tenant_id = $1 AND memory_id = ANY($2)`,
    [tenantId, memoryIds],
  );
  const { rows: now } = await pool.query<{ memory_id: string; content: string }>(
    `SELECT memory_id, content FROM memory
     WHERE tenant_id = $1 AND memory_id = ANY($2)`,
    [tenantId, memoryIds],
  );
  const nowById = new Map(now.map((r) => [r.memory_id, r.content]));

  return then
    .filter((t) => nowById.get(t.memory_id) !== t.content)
    .map((t) => ({
      memory_id: t.memory_id,
      subject: t.subject,
      then: t.content,
      now: nowById.get(t.memory_id) ?? "(deleted)",
    }));
}
