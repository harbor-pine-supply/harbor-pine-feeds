#!/usr/bin/env node
// Verify the investigation summary (work/summary.json) against the order, payment and shipment records.
// Prints each check; exits 1 if any fails, so the summary isn't delivered. Usage: node scripts/verify-summary.mjs
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync("work/summary.json", "utf8"));
const read = (f) => JSON.parse(readFileSync("data/" + f, "utf8"));
const order = read("orders.json").find((o) => o.id === s.order), pay = read("payments.json").find((p) => p.order === s.order), ship = read("shipments.json").find((x) => x.order === s.order);
const checks = [
  ["order exists", Boolean(order)],
  ["amount matches the payment", Number(s.amount) === pay?.amount],
  ["payment date matches", s.dates?.paymentCaptured === pay?.captured],
  ["shipment date matches", s.dates?.shipmentCreated === ship?.created],
  ["cause matches the shipment record", typeof s.cause === "string" && /address|postal/i.test(s.cause) && ship?.state === "rejected"],
];
for (const [name, ok] of checks) console.log((ok ? "PASS " : "FAIL ") + name);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
