# Rewind — time-travel memory for production agents

Every observability tool captures what an agent **said**. None capture what it **believed**.

When an agent acts and the action is wrong, someone has to answer for it — an engineer, a
regulator, a court. Answering means reconstructing the agent's memory as of the moment of the
decision. Today that's an event-sourcing project: append-only belief logs, snapshot tables,
replay infrastructure.

CockroachDB already stores it. MVCC keeps every version of every row for the length of the GC
window, and `AS OF SYSTEM TIME` queries it in one clause. **Rewind stores no history of its own**
— no audit table, no event log, no snapshots — and can still answer "what did the agent believe
at 14:32?" exactly.

---

## What it does

Given one bad agent decision, Rewind answers three questions, then closes the
incident:

1. **Was this bad reasoning or bad memory?** Replays the agent against the exact memory state it
   read, several times, and rules on the result. It refuses to rule when the prompt or model has
   drifted since — a forensics tool that returns a confident wrong answer is worse than none.
2. **Which write caused it?** Walks backwards through MVCC to find the most recent time the
   belief changed, then bisects to pin it and resolves that to the document that wrote it —
   roughly 20 probes to narrow a 7-day window to the second.
3. **What else did it affect?** Enumerates every other decision that read the belief while it was
   wrong, and prices the exposure.

Then it restores the value bisection proved was there before the poisoning, and re-replays every
affected decision against the corrected memory — memory regression testing in the plainest form.
The correction is an ordinary in-place `UPDATE`, so it becomes another MVCC version: six months
from now the same bisection finds both the attack and the fix.

```
VERDICT: BAD_MEMORY
The agent read a belief that had been rewritten shortly before this decision by a
lower-trust source. "policy.refund_limit.enterprise" changed from "Enterprise refund
limit is $500 per incident." to "Enterprise refund limit is $5,000 per incident." via
s3://rewind-demo/inbound/q3-vendor-policy-update.pdf (trust 0.2 vs 1). The model
applied its memory correctly; the memory was wrong.

BLAST RADIUS: 5 decisions read this belief while it was wrong
  Total approved on the bad belief: $12,400
```

## Requirements coverage

| Requirement | Satisfied by | Where |
|---|---|---|
| CockroachDB tool 1 | **Cloud Managed MCP Server** — the agent has no database connection; it reads memory through MCP tools | `src/lib/mcp.ts` |
| CockroachDB tool 2 | **Distributed Vector Indexing (C-SPANN)** — live semantic recall, tenant-prefixed | `db/schema.sql`, `src/lib/memory.ts` |
| CockroachDB tool 3 | **ccloud CLI** — cluster provisioning, scripted | `infra/provision.sh` |
| CockroachDB tool 4 | **Agent Skills** — Rewind's forensic surface, as MCP tools and a skill | `mcp/server.ts`, `skills/` |
| AWS service 1 | **AWS Lambda** — the ingestion pipeline, triggered by S3 | `lambda/ingest.ts` |
| AWS service 2 | **Amazon S3** — source documents, including the one that causes the incident | `docs/inbound/` |
| AWS service 3 | **Amazon Bedrock** — optional model path for the agent and extractor | `src/lib/llm.ts` |

Minimum is 2 CockroachDB tools + 1 AWS service. Rewind uses 4 + 3.

Beyond the tool list, the load-bearing CockroachDB features are **MVCC + `AS OF SYSTEM TIME`**
(the entire product), **`gc.ttlseconds` as a retention policy**, and **CHANGEFEED** for live
detection (`scripts/sentinel.ts`). Full architecture: [`docs/architecture.md`](docs/architecture.md).

The model provider is deliberately pluggable and **defaults to a local one**. Bedrock is one item
on the AWS list, not a requirement — Lambda and S3 already satisfy it — and Rewind's claim is
about the memory layer, not about whose model reads it. Set `REWIND_PROVIDER=bedrock` to run
Claude on Bedrock instead.

## The load-bearing idea

One column: `decision.memory_hlc`.

At the instant the agent reads memory, the cluster's hybrid-logical-clock timestamp is captured
**inside the same read-only transaction as the recall**, so both observe one MVCC snapshot. That
decimal drops straight into `AS OF SYSTEM TIME`, so replay reproduces the agent's memory exactly
rather than approximately. Capturing it outside the transaction would leave a window for a
concurrent write to land between the clock read and the recall — and replay would then reproduce
a memory state the agent never saw.

Everything else in this project is UI. That column is the idea.

Two design rules follow from it, and both are load-bearing:

- **Memory rows are mutated in place, never appended.** The table looks like it has no history;
  MVCC has all of it. The moment we keep our own version table, CockroachDB stops being
  load-bearing and the whole thesis collapses.
- **`gc.ttlseconds` is widened before any data is written.** `AS OF SYSTEM TIME` can only read
  inside the GC window; raising it later does not resurrect collected history. Set it to your
  regulatory retention requirement and forensic replay becomes a config value rather than an
  engineering project.

### The system ranges cap your horizon, and the error doesn't say so

Widening `gc.ttlseconds` on the database is necessary and **not sufficient**. This cost us a
demo, so it is written down properly.

CockroachDB resolves object names *as of the read timestamp*. Every historical query therefore
also reads the descriptor tables in `system` at that same past timestamp — and those live in
ranges with their own zone configuration, which stays at the 4h default no matter what you set on
your database. Past four hours, reads fail like this:

```
batch timestamp ... must be after replica GC threshold (r10: /Table/{5-6})
```

Note what that does *not* say. It does not mention your table, your database, or retention. Your
memory rows are still there, still holding seven days of perfectly readable history — the query
fails because the *name* can no longer be resolved that far back. It reads like a bug in the
storage layer, at the exact moment you are trying to prove there isn't one.

**The effective forensic horizon is `min(database TTL, system range TTL)`.** `pnpm db:init` and
`infra/provision.sh` now widen both; `/api/health` reports both and names the binding constraint.
On managed tiers the system zones may belong to the provider, in which case the horizon is theirs
to set — which is worth knowing before an auditor asks, not during.

## The agent has no database connection

In production, the thing that reads and writes agent memory is a model with a tool surface, and
the tool surface is MCP. Giving the agent a `pg.Pool` would model something nobody deploys — so
when `CRDB_MCP_TOKEN` is set, recall goes through the **CockroachDB Cloud Managed MCP Server**
instead. The forensic half keeps a direct connection, because forensics is the engineer's
infrastructure, not the agent's.

That transport change threatens the one guarantee the project rests on. On a direct connection,
the clock read and the recall are pinned to one MVCC snapshot by a transaction. MCP has no
sessions: each tool call is independent, and two calls could be routed to two gateways with an
ingestion landing in between — reintroducing, at the transport layer, precisely the bug the
transaction exists to prevent.

So the MCP path sends **one statement** that returns `cluster_logical_timestamp()` as a column of
the recall itself. A single statement is its own implicit transaction and therefore its own single
snapshot. The guarantee survives; it just has to be expressed differently.

```sh
export CRDB_MCP_TOKEN=...            # from the CockroachDB Cloud console
export CRDB_MCP_URL=https://cockroachlabs.cloud/mcp   # optional, this is the default
```

Unset, the module is inert and the demo runs with no cloud account at all.

## Rewind is itself an MCP server

The console is for a human watching a demo. `mcp/server.ts` is for the on-call agent at 03:00: an
incident-response agent connected to it can ask what its predecessor believed, replay a decision,
bisect a belief to the write that changed it, and price the exposure — without a human opening a
SQL prompt.

```sh
pnpm mcp        # stdio; .mcp.json wires it into Claude Code automatically
```

Tools: `rewind_timeline`, `rewind_memory_at`, `rewind_verdict`, `rewind_trace`,
`rewind_blast_radius`. They call the same functions the console calls, not a parallel
implementation — a forensic tool surface that drifts from the UI will one day disagree with the
evidence a human is looking at.

**Read-only, deliberately.** Remediation is not exposed. An agent that can "fix" a belief it has
just accused can quietly rewrite the record it is being audited against; correcting memory stays a
human action behind `pnpm rewind fix`. The investigation procedure is written up as an agent skill
in `skills/rewind-forensics/SKILL.md`.

## Live detection

Forensics explains an incident after someone notices. The gap that takes an incident from six
hours to six seconds is *noticing*.

```sh
pnpm sentinel                 # watch, via a core changefeed — no licence needed
pnpm sentinel --install-sql   # the enterprise CHANGEFEED INTO <sink> form
```

The rule is narrow, because a noisy detector is an ignored one: alert when a **high-confidence
policy** belief is overwritten by a source **less trusted** than the one that wrote the value it
replaced. That is the exact shape of the attack in the demo, and not the shape of legitimate
operations.

It detects rather than prevents, and the write has already committed by the time it fires. That is
the correct trade: a gate in the ingestion path would have to be right in real time about a
document it has just met, and being wrong there means dropping a legitimate policy update.
Detecting in seconds and handing the responder a pre-built blast radius is achievable; perfect
prevention is not.

## Why replay uses exact search, not the vector index

Two retrieval paths, deliberately:

- **Live path** — C-SPANN approximate nearest neighbour. Fast, distributed, correct for serving.
- **Replay path** — exact brute-force `cosine_distance` at a historical timestamp.

C-SPANN is an approximate, background-maintained index and makes no guarantee about what a
historical read returns. Replay evidence must be provably identical to what the agent saw, not
approximately identical. **Approximation is fine for recall; it is not fine for evidence.**
Forensics runs over one tenant's working set, where exact search is milliseconds.

(Our day-1 spike found that C-SPANN *does* return correct historical results on v26.2 — but the
replay path does not depend on that holding.)

## Models — free by default

Everything runs on local models with no account, no API key, and no cost:

```sh
brew install ollama && ollama serve
ollama pull qwen2.5:7b          # the agent and the document extractor
ollama pull nomic-embed-text    # embeddings, 768 dims
```

That is the default — no configuration needed. Other providers are one env var each:

| Provider | Setup |
|---|---|
| **Ollama** (default) | nothing; `REWIND_MODEL_ID` to change the model |
| Groq / OpenRouter / DeepSeek / Together | `REWIND_PROVIDER=openai`, `REWIND_BASE_URL`, `REWIND_API_KEY`, `REWIND_MODEL_ID` |
| Claude on Bedrock | `REWIND_PROVIDER=bedrock`, `AWS_REGION` (paid, per token) |
| No model at all | `REWIND_OFFLINE=1` — deterministic stubs for development |

Anything OpenAI-compatible works through the same adapter. If you switch embedding models, set
`REWIND_EMBED_DIM` to match and re-run `pnpm db:reset` — the schema's vector width is set at init
and a mismatch is rejected on insert rather than silently corrupting search.

The `REWIND_OFFLINE=1` stubs exist so the forensic machinery can be developed with no model
running at all. They are not the agent, and nothing demoed comes from them.

## Running it locally

```sh
pnpm install
pnpm db:local          # single-node CockroachDB
pnpm db:init           # create DB, widen GC window, apply schema — in that order
pnpm spike             # validate the thesis before building on it

pnpm db:reset          # before every rehearsal — see below

REWIND_OFFLINE=1 pnpm db:seed     # T+0: correct memory, legitimate decisions
REWIND_OFFLINE=1 pnpm poison      # a malicious PDF rewrites one belief, in place

REWIND_OFFLINE=1 pnpm rewind timeline
REWIND_OFFLINE=1 pnpm rewind verdict <decision-id>
REWIND_OFFLINE=1 pnpm rewind trace policy.refund_limit.enterprise
REWIND_OFFLINE=1 pnpm rewind blast <memory-id> <from-hlc>

REWIND_OFFLINE=1 pnpm rewind fix policy.refund_limit.enterprise "Enterprise refund limit is \$500 per incident."
REWIND_OFFLINE=1 pnpm rewind recheck <memory-id> <from-hlc> <fixed-at-hlc>
```

### Tests

```sh
pnpm test
```

`tests/guards.test.ts` attacks the two places where SQL is necessarily built by string
concatenation — `AS OF SYSTEM TIME` and the MCP SQL tool both refuse bind parameters, so those
guards are the only thing between the historical read path and an injection hole.

`tests/forensics.integration.test.ts` asserts the *premise*: that a past value is readable with no
history table, that the row is invisible before it existed, and that bisection lands on the write
that changed it, logarithmically. It needs a database and skips without one — but if it fails,
nothing else in Rewind is worth running.

### The console

```sh
REWIND_OFFLINE=1 pnpm dev     # http://localhost:3000
```

Three views, which are also the three beats of the demo:

- **Timeline scrubber** — drag across the incident and watch the agent's belief state change,
  with the `AS OF SYSTEM TIME` query for the current slider position shown live. Every stop on
  the track is a real HLC captured at a real decision, not an interpolation.
- **Verdict** — replays the decision against the memory it actually read and rules on it.
- **Trace / blast radius** — the bisection probes stream in, land on the poisoned document, and
  the blast query prices the exposure.
- **Fix & re-replay** — restore the value bisection recovered, re-run every affected decision
  against corrected memory, and watch the outcomes flip.

`/api/health` reports liveness and, more usefully, `gc.ttlseconds`. That value is not a tuning
knob here — it is the maximum age of any question Rewind can answer. A cluster on CockroachDB's
4h default looks completely healthy and fails every forensic query about yesterday, with an error
that reads like a bug rather than a policy.

Against Bedrock, drop `REWIND_OFFLINE=1` and set `AWS_REGION`. The model ID is Bedrock-prefixed
(`anthropic.claude-opus-5`); override with `REWIND_MODEL_ID`.

The demo timeline is compressed into real elapsed hours between `db:seed` and `poison`. Rows are
never backdated — `updated_at` and the MVCC timestamp agree, and you can check.

### Why rehearsing needs a full reset

`pnpm db:reset` discards the local store entirely. `DELETE` and even `DROP DATABASE` are not
enough, and the reason is worth knowing: **CockroachDB resolves object names as of the read
timestamp**, so `AS OF SYSTEM TIME <before the drop>` resolves the *old* database descriptor and
reads the *old* tables. Dropped data stays fully visible to precisely the queries this project is
built on.

That matters because every rehearsal leaves real MVCC history. If a belief held `$5,000` during
yesterday's run, bisection has two genuine transitions to choose between and may trace the wrong
incident. A freshly provisioned Cloud cluster has no such history, so this is a local-rehearsal
concern rather than a product one — but reset before you record.

**Known limit in the tracer:** the backward walk doubles its stride, so it can step over an
interval shorter than the stride it has reached. A belief that flips away from and back to the
same value within a very short window can bracket an older transition than the true most-recent
one. Closing that gap entirely would cost a linear scan of the window; real policy beliefs change
rarely rather than several times a second. Repeated rehearsals are what actually produce the
pattern, which is what `db:reset` is for.

## Deploying

```sh
./infra/provision.sh              # CockroachDB Cloud cluster, GC window, schema
export DATABASE_URL='...'         # printed by provision.sh
./infra/deploy-lambda.sh          # ingestion Lambda + S3 trigger

aws s3 cp docs/inbound/q3-vendor-policy-update.md s3://rewind-demo/inbound/
aws logs tail /aws/lambda/rewind-ingest --follow
```

The Lambda needs no VPC — CockroachDB Cloud is publicly reachable over TLS, and putting the
function in a VPC would force a NAT gateway just to reach Bedrock. Its IAM policy is scoped to the
one bucket it reads and the two Bedrock models it calls.

## The ingestion pipeline is the attack surface

`lambda/ingest.ts` reads the object, extracts text, asks Claude to extract durable beliefs, and
writes each one in place with the `source_id` of the document that produced it. That `source_id`
is the join that lets forensics name a culprit hours later — without it, bisection could tell you
*when* a belief changed but never *why*, and "the number changed at 15:19" is not an incident
report.

Trust is a property of the **ingestion channel**, not the document: anything under `inbound/`
scores 0.2, `policies/` and `internal/` score 1.0 (override with `x-amz-meta-trust`). That is
what the injected document exploits, and what lets the verdict engine accuse the resulting write.

There is deliberately **no guard rejecting low-trust writes**. Adding one would prevent this
incident and defeat the demonstration — and more importantly, real pipelines do not have one,
which is why this class of failure reaches production. Rewind's claim is about explaining the
failure after it happens, not preventing it.

## Layout

```
db/schema.sql        the three tables; read the comments, they carry the design rules
src/lib/db.ts        connection, HLC capture, the AS OF SYSTEM TIME helper
src/lib/memory.ts    live recall (C-SPANN) vs forensic recall (exact)
src/lib/agent.ts     the support agent — and the transactional HLC capture
src/lib/replay.ts    the verdict engine
src/lib/bisect.ts    binary search over MVCC
src/lib/blast.ts     blast radius
src/lib/remediate.ts the fix, and re-replay of everything it touched
src/lib/mcp.ts       the agent's memory access over the managed MCP server
scripts/spike.ts     the day-1 go/no-go
scripts/sentinel.ts  CHANGEFEED watcher — live poison detection
src/lib/extract.ts   document -> beliefs, and the channel-trust model
src/app/             the console: scrubber, verdict, trace, blast, fix
mcp/server.ts        Rewind's own forensic surface, as MCP tools
skills/              the investigation, written as an agent skill
tests/               the guards, and the thesis as an executable claim
lambda/ingest.ts     S3 -> Bedrock -> CockroachDB
infra/               ccloud provisioning, Lambda deploy, local reset
docs/inbound/        the document that causes the incident
docs/architecture.md diagram and the two read paths
docs/SUBMISSION.md   the Devpost copy sheet
docs/VIDEO.md        the shot list
```

## License

MIT
