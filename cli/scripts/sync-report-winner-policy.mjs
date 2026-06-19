#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReportWinnerPolicySource } from "../dist/winnerPolicy.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const templatePath = join(repoRoot, "report.template.html");
const checkOnly = process.argv.includes("--check");

const start = "// BEGIN GENERATED WINNER POLICY";
const end = "// END GENERATED WINNER POLICY";

const html = readFileSync(templatePath, "utf8");
const newline = html.includes("\r\n") ? "\r\n" : "\n";
const generated = createReportWinnerPolicySource().replace(/\n/g, newline);

let next;
let found = false;
if (html.includes(start) && html.includes(end)) {
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  next = html.replace(pattern, generated);
  found = true;
}

if (!found) {
  console.error("sync-report-winner-policy: could not find report winner policy block");
  process.exit(1);
}

if (checkOnly) {
  if (next !== html) {
    console.error("sync-report-winner-policy: report.template.html winner policy is out of sync");
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(templatePath, next);
console.error("sync-report-winner-policy: updated report.template.html");
