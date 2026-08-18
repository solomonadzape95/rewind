/**
 * Amazon Bedrock — the AWS-native model path.
 *
 * This exists because the ingestion Lambda cannot reach a local model. Ollama
 * on a laptop is perfect for developing the forensic machinery and useless to a
 * function running in AWS, so the pipeline that actually writes agent memory in
 * a deployed Rewind needs a model that lives where the function does.
 *
 * Two different services, deliberately:
 *
 *   - Claude, for extracting beliefs and making decisions. Reached through the
 *     Anthropic SDK's Bedrock client, not raw InvokeModel: the older
 *     bedrock-runtime InvokeModel path is legacy, and the Messages API surface
 *     is what the rest of this codebase is written against.
 *   - Titan Text Embeddings V2, for vectors. Claude does not do embeddings, so
 *     this one genuinely is an InvokeModel call against the AWS SDK.
 *
 * Neither is imported unless REWIND_PROVIDER=bedrock. The demo must keep
 * running with no AWS account at all, so these are dynamic imports behind a
 * provider check rather than top-level dependencies of the model layer.
 */
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

function region(): string {
  // AWS_REGION is reserved inside Lambda and set by the runtime; the override
  // exists for local invocation, where it may not be.
  const r = process.env.AWS_REGION_OVERRIDE ?? process.env.AWS_REGION;
  if (!r) {
    throw new Error("REWIND_PROVIDER=bedrock requires AWS_REGION (or AWS_REGION_OVERRIDE)");
  }
  return r;
}

let claude: AnthropicBedrockMantle | null = null;

function client(): AnthropicBedrockMantle {
  claude ??= new AnthropicBedrockMantle({ awsRegion: region() });
  return claude;
}

/**
 * Ask Claude on Bedrock for a JSON object matching `schema`.
 *
 * Note what is NOT sent: `temperature`. Every other provider in this codebase
 * gets `temperature: 0` for replay determinism, but the parameter was removed
 * on current Claude models and is rejected outright — passing it here would
 * fail every request with a 400. The verdict engine already assumes no provider
 * guarantees determinism and replays several times instead, so nothing about
 * the forensics depends on the parameter existing.
 */
export async function bedrockChatJson<T>(params: {
  model: string;
  system: string;
  user: string;
  schema: object;
  maxTokens: number;
}): Promise<T> {
  const message = await client().messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
    // Structured outputs rather than "please reply with JSON" — the schema is
    // enforced by the API, so a malformed shape is impossible rather than
    // merely unlikely. Bedrock supports this; the OpenAI-compatible path in
    // llm.ts cannot rely on it because coverage varies across those providers.
    //
    // The SDK's published types lag this field, so it is passed through an
    // escape hatch rather than by casting the whole request — casting the
    // request would also erase the non-streaming overload and take `content`
    // and `stop_reason` off the result type with it.
    // @ts-expect-error output_config is not in the installed SDK's types yet
    output_config: { format: { type: "json_schema", schema: params.schema } },
  });

  // A safety refusal arrives as a normal 200 with an empty content array, so
  // indexing content[0] blind would throw something unrelated to the cause.
  if (message.stop_reason === "refusal") {
    throw new Error(
      `${params.model} declined this request (refusal). Nothing was extracted.`,
    );
  }

  const text = message.content.find((b: { type: string }) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error(`no text block in the ${params.model} response`);
  }
  return JSON.parse(text.text) as T;
}

/** Titan V2's supported output widths. Anything else is rejected by the model. */
const TITAN_DIMS = new Set([256, 512, 1024]);

let titan: BedrockRuntimeClient | null = null;

/**
 * Embed text with Amazon Titan Text Embeddings V2.
 *
 * The requested width is passed through rather than hardcoded to Titan's 1024
 * default, so the vectors match whatever width the schema was created at. A
 * mismatch here would not be a slow failure — CockroachDB rejects the insert —
 * but the error would point at the database rather than at the model that
 * actually produced the wrong shape, so it is checked up front.
 */
export async function bedrockEmbed(text: string, dim: number): Promise<number[]> {
  if (!TITAN_DIMS.has(dim)) {
    throw new Error(
      `Titan V2 emits 256, 512 or 1024 dimensions; the schema expects ${dim}. ` +
        `Set REWIND_EMBED_DIM to one of those and re-run pnpm db:reset.`,
    );
  }

  titan ??= new BedrockRuntimeClient({ region: region() });

  const res = await titan.send(
    new InvokeModelCommand({
      modelId: process.env.REWIND_EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: dim, normalize: true }),
    }),
  );

  const body = JSON.parse(new TextDecoder().decode(res.body)) as {
    embedding?: number[];
  };
  if (!body.embedding) throw new Error("no embedding in the Titan response");
  if (body.embedding.length !== dim) {
    throw new Error(
      `Titan returned ${body.embedding.length} dimensions but the schema expects ${dim}`,
    );
  }
  return body.embedding;
}
