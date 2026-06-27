#!/usr/bin/env node
// Maintenance: refresh exact size_bytes + sha256 for every entry in the source
// models_catalog.json using Hugging Face file metadata (no download). Run this
// when the catalog grows or entries change. The exact size feeds the runtime
// "light" cache match (local file size == catalog size, no network); the sha256
// is for the future telemetry/anti-tamper path.
//
//   node scripts/refresh-catalog-metadata.mjs           # update in place
//   node scripts/refresh-catalog-metadata.mjs --dry-run # report only
//
// Gated repos (e.g. some Gemma) may 401 without an accepted license/token; those
// entries are reported and left untouched.

import { fileDownloadInfo } from "@huggingface/hub";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(here, "..", "..", "models_catalog.json");
const dryRun = process.argv.includes("--dry-run");

const doc = JSON.parse(readFileSync(catalogPath, "utf8"));
const models = Array.isArray(doc.models) ? doc.models : [];

// Rebuild an entry preserving key order, placing sha256 right after size_bytes.
function withSizeAndSha(entry, size, sha) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === "sha256") continue;
    if (k === "size_bytes") { out.size_bytes = size; out.sha256 = sha; continue; }
    out[k] = v;
  }
  if (!("size_bytes" in out)) { out.size_bytes = size; out.sha256 = sha; }
  return out;
}

let updated = 0, sizeChanged = 0, failed = 0;
const failures = [];

for (let i = 0; i < models.length; i++) {
  const m = models[i];
  if (!m.hf_repo || !m.hf_file) continue;
  try {
    const info = await fileDownloadInfo({ repo: m.hf_repo, path: m.hf_file });
    if (!info) { failures.push(`${m.id}: not found (${m.hf_repo}/${m.hf_file})`); failed++; continue; }
    const sha = info.etag ? info.etag.replace(/"/g, "") : null;
    if (m.size_bytes !== info.size) {
      console.log(`[size] ${m.id}: ${m.size_bytes} -> ${info.size}`);
      sizeChanged++;
    }
    models[i] = withSizeAndSha(m, info.size, sha);
    updated++;
  } catch (error) {
    failures.push(`${m.id}: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

console.log(`\nrefreshed ${updated}/${models.length} entries (${sizeChanged} sizes changed), ${failed} failed`);
if (failures.length) {
  console.log("failures (left untouched):");
  for (const f of failures) console.log(`  - ${f}`);
}

if (dryRun) {
  console.log("\n[dry-run] models_catalog.json not written");
} else {
  writeFileSync(catalogPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\nwrote ${catalogPath}`);
}
