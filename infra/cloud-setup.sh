#!/usr/bin/env bash
#
# Point Rewind at a CockroachDB Cloud cluster you already created in the console.
#
# infra/provision.sh creates a cluster with ccloud. This script is for the far
# more common case of one that already exists: it fetches the CA certificate,
# creates the database, widens the GC window as far as the plan permits, applies
# the schema, and prints the DATABASE_URL to export.
#
# Usage:
#   export CRDB_CLUSTER=oilier-mouse
#   export CRDB_SQL_USER=solomon
#   export CRDB_SQL_PASSWORD='...'          # from the console's Connect dialog
#   ./infra/cloud-setup.sh
#
# Needs: ccloud auth login

set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${CRDB_CLUSTER:?set CRDB_CLUSTER to the cluster name shown in the console}"
SQL_USER="${CRDB_SQL_USER:?set CRDB_SQL_USER to the SQL user from the Connect dialog}"
SQL_PASSWORD="${CRDB_SQL_PASSWORD:?set CRDB_SQL_PASSWORD (Connect dialog -> Connection string)}"
GC_TTL="${REWIND_GC_TTL:-604800}"
EMBED_DIM="${REWIND_EMBED_DIM:-768}"

command -v ccloud >/dev/null || { echo "ccloud not found: brew install cockroachdb/tap/ccloud"; exit 1; }
ccloud auth whoami >/dev/null 2>&1 || { echo "not logged in: run 'ccloud auth login'"; exit 1; }

echo "==> reading connection URL for '$CLUSTER'"
# --connection-url, NOT --connection-string: the latter does not exist and is
# what made infra/provision.sh fail. The URL comes back WITHOUT credentials, so
# the user and password are injected below.
BASE_URL="$(ccloud cluster sql "$CLUSTER" --connection-url --database defaultdb --quiet 2>/dev/null | tail -1)"
case "$BASE_URL" in
  postgresql://*) ;;
  *) echo "could not read a connection URL for '$CLUSTER' (got: $BASE_URL)"; exit 1 ;;
esac

HOSTPORT="${BASE_URL#postgresql://}"
HOSTPORT="${HOSTPORT%%/*}"

# The console's own cert URL. Downloading it is idempotent, and pg needs it
# explicitly: unlike libpq it does not read ~/.postgresql/root.crt on its own.
CLUSTER_ID="$(ccloud cluster list --output json 2>/dev/null \
  | python3 -c "import sys,json;print(next(c['id'] for c in json.load(sys.stdin) if c['name']=='${CLUSTER}'))")"
CERT="$HOME/.postgresql/root.crt"
echo "==> downloading CA certificate to $CERT"
curl -fsSL --create-dirs -o "$CERT" "https://cockroachlabs.cloud/clusters/${CLUSTER_ID}/cert"

ENC_PW="$(python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['CRDB_SQL_PASSWORD'],safe=''))")"
BOOTSTRAP_URL="postgresql://${SQL_USER}:${ENC_PW}@${HOSTPORT}/defaultdb?sslmode=verify-full"
DB_URL="postgresql://${SQL_USER}:${ENC_PW}@${HOSTPORT}/rewind?sslmode=verify-full"

export PGSSLROOTCERT="$CERT"

echo "==> creating database and applying schema (VECTOR(${EMBED_DIM}))"
# db:init does the ordering that matters — database first, GC window before any
# data, schema last — and reports what the plan actually allowed.
DATABASE_URL="$BOOTSTRAP_URL" REWIND_GC_TTL="$GC_TTL" REWIND_EMBED_DIM="$EMBED_DIM" \
  pnpm exec tsx scripts/init.ts

cat <<EOF

Done. Export these and the console, scripts, and Lambda all point at the cluster:

  export PGSSLROOTCERT='$CERT'
  export DATABASE_URL='postgresql://${SQL_USER}:<password>@${HOSTPORT}/rewind?sslmode=verify-full'

Verify the forensic horizon before seeding anything:

  psql "\$DATABASE_URL" -c "SHOW ZONE CONFIGURATION FROM DATABASE rewind;"

If gc.ttlseconds is small (or the statement was refused above), this plan caps how
far back AS OF SYSTEM TIME can read, and no amount of configuration on your side
changes it. That is a property of the plan, not of Rewind — see the README.
EOF
