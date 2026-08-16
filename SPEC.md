# Rewind — Time-Travel Memory for Production Agents

**CockroachDB × AWS Hackathon: Build with Agentic Memory**
Deadline: **Aug 18, 2026, 5:00pm EDT**. Spec written Aug 15.

---

## 1. The pitch (memorize this, it's the whole submission)

> Every observability tool captures what an agent **said**. None capture what it **believed**.
>
> When an agent acts and the action is wrong, someone has to answer for it — an engineer, a regulator, a court. Answering requires reconstructing the agent's memory as of the moment of the decision. Today that's an event-sourcing project: append-only belief logs, snapshot tables, replay infrastructure.
>
> CockroachDB already stores it. MVCC keeps every version of every row for the length of the GC window, and `AS OF SYSTEM TIME` queries it with one clause. Rewind stores **zero** history of its own — no audit table, no event log, no snapshots — and can still answer "what did the agent believe at 14:32?" exactly.

**The one-line demo hook:** a slider that rewinds an AI's mind, and a verdict engine that tells you whether the failure was bad reasoning or bad memory.

### Why this scores on all five criteria

| Criterion | How Rewind hits it |
|---|---|
| Agentic Memory Design | CockroachDB *is* the memory — beliefs, embeddings, and their entire history. Not a cache in front of a vector store. |
| Technological Implementation | MVCC historical reads, HLC timestamp capture, C-SPANN vector index, MCP server as the agent's tool surface, CHANGEFEED for live detection. |
| Real-World Impact | Post-incident debugging, injection forensics, regulated audit (EU AI Act), legal discovery, memory regression testing. |
| Product Readiness | Observability *is* the product. Plus tenant isolation, GC-window policy as a retention control, blast-radius containment. |
| Creativity & Originality | Nobody is doing time-travel debugging for agent memory. Judges will see ~40 RAG chatbots; they'll see one of these. |

**Positioning line for judges:** a vector database would need a whole event-sourcing system bolted on to do this. CockroachDB does it with a `WHERE` clause's worth of effort.

---

## 2. The two technical risks (verified, with decisions)

### Risk A — the GC window bounds how far back you can look
`AS OF SYSTEM TIME` can only read within the garbage collection window set by `gc.ttlseconds`. Anything older is collected and gone.

**Decisions:**
1. Set `gc.ttlseconds = 604800` (7 days) on the demo cluster **on day 1, before seeding any data**. If you seed first and raise it later, the early history is already unrecoverable and the demo is dead.
   ```sql
   ALTER DATABASE rewind CONFIGURE ZONE USING gc.ttlseconds = 604800;
   ```
2. The demo timeline is **compressed into real hours, not faked**. Actually ingest the documents and actually run the decisions over a few hours of wall-clock time. Label the timeline honestly in the UI (e.g. "T+0h / T+2h / T+5h"). Do **not** backdate rows to fake a three-week incident — a judge who knows MVCC will spot that `updated_at` and the MVCC timestamp disagree, and it torches your credibility on the one criterion you're trying to win.
3. Turn the constraint into a feature in the pitch: **the GC window is your retention policy.** "Set `gc.ttlseconds` to your regulatory retention requirement — 7 years for a lender — and forensic replay is a config value, not an engineering project." This converts your biggest limitation into a production-readiness talking point. Say it out loud in the video.

### Risk B — historical reads against a C-SPANN vector index are unproven
C-SPANN (v25.2+) is an approximate, distributed, background-maintained index. Whether an `AS OF SYSTEM TIME` read returns a *correct historical* ANN result is not something to bet the submission on.

**Decision — dual retrieval path, and test this in the first two hours of day 1:**
- **Live path** (agent's normal operation): C-SPANN ANN search. Fast, scales, satisfies the "Distributed Vector Indexing" requirement.
- **Replay path** (historical): exact brute-force `cosine_distance` scan `AS OF SYSTEM TIME`, over a deliberately small demo corpus (< 5k rows). Exact search over 5k vectors is milliseconds.

This is defensible, not a cop-out — say it plainly in the README: *"Forensic replay uses exact search so results are provably identical to what the agent saw, not approximately identical. Approximation is acceptable for recall; it is not acceptable for evidence."* That sentence is a Product Readiness point. Judges reward knowing *why* you chose a path.

**Day-1 spike (do this first, ~30 min):** insert 100 rows with vectors, `UPDATE` some, run both an exact and a C-SPANN query `AS OF SYSTEM TIME` a minute prior. Confirm the exact path returns pre-update state. If C-SPANN also works historically, great — use it and mention it. If it errors or returns current-state results, you've lost 30 minutes instead of a day.

---

## 3. Data model

The single most important design rule: **memory rows are mutated in place with `UPDATE`, never appended.** The table looks like it has no history. MVCC has all of it. That contrast is the demo.

```sql
CREATE DATABASE rewind;
ALTER DATABASE rewind CONFIGURE ZONE USING gc.ttlseconds = 604800;

-- Where beliefs came from. Immutable.
CREATE TABLE ingestion_source (
  source_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  kind         STRING NOT NULL,          -- 'pdf' | 'email' | 'web' | 'human' | 'api'
  uri          STRING NOT NULL,          -- s3://rewind-demo/policies/vendor-update.pdf
  excerpt      STRING,                   -- the span that produced the write
  trust_score  FLOAT8 NOT NULL DEFAULT 0.5,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE MEMORY. Current state only. History lives in MVCC.
CREATE TABLE memory (
  tenant_id   UUID NOT NULL,
  memory_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  kind        STRING NOT NULL,           -- 'fact' | 'policy' | 'episode' | 'profile'
  subject     STRING NOT NULL,           -- stable key: 'policy.refund_limit.enterprise'
  content     STRING NOT NULL,
  embedding   VECTOR(1024),              -- Bedrock Titan Text Embeddings V2
  confidence  FLOAT8 NOT NULL DEFAULT 1.0,
  source_id   UUID REFERENCES ingestion_source(source_id),  -- WHO wrote this belief
  valid       BOOL NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_id),
  INDEX (tenant_id, subject)
);

-- C-SPANN with tenant prefix (multi-tenant isolation at the index level)
CREATE VECTOR INDEX memory_embedding_idx
  ON memory (tenant_id, embedding vector_cosine_ops);

-- Every action the agent took. The forensic anchor.
CREATE TABLE decision (
  tenant_id     UUID NOT NULL,
  decision_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  actor         STRING NOT NULL,         -- 'support-agent-v1'
  input         STRING NOT NULL,         -- the user request
  action        STRING NOT NULL,         -- 'approve_refund'
  action_args   JSONB NOT NULL,          -- {"amount": 4200, "currency": "USD"}
  rationale     STRING,                  -- what the model said
  retrieved_ids UUID[] NOT NULL,         -- exactly which memories it read
  memory_hlc    DECIMAL NOT NULL,        -- ⭐ THE LINCHPIN (see below)
  model_id      STRING NOT NULL,
  prompt_hash   STRING NOT NULL,         -- detects prompt drift between then and replay
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, decision_id)
);
```

### The linchpin: `memory_hlc`

At the instant the agent reads memory, capture the cluster's hybrid-logical-clock timestamp and store it on the decision:

```sql
SELECT cluster_logical_timestamp();  -- returns DECIMAL
```

That decimal is directly usable as `AS OF SYSTEM TIME <decimal>`. It is not an approximation of "around 14:32" — it's the exact MVCC coordinate the agent read at. Replay against it reproduces the agent's memory **bit-for-bit**, which is what makes the verdict engine sound rather than suggestive.

Everything else in this project is UI. This one column is the idea.

---

## 4. The three forensic queries

### 4.1 Recall — what did it believe at time T?
```sql
SELECT memory_id, subject, content, confidence, source_id
FROM memory
AS OF SYSTEM TIME $1          -- decision.memory_hlc
WHERE tenant_id = $2 AND valid
ORDER BY cosine_distance(embedding, $3)
LIMIT 8;
```
Powers the timeline scrubber. One clause. No audit table. That's the money shot in the video — put the SQL on screen.

### 4.2 Bisect — when exactly did a belief flip, and who flipped it?
Binary search over MVCC. Find the earliest timestamp where the belief matches its current (wrong) value:

```
lo = decision_hlc - GC_WINDOW ; hi = now()
while hi - lo > tolerance:
    mid = (lo + hi) / 2
    v = SELECT content, source_id FROM memory AS OF SYSTEM TIME mid
        WHERE tenant_id=$1 AND subject=$2
    if v == poisoned_value: hi = mid else: lo = mid
→ resolve source_id at `hi` → JOIN ingestion_source → the document that did it
```

~15 queries to pin the write to the second across a 7-day window. **We store no change log — we binary-search time itself.** Say that line in the video; it's the most memorable technical claim in the project.

### 4.3 Blast radius — what else did this poison?
This is what turns a debugging toy into a product. Once you know a belief was wrong between `t_poison` and `t_fixed`, every decision in that window that read that memory is suspect:

```sql
SELECT decision_id, action, action_args, created_at
FROM decision
WHERE tenant_id = $1
  AND memory_hlc BETWEEN $2 AND $3        -- poison window
  AND $4 = ANY(retrieved_ids)             -- read the poisoned memory
ORDER BY created_at;
```
Output: *"This one bad PDF caused 23 wrong decisions totalling $71,400."* Nobody else in this hackathon will show a dollar figure.

---

## 5. The verdict engine (bad reasoning vs. bad memory)

The definitive answer the pitch promises. Three runs, one truth table:

| Run | What it does |
|---|---|
| **A — Historical replay** | Same input, memory `AS OF SYSTEM TIME decision.memory_hlc`, same model, same prompt |
| **B — Current replay** | Same input, memory as of `now()` |
| **Recorded** | What actually happened |

```
A ≠ Recorded                    → NON-DETERMINISTIC. Model instability; memory exonerated.
A = Recorded, memory unchanged  → BAD REASONING. Memory was correct, the model misused it.
A = Recorded, memory changed,
  and the changed fact is in
  retrieved_ids                 → BAD MEMORY. Root cause is the write at t_poison. → run 4.2
A = Recorded, B ≠ Recorded      → RESOLVED. Current memory now yields the right action.
```

Also compare `prompt_hash` and `model_id` between decision time and replay — if either differs, the replay isn't clean and Rewind must say so rather than issue a confident verdict. **Build that check.** An honest "cannot issue verdict: prompt changed since decision" is a Product Readiness point; a confidently wrong verdict from a forensics tool is worse than no tool.

Use temperature 0 for replay. Log the raw model response for both runs.

---

## 6. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Rewind Console (Next.js on Vercel)                        │
│  timeline scrubber · memory diff · verdict · blast radius  │
└───────────────────────┬────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
┌───────▼────────┐            ┌─────────▼──────────┐
│ Support Agent  │            │  Replay Engine     │
│ Bedrock        │            │  Lambda            │
│ (Claude)       │            │  pins AS OF        │
│ acts on live   │            │  SYSTEM TIME       │
│ memory         │            │                    │
└───────┬────────┘            └─────────┬──────────┘
        │  MCP tool calls               │  SQL
        └───────────────┬───────────────┘
                        │
┌───────────────────────▼────────────────────────────────────┐
│  CockroachDB Cloud                                          │
│  • Managed MCP Server  ← agent's tool surface               │
│  • C-SPANN vector index ← live semantic recall              │
│  • MVCC + AS OF SYSTEM TIME ← the entire product            │
│  • CHANGEFEED → Lambda   ← live poison detection (stretch)  │
└───────────────────────▲─────────────────────────────────────┘
                        │
        ┌───────────────┴────────────────┐
        │ Ingestion Lambda               │
        │ S3 doc → Bedrock Titan embed   │
        │ → UPDATE memory (in place)     │
        └────────────────────────────────┘
```

**Requirements coverage — state this explicitly in the README, judges check it:**

| Requirement | Satisfied by |
|---|---|
| CockroachDB tool 1 | **Cloud Managed MCP Server** — the agent reads/writes memory exclusively through MCP tools |
| CockroachDB tool 2 | **Distributed Vector Indexing (C-SPANN)** — live semantic recall, tenant-prefixed |
| CockroachDB tool 3 (bonus) | **ccloud CLI** — cluster provisioning scripted in `infra/provision.sh` |
| AWS service 1 | **Amazon Bedrock** — Claude for agent + replay, Titan V2 for embeddings |
| AWS service 2 | **AWS Lambda** — ingestion pipeline + replay engine |
| AWS service 3 | **Amazon S3** — source documents (the poisoned PDF lives here) |

Minimum is 2 CockroachDB + 1 AWS. We hit 3 + 3.

---

## 7. The demo scenario

Grounded in real-world uses **#1 (post-incident debugging)** and **#2 (memory poisoning forensics)** — the two most visceral. #3 and #5 get a sentence each at the end.

**Setup:** a B2B SaaS support agent with authority to approve refunds. Its memory holds the policy `policy.refund_limit.enterprise = $500`.

| Time | Event |
|---|---|
| T+0h | Memory seeded. Refund limit **$500**. Agent handles refunds correctly. |
| T+2h | A "Q3 Vendor Policy Update" PDF lands in S3 (an attacker-supplied doc with injected text). Ingestion Lambda embeds it and **`UPDATE`s** the belief to **$5,000**. No error. No alert. Nothing in any log. |
| T+2h→5h | Agent silently over-approves refunds. |
| T+5h | Agent approves **$4,200** to a fraudulent account. Someone finally notices. |
| T+6h | Engineer opens Rewind. |

Seed 20–30 decisions across the window so blast radius returns a real number rather than one row.

### Video cut (< 3:00 — hard limit, they will enforce it)

| Time | Beat |
|---|---|
| 0:00–0:15 | The incident. "$4,200 approved. The limit is $500. The logs show a normal, confident approval." |
| 0:15–0:40 | Open Rewind, scrub the timeline to the decision. Agent's belief at that instant: **$5,000**. **Put the `AS OF SYSTEM TIME` SQL on screen** — the rules explicitly require "footage showing the CockroachDB memory layer at work." Non-negotiable shot. |
| 0:40–1:15 | Hit **Replay**. Same memory, same model → the agent makes the *same* decision. Verdict: **BAD MEMORY, not bad reasoning.** The model was fine. |
| 1:15–1:50 | Hit **Trace**. Bisection runs live (show the ~15 probes narrowing). Lands on the exact write at T+2h → `source_id` → the PDF in S3 → highlight the injected sentence. |
| 1:50–2:25 | **Blast radius.** "23 other decisions read this poisoned belief. $71,400 exposed." Then fix the memory and replay all 23 against corrected state — outcomes flip green. That's use case #5 (regression testing) shown, not told. |
| 2:25–3:00 | The close: `SHOW ZONE CONFIGURATION` — "we store **no** history. No audit table, no event log, no snapshots. It's MVCC and one SQL clause. Set `gc.ttlseconds` to your regulatory retention window and forensic replay becomes a config value." One sentence naming EU AI Act audit and legal discovery. Cut. |

**Direction:** no talking-head intro, no logo animation, no "hi, we're team X." Open on the incident. Every second of a 3-minute cap spent on preamble is a second not spent on the memory layer.

---

## 8. Build plan (3 days, in priority order)

Ordered so that **if you stop at any point, you still have a submittable project.**

### Day 1 — Aug 15 (today)
- [ ] **Spike first (30 min):** provision cluster via `ccloud`, `gc.ttlseconds = 604800` **before any data**, insert 100 vector rows, UPDATE some, confirm `AS OF SYSTEM TIME` returns pre-update state on both exact and C-SPANN paths. Decide the replay path from the result.
- [ ] Schema + seed script. Wire Bedrock Titan embeddings.
- [ ] Agent loop over the CockroachDB MCP server; capture `cluster_logical_timestamp()` into `decision.memory_hlc`. **Verify replay reproduces the same retrieved set before building any UI.** If this doesn't work, nothing else matters.
- [ ] Kick off the timeline: run the T+0 seeding so real MVCC hours start accumulating overnight.

### Day 2 — Aug 16
- [ ] Ingestion Lambda: S3 → Titan → in-place `UPDATE`. Run the poisoned PDF.
- [ ] Replay engine + verdict truth table + `prompt_hash`/`model_id` guard.
- [ ] Bisection tracer → `source_id` → `ingestion_source`.
- [ ] Console: timeline scrubber, memory diff (then vs. now), verdict card. Ugly is fine; legible is not optional — judges watch on a laptop.

### Day 3 — Aug 17
- [ ] Blast radius query + UI. Batch re-replay against corrected memory.
- [ ] **Record the video early in the day.** Re-record twice. This is the single highest-leverage hour of the whole project — most submissions lose here, not in the code.
- [ ] README: requirements-coverage table, architecture diagram, the "why exact search for replay" paragraph, the GC-window-as-retention-policy paragraph, MIT license, disclose any pre-existing code.
- [ ] Deploy console to Vercel with seeded data so the demo URL works without a judge running anything.

### Day 4 — Aug 18, morning only
- [ ] Buffer. Submit by **noon EDT**, not 4:55pm. Devpost gets slow near deadlines and the cutoff is hard.

### Stretch (only if genuinely ahead)
- CHANGEFEED → Lambda that flags low-trust sources mutating high-confidence policy beliefs **in real time** — prevention on top of forensics. Powerful, but it is the first thing cut.

### Cut list — sacrifice in this order
1. CHANGEFEED live detection
2. Batch re-replay of all 23 decisions (blast radius *count* alone still lands)
3. Multi-tenancy beyond the schema column
4. Any UI polish whatsoever

**Never cut:** `memory_hlc` capture, the replay path, the bisection tracer, the video.

---

## 9. Things that will sink this if you get them wrong

- **`gc.ttlseconds` set after seeding.** History already collected. Unrecoverable. Do it first.
- **Appending memory versions to a table.** It destroys the entire thesis — the pitch is that CockroachDB stores the history *for* you. If you write your own version table, a judge correctly asks why you needed CockroachDB. Mutate in place.
- **Storing `updated_at` instead of the HLC** and reconstructing "approximately." Approximate forensics is not forensics. Store `cluster_logical_timestamp()`.
- **A video over 3:00.** Disqualifying-grade sloppiness on a stated rule.
- **Backdating rows to fake a longer incident.** Judges who know MVCC will catch the mismatch, and it discredits you on the exact criterion you're competing to win. Compress honestly and label it.
- **No CockroachDB in the footage.** The rules name this requirement explicitly. Show the SQL.
```
