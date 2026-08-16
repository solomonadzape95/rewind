import { NextResponse } from "next/server";
import { verdict } from "@/lib/replay";
import { trace } from "@/lib/bisect";
import { blastRadius } from "@/lib/blast";
import { remediate, recheck } from "@/lib/remediate";
import { TENANT } from "@/lib/tenant";

export const dynamic = "force-dynamic";
// Replay runs the model several times and bisection issues ~20 queries; the
// default serverless timeout is not enough.
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as {
    step: "verdict" | "trace" | "blast" | "remediate";
    decisionId?: string;
    subject?: string;
    content?: string;
    memoryId?: string;
    fromHlc?: string;
    toHlc?: string | null;
  };

  try {
    switch (body.step) {
      case "verdict":
        return NextResponse.json(await verdict(TENANT, req_(body.decisionId, "decisionId")));
      case "trace":
        return NextResponse.json(await trace(TENANT, req_(body.subject, "subject")));
      case "blast":
        return NextResponse.json(
          await blastRadius(
            TENANT,
            req_(body.memoryId, "memoryId"),
            req_(body.fromHlc, "fromHlc"),
            body.toHlc ?? null,
          ),
        );
      // Correct the belief, then re-run every decision that read the bad one.
      // Fused into one step on purpose: a fix without a recheck is a claim, and
      // the whole product is about not taking claims on trust. The recheck also
      // has to run AFTER the correction is visible, which is exactly what
      // remediate()'s returned HLC guarantees.
      case "remediate": {
        const { fixedAt } = await remediate({
          tenantId: TENANT,
          subject: req_(body.subject, "subject"),
          content: req_(body.content, "content"),
          operator: "console",
        });
        const result = await recheck(
          TENANT,
          req_(body.memoryId, "memoryId"),
          req_(body.fromHlc, "fromHlc"),
          fixedAt,
        );
        return NextResponse.json({ fixedAt, ...result });
      }

      default:
        return NextResponse.json({ error: "unknown step" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}

function req_(v: string | undefined, name: string): string {
  if (!v) throw new Error(`missing ${name}`);
  return v;
}
