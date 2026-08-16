#!/usr/bin/env node
/**
 * Rewind as an MCP server — the forensic surface, exposed as agent tools.
 *
 * The console is for a human watching a demo. This is for the on-call agent at
 * 03:00. An incident-response agent connected here can ask what its own
 * predecessor believed at a past instant, replay a decision, bisect a belief to
 * the write that changed it, and price the exposure — without a human opening a
 * SQL prompt.
 *
 * The tools are deliberately the SAME functions the console calls, not a
 * parallel implementation. A forensic tool surface that drifts from the UI is a
 * tool surface that will one day disagree with the evidence a human is looking
 * at, and there is no worse property for this particular product to have.
 *
 * READ-ONLY BY DESIGN. Nothing here mutates memory. An agent given the power to
 * "fix" a belief it has just accused is an agent that can quietly rewrite the
 * record it is being audited against; remediation stays a human action behind
 * `pnpm rewind fix`.
 *
 * Run:  pnpm mcp
 * Wire: see .mcp.json (Claude Code / Claude Desktop pick it up automatically)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { pool } from "../src/lib/db";
import { memoryAt, listDecisions } from "../src/lib/queries";
import { verdict } from "../src/lib/replay";
import { trace } from "../src/lib/bisect";
import { blastRadius } from "../src/lib/blast";
import { TENANT } from "../src/lib/tenant";

const server = new McpServer({ name: "rewind", version: "0.1.0" });

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

server.registerTool(
  "rewind_timeline",
  {
    title: "List recorded decisions",
    description:
      "Every action the agent took, with the HLC timestamp of the memory it read. Start here: the decision_id and memory_hlc from this list are the inputs to every other tool.",
    inputSchema: {},
  },
  async () => json(await listDecisions()),
);

server.registerTool(
  "rewind_memory_at",
  {
    title: "Reconstruct the agent's belief state at a past instant",
    description:
      "The agent's entire memory as of an HLC timestamp, read straight out of CockroachDB's MVCC history with AS OF SYSTEM TIME. No snapshot table is consulted because none exists. Pass a decision's memory_hlc to see exactly what it believed when it acted.",
    inputSchema: {
      hlc: z
        .string()
        .describe("A hybrid-logical-clock timestamp, e.g. a decision's memory_hlc."),
    },
  },
  async ({ hlc }) => json(await memoryAt(hlc)),
);

server.registerTool(
  "rewind_verdict",
  {
    title: "Rule on a decision: bad memory or bad reasoning",
    description:
      "Replays the decision against the memory state it actually read, several times, and against memory as of now. Returns BAD_MEMORY, BAD_REASONING, NON_DETERMINISTIC, RESOLVED, or REPLAY_UNSOUND — the last meaning the prompt or model has drifted since, so no honest verdict is available. Slow: it invokes the model several times.",
    inputSchema: {
      decisionId: z.string().describe("decision_id from rewind_timeline."),
    },
  },
  async ({ decisionId }) => json(await verdict(TENANT, decisionId)),
);

server.registerTool(
  "rewind_trace",
  {
    title: "Find the write that changed a belief",
    description:
      "Binary-searches MVCC to pin the most recent moment a belief changed value, then resolves it to the ingested document that wrote it. Roughly 20 probes narrow a 7-day window to the second. Returns the prior value, the new value, and the source document with its trust score.",
    inputSchema: {
      subject: z
        .string()
        .describe("The belief's stable key, e.g. policy.refund_limit.enterprise"),
      upTo: z
        .string()
        .optional()
        .describe("Anchor the search at this HLC instead of now — use a decision's memory_hlc to ask how the belief came to hold the value that decision read."),
    },
  },
  async ({ subject, upTo }) => json(await trace(TENANT, subject, { upTo })),
);

server.registerTool(
  "rewind_blast_radius",
  {
    title: "Enumerate and price every decision made on a bad belief",
    description:
      "Every other decision whose recall window overlapped the period a belief was wrong AND that actually retrieved it, with the total dollar exposure. This is the incident report, not the debugging session.",
    inputSchema: {
      memoryId: z.string().describe("memory_id of the bad belief (rewind_trace returns it)."),
      fromHlc: z.string().describe("Start of the bad window — rewind_trace's flippedAt.after."),
      toHlc: z
        .string()
        .optional()
        .describe("End of the bad window. Omit if the belief has not been corrected yet."),
    },
  },
  async ({ memoryId, fromHlc, toHlc }) =>
    json(await blastRadius(TENANT, memoryId, fromHlc, toHlc ?? null)),
);

// Wrapped in a function rather than a top-level await: this file is run by tsx,
// which transpiles to CJS, where top-level await is a build error rather than a
// runtime one. The failure mode is that `pnpm mcp` refuses to start at all.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio is the protocol channel — anything written to stdout that is not a
  // JSON-RPC frame corrupts the session. Diagnostics go to stderr, always.
  process.stderr.write("rewind mcp server ready\n");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void pool.end().finally(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  process.stderr.write(`rewind mcp server failed to start: ${e}\n`);
  process.exit(1);
});
