import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  aggregateBenchResult,
  deriveResultFields,
  getFailureReason,
  inferFitStatus,
  median,
  runStats,
} from "../dist/resultCore.js";

function item() {
  return {
    id: "qwen3.5-9b-q4km__ctx16384_q8",
    label: "Qwen3.5-9B Q4_K_M @ ctx=16384_kv=q8_0",
    model: "Qwen3.5-9B",
    variant: "Q4_K_M",
    series: "qwen",
    level: "high",
    sweep: "context",
    reasoning_mode: "default",
    template_note: null,
    gguf_context_length: 131072,
    gguf_architecture: "qwen3",
    model_path: "C:\\models\\qwen.gguf",
    mmproj_path: null,
    extra_args: "--ctx-size 16384 --gpu-layers 99 --cache-type-k q8_0",
  };
}

function cfg() {
  return {
    llama_server_exe: "C:\\llama\\llama-server.exe",
    hardware: { vram_total_mib: 8192 },
    wddm_detection: {
      vram_saturation_threshold: 0.92,
      shared_delta_confirm_mib: 500,
    },
  };
}

function run(i, vramPeak, sharedPeak, promptTps, evalTps) {
  return {
    run_index: i,
    timestamp: `2026-05-16T10:00:0${i}`,
    vram_before_mib: 1200,
    vram_peak_mib: vramPeak,
    vram_baseline_mib: 1200,
    vram_baseline_pct: 0.1465,
    vram_total_peak_mib: vramPeak,
    vram_process_peak_mib: vramPeak - 1200,
    vram_external_peak_mib: 1200,
    shared_peak_mib: sharedPeak,
    load_sec: 6.5,
    ready: true,
    ok: true,
    error: null,
    prompt_n: 80,
    prompt_tps: promptTps,
    eval_n: 128,
    eval_tps: evalTps,
    cpu_model_mib: 0,
    cuda_model_mib: 5200,
    kv_cache_mib: 1024,
    compute_cuda_mib: 360,
    compute_host_mib: 80,
    layers_offloaded: "33/33",
    fit_status: "success",
    ttft_sec: 0.2 + i / 10,
    prompt_ms: 200 + i * 100,
    ttfr_ms: 100 + i * 20,
    e2e_ttft_ms: 180 + i * 60,
    total_request_ms: 3000 + i * 200,
    latency_total_request_ms: 360 + i * 60,
    gpu_power_peak_w: [130, 180, 150][i] ?? 140,
    gpu_temp_peak_c: [60, 72, 65][i] ?? 60,
    gpu_util_avg_pct: [60, 75, 90][i] ?? 70,
    process_sm_peak_pct: [45, 71, 52][i] ?? 45,
    process_mem_peak_pct: [30, 47, 35][i] ?? 30,
    ram_baseline_mib: 12000,
    ram_used_peak_mib: [500, 900, 700][i] ?? 500,
    disk_read_peak_mb_s: [200, 500, 300][i] ?? 200,
  };
}

test("median mirrors PowerShell lower-middle behavior", () => {
  assert.equal(median([42]), 42);
  assert.equal(median([12, 7, 10]), 10);
  assert.equal(median([3, 1, 4, 2]), 2);
  assert.equal(median([null, undefined]), null);
});

test("aggregateBenchResult preserves first run and computes median/peaks", () => {
  const result = aggregateBenchResult({
    item: item(),
    cfg: cfg(),
    runs: [
      run(0, 7000, 30, 410, 46),
      run(1, 7200, 50, 430, 64),
      run(2, 7100, 40, 420, 55),
    ],
    session: {
      bench_session_id: "s1",
      bench_session_started_at: "2026-05-16T10:00:00",
      llama_server_version: "b9999",
    },
  });

  assert.equal(result.vram_peak_mib, 7100);
  assert.equal(result.vram_baseline_mib, 1200);
  assert.equal(result.vram_baseline_pct, 0.1465);
  assert.equal(result.vram_total_peak_mib, 7100);
  assert.equal(result.vram_process_peak_mib, 5900);
  assert.equal(result.vram_external_peak_mib, 1200);
  assert.equal(result.shared_peak_mib, 40);
  assert.equal(result.prompt_tps, 420);
  assert.equal(result.eval_tps, 55);
  assert.equal(result.run_count, 3);
  assert.equal(result.first_eval_tps, 46);
  assert.equal(result.repeat_eval_tps, 55);
  assert.equal(result.eval_spread_pct, 32.7);
  assert.equal(result.process_sm_peak_pct, 71);
  assert.equal(result.process_mem_peak_pct, 47);
  assert.equal(result.gpu_power_peak_w, 180);
  assert.equal(result.gpu_temp_peak_c, 72);
  assert.equal(result.ram_used_peak_mib, 900);
  assert.equal(result.disk_read_peak_mb_s, 500);
  assert.equal(result.bench_session_id, "s1");
  assert.equal(result.llama_server_version, "b9999");
});

test("fit and failure classification match the transitional engine rules", () => {
  assert.equal(inferFitStatus("unknown", true, 40, 500), "success");
  assert.equal(inferFitStatus("unknown", true, 800, 500), "failed_but_running");
  assert.equal(getFailureReason({ ok: true }), null);
  assert.equal(getFailureReason({ ok: false, unsupported_architecture: "qwen-new" }), "unsupported_arch");
  assert.equal(getFailureReason({ ok: false, fit_status: "failed_but_running" }), "vram_overflow");
  assert.equal(getFailureReason({ ok: false, shared_peak_mib: 900 }), "vram_overflow");
  assert.equal(getFailureReason({ ok: false, failure_reason: "process_vram_unavailable", ready: true }), "process_vram_unavailable");
  assert.equal(getFailureReason({ ok: false, ready: false, shared_peak_mib: 0 }), "server_timeout");
  assert.equal(getFailureReason({ ok: false, ready: true, shared_peak_mib: 0 }), "other");
});

test("derived fields and run stats can be reconstructed from existing result JSON", () => {
  const result = {
    prompt_n: 80,
    prompt_tps: 100,
    eval_n: 128,
    eval_tps: 50,
    vram_peak_mib: 2000,
    extra_args: "--ctx-size 16384 --gpu-layers 99",
    runs: [{ eval_tps: 45 }, { eval_tps: 50 }, { eval_tps: 55 }],
  };
  assert.deepEqual(deriveResultFields(result, 8192), {
    time_total_sec: 3.36,
    headroom_mib: 6192,
    ctx_size: 16384,
  });
  assert.deepEqual(runStats(result), {
    run_count: 3,
    first_eval_tps: 45,
    repeat_eval_tps: 50,
    eval_min_tps: 45,
    eval_max_tps: 55,
    eval_spread_pct: 20,
  });
});

test("resultCoreCli reads a JSON-file aggregate payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "calibr-result-core-"));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify({
    action: "aggregate",
    item: item(),
    cfg: cfg(),
    runs: [run(0, 7000, 30, 410, 46), run(1, 7200, 50, 430, 64), run(2, 7100, 40, 420, 55)],
  }), "utf8");

  try {
    const proc = spawnSync(process.execPath, [join(process.cwd(), "dist", "resultCoreCli.js"), "--json-file", payloadPath], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(proc.status, 0);
    const out = JSON.parse(proc.stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.result.eval_tps, 55);
    assert.equal(out.result.first_eval_tps, 46);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resultCoreCli returns bulk report fields for existing result JSONs", () => {
  const dir = mkdtempSync(join(tmpdir(), "calibr-result-fields-"));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify({
    action: "report-fields",
    vramTotalMib: 8192,
    results: [{
      prompt_n: 80,
      prompt_tps: 100,
      eval_n: 128,
      eval_tps: 50,
      vram_peak_mib: 2000,
      extra_args: "--ctx-size 16384 --gpu-layers 99",
      runs: [{ eval_tps: 45 }, { eval_tps: 50 }, { eval_tps: 55 }],
    }],
  }), "utf8");

  try {
    const proc = spawnSync(process.execPath, [join(process.cwd(), "dist", "resultCoreCli.js"), "--json-file", payloadPath], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(proc.status, 0);
    const out = JSON.parse(proc.stdout.trim());
    assert.equal(out.ok, true);
    assert.equal(out.result[0].derived.headroom_mib, 6192);
    assert.equal(out.result[0].run_stats.first_eval_tps, 45);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
