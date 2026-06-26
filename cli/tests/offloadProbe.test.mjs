import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { memorySamplesStable, runLoadProbe } from "../dist/engine/planning/offloadProbe.js";
import { validateLoadProbePayload } from "../dist/engine/planning/offloadProbeCli.js";

function metric(gpu, shared = 100, processVram = 3000) {
  return {
    at: new Date().toISOString(), gpu_mem_mib: gpu, gpu_power_w: 20,
    gpu_temp_c: 40, gpu_util_pct: 0, cpu_util_pct: 10,
    process_vram_mib: processVram, shared_mib: shared,
    ram_avail_mib: 10000, disk_read_mb_s: 0,
  };
}

function fakeChild(stderrText) {
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.stderr = new PassThrough();
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
  queueMicrotask(() => child.stderr.write(stderrText));
  return child;
}

const stderr = [
  "llama_model_load: CPU model buffer size = 1200.00 MiB",
  "llama_model_load: CUDA0 model buffer size = 5000.00 MiB",
  "llama_kv_cache: CUDA0 KV buffer size = 512.00 MiB",
  "llama_context: CUDA0 compute buffer size = 256.00 MiB",
  "llama_context: CUDA_Host compute buffer size = 64.00 MiB",
  "load_tensors: offloaded 20/40 layers to GPU",
  "common_init_result: successfully fit params to device memory",
].join("\n");

test("memorySamplesStable requires the requested tail window within tolerance", () => {
  assert.equal(memorySamplesStable([metric(5000), metric(5008)], 3, 16), false);
  assert.equal(memorySamplesStable([metric(4900), metric(5000), metric(5008), metric(4998)], 3, 16), true);
  assert.equal(memorySamplesStable([metric(5000), metric(5030), metric(5008)], 3, 16), false);
});

test("runLoadProbe records stable allocation without generating tokens", async () => {
  const samples = [metric(800, 100, -1), metric(6500, 120), metric(6508, 122), metric(6504, 121)];
  let stopped = false;
  const result = await runLoadProbe({
    executable: "llama-server", args: ["-m", "model.gguf", "--gpu-layers", "20"],
    baseUrl: "http://127.0.0.1:18080", timeoutMs: 1000,
    requestedLayers: 20, vramTotalMib: 8192, safetyFraction: 0.95,
    stableSampleCount: 3, stableToleranceMib: 16,
  }, {
    spawnServer: () => fakeChild(stderr),
    waitReady: async () => ({ ready: true, loadMs: 42000, reason: "ready" }),
    collectSample: async () => samples.shift() ?? metric(6504, 121),
    stopServer: () => { stopped = true; },
    sleep: async () => {},
  });

  assert.equal(stopped, true);
  assert.equal(result.ready, true);
  assert.equal(result.offloaded_layers, 20);
  assert.equal(result.total_layers, 40);
  assert.equal(result.vram_baseline_mib, 800);
  assert.equal(result.vram_ready_mib, 6508);
  assert.equal(result.vram_run_mib, 5708);
  assert.equal(result.shared_growth_mib, 22);
  assert.equal(result.cuda_model_mib, 5000);
  assert.equal(result.kv_cache_mib, 512);
  assert.equal(result.compute_cuda_mib, 256);
  assert.equal(result.stable, true);
  assert.equal(result.sample_count, 3);
  assert.equal(result.fit_under_safe_cap, true);
  assert.equal(result.error, null);
});

test("runLoadProbe rejects a ready allocation above the dedicated VRAM safe cap", async () => {
  const samples = [metric(900, 100, -1), metric(7900, 700), metric(7902, 710), metric(7901, 705)];
  const result = await runLoadProbe({
    executable: "llama-server", args: [], baseUrl: "http://127.0.0.1:18080",
    timeoutMs: 1000, requestedLayers: 24, vramTotalMib: 8192,
    safetyFraction: 0.95, sharedConfirmMib: 500,
  }, {
    spawnServer: () => fakeChild(stderr),
    waitReady: async () => ({ ready: true, loadMs: 100, reason: "ready" }),
    collectSample: async () => samples.shift() ?? metric(7901, 705),
    stopServer: () => {}, sleep: async () => {},
  });
  assert.equal(result.vram_safe_cap_mib, 7782);
  assert.equal(result.shared_growth_mib, 610);
  assert.equal(result.fit_under_safe_cap, false);
});

test("runLoadProbe keeps intentional CPU-offload shared memory diagnostic", async () => {
  const samples = [metric(900, 100, -1), metric(6500, 3700), metric(6502, 3710), metric(6501, 3705)];
  const result = await runLoadProbe({
    executable: "llama-server", args: [], baseUrl: "http://127.0.0.1:18080",
    timeoutMs: 1000, requestedLayers: 12, vramTotalMib: 8192,
    safetyFraction: 0.95, sharedConfirmMib: 500,
  }, {
    spawnServer: () => fakeChild(stderr),
    waitReady: async () => ({ ready: true, loadMs: 100, reason: "ready" }),
    collectSample: async () => samples.shift() ?? metric(6501, 3705),
    stopServer: () => {}, sleep: async () => {},
  });
  assert.equal(result.shared_growth_mib, 3610);
  assert.equal(result.fit_under_safe_cap, true);
});

test("runLoadProbe reports readiness failure and still stops the process", async () => {
  let stopped = false;
  const result = await runLoadProbe({
    executable: "llama-server", args: [], baseUrl: "http://127.0.0.1:18080",
    timeoutMs: 1000, requestedLayers: 10, vramTotalMib: 8192, safetyFraction: 0.95,
  }, {
    spawnServer: () => fakeChild("failed to fit params"),
    waitReady: async () => ({ ready: false, loadMs: 1000, reason: "exited" }),
    collectSample: async () => metric(700),
    stopServer: () => { stopped = true; }, sleep: async () => {},
  });
  assert.equal(stopped, true);
  assert.equal(result.ready, false);
  assert.equal(result.fit_under_safe_cap, false);
  assert.match(result.error, /did not become ready.*exited/);
});
test("validateLoadProbePayload rejects incomplete and unsafe contracts", () => {
  assert.equal(validateLoadProbePayload({}), "missing executable");
  assert.equal(validateLoadProbePayload({
    executable: "llama-server", args: [], baseUrl: "http://127.0.0.1:1",
    timeoutMs: 1000, requestedLayers: 1, vramTotalMib: 8192, safetyFraction: 1.2,
  }), "safetyFraction must be within (0, 1]");
  assert.equal(validateLoadProbePayload({
    executable: "llama-server", args: [], baseUrl: "http://127.0.0.1:1",
    timeoutMs: 1000, requestedLayers: 1, vramTotalMib: 8192, safetyFraction: 0.95,
  }), null);
});
