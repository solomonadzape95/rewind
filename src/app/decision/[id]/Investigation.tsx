"use client";

import { useState } from "react";
import type { Verdict } from "@/lib/replay";
import type { Trace } from "@/lib/bisect";
import type { BlastRadius } from "@/lib/blast";
import type { Recheck } from "@/lib/remediate";
import { Field, Panel, SectionLabel } from "../../ui";

interface Remediation {
  fixedAt: string;
  results: Recheck[];
  flipped: number;
  recovered: number;
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/investigate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error ?? "request failed");
  return json as T;
}

/**
 * The three beats of the demo, in order: rule on it, trace it, price it.
 * Each step unlocks the next — trace needs the subject the verdict accused,
 * blast needs the window and memory id the trace found.
 */
export function Investigation({ decisionId }: { decisionId: string }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [blast, setBlast] = useState<BlastRadius | null>(null);
  const [fix, setFix] = useState<Remediation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accused = verdict?.changedBeliefs[0]?.subject ?? suspectSubject(verdict);

  const run = (step: string, fn: () => Promise<void>) => async () => {
    setBusy(step);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section>
        <SectionLabel n="02" title="Investigation" meta="replay · trace · price" />
        <div className="flex flex-col gap-px border border-line bg-line sm:flex-row">
          <Step
            n="1"
            label="Replay"
            busyLabel="replaying"
            active={busy === "replay"}
            disabled={busy !== null}
            onClick={run("replay", async () =>
              setVerdict(await call<Verdict>({ step: "verdict", decisionId })),
            )}
          />
          <Step
            n="2"
            label="Trace the write"
            busyLabel="bisecting"
            active={busy === "trace"}
            disabled={busy !== null || !accused}
            onClick={run("trace", async () =>
              setTrace(await call<Trace>({ step: "trace", subject: accused! })),
            )}
          />
          <Step
            n="3"
            label="Blast radius"
            busyLabel="scanning"
            active={busy === "blast"}
            disabled={busy !== null || !trace}
            onClick={run("blast", async () =>
              setBlast(
                await call<BlastRadius>({
                  step: "blast",
                  memoryId: trace!.memoryId,
                  fromHlc: trace!.flippedAt.after,
                }),
              ),
            )}
          />
          <Step
            n="4"
            label="Fix & re-replay"
            busyLabel="re-replaying"
            active={busy === "fix"}
            disabled={busy !== null || !blast || !trace?.priorContent}
            onClick={run("fix", async () =>
              setFix(
                await call<Remediation>({
                  step: "remediate",
                  subject: trace!.subject,
                  // Restore the value the bisection proved was there before the
                  // poisoning, rather than a value typed in now. The corrected
                  // state is then evidence-derived too, not a guess.
                  content: trace!.priorContent!,
                  memoryId: trace!.memoryId,
                  fromHlc: trace!.flippedAt.after,
                }),
              ),
            )}
          />
        </div>
        {error ? (
          <p className="mt-4 border border-bad px-5 py-3 font-mono text-[12px] text-bad">
            {error}
          </p>
        ) : null}
      </section>

      {verdict ? (
        <section>
          <Panel>
            <div
              className={`font-mono text-[clamp(1.6rem,4vw,2.6rem)] leading-none tracking-tight ${
                verdict.kind === "BAD_MEMORY"
                  ? "text-bad"
                  : verdict.kind === "RESOLVED"
                    ? "text-good"
                    : "text-text"
              }`}
            >
              {verdict.kind.replace(/_/g, " ")}
            </div>
            <p className="mb-6 mt-5 max-w-3xl text-[14px] leading-relaxed text-muted">
              {verdict.summary}
            </p>

            <Field k="recorded">
              {verdict.recorded.action} {money(verdict.recorded.amount)}
            </Field>
            {verdict.historical.map((h, n) => (
              <Field key={n} k={`replay ${n + 1}`}>
                {h.action} {money(h.amount)}
                <span className="ml-3 text-faint">memory as of the decision</span>
              </Field>
            ))}
            {verdict.current ? (
              <Field k="now">
                {verdict.current.action} {money(verdict.current.amount)}
                <span className="ml-3 text-faint">memory as of now</span>
              </Field>
            ) : null}
          </Panel>
        </section>
      ) : null}

      {trace ? (
        <section>
          <Panel>
            <p className="mb-5 font-mono text-[12px] uppercase tracking-[0.2em] text-muted">
              {trace.subject}
            </p>

            <div className="mb-5 max-h-64 overflow-y-auto border border-line bg-bg px-5 py-4">
              {trace.probes.map((p, n) => (
                <div
                  key={n}
                  className="flex items-baseline gap-4 font-mono text-[11.5px] leading-6"
                >
                  <span className="text-faint">{String(n + 1).padStart(2, "0")}</span>
                  <span className="text-faint">{p.at}</span>
                  <span className={p.matchesCurrent ? "text-bad" : "text-good"}>
                    {p.matchesCurrent ? "poisoned value" : "original value"}
                  </span>
                </div>
              ))}
            </div>

            <p className="mb-6 font-mono text-[11px] tracking-[0.08em] text-faint">
              {trace.probes.length} probes over MVCC. We store no change log — this binary-searches
              time itself.
            </p>

            <Field k="was" tone="good">
              {trace.priorContent ?? "(outside the GC window)"}
            </Field>
            <Field k="became" tone="bad">
              {trace.currentContent}
            </Field>
            <Field k="flipped at">{trace.flippedAt.atIso}</Field>
            {trace.source ? (
              <>
                <Field k="written by">{trace.source.uri}</Field>
                <Field k="trust score" tone="bad">
                  {trace.source.trust_score}
                </Field>
                <Field k="excerpt" tone="bad">
                  {trace.source.excerpt}
                </Field>
              </>
            ) : null}
          </Panel>
        </section>
      ) : null}

      {blast ? (
        <section>
          <Panel>
            <div className="mb-8 flex flex-wrap items-end gap-x-10 gap-y-6">
              <Stat value={String(blast.decisions.length)} label="decisions affected" />
              <Stat value={money(blast.exposure)} label="approved on the bad belief" bad />
            </div>

            {blast.decisions.map((d) => (
              <div
                key={d.decision_id}
                className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-6"
              >
                <span className="shrink-0 font-mono text-[11px] tracking-[0.06em] text-faint">
                  {d.created_at.slice(0, 19)}
                </span>
                <span className="shrink-0 font-mono text-[14px] tabular-nums text-bad sm:w-24 sm:text-right">
                  {money(d.action_args.amount)}
                </span>
                <span className="min-w-0 flex-1 text-[13px] text-muted">{d.input}</span>
              </div>
            ))}
          </Panel>
        </section>
      ) : null}

      {fix ? (
        <section>
          <Panel>
            <div className="mb-8 flex flex-wrap items-end gap-x-10 gap-y-6">
              <Stat value={`${fix.flipped}/${fix.results.length}`} label="decisions now decided differently" />
              <Stat value={money(fix.recovered)} label="would not have been approved" />
            </div>

            <p className="mb-6 max-w-3xl text-[14px] leading-relaxed text-muted">
              The belief was corrected with an ordinary in-place UPDATE — the same kind of write
              that poisoned it — so the repair is itself another MVCC version. Six months from now
              the same bisection finds both the attack and the fix.
            </p>

            {fix.results.map((r) => (
              <div
                key={r.decision.decision_id}
                className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-6"
              >
                <span
                  className={`shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] sm:w-24 ${
                    r.flipped ? "text-good" : "text-faint"
                  }`}
                >
                  {r.flipped ? "flipped" : "unchanged"}
                </span>
                <span className="shrink-0 font-mono text-[13px] tabular-nums text-bad line-through sm:w-24 sm:text-right">
                  {money(r.recordedAmount)}
                </span>
                <span className="shrink-0 font-mono text-[13px] tabular-nums text-good sm:w-24 sm:text-right">
                  {r.replayedAction === "approve_refund" ? money(r.replayedAmount) : r.replayedAction.replace("_", " ")}
                </span>
                <span className="min-w-0 flex-1 text-[13px] text-muted">{r.decision.input}</span>
              </div>
            ))}
          </Panel>
        </section>
      ) : null}
    </>
  );
}

function Step({
  n,
  label,
  busyLabel,
  active,
  disabled,
  onClick,
}: {
  n: string;
  label: string;
  busyLabel: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-1 items-center gap-4 bg-surface px-6 py-6 text-left transition-colors hover:bg-surface-2 disabled:opacity-35 disabled:hover:bg-surface"
    >
      <span className="stripe-dense flex h-9 w-9 shrink-0 items-center justify-center border border-line-strong font-mono text-[13px]">
        {n}
      </span>
      <span className="font-mono text-[12px] uppercase tracking-[0.18em]">
        {active ? `${busyLabel}…` : label}
      </span>
    </button>
  );
}

function Stat({ value, label, bad }: { value: string; label: string; bad?: boolean }) {
  return (
    <div>
      <div
        className={`font-mono text-[clamp(2.25rem,5vw,3.5rem)] leading-[0.85] tracking-tighter tabular-nums ${
          bad ? "text-bad" : "text-text"
        }`}
      >
        {value}
      </div>
      <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.22em] text-muted">
        {label}
      </div>
    </div>
  );
}

/** The verdict names the accused belief in its summary; pull the subject out. */
function suspectSubject(v: Verdict | null): string | undefined {
  if (!v) return undefined;
  return /"([a-z0-9_.]+)"/i.exec(v.summary)?.[1];
}
