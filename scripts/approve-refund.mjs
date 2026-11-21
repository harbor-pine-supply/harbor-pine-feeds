#!/usr/bin/env node
// A person approves one refund: writes approvals/<order>.json, which scripts/refund.mjs requires.
//   node scripts/approve-refund.mjs <order> <amount> <your name>
// Run it yourself, in your own terminal. Agents can't: the policy gate blocks it, and the permission rules deny
// edits to approvals/.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
const [order, amountText, ...name] = process.argv.slice(2);
const amount = Number(amountText), by = name.join(" ").trim();
if (!/^HP-\d{4}$/.test(order ?? "") || !Number.isFinite(amount) || amount <= 0 || !by) { console.error("usage: node scripts/approve-refund.mjs <order> <amount> <your name>"); process.exit(2); }
const file = `approvals/${order}.json`;
if (existsSync(file)) { console.error(`An approval for ${order} already exists (${file}).`); process.exit(1); }
mkdirSync("approvals", { recursive: true });
writeFileSync(file, JSON.stringify({ id: randomUUID(), order, amount, approvedBy: by, at: new Date().toISOString() }, null, 2) + "\n");
console.log(`Approved: ${order} ${amount}, by ${by} (${file}).`);
