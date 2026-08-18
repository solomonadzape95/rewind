import { NextResponse } from "next/server";
import { verdict } from "@/lib/replay";
import { trace } from "@/lib/bisect";
import { blastRadius } from "@/lib/blast";
import { remediate, recheck } from "@/lib/remediate";
import { TENANT } from "@/lib/tenant";

export const dynamic = "force-dynamic";

// Replay runs the model several times and bisection issues ~20 queries, so the
// 10s serverless default is not enough.
//
// 60 rather than 300 on purpose: Vercel's Hobby plan caps maxDuration at 60 and
// FAILS THE BUILD above it. A submission that deploys everywhere at 60s beats
// one that needs a Pro account to exist at all. On Pro, raise it — but only if
// the model behind it is slow enough to need it; a hosted model (Groq, Bedrock)
// completes three replay runs well inside a minute.
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json()) as {
    step: "verdict" | "trace" | "blast" | "remediate";
    decisionId?: string;
    subject?: string;
    content?: string;
    upTo?: string;
    memoryId?: string;
    fromHlc?: string;
    toHlc?: string | null;
  };

  try {
    switch (body.step) {
      case "verdict":
        return NextResponse.json(await verdict(TENANT, req_(body.decisionId, "decisionId")));
      case "trace":
        return NextResponse.json(
          await trace(TENANT, req_(body.subject, "subject"), { upTo: body.upTo }),
        );
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
