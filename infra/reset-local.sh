#!/usr/bin/env bash
#
# Wipe the local CockroachDB store and start over.
#
# DROP DATABASE is NOT enough. CockroachDB resolves object names as of the read
# timestamp, so `AS OF SYSTEM TIME <before the drop>` resolves the old database
# descriptor and reads the old tables — dropped data stays fully visible to
# exactly the queries this project is built on. Only discarding the store
# removes it.
#
# You need this because rehearsing the demo repeatedly leaves real MVCC history
# from every prior run, and bisection then has several genuine transitions to
# choose between. A freshly provisioned Cloud cluster has no such history, so
# this is a local-rehearsal tool, not a production one.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> stopping any local node"
pkill -f "cockroach start-single-node" 2>/dev/null || true
sleep 2

echo "==> discarding store"
rm -rf .crdb

echo "==> starting fresh node"
cockroach start-single-node --insecure --store=.crdb \
  --listen-addr=localhost:26257 --http-addr=localhost:8080 --background
sleep 3

echo "==> schema (GC window widened before any data)"
pnpm exec tsx scripts/init.ts

echo
echo "Clean. Now: pnpm db:seed, wait, pnpm poison"
