# Deploying the demo URL

The submission needs a working URL a judge can open without running anything.
Three pieces have to line up: a cluster with history in it, a console, and a
model the console can actually reach.

## The thing that catches people

**Your local Ollama is not reachable from Vercel.** The seeded decisions display
fine without a model — their rationales are already stored — but the *Replay*,
*Trace* and *Fix & re-replay* buttons call one live. Deploy with no reachable
model and the demo looks broken on the exact click a judge will make first.

So the deployed console needs a hosted model. Do **not** solve this with
`REWIND_OFFLINE=1`: the stub tags itself in every rationale
(`[dev-stub, not model output]`) and that text renders on screen.

| Option | Setup | Notes |
|---|---|---|
| **Groq** (fastest to stand up) | `REWIND_PROVIDER=openai`, `REWIND_BASE_URL=https://api.groq.com/openai/v1`, `REWIND_API_KEY=...`, `REWIND_MODEL_ID=llama-3.3-70b-versatile` | Free tier, OpenAI-compatible, comfortably inside the 60s function limit |
| **Bedrock** | `REWIND_PROVIDER=bedrock`, `AWS_REGION`, plus AWS credentials in Vercel env | Paid per token, but it is an AWS service and therefore also scores on requirements coverage |

Embeddings matter too. `REWIND_EMBED_DIM` **must** match whatever produced the
vectors in the database — the schema's `VECTOR` width is fixed at init and a
mismatch is rejected on insert. The current cluster was seeded with
`nomic-embed-text` at 768. If the deployed instance uses a different embedding
model, re-seed the cloud cluster with that model rather than mixing widths.

## 1. Cluster

```sh
ccloud auth login
./infra/provision.sh                 # creates the cluster, widens BOTH GC windows, applies schema
export DATABASE_URL='...'            # printed by provision.sh
```

`provision.sh` widens the database *and* the system ranges. Both are required —
historical name resolution reads the system descriptor tables at the past
timestamp, so a 7-day database on top of 4h system ranges gives you a 4h
horizon. Check it after provisioning:

```sh
curl -s "$DEMO_URL/api/health" | jq .retention
```

If `warning` is non-null, the horizon is shorter than you think. On managed
tiers the system zones may be the provider's to set.

## 2. Seed the cloud cluster with a real timeline

The demo URL needs history, and history takes real elapsed time — the same
constraint as recording. Seed, wait, then poison.

```sh
DATABASE_URL='...' pnpm db:seed      # T+0
# ... let hours pass ...
DATABASE_URL='...' pnpm poison       # the incident
```

Do not backdate rows to shortcut this. `updated_at` and the MVCC timestamp would
disagree, and that is checkable.

## 3. Console

```sh
npm i -g vercel
vercel link
vercel env add DATABASE_URL production
vercel env add REWIND_PROVIDER production      # openai | bedrock
vercel env add REWIND_BASE_URL production
vercel env add REWIND_API_KEY production
vercel env add REWIND_MODEL_ID production
vercel --prod
```

`maxDuration` on `/api/investigate` is 60s, which deploys on every Vercel plan.
Hobby fails the build above 60; raise it only on Pro and only if your model
needs it.

## 4. Optional but worth it — the managed MCP server

Setting these makes the agent read memory through the CockroachDB Cloud Managed
MCP Server rather than a direct connection, which turns the strongest
requirements claim from "implemented" into "demonstrated":

```sh
vercel env add CRDB_MCP_TOKEN production       # from the Cloud console
```

`/api/health` reports `memoryAccess`, so you can confirm it took effect:
`"cockroachdb-cloud-mcp"` rather than `"direct-sql"`.

## Pre-flight before you paste the URL into Devpost

```sh
curl -s "$DEMO_URL/api/health" | jq
```

- [ ] `ok: true`
- [ ] `retention.warning` is `null`
- [ ] `retention.forensicHorizonDays` covers the age of the seeded incident
- [ ] `model.provider` is not `offline`
- [ ] Open the $4,200 decision and click **Replay** — it must return a verdict,
      not a timeout
- [ ] No rationale anywhere reads `[dev-stub, not model output]`
