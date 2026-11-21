#!/usr/bin/env node
// Deliver an investigation summary only if it passes verification.
//   node scripts/deliver-summary.mjs <order> [summary file, default work/summary.json]
// Every run first records outbox/<order>.status.json for THIS run as pending (delivered: false), then withdraws any
// earlier delivery for the order, and ends by recording delivered: true or false. If the run is interrupted, or an
// error stops it, the status still says not delivered, so a reader never mistakes an older result for this one.
// Every status and delivery file is written to a temporary file first and then renamed into place.
// Pass: copies the summary to outbox/<order>.json. Fail: delivers nothing, and writes the failed checks to
// work/verify-failures.json, so the harness can send them back to the agent as evidence (or to a person). It never
// retries on its own.
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
const [order, file = "work/summary.json"] = process.argv.slice(2);
if (!/^HP-\d{4}$/.test(order ?? "")) { console.error("usage: node scripts/deliver-summary.mjs <order> [summary file]"); process.exit(2); }
const run = randomUUID(), at = new Date().toISOString();
const atomic = (path, text) => { writeFileSync(path + ".tmp", text); renameSync(path + ".tmp", path); };
const status = (state, extra = {}) => atomic(`outbox/${order}.status.json`, JSON.stringify({ order, run, at, file, state, delivered: state === "delivered", ...extra }, null, 2) + "\n");
// The outbox holds the status, so it comes first; if even that fails, there is no earlier status left to mislead.
mkdirSync("outbox", { recursive: true });
status("pending"); // before anything else: from here on, an interrupted run reads as not delivered
try {
  mkdirSync("work", { recursive: true });
  rmSync(`outbox/${order}.json`, { force: true }); // withdraw any earlier delivery before deciding this one
  const v = spawnSync(process.execPath, ["scripts/verify-summary.mjs", order, file], { encoding: "utf8", timeout: 30000 });
  const out = (v.stdout || "") + (v.stderr || "");
  process.stdout.write(out);
  if (v.status === 0) {
    copyFileSync(file, `outbox/${order}.json.tmp`); renameSync(`outbox/${order}.json.tmp`, `outbox/${order}.json`);
    status("delivered");
    console.log(`DELIVERED: outbox/${order}.json (run ${run.slice(0, 8)})`);
    process.exit(0);
  }
  const failures = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL "));
  atomic("work/verify-failures.json", JSON.stringify({ order, run, file, failures, at }, null, 2) + "\n");
  status("failed", { failures });
  console.log(`NOT DELIVERED (run ${run.slice(0, 8)}): the failed checks are in work/verify-failures.json, to go back to the agent or a person.`);
  process.exit(1);
} catch (e) {
  status("error", { error: String(e?.message ?? e).slice(0, 300) });
  console.log(`NOT DELIVERED (run ${run.slice(0, 8)}): delivery stopped with an error: ${String(e?.message ?? e).slice(0, 200)}`);
  process.exit(1);
}
