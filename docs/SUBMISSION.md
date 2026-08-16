# Devpost submission — copy sheet

Everything the form asks for, written out. Paste, don't re-draft at 4pm.

Deadline: **Aug 18, 2026, 5:00pm EDT**. Submit by noon.

---

## Tagline (one line)

Time-travel forensics for agent memory — replay what an AI *believed*, not just
what it said.

## Elevator pitch (~200 words)

Every observability tool captures what an agent said. None capture what it
believed. When an agent acts and the action is wrong, answering for it means
reconstructing its memory as of that instant — and today that's an
event-sourcing project: belief logs, snapshot tables, replay infrastructure.

CockroachDB already stores it. MVCC keeps every version of every row for the
length of the GC window, and `AS OF SYSTEM TIME` queries it in one clause.
Rewind stores **no history of its own** — no audit table, no event log, no
snapshots — and still answers "what did the agent believe at 14:32?" exactly.

Given one bad decision, Rewind answers three questions. *Was this bad reasoning
or bad memory?* — it replays the agent against the exact memory state it read,
and refuses to rule if the prompt or model has drifted since. *Which write
caused it?* — it binary-searches MVCC, roughly 20 probes to narrow a 7-day
window to the second, and resolves the flip to the document that wrote it.
*What else did it affect?* — it enumerates every other decision that read the
belief while it was wrong, and prices the exposure.

Then it fixes the belief and re-replays all of them.

## The one-line hook

A slider that rewinds an AI's mind, and a verdict engine that tells you whether
the failure was bad reasoning or bad memory.

---

## Which CockroachDB tools, and how

| Tool | Where it is used | What it does here |
|---|---|---|
| **Cloud Managed MCP Server** | `src/lib/mcp.ts`, wired into `src/lib/agent.ts` | The agent has no database connection. It reads memory through the managed MCP endpoint's SQL tool, discovered at runtime via `tools/list` rather than hardcoded. The recall and the HLC capture go out as **one statement** so they share one MVCC snapshot — the guarantee a transaction gives on a direct connection, preserved across a transport that has no sessions. |
| **Distributed Vector Indexing (C-SPANN)** | `db/schema.sql`, `src/lib/memory.ts` | `CREATE VECTOR INDEX ... ON memory (tenant_id, embedding)` — tenant-prefixed, so the index itself enforces multi-tenant isolation instead of a `WHERE` clause. Serves the live recall path. |
| **ccloud CLI** | `infra/provision.sh` | Scripted cluster provisioning, with `gc.ttlseconds` widened **before** any row is written — order that is load-bearing, not cosmetic. |
| **Agent Skills** | `skills/rewind-forensics/SKILL.md`, `mcp/server.ts` | Rewind's own forensic surface is exposed as MCP tools and an agent skill, so an on-call agent can run the investigation itself. |

Beyond the tool list, the load-bearing CockroachDB features are **MVCC +
`AS OF SYSTEM TIME`** (the entire product), **`gc.ttlseconds` as a retention
policy**, and **CHANGEFEED** (`scripts/sentinel.ts`) for live detection.

## Which AWS services, and how

| Service | Where | What it does here |
|---|---|---|
| **AWS Lambda** | `lambda/ingest.ts`, `infra/deploy-lambda.sh` | The ingestion pipeline. S3 object → text → model-extracted beliefs → in-place `UPDATE` to memory, tagged with the `source_id` of the document that wrote it. This is the attack surface, deliberately unguarded. |
| **Amazon S3** | `docs/inbound/`, bucket `rewind-demo` | Source documents, including the injected one that causes the incident. Trust is a property of the key prefix: `inbound/` → 0.2, `policies/` → 1.0. |
| **Amazon Bedrock** | `src/lib/llm.ts` (`REWIND_PROVIDER=bedrock`) | Optional model path for the agent and the extractor. Optional on purpose: the claim is about the memory layer, not about whose model reads it, and the project must run with no cloud account. |

Minimum is 2 CockroachDB tools + 1 AWS service. Rewind uses 4 + 3.

---

## How it addresses the judging criteria

**Agentic Memory Design.** CockroachDB *is* the memory — beliefs, embeddings,
and their entire history — not a cache in front of a vector store. The design
rule that makes it work is that memory rows are mutated in place and never
appended: the table looks like it has no history, and MVCC has all of it. The
moment we keep our own version table, CockroachDB stops being load-bearing.

**Technical Implementation.** The linchpin is one column, `decision.memory_hlc`,
captured inside the same transaction as the recall so replay reproduces the
agent's memory exactly rather than approximately. `tests/forensics.integration.test.ts`
asserts that premise against a live cluster; `tests/guards.test.ts` attacks the
two places where SQL is necessarily built by concatenation (`AS OF SYSTEM TIME`
and the MCP SQL tool both refuse bind parameters).

**Real-World Impact.** Post-incident debugging, memory-poisoning forensics,
regulated audit (EU AI Act), legal discovery, and memory regression testing. The
blast-radius query returns a dollar figure, which is the form an incident report
has to take before anyone acts on it.

**Production Readiness.** The verdict engine **refuses to rule** when the prompt
or model has drifted since the decision — a forensics tool that returns a
confident wrong answer is worse than none. `/api/health` surfaces
`gc.ttlseconds`, because a cluster on the 4h default looks healthy and will fail
every question about yesterday. Tenant isolation is enforced at the index. The
sentinel detects low-trust overwrites of high-confidence policy beliefs live.

**Creativity & Originality.** Nobody is doing time-travel debugging for agent
memory. A vector database would need a whole event-sourcing system bolted on to
answer these questions; CockroachDB does it with a `WHERE` clause's worth of
effort.

---

## Feedback on CockroachDB's AI tools (optional field — fill it, it's cheap goodwill)

Points worth making, all encountered while building:

- `AS OF SYSTEM TIME` accepting the raw `cluster_logical_timestamp()` decimal is
  what makes exact replay possible at all. Nothing else in the ecosystem offers
  a coordinate that is both cheap to store and exactly re-readable.
- `AS OF SYSTEM TIME` does not accept a bind parameter, which forces every
  historical read to build SQL by concatenation. A parameterised form would
  remove a whole class of injection risk from anything doing this seriously.
- **Object names resolve as of the read timestamp**, so `AS OF SYSTEM TIME`
  before a `DROP DATABASE` reads the *old* descriptor and the *old* tables.
  Correct, and genuinely surprising the first time — worth a callout in the docs
  next to the historical-query section.
- **The biggest one.** Widening `gc.ttlseconds` on a database is not sufficient to
  extend how far back `AS OF SYSTEM TIME` works, because name resolution reads
  the `system` descriptor tables at the historical timestamp too, and those
  ranges keep the 4h default. The resulting error names a system range
  (`must be after replica GC threshold (r10: /Table/{5-6})`) and never mentions
  retention, so it reads as a storage bug rather than a policy limit. The
  historical-query docs should state that the effective horizon is
  `min(database TTL, system range TTL)`, and ideally `SHOW ZONE CONFIGURATION`
  or an error hint should surface it.
- `crdb_internal` is blocked on Cloud (42501), so a health check that reads zone
  configuration has to go through `SHOW ZONE CONFIGURATION` and parse the raw
  SQL string. A supported structured accessor for `gc.ttlseconds` would help.
- Managed MCP tool names shifted during preview; discovering the SQL tool via
  `tools/list` rather than hardcoding it turned out to be necessary.
- C-SPANN did return correct historical results under `AS OF SYSTEM TIME` on
  v26.2 in our day-1 spike, but the guarantee isn't documented. Stating one
  either way would let people build on it.

---

## Submission checklist

- [ ] **Public repo** — pushed to GitHub, MIT licence present (`LICENSE`), README
      has setup instructions and the requirements-coverage table.
- [ ] **Working demo URL** — console deployed with seeded data, so a judge sees
      the incident without running anything.
- [ ] **Demo video < 3:00** — public on YouTube/Vimeo. Shot list in `docs/VIDEO.md`.
      **The `AS OF SYSTEM TIME` SQL must be on screen.** The rules require footage
      of the memory layer at work.
- [ ] **Documentation** — CockroachDB tools and AWS services identified with
      implementation detail (the two tables above), architecture diagram
      (`docs/architecture.md`), feedback field filled.
- [ ] Disclose any pre-existing code.
- [ ] Submitted by **noon EDT Aug 18**, not 4:55pm.
