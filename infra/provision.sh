#!/usr/bin/env bash
#
# Provision a CockroachDB Cloud cluster for Rewind, from nothing.
#
# If you already created a cluster in the Cloud console, you do NOT want this
# script — use infra/cloud-setup.sh, which configures a cluster that exists.
# This one creates one first and then calls that script to do the rest, so the
# database/GC/schema logic lives in exactly one place.
#
# Usage:  ./infra/provision.sh [cluster-name]
# Needs:  ccloud auth login
#
# ORDER MATTERS AND IS NOT COSMETIC. gc.ttlseconds is widened before a single row
# is written. `AS OF SYSTEM TIME` can only read inside the garbage-collection
# window, and raising the setting later does not resurrect history that has
# already been collected. Seed first and the forensic record is gone before you
# ever look for it. cloud-setup.sh preserves that ordering.

set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${1:-${CRDB_CLUSTER:-rewind}}"
REGION="${REWIND_REGION:-us-east-1}"
CLOUD="${REWIND_CLOUD:-AWS}"
PLAN="${REWIND_PLAN:-BASIC}"
SQL_USER="${CRDB_SQL_USER:-rewind}"

command -v ccloud >/dev/null || { echo "ccloud not found: brew install cockroachdb/tap/ccloud"; exit 1; }
ccloud auth whoami >/dev/null 2>&1 || { echo "not logged in: run 'ccloud auth login'"; exit 1; }

echo "==> cluster '$CLUSTER' ($PLAN on $CLOUD, $REGION)"
if ccloud cluster list --output json 2>/dev/null | grep -q "\"name\": *\"$CLUSTER\""; then
  echo "    already exists, reusing"
else
  # Region is a POSITIONAL argument, not a flag — `--region` does not exist and
  # fails with "unknown flag". The cloud provider does need a flag, and defaults
  # to GCP, so it is passed explicitly.
  ccloud cluster create "$PLAN" "$CLUSTER" "$REGION" --cloud "$CLOUD" --wait
fi

# A SQL user with a known password, so the rest of the flow is non-interactive.
# `ccloud cluster sql --connection-url` returns a URL with no credentials in it,
# which is why the earlier version of this script could not actually connect.
if [ -z "${CRDB_SQL_PASSWORD:-}" ]; then
  CRDB_SQL_PASSWORD="$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"
  echo "==> creating SQL user '$SQL_USER' with a generated password"
  if ! ccloud cluster user create "$CLUSTER" "$SQL_USER" -p "$CRDB_SQL_PASSWORD" >/dev/null 2>&1; then
    echo "    user exists, rotating its password instead"
    ccloud cluster user password "$CLUSTER" "$SQL_USER" -p "$CRDB_SQL_PASSWORD" >/dev/null
  fi
  echo
  echo "    SQL password (save it — it is not recoverable from ccloud):"
  echo "      $CRDB_SQL_PASSWORD"
  echo
fi

echo "==> configuring database, GC window, and schema"
CRDB_CLUSTER="$CLUSTER" \
CRDB_SQL_USER="$SQL_USER" \
CRDB_SQL_PASSWORD="$CRDB_SQL_PASSWORD" \
  ./infra/cloud-setup.sh
