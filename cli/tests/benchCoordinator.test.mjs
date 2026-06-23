import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrateGpuEnergyWh, runBenchCoordinator } from "../dist/benchCoordinator.js";

function child() {
  const proc = new EventEmitter();
  proc.pid = 1234;
  proc.exitCode = null;
  proc.stderr = new PassThrough();
  proc.kill = () => {
    proc.exitCode = 0;
    proc.emit("exit", 0);
    return true;
  };
  return proc;
}

const testCapabilities = {
  executable: "llama-server",
  version: "test",
  options: [
    "-m", "--ctx-size", "--port", "--host", "--no-warmup",
    "--cache-ram", "--slot-save-path",
  ],
  cacheTypesK: [],
  cacheTypesV: [],
  helpExitCode: 0,
  ok: true,
  error: null,
};

test("integrateGpuEnergyWh integrates sampled board power across elapsed time", () => {
  const wh = integrateGpuEnergyWh([
    { elapsed_ms: 0, gpu_power_w: 100 },
    { elapsed_ms: 1_000, gpu_power_w: 200 },
    { elapsed_ms: 2_000, gpu_power_w: 100 },
  ]);
  assert.equal(wh, 300 / 3600);
});

test("integrateGpuEnergyWh extends final sampled power to the run end", () => {
  const wh = integrateGpuEnergyWh([
    { elapsed_ms: 0, gpu_power_w: 50 },
    { elapsed_ms: 1_000, gpu_power_w: 50 },
  ], 2_000);
  assert.equal(wh, 100 / 3600);
});

test("runBenchCoordinator repeats runs and aggregates in one process", async () => {
  const root = mkdtempSync(join(tmpdir(), "calibr-coordinator-"));
  let httpCalls = 0;
  try {
    const out = await runBenchCoordinator({
      item: {
        id: "x",
        model: "X",
        model_path: "x.gguf",
        extra_args: "--ctx-size 16",
      },
      cfg: {
        llama_server_exe: "llama-server",
        hardware: { vram_total_mib: 8192 },
        wddm_detection: { vram_saturation_threshold: 0.92, shared_delta_confirm_mib: 500 },
        bench: { prompt: "hi", n_predict: 8, port: 18080, wait_sec_ready: 1, warmup: true },
      },
      runs: 2,
      minimalPolling: false,
      eventFile: join(root, "events.log"),
      logFile: join(root, "bench.log"),
    }, {
      inspectLlama: () => testCapabilities,
      spawnServer: () => child(),
      waitReady: async () => ({ ready: true, loadMs: 100, reason: "ready" }),
      collectSample: async () => ({
        at: new Date().toISOString(),
        gpu_mem_mib: 4000,
        gpu_power_w: 100,
        gpu_temp_c: 50,
        gpu_util_pct: 75,
        cpu_util_pct: 30,
        process_vram_mib: 3000,
        shared_mib: -1,
        ram_avail_mib: 10000,
        disk_read_mb_s: 0,
      }),
      runHttp: async (_payload, hooks) => {
        httpCalls++;
        hooks.onPhase?.("latency_prompt");
        hooks.onStreamEvent?.({ at_ms: 10, index: 1, kind: "reasoning", timings: { predicted_n: 1, predicted_ms: 10 } });
        hooks.onStreamEvent?.({ at_ms: 30, index: 2, kind: "answer", timings: { predicted_n: 2, predicted_ms: 30 }, delivery_gap_ms: 20 });
        return {
          ok: true,
          status: 200,
          total_request_ms: 1000,
          timings: {
            prompt_n: 10,
            prompt_per_second: 100,
            prompt_ms: 100,
            predicted_n: 8,
            predicted_per_second: httpCalls === 1 ? 40 : 50,
            predicted_ms: 200,
          },
          ttfr_ms: 80,
          e2e_ttft_ms: 90,
          latency_total_request_ms: 300,
        };
      },
      sleep: async () => {},
    });

    assert.equal(out.ok, true);
    assert.equal(out.runs.length, 2);
    assert.equal(out.result.run_count, 2);
    assert.equal(out.result.eval_tps, 40);
    assert.equal(httpCalls, 2);
    const tokenPoints = out.runs[0].telemetry.filter(point => point.event_index != null);
    assert.equal(tokenPoints.length, 2);
    assert.equal(tokenPoints[0].phase, "latency_reasoning");
    assert.equal(tokenPoints[1].phase, "latency_answer");
    assert.equal(tokenPoints[1].event_index, 2);
    assert.equal(tokenPoints[1].server_tps, 50);
    assert.equal(tokenPoints[1].delivery_gap_ms, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBenchCoordinator retries a failed measured run without aggregating failed attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "calibr-coordinator-fail-"));
  let httpCalls = 0;
  try {
    const out = await runBenchCoordinator({
      item: { id: "x", model: "X", model_path: "x.gguf" },
      cfg: {
        llama_server_exe: "llama-server",
        hardware: { vram_total_mib: 8192 },
        wddm_detection: { shared_delta_confirm_mib: 500 },
        bench: { prompt: "hi", n_predict: 8, port: 18080, wait_sec_ready: 1 },
      },
      runs: 3,
      minimalPolling: true,
      eventFile: join(root, "events.log"),
      logFile: join(root, "bench.log"),
    }, {
      inspectLlama: () => testCapabilities,
      spawnServer: () => child(),
      waitReady: async () => ({ ready: true, loadMs: 100, reason: "ready" }),
      collectSample: async () => ({
        at: new Date().toISOString(),
        gpu_mem_mib: 4000,
        gpu_power_w: 100,
        gpu_temp_c: 50,
        gpu_util_pct: 75,
        cpu_util_pct: 30,
        process_vram_mib: 3000,
        shared_mib: -1,
        ram_avail_mib: 10000,
        disk_read_mb_s: 0,
      }),
      runHttp: async () => {
        httpCalls++;
        return {
          ok: false,
          status: 500,
          total_request_ms: 10,
          timings: null,
          ttfr_ms: null,
          e2e_ttft_ms: null,
          latency_total_request_ms: null,
          error: "boom",
        };
      },
      sleep: async () => {},
    });
    assert.equal(out.ok, false);
    assert.equal(out.runs.length, 0);
    assert.equal(out.attempts.length, 3);
    assert.equal(httpCalls, 3);
    assert.equal(out.failure?.cause, "unknown");
    assert.equal(out.failure?.retry_exhausted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBenchCoordinator rejects unsupported sweep arguments before spawning llama-server", async () => {
  const root = mkdtempSync(join(tmpdir(), "calibr-coordinator-compat-"));
  let spawned = false;
  try {
    const out = await runBenchCoordinator({
      item: {
        id: "x",
        model: "X",
        model_path: "x.gguf",
        extra_args: "--ctx-size 16 --n-cpu-moe 4",
      },
      cfg: {
        llama_server_exe: "llama-server",
        bench: { port: 18080 },
      },
      runs: 1,
      eventFile: join(root, "events.log"),
      logFile: join(root, "bench.log"),
    }, {
      inspectLlama: () => ({
        ...testCapabilities,
        options: testCapabilities.options.filter((option) => option !== "--n-cpu-moe"),
      }),
      spawnServer: () => {
        spawned = true;
        return child();
      },
    });
    assert.equal(out.ok, false);
    assert.equal(spawned, false);
    assert.equal(out.result.failure_reason, "unsupported_argument");
    assert.match(out.error, /--n-cpu-moe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
