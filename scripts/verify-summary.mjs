#!/usr/bin/env node
// Verify an investigation summary against the source records, field by field.
//   node scripts/verify-summary.mjs <order> [summary file, default work/summary.json]
// Checks only structured fields: the order, the amount, both dates, and the shipment's state and reason (copied from
// the record). The free-text "cause" and the "actions" are not machine-checked: a person reads them. Exits 1 if any
// check fails, so the caller (scripts/deliver-summary.mjs) doesn't deliver it.
import { readFileSync, existsSync } from "node:fs";
const [order, file = "work/summary.json"] = process.argv.slice(2);
const results = [];
const check = (name, ok) => results.push([name, Boolean(ok)]);
const read = (f) => JSON.parse(readFileSync(f, "utf8"));
let s = null;
try { s = existsSync(file) ? read(file) : null; } catch { s = null; }
check("summary is valid JSON", s && typeof s === "object");
if (s) {
  const pay = read("data/payments.json").find((p) => p.order === order);
  const ship = read("data/shipments.json").find((x) => x.order === order);
  const ymd = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  check(`it is about the assigned order (${order})`, /^HP-\d{4}$/.test(order ?? "") && s.order === order);
  check("the order has payment and shipment records", pay && ship);
  check("amount matches the captured payment", typeof s.amount === "number" && pay && s.amount === pay.amount);
  check("payment date is present and matches", ymd(s.dates?.paymentCaptured) && pay && s.dates.paymentCaptured === pay.captured);
  check("shipment date is present and matches", ymd(s.dates?.shipmentCreated) && ship && s.dates.shipmentCreated === ship.created);
  check("shipment state matches the record", ship && s.shipment?.state === ship.state);
  check("shipment reason matches the record exactly", ship && typeof ship.reason === "string" && s.shipment?.reason === ship.reason);
}
for (const [name, ok] of results) console.log((ok ? "PASS " : "FAIL ") + name);
console.log("NOT CHECKED: the free-text cause and the actions (a person reads them)");
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
