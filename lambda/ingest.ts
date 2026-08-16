import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { S3Event } from "aws-lambda";
import { pool } from "../src/lib/db";
import { embed } from "../src/lib/embeddings";
import { remember } from "../src/lib/memory";
import { extractBeliefs, extractText, trustForKey } from "../src/lib/extract";
import { TENANT } from "../src/lib/tenant";

const s3 = new S3Client({});

/**
 * S3 → Bedrock → CockroachDB. The agent's memory changes here and nowhere else.
 *
 * Every belief written records the `source_id` of the document that produced it,
 * which is the join that lets forensics name a culprit hours later. Without it,
 * bisection could tell you WHEN a belief changed but never WHY — and "the number
 * changed at 15:19" is not an incident report.
 *
 * Note there is deliberately no guard here rejecting low-trust writes. Adding one
 * would prevent this specific incident and defeat the demonstration; more
 * importantly, real pipelines do not have it either, which is why this class of
 * failure reaches production. Rewind's claim is about explaining the failure
 * after it happens, not preventing it.
 */
export async function handler(event: S3Event): Promise<{ ingested: number }> {
  let ingested = 0;

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = Buffer.from(await obj.Body!.transformToByteArray());
    const text = await extractText(key, body);
    const trust = trustForKey(key, obj.Metadata?.trust);

    const beliefs = await extractBeliefs(text);
    if (beliefs.length === 0) {
      console.log(JSON.stringify({ msg: "no beliefs extracted", key }));
      continue;
    }

    // One source row per document, recorded before any belief that cites it.
    const { rows } = await pool.query<{ source_id: string }>(
      `INSERT INTO ingestion_source (tenant_id, kind, uri, excerpt, trust_score)
       VALUES ($1, $2, $3, $4, $5) RETURNING source_id`,
      [
        TENANT,
        key.split(".").pop()?.toLowerCase() ?? "unknown",
        `s3://${bucket}/${key}`,
        text.slice(0, 2000),
        trust,
      ],
    );
    const sourceId = rows[0].source_id;

    for (const b of beliefs) {
      await remember({
        tenantId: TENANT,
        kind: b.subject.startsWith("policy.") ? "policy" : "fact",
        subject: b.subject,
        content: b.content,
        embedding: await embed(b.content),
        sourceId,
        confidence: b.confidence,
      });
      ingested++;
      console.log(
        JSON.stringify({ msg: "belief written", subject: b.subject, trust, source: sourceId }),
      );
    }
  }

  return { ingested };
}
