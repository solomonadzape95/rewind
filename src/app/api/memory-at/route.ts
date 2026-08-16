import { NextResponse } from "next/server";
import { memoryAt } from "@/lib/queries";
import { assertHlc } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const hlc = new URL(req.url).searchParams.get("hlc");
  if (!hlc) return NextResponse.json({ error: "hlc required" }, { status: 400 });
  try {
    assertHlc(hlc);
  } catch {
    return NextResponse.json({ error: "malformed hlc" }, { status: 400 });
  }
  return NextResponse.json({ memories: await memoryAt(hlc) });
}
