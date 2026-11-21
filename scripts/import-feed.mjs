#!/usr/bin/env node
// Nightly supplier-feed import, as a workflow: six predefined steps, with the model called only to normalize
// descriptions. A failure stops at a named step, with its reason. Usage: node scripts/import-feed.mjs
// The model's rewording is checked only for shape and for keeping every number from the original; it is otherwise
// unverified wording, so the catalog keeps prices, units and quantities from the feed, never from the model.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
const report = { steps: [], rejected: [], imported: 0 };
function finish(code) { mkdirSync("work", { recursive: true }); writeFileSync("work/report.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report)); process.exit(code); }
const step = (name, fn) => { const t0 = Date.now(); try { const r = fn(); report.steps.push({ name, ok: true, ms: Date.now() - t0 }); return r; } catch (e) { report.steps.push({ name, ok: false, error: e.message }); finish(1); } };
const csv = (text) => { const [head, ...rows] = text.trim().split(/\r?\n/); const keys = head.split(","); return rows.map((line) => { const cells = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; } cells.push(cur); return Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? "").trim()])); }); };
const UNITS = /^(each|\d+\s*pk)$/i;

// 1. Download (tonight's feed is a local fixture in this demo)
step("download", () => { mkdirSync("work", { recursive: true }); copyFileSync("data/supplier-feed.csv", "work/feed.csv"); });
// 2. Validate: a SKU, a name, a positive price and quantity, a known unit; duplicates dropped
const rows = step("validate", () => {
  const seen = new Set(), ok = [];
  for (const r of csv(readFileSync("work/feed.csv", "utf8"))) {
    const price = Number(r.price), qty = Number(r.qty);
    const reason = !r.sku || !r.name ? "missing SKU or name" : r.price === "" ? "missing price" : !Number.isFinite(price) || price <= 0 ? "price is not a positive number" : !Number.isInteger(qty) || qty < 0 ? "quantity is not a whole number" : !UNITS.test(r.unit) ? `unknown unit "${r.unit}"` : seen.has(r.sku) ? "duplicate SKU" : null;
    if (reason) { report.rejected.push({ sku: r.sku, reason }); continue; }
    seen.add(r.sku); ok.push({ ...r, price, qty });
  }
  return ok;
});
// 3. Map fields to the catalog's shape ("12 pk" becomes "pack of 12")
const mapped = step("map", () => rows.map((r) => ({ sku: r.sku, name: r.name, rawDescription: r.description, price: r.price, unit: /pk$/i.test(r.unit) ? "pack of " + r.unit.match(/\d+/)[0] : r.unit, qty: r.qty })));
// 4. The one model call: normalize product descriptions (no tools; JSON only; two-minute deadline)
const described = step("normalize", () => {
  const prompt = "Rewrite each product description in a catalog style: one sentence, sentence case, plain units. Change no facts and keep every number. Return only a JSON object mapping each SKU to its description.\n\n" + JSON.stringify(Object.fromEntries(mapped.map((m) => [m.sku, m.rawDescription])));
  const r = spawnSync("claude", ["-p", "--output-format", "json", "--tools", "", "--", prompt], { encoding: "utf8", shell: false, timeout: 120000 });
  if (r.error) throw Error(`model call could not run: ${r.error.code === "ETIMEDOUT" ? "timed out after 120 s" : r.error.message}`);
  if (r.status !== 0) throw Error("model call failed: " + (r.stderr || r.stdout || "").slice(0, 200));
  let out; try { out = JSON.parse(r.stdout); } catch { throw Error("model call returned no JSON"); }
  if (out.is_error) throw Error("the model reported an error: " + String(out.result ?? "").slice(0, 200));
  const text = String(out.result ?? "");
  report.model = { calls: 1, inputTokens: out.usage?.input_tokens, outputTokens: out.usage?.output_tokens, costUsd: out.total_cost_usd };
  let json; try { json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { throw Error("the model's answer was not a JSON object"); }
  return mapped.map((m) => {
    const d = json[m.sku];
    if (typeof d !== "string" || !d.trim() || d.length > 240) throw Error(`no usable description for ${m.sku}`);
    // Every number in the original must survive the rewording (a cheap check; not proof that no fact changed).
    const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const nums = (s) => [...(s.match(/\d+(?:\.\d+)?/g) ?? []), ...((s.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g) ?? []).map((w) => String(WORDS[w])))];
    const lost = nums(m.rawDescription).filter((x) => !nums(d).includes(x));
    if (lost.length) throw Error(`the rewording of ${m.sku} dropped ${lost.join(", ")}`);
    const { rawDescription, ...rest } = m; return { ...rest, description: d.trim() };
  });
});
// 5. Write the catalog atomically (new SKUs added, existing ones updated)
step("write", () => { const catalog = JSON.parse(readFileSync("data/catalog.json", "utf8")); for (const p of described) { const i = catalog.findIndex((c) => c.sku === p.sku); if (i >= 0) catalog[i] = p; else catalog.push(p); } writeFileSync("data/catalog.json.tmp", JSON.stringify(catalog, null, 2) + "\n"); renameSync("data/catalog.json.tmp", "data/catalog.json"); report.imported = described.length; });
// 6. Report
step("report", () => {});
finish(0);
