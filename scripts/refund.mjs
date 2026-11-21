#!/usr/bin/env node
// SIMULATED refund for an order: writes a ledger entry to data/refunds.json. No payment provider is called.
// The refund tool enforces its own rule (not just the hook in front of it): it refuses unless a person has approved
// this exact refund in approvals/<order>.json, and it validates the order, the captured payment and the amount.
//   node scripts/refund.mjs <order> <amount>
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
const fail = (msg) => { console.error("Refund refused: " + msg); process.exit(1); };
const [order, amountText] = process.argv.slice(2);
if (!/^HP-\d{4}$/.test(order ?? "")) fail("usage: node scripts/refund.mjs <order> <amount>");
const amount = Number(amountText);
if (!Number.isFinite(amount) || amount <= 0 || !/^\d+(\.\d{1,2})?$/.test(amountText)) fail(`"${amountText}" is not a positive amount in dollars and cents.`);
const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const pay = read("data/payments.json").find((p) => p.order === order);
if (!read("data/orders.json").some((o) => o.id === order) || !pay || pay.state !== "captured") fail(`${order} has no captured payment.`);
// A person's approval, for this order and this amount (approvals/ is outside what an agent may write).
const approvalFile = `approvals/${order}.json`;
if (!existsSync(approvalFile)) fail(`no approval from a person for ${order} (expected ${approvalFile}).`);
const approval = read(approvalFile);
if (approval.order !== order || Number(approval.amount) !== amount || !approval.approvedBy || !approval.id) fail("the approval doesn't match this order and amount.");
// Never more than was captured, and each approval is used once (idempotent).
const file = "data/refunds.json", ledger = existsSync(file) ? read(file) : [];
if (ledger.some((r) => r.approval === approval.id)) fail(`approval ${approval.id} was already used.`);
const refunded = ledger.filter((r) => r.order === order).reduce((n, r) => n + r.amount, 0);
if (Math.round((refunded + amount) * 100) > Math.round(pay.amount * 100)) fail(`${amount} would exceed the captured ${pay.amount} (already refunded: ${refunded}).`);
ledger.push({ order, amount, approval: approval.id, approvedBy: approval.approvedBy, simulated: true, at: new Date().toISOString() });
writeFileSync(file + ".tmp", JSON.stringify(ledger, null, 2) + "\n"); renameSync(file + ".tmp", file);
console.log(`SIMULATED refund recorded: ${order} ${amount} (approval ${approval.id}; no payment provider was called).`);
