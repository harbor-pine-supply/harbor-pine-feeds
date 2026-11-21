// Tests for the investigation harness: the policy gate, the refund tool, the verify step and delivery.
// Each test runs in a fresh temporary copy of the repo, so nothing real changes. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repo = process.cwd();
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "hp-harness-"));
  for (const d of ["data", "scripts", ".claude"]) cpSync(join(repo, d), join(dir, d), { recursive: true });
  return dir;
}
// Each sandbox gets its own gate-counter folder (in real use it lives in the system temp folder, outside the repo).
const envFor = (dir) => ({ ...process.env, CLAUDE_PROJECT_DIR: dir, HARBOR_PINE_GATE_DIR: join(dir, "..", "gate-" + dir.split(/[\\/]/).pop()) });
const run = (dir, args, input) => spawnSync(process.execPath, args, { cwd: dir, input, encoding: "utf8", env: envFor(dir) });
const gate = (dir, call) => run(dir, [".claude/hooks/policy-gate.mjs"], typeof call === "string" ? call : JSON.stringify({ session_id: "t", ...call }));
const shell = (command, tool = "Bash") => ({ tool_name: tool, tool_input: { command } });

test("the gate blocks known direct and wrapped invocations of the refund and approval tools", () => {
  const dir = sandbox();
  for (const tool of ["Bash", "PowerShell"]) for (const cmd of [
    "node scripts/refund.mjs HP-1042 288.95", "node -- scripts/refund.mjs HP-1042 1", "node --no-warnings scripts/refund.mjs HP-1042 1",
    "cd ~/x && node ./scripts/refund.mjs HP-1042 1", "bash -c \"node scripts/refund.mjs HP-1042 1\"", "node scripts/approve-refund.mjs HP-1042 1 me",
  ]) assert.equal(gate(dir, shell(cmd, tool)).status, 2, `${tool}: ${cmd}`);
});
test("the gate blocks shell writes to the records, approvals, scripts and harness", () => {
  const dir = sandbox();
  for (const cmd of ["echo [] > data/refunds.json", "Set-Content approvals/HP-1042.json x", "cp x scripts/verify-summary.mjs", "rm .claude/hooks/policy-gate.mjs", "cat x > scripts/verify-summary.mjs"])
    assert.equal(gate(dir, shell(cmd)).status, 2, cmd);
});
test("the gate lets harmless calls through: reads, searches, other scripts", () => {
  const dir = sandbox();
  for (const cmd of ["cat scripts/refund.mjs scripts/verify-summary.mjs", "grep -n amount scripts/refund.mjs", "grep -n writeFileSync scripts/refund.mjs", "ls scripts 2>/dev/null", "cat scripts/refund.mjs 2>&1 | head -5", "node scripts/refund.mjs.bak", "node scripts/verify-summary.mjs HP-1042", "node scripts/verify-summary.mjs HP-1042; cat scripts/refund.mjs"])
    assert.equal(gate(dir, shell(cmd)).status, 0, cmd);
  assert.equal(gate(dir, { tool_name: "Read", tool_input: { file_path: "data/orders.json" } }).status, 0);
});
test("file writes: only work/summary.json", () => {
  const dir = sandbox();
  assert.equal(gate(dir, { tool_name: "Write", tool_input: { file_path: join(dir, "work/summary.json") } }).status, 0);
  for (const p of ["data/refunds.json", "approvals/HP-1042.json", "scripts/verify-summary.mjs", ".claude/settings.json", "work/other.json"])
    assert.equal(gate(dir, { tool_name: "Edit", tool_input: { file_path: join(dir, p) } }).status, 2, p);
});
test("the gate fails closed on bad input, and enforces the step limit", () => {
  const dir = sandbox();
  assert.equal(gate(dir, "not json").status, 2);
  for (let i = 1; i <= 15; i++) assert.equal(gate(dir, { tool_name: "Read", tool_input: { file_path: "x" } }).status, 0, `call ${i}`);
  // Resetting the copy in work/ changes nothing: the real counter is outside the repo.
  writeFileSync(join(dir, "work/steps.json"), JSON.stringify({ n: 0 }));
  assert.equal(gate(dir, { tool_name: "Read", tool_input: { file_path: "x" } }).status, 2, "call 16, after a reset attempt");
});
test("the tool-call counter counts calls that arrive at the same moment", async () => {
  const dir = sandbox(), { spawn } = await import("node:child_process");
  const one = () => new Promise((ok) => { const p = spawn(process.execPath, [".claude/hooks/policy-gate.mjs"], { cwd: dir, env: envFor(dir) }); p.on("exit", (code) => ok(code)); p.stdin.end(JSON.stringify({ session_id: "par", tool_name: "Read", tool_input: { file_path: "x" } })); });
  const codes = await Promise.all(Array.from({ length: 20 }, one));
  assert.equal(codes.filter((c) => c === 0).length, 15, "exactly 15 allowed");
  assert.equal(codes.filter((c) => c === 2).length, 5, "the rest blocked");
});
test("the workflow rejects blank quantities, zero-size packs and bad prices, and calls no model when nothing is valid", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "data/supplier-feed.csv"), "sku,name,description,price,unit,qty\nHP-A,A,a,10,each,\nHP-B,B,b,10,0 pk,5\nHP-C,C,c,abc,each,5\n");
  const r = run(dir, ["scripts/import-feed.mjs"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rep = JSON.parse(readFileSync(join(dir, "work/report.json"), "utf8"));
  assert.deepEqual(rep.rejected.map((x) => x.reason), ["missing quantity", "pack size must be at least 1", "price is not a positive number"]);
  assert.equal(rep.model.calls, 0);
});

const good = { order: "HP-1042", amount: 288.95, dates: { paymentCaptured: "2026-11-18", shipmentCreated: "2026-11-19" }, shipment: { state: "rejected", reason: "address validation failed: postal code 83702 does not match city Bend" }, cause: "The carrier rejected the address.", actions: [] };
const verify = (dir, s) => { mkdirSync(join(dir, "work"), { recursive: true }); writeFileSync(join(dir, "work/summary.json"), typeof s === "string" ? s : JSON.stringify(s)); return run(dir, ["scripts/verify-summary.mjs", "HP-1042"]).status; };
test("verify passes a correct summary and fails each kind of wrong one", () => {
  const dir = sandbox();
  assert.equal(verify(dir, good), 0);
  for (const [why, s] of [["wrong order", { ...good, order: "HP-1041" }], ["wrong amount", { ...good, amount: 288.9 }], ["missing date", { ...good, dates: { paymentCaptured: "2026-11-18" } }],
    ["wrong reason", { ...good, shipment: { state: "rejected", reason: "insufficient stock" } }], ["not JSON", "{oops"]]) assert.equal(verify(dir, s), 1, why);
});
test("delivery: a passing summary reaches the outbox; a failing one doesn't, and its failures are kept", () => {
  const dir = sandbox();
  verify(dir, good);
  assert.equal(run(dir, ["scripts/deliver-summary.mjs", "HP-1042"]).status, 0);
  assert.ok(existsSync(join(dir, "outbox/HP-1042.json")));
  // Then a failing run in the same folder: the earlier delivery is withdrawn, and the status says this run failed.
  verify(dir, { ...good, amount: 1 });
  assert.equal(run(dir, ["scripts/deliver-summary.mjs", "HP-1042"]).status, 1);
  assert.ok(!existsSync(join(dir, "outbox/HP-1042.json")), "the earlier delivery is withdrawn");
  assert.equal(JSON.parse(readFileSync(join(dir, "outbox/HP-1042.status.json"), "utf8")).delivered, false);
  assert.match(readFileSync(join(dir, "work/verify-failures.json"), "utf8"), /amount/);
});
test("delivery: an error after an earlier success leaves the status as not delivered", () => {
  const dir = sandbox();
  verify(dir, good);
  assert.equal(run(dir, ["scripts/deliver-summary.mjs", "HP-1042"]).status, 0);
  // Force an error: the delivered file can't be withdrawn (a folder stands in its place).
  rmSync(join(dir, "outbox/HP-1042.json")); mkdirSync(join(dir, "outbox/HP-1042.json"));
  const r = run(dir, ["scripts/deliver-summary.mjs", "HP-1042"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT DELIVERED/);
  const s = JSON.parse(readFileSync(join(dir, "outbox/HP-1042.status.json"), "utf8"));
  assert.equal(s.delivered, false); assert.equal(s.state, "error");
  // And a failure while starting up: work/ can't be created (a file stands in its place).
  rmSync(join(dir, "outbox/HP-1042.json"), { recursive: true, force: true });
  verify(dir, good);
  assert.equal(run(dir, ["scripts/deliver-summary.mjs", "HP-1042"]).status, 0, "delivered again first");
  rmSync(join(dir, "work"), { recursive: true, force: true }); writeFileSync(join(dir, "work"), "not a folder");
  const r2 = run(dir, ["scripts/deliver-summary.mjs", "HP-1042", "summary-elsewhere.json"]);
  assert.equal(r2.status, 1);
  const s2 = JSON.parse(readFileSync(join(dir, "outbox/HP-1042.status.json"), "utf8"));
  assert.equal(s2.delivered, false); assert.equal(s2.state, "error");
});
test("the refund tool refuses without a matching, unused approval for a known order", () => {
  const dir = sandbox();
  assert.equal(run(dir, ["scripts/refund.mjs", "HP-1042", "288.95"]).status, 1, "no approval");
  assert.equal(run(dir, ["scripts/approve-refund.mjs", "HP-1042", "100", "A person"]).status, 0);
  assert.equal(run(dir, ["scripts/refund.mjs", "HP-1042", "288.95"]).status, 1, "amount differs from the approval");
  assert.equal(run(dir, ["scripts/refund.mjs", "HP-1042", "abc"]).status, 1, "not a number");
  assert.equal(run(dir, ["scripts/refund.mjs", "HP-9999", "100"]).status, 1, "unknown order");
  const ok = run(dir, ["scripts/refund.mjs", "HP-1042", "100"]);
  assert.equal(ok.status, 0); assert.match(ok.stdout, /SIMULATED/);
  assert.equal(run(dir, ["scripts/refund.mjs", "HP-1042", "100"]).status, 1, "the approval is used once");
});
