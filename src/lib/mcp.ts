/**
 * The agent's memory access, routed through the CockroachDB Cloud Managed MCP
 * Server instead of a direct SQL connection.
 *
 * WHY THIS EXISTS
 *
 * The forensic half of Rewind holds a database connection because forensics is
 * infrastructure — it is the engineer's tool, not the agent's. The *agent* is a
 * different case. In production the thing that reads and writes memory is a
 * model with a tool surface, and the tool surface is MCP. Giving the agent a
 * `pg.Pool` would model something nobody deploys.
 *
 * THE HARD PART, AND WHY IT IS ONE SQL STATEMENT
 *
 * Rewind's whole thesis rests on `decision.memory_hlc` being the exact MVCC
 * coordinate the recall observed. Over a direct connection that is enforced by
 * running the clock read and the recall inside one `BEGIN ... COMMIT` (see
 * agent.ts). Over MCP there is no such thing as a session: each tool call is
 * independent, and a server is free to route two calls to two different
 * gateways. Issuing `SELECT cluster_logical_timestamp()` and then a recall as
 * two tool calls would leave a window for an ingestion to land between them —
 * and replay would then reproduce a memory state the agent never saw. That is
 * precisely the bug the transaction exists to prevent, reintroduced by the
 * transport.
 *
 * So the MCP path sends ONE statement that returns the timestamp alongside the
 * rows. A single statement is its own implicit transaction and therefore its
 * own single MVCC snapshot, which restores the invariant without needing
 * session state. The guarantee survives the transport change; it just has to be
 * expressed differently.
 *
 * Unconfigured, this module is inert and the agent uses the direct path. That
 * is deliberate: the demo must run with no cloud account.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Cockroach Labs' managed endpoint. Override for a self-hosted MCP server. */
const DEFAULT_URL = "https://cockroachlabs.cloud/mcp";

export function mcpEnabled(): boolean {
  return process.env.REWIND_MCP === "1" || Boolean(process.env.CRDB_MCP_TOKEN);
}

function mcpUrl(): string {
  return process.env.CRDB_MCP_URL ?? DEFAULT_URL;
}

let cached: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  if (cached) return cached;
  cached = (async () => {
    const token = process.env.CRDB_MCP_TOKEN;
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
      requestInit: token
        ? { headers: { Authorization: `Bearer ${token}` } }
        : undefined,
    });
    const client = new Client(
      { name: "rewind-agent", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  })();
  // A failed connect must not poison the cache — the next call should retry
  // rather than replay the same rejected promise forever.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/**
 * The managed server's SQL tool, discovered rather than hardcoded.
 *
 * Tool names are the server's to choose and have changed during preview. Asking
 * for the catalogue and matching on it costs one round trip at startup and
 * means a rename upstream does not silently break the agent — it produces a
 * legible error naming the tools that were actually offered.
 */
let sqlToolName: string | null = null;

async function findSqlTool(client: Client): Promise<string> {
  if (sqlToolName) return sqlToolName;
  const { tools } = await client.listTools();
  const match =
    tools.find((t) => /^(execute_)?sql$/i.test(t.name)) ??
    tools.find((t) => /\b(sql|query)\b/i.test(t.name) && !/explain|plan/i.test(t.name));
  if (!match) {
    throw new Error(
      `no SQL tool on the MCP server at ${mcpUrl()}; it offered: ${tools
        .map((t) => t.name)
        .join(", ")}`,
    );
  }
  sqlToolName = match.name;
  return sqlToolName;
}

/**
 * Run a statement through MCP and return its rows.
 *
 * MCP tool results are content blocks meant for a model to read, not a typed
 * result set, so the rows come back as text that has to be parsed. Servers vary
 * in what they wrap the payload in; we accept the shapes seen in the wild and
 * fail loudly on anything else rather than quietly returning zero rows — a
 * silent empty recall would look like "the agent believed nothing", which is a
 * far worse failure than an exception.
 */
export async function mcpSql<T>(statement: string): Promise<T[]> {
  const client = await connect();
  const tool = await findSqlTool(client);
  const result = await client.callTool({
    name: tool,
    arguments: { sql: statement, statement, query: statement },
  });

  if (result.isError) {
    throw new Error(`MCP SQL tool reported an error: ${renderContent(result)}`);
  }

  const text = renderContent(result);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`MCP SQL tool returned non-JSON output: ${text.slice(0, 300)}`);
  }

  if (Array.isArray(parsed)) return parsed as T[];
  const rows = (parsed as { rows?: unknown; results?: unknown }).rows ??
    (parsed as { results?: unknown }).results;
  if (Array.isArray(rows)) return rows as T[];
  throw new Error(`MCP SQL tool returned an unrecognised shape: ${text.slice(0, 300)}`);
}

function renderContent(result: unknown): string {
  const { content } = (result ?? {}) as { content?: unknown };
  return renderBlocks(content);
}

function renderBlocks(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export interface McpRecall {
  hlc: string;
  memories: {
    memory_id: string;
    kind: string;
    subject: string;
    content: string;
    confidence: number;
    source_id: string | null;
    distance: number;
  }[];
}

/**
 * Recall + timestamp capture, in one statement, over MCP.
 *
 * `cluster_logical_timestamp()` is selected as a column of the recall itself.
 * One statement, one implicit transaction, one snapshot — the rows and the
 * timestamp cannot disagree, whatever the transport does between calls.
 *
 * The parameters are inlined because the managed server's SQL tool takes a
 * statement string and no bind array. `quote` below is the only thing standing
 * between that and an injection hole, so it is deliberately strict: the tenant
 * must be a UUID and the vector must be numeric. Nothing else reaches the
 * statement.
 */
export async function mcpRecall(
  tenantId: string,
  embedding: number[],
  k = 8,
): Promise<McpRecall> {
  const rows = await mcpSql<{
    hlc: string;
    memory_id: string;
    kind: string;
    subject: string;
    content: string;
    confidence: number;
    source_id: string | null;
    distance: number;
  }>(
    `SELECT cluster_logical_timestamp()::STRING AS hlc,
            memory_id, kind, subject, content, confidence, source_id,
            embedding <=> ${vectorLiteral(embedding)} AS distance
     FROM memory
     WHERE tenant_id = ${uuidLiteral(tenantId)} AND valid
     ORDER BY embedding <=> ${vectorLiteral(embedding)}
     LIMIT ${Math.trunc(k)}`,
  );

  if (rows.length === 0) {
    throw new Error("MCP recall returned no memories; refusing to record a decision with an unknown HLC");
  }
  // Every row carries the same timestamp because they come from one snapshot.
  // If they ever disagree, the single-statement assumption has been broken by
  // the server and the forensic anchor is not trustworthy — say so.
  const hlc = rows[0].hlc;
  if (rows.some((r) => r.hlc !== hlc)) {
    throw new Error("MCP recall returned rows from more than one snapshot; the HLC anchor is unsound");
  }

  return {
    hlc,
    memories: rows.map(({ hlc: _drop, ...m }) => ({ ...m, distance: Number(m.distance) })),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidLiteral(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`not a UUID, refusing to interpolate: ${id}`);
  return `'${id}'::UUID`;
}

export function vectorLiteral(embedding: number[]): string {
  for (const n of embedding) {
    if (!Number.isFinite(n)) throw new Error("embedding contains a non-finite value");
  }
  return `'[${embedding.join(",")}]'::VECTOR`;
}
