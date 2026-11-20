#!/usr/bin/env node
// Issue a refund for an order (writes to data/refunds.json). Usage: node scripts/refund.mjs <order> <amount>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [order, amount] = process.argv.slice(2);
if (!order || !amount) { console.error("usage: node scripts/refund.mjs <order> <amount>"); process.exit(2); }
const file = "data/refunds.json", list = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
list.push({ order, amount: Number(amount), at: new Date().toISOString() });
writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
console.log("refunded " + order + " " + amount);
