#!/usr/bin/env node
// Deliver an investigation summary only if it passes verification.
//   node scripts/deliver-summary.mjs <order> [summary file, default work/summary.json]
// Pass: copies it to outbox/<order>.json (what a person or another system reads). Fail: delivers nothing, and writes
// the failed checks to work/verify-failures.json, so the harness can send them back to the agent as evidence (or to a
// person). It never retries on its own.
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
const [order, file = "work/summary.json"] = process.argv.slice(2);
const v = spawnSync(process.execPath, ["scripts/verify-summary.mjs", order ?? "", file], { encoding: "utf8", timeout: 30000 });
const out = (v.stdout || "") + (v.stderr || "");
process.stdout.write(out);
mkdirSync("work", { recursive: true });
if (v.status === 0) {
  mkdirSync("outbox", { recursive: true });
  copyFileSync(file, `outbox/${order}.json`);
  console.log(`DELIVERED: outbox/${order}.json`);
  process.exit(0);
}
const failures = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL "));
writeFileSync("work/verify-failures.json", JSON.stringify({ order, file, failures, at: new Date().toISOString() }, null, 2) + "\n");
console.log("NOT DELIVERED: the failed checks are in work/verify-failures.json, to go back to the agent or a person.");
process.exit(1);
