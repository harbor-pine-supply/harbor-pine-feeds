#!/usr/bin/env node
// PreToolUse hook: the harness's policy gate, version 3. Reads the tool call on stdin; exit 2 blocks it, and the reason
// (stderr) goes to the agent. It is a second layer, not the boundary: the investigation's allowlist
// (.claude/investigation.json) lets the agent run one command only, the refund tool checks a person's approval itself,
// and the permission rules in .claude/settings.json deny edits to the records, the scripts and the harness.
// Fails closed: any error inside the gate blocks the call (and settings.json sets onFailure to block, for crashes).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
const block = (why) => { console.error("Blocked by policy: " + why); process.exit(2); };
try {
  const call = JSON.parse(readFileSync(0, "utf8"));
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });

  // 1. Tool-call limit: one counter per session, kept outside the repo (the agent can't reset it), updated under a
  // lock so calls at the same moment can't both read the same count.
  const sid = String(call.session_id || "no-session").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "no-session";
  const dir = join(process.env.HARBOR_PINE_GATE_DIR || join(tmpdir(), "harbor-pine-gate")), counter = join(dir, `${sid}.json`), lock = counter + ".lock", LIMIT = 15;
  mkdirSync(dir, { recursive: true });
  const until = Date.now() + 5000;
  for (;;) { try { mkdirSync(lock); break; } catch (e) { if (e.code !== "EEXIST" || Date.now() > until) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } }
  let n;
  try { n = (existsSync(counter) ? JSON.parse(readFileSync(counter, "utf8")).n : 0) + 1; writeFileSync(counter + ".tmp", JSON.stringify({ n }) + "\n"); renameSync(counter + ".tmp", counter); }
  finally { rmdirSync(lock); }
  writeFileSync(join(work, "steps.json"), JSON.stringify({ n, limit: LIMIT }) + "\n"); // a copy for people to read; never read back
  if (n > LIMIT) block(`tool-call limit reached (${LIMIT}). Stop and report what you found so far.`);

  const tool = call.tool_name, input = call.tool_input || {};
  // 2. Shell commands: block known direct and wrapped runs of the refund or approval tools (node x, node -- x, node --flag x, bash -c "node x"). Not every form: node -e with a dynamic import gets past this pattern; the allowlist stops that.
  if (["Bash", "PowerShell"].includes(tool)) {
    const cmd = String(input.command ?? "");
    const runs = (name) => new RegExp(`\\bnode(?:\\.exe)?(?:\\s+-{1,2}[^\\s"';&|]*)*\\s+["']?[^\\s"';&|]*${name}(?=["'\\s;&|)]|$)`, "i").test(cmd);
    if (runs("refund\\.mjs") || runs("approve-refund\\.mjs")) {
      const q = join(work, "approvals-requested.json"), list = existsSync(q) ? JSON.parse(readFileSync(q, "utf8")) : [];
      list.push({ requested: cmd.slice(0, 300), at: new Date().toISOString(), status: "waiting for a person" });
      writeFileSync(q + ".tmp", JSON.stringify(list, null, 2) + "\n"); renameSync(q + ".tmp", q);
      block("refunds need a person's approval. The request was added to work/approvals-requested.json. Don't retry; include it in your summary.");
    }
    // Shell writes to the records, approvals, scripts or the harness are not this job's. A segment that starts with a
    // read-only program (cat, grep, …) and has no redirect is a read, whatever text it searches for.
    const READ_ONLY = /^\s*(?:cd\s+\S+\s*$|cat|head|tail|less|more|grep|rg|findstr|ls|dir|find|wc|type|Get-Content|Select-String|Get-ChildItem)\b/i;
    const PROTECTED = /(?:^|[\s"'=/\\])(?:data|approvals|scripts|outbox|\.claude)[\\/]/i;
    const INTO_PROTECTED = />>?\s*["']?[^\s"';&|]*?(?:^|[\\/"'\s]|\b)(?:data|approvals|scripts|outbox|\.claude)[\\/]/i; // a redirect whose target is protected
    const writesProtected = cmd.split(/&&|\|\||[;&|\n]/).some((seg) => INTO_PROTECTED.test(seg) || (PROTECTED.test(seg) && !READ_ONLY.test(seg) && /\b(?:Out-File|Set-Content|Add-Content|Remove-Item|Copy-Item|Move-Item|writeFileSync|cp|mv|rm|del|copy|move|tee)\b/i.test(seg)));
    if (writesProtected) block("this job may not change the records, approvals, scripts or the harness.");
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
