-- Rewind — time-travel memory for production agents.
--
-- DESIGN RULE #1: `memory` rows are mutated in place with UPDATE, never appended.
-- The table looks like it has no history. MVCC has all of it. That contrast is
-- the entire product. If you ever find yourself adding a `memory_version` table,
-- stop — you have just rebuilt event sourcing and thrown away the reason to use
-- CockroachDB at all.

-- DESIGN RULE #2: the GC window must be widened BEFORE any data is written.
-- `AS OF SYSTEM TIME` cannot read past `gc.ttlseconds`. Raising it after seeding
-- does not resurrect already-collected history.
ALTER DATABASE rewind CONFIGURE ZONE USING gc.ttlseconds = 604800;  -- 7 days

-- Where beliefs came from. Append-only, immutable: a source is a historical fact
-- about the world, not a belief about it.
CREATE TABLE IF NOT EXISTS ingestion_source (
  source_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  kind         STRING NOT NULL,        -- 'pdf' | 'email' | 'web' | 'human' | 'api'
  uri          STRING NOT NULL,        -- s3://rewind-demo/policies/vendor-update.pdf
  excerpt      STRING,                 -- the exact span that produced the write
  trust_score  FLOAT8 NOT NULL DEFAULT 0.5,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE MEMORY. Current state only.
CREATE TABLE IF NOT EXISTS memory (
  tenant_id   UUID NOT NULL,
  memory_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  kind        STRING NOT NULL,         -- 'fact' | 'policy' | 'episode' | 'profile'
  subject     STRING NOT NULL,         -- stable key: 'policy.refund_limit.enterprise'
  content     STRING NOT NULL,
  embedding   VECTOR(${EMBED_DIM}),    -- width set by REWIND_EMBED_DIM at init
  confidence  FLOAT8 NOT NULL DEFAULT 1.0,
  source_id   UUID REFERENCES ingestion_source(source_id),  -- who wrote this belief
  valid       BOOL NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_memory PRIMARY KEY (tenant_id, memory_id),
  INDEX idx_memory_subject (tenant_id, subject)
);

-- C-SPANN distributed vector index, prefixed by tenant so the index itself
-- enforces multi-tenant isolation rather than relying on a WHERE clause.
-- Serves the LIVE recall path only; forensic replay uses exact search (see
-- src/lib/memory.ts for why).
CREATE VECTOR INDEX IF NOT EXISTS memory_embedding_idx
  ON memory (tenant_id, embedding);

-- Every action the agent took. The forensic anchor.
CREATE TABLE IF NOT EXISTS decision (
  tenant_id     UUID NOT NULL,
  decision_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  actor         STRING NOT NULL,       -- 'support-agent-v1'
  input         STRING NOT NULL,       -- the user request
  action        STRING NOT NULL,       -- 'approve_refund' | 'deny_refund' | 'escalate'
  action_args   JSONB NOT NULL,        -- {"amount": 4200, "currency": "USD"}
  rationale     STRING,                -- what the model said
  retrieved_ids UUID[] NOT NULL,       -- exactly which memories it read

  -- ⭐ THE LINCHPIN. `cluster_logical_timestamp()` captured at the instant the
  -- agent read memory. Drops directly into AS OF SYSTEM TIME, so replay
  -- reproduces the agent's memory exactly rather than approximately.
  -- Everything else in this project is UI. This column is the idea.
  memory_hlc    DECIMAL NOT NULL,

  -- Replay is only sound if the model and prompt are unchanged since the
  -- decision. When these drift, the verdict engine must refuse to rule rather
  -- than issue a confident but meaningless verdict.
  model_id      STRING NOT NULL,
  prompt_hash   STRING NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_decision PRIMARY KEY (tenant_id, decision_id),
  INDEX idx_decision_hlc (tenant_id, memory_hlc)   -- blast-radius window scans
);
