/**
 * Rewind CLI — the forensic surface, before the console exists.
 *
 *   pnpm rewind timeline
 *   pnpm rewind verdict <decision-id>
 *   pnpm rewind trace   <subject>
 *   pnpm rewind blast   <memory-id> <from-hlc> [to-hlc]
 *   pnpm rewind fix     <subject> <corrected content>
 *   pnpm rewind recheck <memory-id> <from-hlc> [to-hlc]
 */
import { pool } from "../src/lib/db";
import { verdict } from "../src/lib/replay";
import { trace } from "../src/lib/bisect";
import { blastRadius } from "../src/lib/blast";
import { remediate, recheck } from "../src/lib/remediate";
import { TENANT } from "../src/lib/tenant";

const [cmd, ...args] = process.argv.slice(2);

const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const rule = () => console.log("─".repeat(72));

async function main() {
  switch (cmd) {
    case "timeline": {
      const { rows } = await pool.query(
        `SELECT decision_id, action, action_args, created_at::STRING AS at,
                memory_hlc::STRING AS hlc
         FROM decision WHERE tenant_id = $1 ORDER BY created_at`,
        [TENANT],
      );
      for (const r of rows) {
        console.log(
          `${r.at}  ${r.action.padEnd(15)} ${money(r.action_args.amount).padStart(8)}  ${r.decision_id}`,
        );
      }
      break;
    }

    case "verdict": {
      const v = await verdict(TENANT, req(args[0], "decision-id"));
      rule();
      console.log(`VERDICT: ${v.kind}`);
      rule();
      console.log(v.summary + "\n");
      console.log(`Recorded : ${v.recorded.action} ${money(v.recorded.amount)}`);
      for (const [i, h] of v.historical.entries()) {
        console.log(
          `Replay ${i + 1} : ${h.action} ${money(h.amount)}   (memory as of the decision)`,
        );
      }
      if (v.current) {
        console.log(`Now      : ${v.current.action} ${money(v.current.amount)}   (memory as of now)`);
      }
      if (v.changedBeliefs.length) {
        console.log("\nBeliefs that changed since the decision:");
        for (const c of v.changedBeliefs) {
          console.log(`  ${c.subject}`);
          console.log(`    then: ${c.then}`);
          console.log(`    now : ${c.now}`);
          console.log(`    memory_id: ${c.memory_id}`);
        }
      }
      break;
    }

    case "trace": {
      const t = await trace(TENANT, req(args[0], "subject"));
      rule();
      console.log(`TRACE: ${t.subject}`);
      rule();
      for (const p of t.probes) {
        console.log(`  probe ${p.at}  ${p.matchesCurrent ? "current value" : "prior value"}`);
      }
      console.log(`\n  ${t.probes.length} probes over MVCC — no change log was consulted.`);
      console.log(`\n  was : ${t.priorContent ?? "(outside the GC window)"}`);
      console.log(`  now : ${t.currentContent}`);
      console.log(`  flipped at ~${t.flippedAt.atIso}`);
      if (t.source) {
        console.log(`\n  written by: ${t.source.kind}  ${t.source.uri}`);
        console.log(`  trust score: ${t.source.trust_score}`);
        console.log(`  excerpt: ${t.source.excerpt}`);
      }
      console.log(`\n  blast window starts at HLC ${t.flippedAt.after}`);
      break;
    }

    case "blast": {
      const b = await blastRadius(
        TENANT,
        req(args[0], "memory-id"),
        req(args[1], "from-hlc"),
        args[2] ?? null,
      );
      rule();
      console.log(`BLAST RADIUS: ${b.decisions.length} decisions read this belief while it was wrong`);
      rule();
      for (const d of b.decisions) {
        console.log(`  ${d.created_at}  ${d.action.padEnd(15)} ${money(d.action_args.amount).padStart(8)}`);
        console.log(`    ${d.input}`);
      }
      console.log(`\n  Total approved on the bad belief: ${money(b.exposure)}`);
      break;
    }

    case "fix": {
      const subject = req(args[0], "subject");
      const content = args.slice(1).join(" ");
      if (!content) {
        console.error("missing required argument: <corrected content>");
        process.exit(1);
      }
      const r = await remediate({
        tenantId: TENANT,
        subject,
        content,
        operator: process.env.USER ?? "operator",
      });
      rule();
      console.log(`FIXED: ${subject}`);
      rule();
      console.log(`  now : ${content}`);
      console.log(`\n  The correction is an ordinary in-place UPDATE, so it becomes`);
      console.log(`  another MVCC version — the fix is as auditable as the attack.`);
      console.log(`\n  bad window closes at HLC ${r.fixedAt}`);
      console.log(`  next: pnpm rewind recheck <memory-id> <from-hlc> ${r.fixedAt}`);
      break;
    }

    case "recheck": {
      const r = await recheck(
        TENANT,
        req(args[0], "memory-id"),
        req(args[1], "from-hlc"),
        args[2] ?? null,
      );
      rule();
      console.log(`RECHECK: ${r.results.length} decisions replayed against the corrected memory`);
      rule();
      for (const x of r.results) {
        const mark = x.flipped ? "FLIPPED" : "unchanged";
        console.log(
          `  ${mark.padEnd(10)} ${x.recordedAction} ${money(x.recordedAmount)}` +
            `  ->  ${x.replayedAction} ${money(x.replayedAmount)}`,
        );
        console.log(`    ${x.decision.input}`);
      }
      console.log(`\n  ${r.flipped} of ${r.results.length} decisions change on the corrected memory.`);
      console.log(`  Would not have been approved: ${money(r.recovered)}`);
      break;
    }

    default:
      console.log(
        "commands: timeline | verdict <id> | trace <subject> | blast <memory-id> <from-hlc> [to-hlc] |\n" +
          "          fix <subject> <content> | recheck <memory-id> <from-hlc> [to-hlc]",
      );
      process.exitCode = 1;
  }
  await pool.end();
}

function req(v: string | undefined, name: string): string {
  if (!v) {
    console.error(`missing required argument: <${name}>`);
    process.exit(1);
  }
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
