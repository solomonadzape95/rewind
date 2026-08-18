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

# The project description

Devpost's description field uses these seven headings. Written out to paste.

## Inspiration

Every AI observability tool on the market captures what an agent **said** — the
prompt, the tokens, the tool calls, the latency. Not one captures what it
**believed**.

That gap only matters when something goes wrong, and then it matters completely.
An agent approves a $4,200 refund against a $500 policy. The logs show a normal,
confident approval citing policy correctly. Nothing looks broken. To answer for
it — to an engineer, an auditor, or a court — you have to reconstruct the
agent's memory as of that exact instant, and the honest answer is usually that
nobody can.

The standard fix is to build event sourcing: append-only belief logs, snapshot
tables, replay infrastructure. Months of work, and a second source of truth that
can drift from the first.

Then the obvious thing: **CockroachDB already stores every version of every
row.** MVCC keeps them for the length of the GC window, and `AS OF SYSTEM TIME`
queries them in one clause. The history isn't missing. Nobody was pointing at it.

## What it does

Rewind takes one bad agent decision and answers three questions, then closes the
incident.

1. **Was this bad reasoning, or bad memory?** It replays the agent against the
   exact memory state it read — not a reconstruction — several times, and rules.
   Crucially, it **refuses to rule** when the prompt or model has drifted since
   the decision, because a forensics tool that returns a confident wrong answer
   is worse than no tool.
2. **Which write caused it?** It binary-searches MVCC itself. Roughly 20 probes
   narrow a 7-day window to the second, then resolves that instant to the
   ingested document that wrote the belief, with the trust score of the channel
   it arrived through.
3. **What else did it affect?** It enumerates every other decision that read the
   belief while it was wrong and prices the exposure — "5 decisions, $12,400" —
   because a count alone doesn't get acted on.

Then it restores the value the bisection *proved* was there before the
poisoning, and re-replays every affected decision against the corrected memory.
That's memory regression testing, shown rather than described.

**Rewind stores no history of its own.** No audit table, no event log, no
snapshots. Delete every table it queries except `memory` and `decision` and it
still works.

## How we built it

The whole thing rests on **one column**: `decision.memory_hlc`.

At the instant the agent reads memory, the cluster's hybrid-logical-clock
timestamp is captured *inside the same read-only transaction as the recall*, so
both observe exactly one MVCC snapshot. That decimal drops straight into
`AS OF SYSTEM TIME`, so replay reproduces the agent's memory **exactly** rather
than approximately. Capture it outside the transaction and a concurrent
ingestion can land in the gap — replay would then reproduce a state the agent
never saw, and the evidence would be quietly wrong.

Two design rules follow, and both are load-bearing:

- **Memory rows are mutated in place, never appended.** The table looks like it
  has no history; MVCC has all of it. The moment we keep our own version table,
  CockroachDB stops being load-bearing and the thesis collapses.
- **`gc.ttlseconds` is widened before any data is written.** Raising it later
  does not resurrect collected history.

Around that:

- **CockroachDB Cloud Managed MCP Server** — the agent has no database
  connection at all. It reads memory through MCP tools, discovered at runtime
  rather than hardcoded.
- **Distributed Vector Indexing (C-SPANN)** — live semantic recall, prefixed by
  tenant so the index itself enforces multi-tenant isolation.
- **ccloud CLI** — scripted provisioning, GC windows widened before any row exists.
- **AWS Lambda + S3** — the ingestion pipeline, and the attack surface. An S3
  object triggers a Lambda that extracts durable beliefs and writes each one in
  place, tagged with the `source_id` of the document that produced it. That join
  is what lets forensics name a culprit hours later.
- **Amazon Bedrock** — optional model path, deliberately optional: the claim is
  about the memory layer, not about whose model reads it.
- **CHANGEFEED** — a sentinel that flags a low-trust source overwriting a
  high-confidence policy belief, live.

Two retrieval paths, on purpose. Live recall uses the approximate C-SPANN index.
Forensic replay uses exact brute-force `cosine_distance` at the historical
timestamp. **Approximation is fine for recall; it is not fine for evidence.**

## Challenges we ran into

**The GC window trap that isn't documented.** Widening `gc.ttlseconds` on the
database is necessary and *not sufficient*. CockroachDB resolves object names as
of the read timestamp, so every historical query also reads the `system`
descriptor tables at that past timestamp — and those ranges keep their own zone
config, stuck at the 4h default. Past four hours, reads fail with:

```
batch timestamp ... must be after replica GC threshold (r10: /Table/{5-6})
```

Note what that does not say: not your table, not your database, not retention.
The memory rows are still there holding seven days of perfectly readable
history; the query fails because the *name* can no longer be resolved that far
back. It reads like a storage bug at the exact moment you're trying to prove
there isn't one. It cost us a seeded timeline before we understood it. The
effective horizon is `min(database TTL, system range TTL)`, and both provisioning
paths now widen both.

**Preserving the snapshot guarantee across MCP.** On a direct connection, a
transaction pins the clock read and the recall to one snapshot. MCP has no
sessions — each tool call is independent and could be routed anywhere — so
issuing them as two calls reintroduces, at the transport layer, precisely the
race the transaction exists to prevent. The fix: send *one statement* that
returns `cluster_logical_timestamp()` as a column of the recall itself. One
statement is its own implicit transaction, therefore its own single snapshot.

**Diagnosing at incident time, not after cleanup.** The first verdict engine
compared memory "then" against "now" — which finds nothing, because when the
engineer opens the tool the poisoned belief is still live. It would have blamed
the model for every real poisoning. What *is* knowable at incident time is
provenance: was the belief rewritten shortly before the decision, by a source
less trusted than the one it replaced? Two historical reads and a trust
comparison, no provenance table.

**Bisection on beliefs that oscillate.** A plain binary search over the window
converges on an arbitrary transition, so a belief that changed several times
could pin a months-old write for today's incident. It walks backwards in
doubling steps first, which guarantees the *most recent* transition.

**Dropped data stays visible.** `DROP DATABASE` doesn't clear the slate —
`AS OF SYSTEM TIME` before the drop resolves the old descriptor and reads the
old tables. Correct behaviour, genuinely surprising, and it means rehearsing the
demo requires discarding the store entirely.

## Accomplishments that we're proud of

**It stores nothing and answers everything.** No audit table, no event log, no
snapshots — and it still reconstructs a belief state from 46 hours earlier,
exactly, in one SQL clause.

**It refuses to answer when it can't answer honestly.** If the prompt hash or
model ID has drifted since the decision, the verdict engine returns
`REPLAY_UNSOUND` and explains why, instead of issuing a confident ruling on a
changed experiment. Most tools would guess.

**The thesis is an executable test.** `tests/forensics.integration.test.ts`
asserts the premise the whole project rests on against a live cluster, and CI
starts a real CockroachDB node to run it. If it fails, nothing else is worth
running.

**It produces a dollar figure.** Blast radius outputs "5 decisions, $12,400
approved on the bad belief" — the form an incident report has to take before
anyone acts on it.

**The fix is as auditable as the attack.** Remediation is an ordinary in-place
`UPDATE`, so it becomes another MVCC version. Six months later, the same
bisection finds both.

## What we learned

**MVCC is a product surface, not an implementation detail.** Every database with
multi-version concurrency control is already storing the history teams build
event-sourcing systems to duplicate. CockroachDB is unusual in exposing a
coordinate that is both cheap to store and exactly re-readable.

**The GC window is a retention policy.** This looked like the project's biggest
limitation and turned out to be its best production-readiness argument: set
`gc.ttlseconds` to your regulatory retention requirement — seven years for a
lender — and forensic replay becomes a config value rather than an engineering
project.

**Evidence has a higher bar than recall.** The instinct was to use the vector
index everywhere. But an approximate, background-maintained index makes no
guarantee about what a historical read returns, and "approximately what the
agent saw" is not evidence. Knowing *why* you chose a slower path matters more
than the path.

**Honest tools have to be able to say no.** The most valuable behaviour we built
is a refusal.

## What's next for Rewind

- **Prevention, not just forensics.** The CHANGEFEED sentinel detects low-trust
  overwrites seconds after they commit. The next step is a quarantine path:
  hold the write, alert, and require a human to promote it.
- **Belief-level diffing across model versions.** Replay the same decision corpus
  against a new model to see which decisions change *before* shipping it — memory
  regression testing as a CI gate.
- **Longer horizons than the GC window.** For retention beyond what MVCC can hold
  economically, tier cold history out while keeping the same query interface.
- **Beyond refunds.** The scenario is a support agent, but the machinery is
  domain-agnostic: any agent whose memory is a set of beliefs with provenance.
  Clinical decision support, trading, content moderation.
- **Multi-tenant forensics at scale.** Tenant isolation is enforced at the index
  today; the forensic paths need the same treatment under real load.

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
| **Amazon Bedrock** | `src/lib/bedrock.ts`, wired into `src/lib/llm.ts` | Two services, not one: **Claude** extracts durable beliefs from each ingested document (via the Anthropic SDK's Bedrock client, with structured outputs enforcing the response shape), and **Titan Text Embeddings V2** produces the vectors, since Claude does not embed. This is what makes the deployed pipeline work at all — the local default is Ollama, and `localhost` is not reachable from Lambda. |

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

## Feedback on CockroachDB's AI tools (optional Devpost field)

Every point below was hit while building this, and each cost real time — which is
exactly what makes them worth reporting back:

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

---

# Additional info form — field by field

The "Additional info" step (4/5). Every answer below is ready to paste. Fields marked
**⚠ BLOCKED** need something that does not exist yet.

## ⚠ URL to your functional demo application *(required)*

**BLOCKED — nothing is deployed yet.** This is the one field you cannot fake; see
`docs/DEPLOY.md` for the steps. It will look like:

```
https://rewind-<something>.vercel.app
```

## Testing credentials or instructions for your functional demo app

```
No credentials, login, or API key are required — open the URL and everything is
already seeded.

What you are looking at: a B2B SaaS support agent that approves customer refunds.
Its memory holds the policy "Enterprise refund limit is $500 per incident." A
document ingested through the low-trust `inbound/` channel silently rewrote that
belief to $5,000, and the agent then over-approved five refunds without raising a
single error.

Walk the incident in this order:

1. On the home page, drag the timeline scrubber. This reconstructs the agent's
   entire belief state at any past instant using CockroachDB's MVCC history and
   one AS OF SYSTEM TIME clause. There is no snapshot or audit table behind it.
2. Open the $4,200 decision (the last row, in red).
3. Click "Replay". It re-runs the agent against the exact memory state that
   decision read, several times, and rules: BAD MEMORY, not bad reasoning.
   Takes ~20 seconds — it is invoking a model, not replaying a recording.
4. Click "Trace the write". Watch the bisection probes narrow. This binary-searches
   MVCC to pin the moment the belief changed, then names the S3 document that did
   it and its trust score. No change log is consulted; there isn't one.
5. Click "Blast radius" for the other decisions that read the poisoned belief and
   the total dollar exposure.
6. Click "Fix & re-replay" to restore the value bisection recovered and re-run every
   affected decision against corrected memory. The outcomes flip.

GET /api/health reports the cluster's live gc.ttlseconds, which is the real limit on
how far back any of this can see.

To run it locally instead, the README has a complete no-account path: local
CockroachDB plus local models, no cloud credentials of any kind.
```

## URL to your open source and public code repository *(required)*

```
https://github.com/solomonadzape95/rewind
```

## URL to your open-source license file *(required)*

```
https://github.com/solomonadzape95/rewind/blob/main/LICENSE
```

MIT. GitHub already detects it and shows "MIT" in the About section.

## Which CockroachDB tools are used? *(required, pick ≥2)*

Tick these three:

- ✅ **CockroachDB Cloud Managed MCP Server**
- ✅ **Distributed Vector Indexing**
- ✅ **ccloud CLI (Agent-Ready)**

**Do not tick "Agent Skills Repo (Open Source)"** unless you change something first.
Rewind ships its *own* agent skill (`skills/rewind-forensics/SKILL.md`, written to the
Agent Skills Specification) but does not consume anything from
`github.com/cockroachlabs/cockroachdb-skills`. Ticking it would be claiming a tool the
repo does not use, and a judge reading the code would find that in a minute. Three of
four already clears the minimum of two.

## Which AWS Services are used? *(required, pick ≥1)*

- ✅ **AWS Lambda**
- ✅ **Amazon S3**
- ✅ **Amazon Bedrock**

## How the components are meaningfully integrated *(required)*

```
CockroachDB is not a datastore this project writes to — it is the mechanism the
product is built out of.

MVCC + AS OF SYSTEM TIME. Rewind keeps no history of its own: no audit table, no
event log, no snapshots. Memory rows are mutated in place with UPDATE and never
appended, so the `memory` table looks like it has no past while MVCC holds all of
it. Every forensic answer is an ordinary query at a past timestamp. The linchpin is
one column, `decision.memory_hlc`: at the instant the agent reads memory, the
cluster's hybrid-logical-clock timestamp is captured inside the same read-only
transaction as the recall, so both observe exactly one MVCC snapshot. That decimal
drops straight into AS OF SYSTEM TIME, which is what makes replay evidence rather
than reconstruction. Bisection then binary-searches MVCC itself — about 20 probes
narrow a 7-day window to the second — to find the write that changed a belief.
Remove CockroachDB and the project is an event-sourcing system that does not exist.

Cloud Managed MCP Server. The agent has no database connection. It reads memory
through the managed MCP endpoint's SQL tool, discovered at runtime via tools/list
rather than hardcoded (src/lib/mcp.ts). This forced a real design problem: MCP has
no sessions, so the transaction that pins the clock read to the recall cannot exist.
The fix is to send both as a single statement, which is its own implicit transaction
and therefore its own single snapshot — the guarantee survives the transport change.

Distributed Vector Indexing. `CREATE VECTOR INDEX ... ON memory (tenant_id, embedding)`
— tenant-prefixed, so the index enforces multi-tenant isolation rather than a WHERE
clause. It serves live recall only. Forensic replay deliberately uses exact
cosine_distance at the historical timestamp, because an approximate,
background-maintained index makes no guarantee about what a historical read returns.
Approximation is fine for recall; it is not fine for evidence.

ccloud CLI. infra/provision.sh scripts the cluster and widens gc.ttlseconds before a
single row is written — ordering that is load-bearing, since raising it later cannot
resurrect collected history.

AWS Lambda + S3 are the ingestion pipeline and the attack surface. An S3 object
triggers a Lambda that extracts durable beliefs and writes each one in place, tagged
with the source_id of the document that produced it. That join is what lets forensics
name a culprit hours later — without it, bisection can say when a belief changed but
never why, and "the number changed at 15:19" is not an incident report. Trust is a
property of the key prefix: inbound/ scores 0.2, policies/ scores 1.0. There is
deliberately no guard rejecting low-trust writes, because real pipelines do not have
one — which is why this class of failure reaches production.

Amazon Bedrock is two services inside that Lambda, not a checkbox: Claude extracts
the beliefs, and Titan Text Embeddings V2 produces the vectors, since Claude does not
embed. It is what makes the deployed pipeline work at all — the local default is
Ollama, and localhost is not reachable from Lambda.

CHANGEFEED closes the loop: scripts/sentinel.ts watches for a low-trust source
overwriting a high-confidence policy belief and alerts within seconds, turning
after-the-fact forensics into live detection.
```

## What date did you start this project? *(required, MM-DD-YY)*

```
08-15-26
```

The first commit squashes three days of work, so the git history alone understates
this — `SPEC.md` and `LICENSE` are both dated Aug 15, and `SPEC.md` says so in its
header. **Confirm the submission period opened on or before Aug 15** before entering
it; if it opened later, say so plainly rather than adjusting the date.

## Pre-existing code or work incorporated *(required)*

```
None. Every line was written during the submission period, starting 08-15-26.

Standard tooling and libraries only: Next.js, React, Tailwind, node-postgres, the
Model Context Protocol TypeScript SDK, the Anthropic SDK's Bedrock client, the AWS
SDK, esbuild, tsx, and Vitest — all installed from their public registries and used
as published.

Development tools: Claude Code (Claude Opus 5) was used as a coding assistant
throughout — architecture discussion, implementation, code review, and
documentation. All design decisions, the data model, and the forensic approach were
directed by me; no code was carried in from a prior project, starter template, or
another hackathon.

The models the application itself runs on are configuration, not incorporated work:
it defaults to local Ollama models (qwen2.5:7b and nomic-embed-text) and can be
pointed at Claude on Amazon Bedrock, or any OpenAI-compatible endpoint, with one
environment variable.
```

## Which AI tools have you leveraged? *(required)*

```
Claude Code (Claude Opus 5) — used throughout for architecture discussion,
implementation, code review, and documentation. It was most valuable as a reviewer:
it caught that widening gc.ttlseconds on the database is not sufficient because
historical name resolution reads the system ranges too, which is the single most
important thing this project learned.

Claude on Amazon Bedrock — inside the product, for extracting durable beliefs from
ingested documents and for the replay engine that re-runs recorded decisions.

Amazon Titan Text Embeddings V2 — vector embeddings for semantic recall on the
deployed path.

Ollama (qwen2.5:7b, nomic-embed-text) — the local default, so the entire project
runs with no account, no API key, and no cost.
```

## Level of learning derived from the project

The dropdown currently reads **Moderate**. Consider raising it — the project
surfaced two genuinely non-obvious CockroachDB behaviors that are written up in the
README and the feedback field (system-range GC bounding the forensic horizon, and
object names resolving as of the read timestamp so dropped data stays visible to
historical reads). Your call; pick the option that honestly matches.

## Did you gain AI value you can use in your career?

**Yes** — already selected.

## Submitter type / country / organization

Individual · Nigeria · organization name blank. Already correct.

## Optional: architecture diagram upload

`docs/architecture.md` holds the diagram as Mermaid, which the upload field will not
take — it wants PDF, PNG, or JPG. Either render that Mermaid to PNG, or skip the
field; it is optional and the README covers the same ground.

## Optional: feedback on CockroachDB AI tools

Already drafted — see the feedback section above in this document. Paste it whole.

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
