#!/usr/bin/env node
// PreToolUse hook: the harness's policy gate, version 2. Reads the tool call on stdin; exit 2 blocks it, and the reason
// (stderr) goes to the agent. It is one layer, not the only one: the refund tool checks a person's approval itself, and
// the permission rules in .claude/settings.json deny edits to the records, the scripts and the harness.
// Fails closed: any error inside the gate blocks the call (and settings.json sets onFailure to block, for crashes).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve, relative } from "node:path";
const block = (why) => { console.error("Blocked by policy: " + why); process.exit(2); };
try {
  const call = JSON.parse(readFileSync(0, "utf8"));
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });

  // 1. Step limit: count this session's tool calls (one counter per session id), written atomically.
  const sid = String(call.session_id || "no-session").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "no-session";
  const counter = join(work, `steps-${sid}.json`), LIMIT = 15;
  const n = (existsSync(counter) ? JSON.parse(readFileSync(counter, "utf8")).n : 0) + 1;
  writeFileSync(counter + ".tmp", JSON.stringify({ n }) + "\n"); renameSync(counter + ".tmp", counter);
  if (n > LIMIT) block(`step limit reached (${LIMIT} tool calls). Stop and report what you found so far.`);

  const tool = call.tool_name, input = call.tool_input || {};
  // 2. Shell commands: never run the refund or approval tools, in any form (node -- x, node --flag x, bash -c "node x").
  if (["Bash", "PowerShell"].includes(tool)) {
    const cmd = String(input.command ?? "");
    const runs = (name) => new RegExp(`\\bnode(?:\\.exe)?(?:\\s+-{1,2}[^\\s"';&|]*)*\\s+["']?[^\\s"';&|]*${name}(?=["'\\s;&|)]|$)`, "i").test(cmd);
    if (runs("refund\\.mjs") || runs("approve-refund\\.mjs")) {
      const q = join(work, "approvals-requested.json"), list = existsSync(q) ? JSON.parse(readFileSync(q, "utf8")) : [];
      list.push({ requested: cmd.slice(0, 300), at: new Date().toISOString(), status: "waiting for a person" });
      writeFileSync(q + ".tmp", JSON.stringify(list, null, 2) + "\n"); renameSync(q + ".tmp", q);
      block("refunds need a person's approval. The request was added to work/approvals-requested.json. Don't retry; include it in your summary.");
    }
    // Shell writes to the records, approvals, scripts or the harness are not this job's.
    if (/(>>?|\b(?:Out-File|Set-Content|Add-Content|Remove-Item|Copy-Item|Move-Item|writeFileSync|cp|mv|rm|del|copy|move|tee)\b)[^;&|]*(?:^|[\s"'=/\\])(?:data|approvals|scripts|outbox|\.claude)[\\/]/i.test(cmd)) block("this job may not change the records, approvals, scripts or the harness.");
  }
  // 3. File writes: only the summary, in work/.
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const target = relative(root, resolve(root, String(input.file_path ?? input.notebook_path ?? ""))).replace(/\\/g, "/");
    if (target !== "work/summary.json") block(`this job may write only work/summary.json (not ${target}).`);
  }
  process.exit(0);
} catch (e) {
  block("the gate itself failed (" + String(e?.message || e).slice(0, 120) + "), so the call is blocked.");
}
