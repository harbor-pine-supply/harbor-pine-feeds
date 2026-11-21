#!/usr/bin/env node
// Deliver an investigation summary only if it passes verification.
//   node scripts/deliver-summary.mjs <order> [summary file, default work/summary.json]
// Every run first withdraws any earlier delivery for the order, then writes outbox/<order>.status.json for THIS run
// (delivered: true or false), so a reader never mistakes an older result for this one.
// Pass: copies the summary to outbox/<order>.json. Fail: delivers nothing, and writes the failed checks to
// work/verify-failures.json, so the harness can send them back to the agent as evidence (or to a person). It never
// retries on its own.
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
const [order, file = "work/summary.json"] = process.argv.slice(2);
if (!/^HP-\d{4}$/.test(order ?? "")) { console.error("usage: node scripts/deliver-summary.mjs <order> [summary file]"); process.exit(2); }
const run = randomUUID(), at = new Date().toISOString();
mkdirSync("outbox", { recursive: true }); mkdirSync("work", { recursive: true });
rmSync(`outbox/${order}.json`, { force: true }); // withdraw any earlier delivery before deciding this one
const v = spawnSync(process.execPath, ["scripts/verify-summary.mjs", order, file], { encoding: "utf8", timeout: 30000 });
const out = (v.stdout || "") + (v.stderr || "");
process.stdout.write(out);
const status = (delivered, extra = {}) => writeFileSync(`outbox/${order}.status.json`, JSON.stringify({ order, run, at, file, delivered, ...extra }, null, 2) + "\n");
if (v.status === 0) {
  copyFileSync(file, `outbox/${order}.json`);
  status(true);
  console.log(`DELIVERED: outbox/${order}.json (run ${run.slice(0, 8)})`);
  process.exit(0);
}
const failures = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL "));
writeFileSync("work/verify-failures.json", JSON.stringify({ order, run, file, failures, at }, null, 2) + "\n");
status(false, { failures });
console.log(`NOT DELIVERED (run ${run.slice(0, 8)}): the failed checks are in work/verify-failures.json, to go back to the agent or a person.`);
process.exit(1);
