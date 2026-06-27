import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "calibr-engine-"));
process.env.CALIBR_DATA_DIR = dataDir;

const engine = await import(`../dist/engine.js?cache=${Date.now()}`);

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("download footprint separates total transfer from peak disk working-set", () => {
  assert.deepEqual(engine.downloadFootprintBytes([
    { size_bytes: 2_000_000_000 },
    { size_bytes: 5_000_000_000 },
    { size_bytes: 3_000_000_000 },
  ]), {
    totalBytes: 10_000_000_000,
    maxFileBytes: 5_000_000_000,
  });
});

test("catalog download plan counts only missing or mismatched files as transfer", () => {
  const root = mkdtempSync(join(tmpdir(), "calibr-download-plan-"));
  try {
    mkdirSync(join(root, "cached"), { recursive: true });
    mkdirSync(join(root, "wrong"), { recursive: true });
    writeFileSync(join(root, "cached", "ok.gguf"), Buffer.alloc(10));
    writeFileSync(join(root, "wrong", "bad.gguf"), Buffer.alloc(3));
    assert.deepEqual(engine.catalogDownloadPlanBytes([
      { id: "cached", target_dir: "cached", hf_file: "ok.gguf", size_bytes: 10 },
      { id: "wrong", target_dir: "wrong", hf_file: "bad.gguf", size_bytes: 20 },
      { id: "missing", target_dir: "missing", hf_file: "new.gguf", size_bytes: 30 },
    ], root), {
      totalBytes: 50,
      maxFileBytes: 30,
      cachedCount: 1,
      toDownload: 2,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list/delete cached llama.cpp builds under CALIBR_DATA_DIR", () => {
  const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const flavorDir = join(dataDir, "llama-bin", "b9360", "vulkan");
  mkdirSync(flavorDir, { recursive: true });
  const server = join(flavorDir, binName);
  writeFileSync(server, "stub");

  const archiveDir = join(dataDir, "llama-bin", "archives", "b0000");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, binName), "ignored");

  const builds = engine.listCachedLlamaBuilds();
  assert.equal(builds.length, 1);
  assert.equal(builds[0].tag, "b9360");
  assert.equal(builds[0].flavor, "vulkan");
  assert.equal(builds[0].path, server);

  engine.deleteCachedLlamaBuild(builds[0]);
  assert.equal(existsSync(flavorDir), false);
});

test("traceAction writes JSONL and human log with redacted paths", () => {
  engine.traceSessionStart();
  engine.traceAction({
    flow: "guided run",
    action: "llama.cpp download",
    status: "selected",
    message: "guided run > llama.cpp > download selected (latest)",
    details: { build: "latest", path: join(dataDir, "llama-bin", "b9360") },
  });

  assert.equal(existsSync(engine.CALIBR_ACTION_TRACE), true);
  const lines = readFileSync(engine.CALIBR_ACTION_TRACE, "utf8").trim().split(/\r?\n/);
  const entry = JSON.parse(lines.at(-1));
  assert.equal(entry.source, "cli");
  assert.equal(entry.flow, "guided run");
  assert.equal(entry.action, "llama.cpp download");
  assert.equal(entry.status, "selected");
  assert.equal(entry.details.build, "latest");
  assert.equal(entry.details.path, join("<CALIBR_DATA_DIR>", "llama-bin", "b9360"));

  assert.equal(existsSync(engine.CALIBR_ACTION_TRACE_LOG), true);
  const human = readFileSync(engine.CALIBR_ACTION_TRACE_LOG, "utf8");
  assert.match(human, /SESSION /);
  assert.match(human, /TIME\s+\| SOURCE\s+\| FLOW/);
  assert.match(human, /guided run/);
  assert.match(human, /llama\.cpp download/);
  assert.match(human, /<CALIBR_DATA_DIR>/);
  assert.doesNotMatch(human, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("listBenchmarkLogs excludes action traces and exposes per-config run counts", () => {
  mkdirSync(engine.CALIBR_LOGS_DIR, { recursive: true });
  writeFileSync(join(engine.CALIBR_LOGS_DIR, "config-a.log"),
    "===== RUN 0 =====\nfirst\n===== RUN 1 =====\nsecond\n");
  writeFileSync(join(engine.CALIBR_LOGS_DIR, "campaign.out.log"), "campaign output\n");
  writeFileSync(join(engine.CALIBR_LOGS_DIR, "action-trace.log"), "trace\n");

  const logs = engine.listBenchmarkLogs();
  const config = logs.find((entry) => entry.name === "config-a.log");
  assert.equal(config.runCount, 2);
  assert.equal(config.kind, "config");
  assert.equal(config.configId, "config-a");
  assert.equal(logs.some((entry) => entry.name === "action-trace.log"), false);
  assert.deepEqual(engine.readBenchmarkLogTail(config.path, 2), ["===== RUN 1 =====", "second"]);
});

test("groupByModel applies the same near-tie winner rule as the report", () => {
  const cfg = { wddm_detection: { shared_delta_confirm_mib: 500 } };
  const groups = engine.groupByModel([
    {
      id: "small-fast",
      model: "Qwen",
      variant: "Q4",
      ok: true,
      eval_tps: 100,
      shared_peak_mib: 0,
      vram_peak_mib: 2400,
      extra_args: "--ctx-size 16384",
    },
    {
      id: "large-near",
      model: "Qwen",
      variant: "Q4",
      ok: true,
      eval_tps: 97,
      shared_peak_mib: 0,
      vram_peak_mib: 2600,
      extra_args: "--ctx-size 65536",
    },
  ], cfg);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].winner.id, "large-near");
});

test("groupByModel keeps rendering when a model has only controls or diagnostic workloads", () => {
  const cfg = { wddm_detection: { shared_delta_confirm_mib: 500 } };
  const groups = engine.groupByModel([
    {
      id: "vanilla",
      model: "Gemma",
      series: "Gemma-4",
      variant: "Q4",
      ok: true,
      eval_tps: 56,
      control_kind: "vanilla",
      workload_kind: "baseline",
    },
    {
      id: "prefill",
      model: "Gemma",
      series: "Gemma-4",
      variant: "Q4",
      ok: true,
      eval_tps: 22,
      workload_kind: "prefill",
      prefill_target_tokens: 117964,
    },
  ], cfg);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].winner.id, "vanilla");
  assert.equal(groups[0].winner._fallback, true);
  assert.equal(groups[0].series, "Gemma-4");
});
