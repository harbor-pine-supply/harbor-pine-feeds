#!/usr/bin/env node
// Nightly supplier-feed import, as a workflow: six fixed steps, the model called only to normalize descriptions.
// Every run takes the same path; a failure stops at a named step. Usage: node scripts/import-feed.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const report = { steps: [], rejected: [], imported: 0 };
const step = (name, fn) => { const t0 = Date.now(); try { const r = fn(); report.steps.push({ name, ok: true, ms: Date.now() - t0 }); return r; } catch (e) { report.steps.push({ name, ok: false, error: e.message }); finish(1); } };
function finish(code) { mkdirSync("work", { recursive: true }); writeFileSync("work/report.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report)); process.exit(code); }
const csv = (text) => { const [head, ...rows] = text.trim().split(/\r?\n/); const keys = head.split(","); return rows.map((line) => { const cells = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; } cells.push(cur); return Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? ""])); }); };

// 1. Download (tonight's feed is a local fixture in this demo)
step("download", () => { mkdirSync("work", { recursive: true }); copyFileSync("data/supplier-feed.csv", "work/feed.csv"); });
// 2. Validate: every row needs a SKU, a name and a price; duplicates are dropped
const rows = step("validate", () => { const seen = new Set(), ok = []; for (const r of csv(readFileSync("work/feed.csv", "utf8"))) { if (!r.sku || !r.name || !r.price) { report.rejected.push({ sku: r.sku, reason: "missing price" }); continue; } if (seen.has(r.sku)) { report.rejected.push({ sku: r.sku, reason: "duplicate SKU" }); continue; } seen.add(r.sku); ok.push(r); } return ok; });
// 3. Map fields to the catalog's shape (units: "12 pk" becomes a pack of 12)
const mapped = step("map", () => rows.map((r) => ({ sku: r.sku, name: r.name, rawDescription: r.description, price: Number(r.price), unit: /^(\d+)\s*pk$/i.test(r.unit) ? "pack of " + r.unit.match(/\d+/)[0] : r.unit, qty: Number(r.qty) })));
// 4. The one model call: normalize product descriptions to the catalog's style (no tools; returns JSON only)
const described = step("normalize", () => {
  const prompt = "Rewrite each product description in a catalog style: one sentence, sentence case, plain units. Change no facts. Return only a JSON object mapping each SKU to its description.\n\n" + JSON.stringify(Object.fromEntries(mapped.map((m) => [m.sku, m.rawDescription])));
  const r = spawnSync("claude", ["-p", "--output-format", "json", "--tools", "", prompt], { encoding: "utf8", shell: false });
  if (r.status !== 0) throw Error("model call failed: " + (r.stderr || "").slice(0, 200));
  const out = JSON.parse(r.stdout), text = String(out.result ?? "");
  report.model = { calls: 1, inputTokens: out.usage?.input_tokens, outputTokens: out.usage?.output_tokens, costUsd: out.total_cost_usd };
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return mapped.map((m) => { if (typeof json[m.sku] !== "string") throw Error("no description for " + m.sku); const { rawDescription, ...rest } = m; return { ...rest, description: json[m.sku] }; });
});
// 5. Write the catalog (new SKUs added, existing ones updated)
step("write", () => { const catalog = JSON.parse(readFileSync("data/catalog.json", "utf8")); for (const p of described) { const i = catalog.findIndex((c) => c.sku === p.sku); if (i >= 0) catalog[i] = p; else catalog.push(p); } writeFileSync("data/catalog.json", JSON.stringify(catalog, null, 2) + "\n"); report.imported = described.length; });
// 6. Report
step("report", () => {});
finish(0);
