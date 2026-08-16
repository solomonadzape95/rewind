#!/usr/bin/env bash
#
# Provision the CockroachDB Cloud cluster for Rewind.
#
# ORDER MATTERS AND IS NOT COSMETIC. gc.ttlseconds is widened before a single row
# is written. `AS OF SYSTEM TIME` can only read inside the garbage-collection
# window, and raising the setting later does not resurrect history that has
# already been collected. Seed first and the forensic record is gone before you
# ever look for it.
#
# Usage:  ./infra/provision.sh [cluster-name]
# Needs:  ccloud auth login

set -euo pipefail

CLUSTER="${1:-rewind}"
REGION="${REWIND_REGION:-us-east-1}"
GC_TTL="${REWIND_GC_TTL:-604800}"   # 7 days

command -v ccloud >/dev/null || { echo "ccloud not found: brew install cockroachdb/tap/ccloud"; exit 1; }
ccloud auth whoami >/dev/null 2>&1 || { echo "not logged in: run 'ccloud auth login'"; exit 1; }

echo "==> cluster '$CLUSTER' in $REGION"
if ccloud cluster list --output json 2>/dev/null | grep -q "\"name\": *\"$CLUSTER\""; then
  echo "    already exists, reusing"
else
  # Basic (serverless) is enough for the demo and provisions in seconds. The
  # GC window is a zone setting, not a plan feature, so nothing here depends on
  # the tier.
  ccloud cluster create basic "$CLUSTER" --region "$REGION"
fi

echo "==> connection string"
URL="$(ccloud cluster sql "$CLUSTER" --connection-string)"
[ -n "$URL" ] || { echo "could not read connection string"; exit 1; }

# ccloud hands back a URL pointing at defaultdb; Rewind lives in its own database.
BOOTSTRAP_URL="$URL"
DB_URL="$(printf '%s' "$URL" | sed -E 's#/defaultdb([?]|$)#/rewind\1#')"

echo "==> create database"
cockroach sql --url "$BOOTSTRAP_URL" -e "CREATE DATABASE IF NOT EXISTS rewind;"

echo "==> widen the GC window to ${GC_TTL}s ($((GC_TTL / 86400)) days) — BEFORE any data"
cockroach sql --url "$DB_URL" -e \
  "ALTER DATABASE rewind CONFIGURE ZONE USING gc.ttlseconds = ${GC_TTL};"

# Widening the database alone is NOT enough, and the failure is disguised.
# Historical queries resolve object names as of the read timestamp, so every
# AS OF SYSTEM TIME read also touches the system descriptor tables at that past
# timestamp. Those ranges keep their own zone config — 4h by default — and the
# error when you exceed it names a system range, not your table:
#
#   batch timestamp ... must be after replica GC threshold (r10: /Table/{5-6})
#
# The effective forensic horizon is min(database TTL, system range TTL).
echo "==> widen the system ranges too (name resolution reads them historically)"
for TARGET in "RANGE default" "RANGE meta" "RANGE liveness" "DATABASE system"; do
  # Best effort: on managed tiers these belong to the provider, not the tenant.
  # A refusal caps the horizon rather than breaking anything, so warn and go on.
  cockroach sql --url "$BOOTSTRAP_URL" -e \
    "ALTER ${TARGET} CONFIGURE ZONE USING gc.ttlseconds = ${GC_TTL};" >/dev/null 2>&1 \
    || echo "    WARNING: could not widen ${TARGET} — your real horizon is that zone's TTL, not ${GC_TTL}s"
done

echo "==> apply schema"
cockroach sql --url "$DB_URL" --file db/schema.sql

echo "==> verify"
cockroach sql --url "$DB_URL" -e "SHOW ZONE CONFIGURATION FROM DATABASE rewind;"

cat <<EOF

Done. Export this and the app, scripts, and Lambda all point at the cluster:

  export DATABASE_URL='$DB_URL'

Next:
  pnpm spike                     # confirm AS OF SYSTEM TIME behaves on this cluster
  ./infra/deploy-lambda.sh       # ingestion pipeline
EOF
