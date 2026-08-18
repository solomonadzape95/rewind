import { pool } from "../src/lib/db";

// Walk backwards until a historical read stops working, and report which wall
// we hit: the GC threshold (a real retention limit) or the object simply not
// existing yet (the cluster is young, which is not a retention limit).
const ladder = [60, 300, 900, 1800, 3600, 4500, 5400, 7200, 14400, 86400];

async function main() {
  const { rows } = await pool.query("SELECT now()::STRING AS now");
  console.log("now:", rows[0].now);
  for (const secs of ladder) {
    try {
      await pool.query(`SELECT count(*) FROM memory AS OF SYSTEM TIME '-${secs}s'`);
      console.log(`  -${String(secs).padStart(6)}s  OK`);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      const msg = err.message ?? "";
      const kind = /GC threshold/i.test(msg)
        ? "GC THRESHOLD — this is the retention wall"
        : err.code === "3D000" || err.code === "42P01"
          ? "object did not exist yet (cluster/table too young, NOT a retention limit)"
          : `other: ${err.code}`;
      console.log(`  -${String(secs).padStart(6)}s  ${kind}`);
    }
  }
  await pool.end();
}
main();
