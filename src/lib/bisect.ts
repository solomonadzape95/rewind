import { pool, now, asOf, type Hlc } from "./db";
import { subjectAsOf } from "./memory";

export interface Probe {
  hlc: Hlc;
  at: string; // ISO, for the UI timeline
  matchesCurrent: boolean;
}

export interface Trace {
  subject: string;
  /** Returned so callers can scope a blast-radius query without a second lookup. */
  memoryId: string;
  currentContent: string;
  priorContent: string | null;
  /** Tightest known bound on when the belief flipped. */
  flippedAt: { after: Hlc; before: Hlc; atIso: string };
  source: {
    source_id: string;
    kind: string;
    uri: string;
    excerpt: string | null;
    trust_score: number;
    ingested_at: string;
  } | null;
  probes: Probe[];
}

/**
 * Find the exact write that gave a belief its current value — by binary
 * searching time itself.
 *
 * We keep no change log, no audit table, and no version history. MVCC already
 * holds every version of this row; bisection over `AS OF SYSTEM TIME` finds the
 * transition in ~log2(window) probes. A 7-day GC window resolves to the second
 * in about 20 queries.
 *
 * Invariant maintained throughout: at `lo` the belief does NOT have its current
 * value; at `hi` it does. The flip is always in between.
 *
 * KNOWN LIMIT: the backward walk doubles its stride, so it can step over an
 * interval shorter than the stride it had reached. If a belief flips away from
 * and back to the same value within a window narrower than that stride, the
 * walk brackets an older transition than the true most-recent one. Widening the
 * search to a linear scan would cost O(window) probes to close a gap that real
 * policy beliefs do not exhibit — they change rarely, not several times a
 * second. What DOES exhibit it is rehearsing the demo repeatedly against one
 * cluster, which is why `pnpm db:reset` exists.
 */
export async function trace(
  tenantId: string,
  subject: string,
  opts: { toleranceMs?: number; windowSeconds?: number; upTo?: Hlc } = {},
): Promise<Trace> {
  const toleranceNs = BigInt(opts.toleranceMs ?? 1000) * 1_000_000n;
  const windowNs = BigInt(opts.windowSeconds ?? 604800) * 1_000_000_000n;

  // `upTo` anchors the search at a past moment instead of now — this is what
  // lets the verdict engine ask "how did this belief come to hold the value the
  // agent read?" at incident time, before anyone has corrected anything.
  const anchor = opts.upTo ?? (await now());
  const anchored = await asOf<{ memory_id: string; content: string }>(
    anchor,
    `SELECT memory_id, content FROM memory {AS_OF}
     WHERE tenant_id = $1 AND subject = $2`,
    [tenantId, subject],
  );
  if (!anchored[0]) throw new Error(`no memory with subject "${subject}" at ${anchor}`);
  const currentContent = anchored[0].content;
  const memoryId = anchored[0].memory_id;

  const probes: Probe[] = [];
  const seen = async (hlc: Hlc): Promise<boolean> => {
    let matches: boolean;
    try {
      const v = await subjectAsOf(tenantId, subject, hlc);
      matches = v?.content === currentContent;
    } catch (e) {
      // A probe far enough back predates the database or table itself, and
      // CockroachDB rejects it outright rather than returning no rows. Both
      // mean the same thing for our purposes — the belief did not hold this
      // value then — so treat it as a miss and let the search move forward.
      if (!isPreExistence(e)) throw e;
      matches = false;
    }
    probes.push({ hlc, at: nsToIso(intPart(hlc)), matchesCurrent: matches });
    return matches;
  };

  const anchorNs = intPart(anchor);

  // Phase 1 — walk backwards in doubling steps to find the nearest moment the
  // belief did NOT hold its current value.
  //
  // Bisecting the whole window directly would be wrong whenever a belief has
  // oscillated: with several A->B transitions in the window, a plain binary
  // search converges on an arbitrary one, and accusing a months-old write for
  // today's incident is worse than useless. Walking backwards guarantees we
  // find the MOST RECENT transition — the one that produced the value the agent
  // actually read.
  let step = 1_000_000_000n; // 1s
  let hi = anchorNs; // known: holds the current value
  let lo: bigint | null = null; // known: does not

  while (step <= windowNs) {
    const probe = anchorNs - step;
    if (await seen(probe.toString())) {
      hi = probe; // still the current value this far back — keep going
      step *= 2n;
    } else {
      lo = probe;
      break;
    }
  }

  // Never found a moment without this value inside the GC window: either the
  // belief has held it all along, or the write predates our visibility.
  if (lo === null) {
    const edge = anchorNs - windowNs;
    return {
      subject,
      memoryId,
      currentContent,
      priorContent: null,
      flippedAt: { after: edge.toString(), before: edge.toString(), atIso: nsToIso(edge) },
      source: await sourceAt(tenantId, subject, hi.toString()),
      probes,
    };
  }

  // Phase 2 — bisect the bracket the walk produced. Invariant throughout:
  // `lo` does not hold the current value, `hi` does.
  let low: bigint = lo;
  while (hi - low > toleranceNs) {
    const mid: bigint = (low + hi) / 2n;
    if (await seen(mid.toString())) hi = mid;
    else low = mid;
  }

  const before = await subjectAsOf(tenantId, subject, low.toString());
  return {
    subject,
    memoryId,
    currentContent,
    priorContent: before?.content ?? null,
    flippedAt: { after: low.toString(), before: hi.toString(), atIso: nsToIso(hi) },
    source: await sourceAt(tenantId, subject, hi.toString()),
    probes,
  };
}

/** Who wrote the belief, as recorded at the moment it took its current value. */
async function sourceAt(
  tenantId: string,
  subject: string,
  hlc: Hlc,
): Promise<Trace["source"]> {
  const rows = await asOf<NonNullable<Trace["source"]>>(
    hlc,
    `SELECT s.source_id, s.kind, s.uri, s.excerpt, s.trust_score,
            s.ingested_at::STRING AS ingested_at
     FROM memory m
     JOIN ingestion_source s ON s.source_id = m.source_id
     {AS_OF}
     WHERE m.tenant_id = $1 AND m.subject = $2`,
    [tenantId, subject],
  );
  return rows[0] ?? null;
}

/**
 * Does this error mean "you read before this object existed" rather than a real
 * failure? 3D000 = undefined database, 42P01 = undefined table.
 */
function isPreExistence(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === "3D000" || code === "42P01";
}

/** HLC is `<nanos>.<logical>`; the nanosecond part is all we bisect on. */
function intPart(hlc: string): bigint {
  return BigInt(hlc.split(".")[0]);
}

function nsToIso(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString();
}
