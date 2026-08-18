import Link from "next/link";
import { getDecision } from "@/lib/queries";
import { Investigation } from "./Investigation";
import { Field, Panel, SectionLabel } from "../../ui";

export const dynamic = "force-dynamic";

export default async function DecisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = await getDecision(id);

  if (!d) {
    return (
      <div className="stripe border border-line bg-surface p-10 font-mono text-[13px] text-muted">
        No such decision.
      </div>
    );
  }

  const over = d.action === "approve_refund" && d.action_args.amount > 500;

  return (
    <div className="flex flex-col gap-14">
      <Link
        href="/"
        className="font-mono text-[11px] uppercase tracking-[0.2em] text-faint hover:text-text"
      >
        &larr; all decisions
      </Link>

      <section>
        <SectionLabel n="01" title="The incident" meta={d.created_at.slice(0, 19)} />
        <Panel>
          <div className="mb-8 flex flex-wrap items-end justify-between gap-6">
            <span
              className={`font-mono text-[clamp(2.5rem,6vw,4rem)] leading-[0.85] tracking-tighter tabular-nums ${
                over ? "text-bad" : "text-text"
              }`}
            >
              ${d.action_args.amount.toLocaleString("en-US")}
            </span>
            <span
              className={`font-mono text-[12px] uppercase tracking-[0.22em] ${
                over ? "text-bad" : "text-muted"
              }`}
            >
              {d.action.replace("_", " ")}
            </span>
          </div>

          <Field k="request">{d.input}</Field>
          <Field k="rationale">{d.rationale ?? "—"}</Field>
          <Field k="actor">{d.actor}</Field>
          <Field k="memory_hlc">{d.memory_hlc}</Field>

          <p className="mt-6 font-mono text-[11px] leading-relaxed tracking-[0.08em] text-faint">
            The HLC was captured inside the same transaction as the memory read, so it is the exact
            MVCC coordinate the agent saw — not an approximation of when it read.
          </p>
        </Panel>
      </section>

      <Investigation decisionId={d.decision_id} memoryHlc={d.memory_hlc} />
    </div>
  );
}
