#!/usr/bin/env node
// PreToolUse hook: the harness's policy gate. Reads the tool call on stdin; exit 2 blocks it, with the reason on stderr.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
const call = JSON.parse(readFileSync(0, "utf8"));
mkdirSync("work", { recursive: true });
const STEPS = "work/steps.json", LIMIT = 15;
const n = (existsSync(STEPS) ? JSON.parse(readFileSync(STEPS, "utf8")).n : 0) + 1;
writeFileSync(STEPS, JSON.stringify({ n }) + "\n");
if (n > LIMIT) { console.error("Step limit reached (" + LIMIT + "). Stop and report what you found so far."); process.exit(2); }
const cmd = String(call.tool_input?.command ?? "");
// Block running the refund tool (node ... refund.mjs, at the start or after ; & |), from either shell tool.
// Reading or listing the script is not a refund (the first version blocked "cat scripts/refund.mjs": a false positive).
if (["Bash", "PowerShell"].includes(call.tool_name) && /(?:^|[;&|])\s*node(?:\.exe)?\s+\S*refund\.mjs\b/.test(cmd)) {
  const q = "work/approvals.json", list = existsSync(q) ? JSON.parse(readFileSync(q, "utf8")) : [];
  list.push({ requested: cmd, at: new Date().toISOString(), status: "waiting for a person" });
  writeFileSync(q, JSON.stringify(list, null, 2) + "\n");
  console.error("Blocked by policy: refunds need a person's approval. The request was added to work/approvals.json. Don't retry; include it in your summary.");
  process.exit(2);
}
process.exit(0);
