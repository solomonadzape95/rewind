import Link from "next/link";
import { listDecisions } from "@/lib/queries";
import { Scrubber } from "./Scrubber";
import { SectionLabel } from "./ui";

export const dynamic = "force-dynamic";

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

export default async function Home() {
  const decisions = await listDecisions();

  if (decisions.length === 0) {
    return (
      <div className="stripe border border-line bg-surface p-10">
        <p className="font-mono text-[13px] uppercase tracking-[0.2em] text-muted">
          No decisions recorded
        </p>
        <p className="mt-4 font-mono text-[13px] text-faint">
          pnpm db:reset &rarr; pnpm db:seed &rarr; wait &rarr; pnpm poison
        </p>
      </div>
    );
  }

  const overCount = decisions.filter(
    (d) => d.action === "approve_refund" && d.action_args.amount > 500,
  ).length;

  return (
    <div className="flex flex-col gap-14">
      <section>
        <SectionLabel n="01" title="Memory timeline" meta="drag to move through time" />
        <Scrubber decisions={decisions.map((d) => ({ hlc: d.memory_hlc, at: d.created_at }))} />
      </section>

      <section>
        <SectionLabel
          n="02"
          title="Decisions"
          meta={`${decisions.length} recorded · ${overCount} over policy`}
        />
        <div className="border border-line bg-surface">
          {decisions.map((d) => {
            const over = d.action === "approve_refund" && d.action_args.amount > 500;
            return (
              <Link
                key={d.decision_id}
                href={`/decision/${d.decision_id}`}
                className="flex flex-col gap-2 border-b border-line px-5 py-4 transition-colors last:border-b-0 hover:bg-surface-2 sm:flex-row sm:items-baseline sm:gap-6"
              >
                <span className="shrink-0 font-mono text-[12px] tracking-[0.06em] text-faint">
                  {d.created_at.slice(0, 19)}
                </span>
                <span
                  className={`shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] ${
                    over ? "text-bad" : "text-muted"
                  }`}
                >
                  {d.action.replace("_", " ")}
                </span>
                <span
                  className={`shrink-0 font-mono text-[15px] tabular-nums sm:w-24 sm:text-right ${
                    over ? "text-bad" : "text-text"
                  }`}
                >
                  {money(d.action_args.amount)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] text-muted">
                  {d.input}
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
