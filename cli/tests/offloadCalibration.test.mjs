import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOffloadProbeArgs, calibrateOffload } from "../dist/offloadCalibration.js";
import { validateOffloadCalibrationPayload } from "../dist/offloadCalibrationCli.js";

const MiB = 1024 * 1024;
const metric = (gpu = 500) => ({
  at: new Date().toISOString(), gpu_mem_mib: gpu, gpu_power_w: 0,
  gpu_temp_c: 0, gpu_util_pct: 0, cpu_util_pct: 0,
  process_vram_mib: -1, shared_mib: 100, ram_avail_mib: 10000, disk_read_mb_s: 0,
});

function payload(blockCount = 40) {
  return {
    executable: "llama-server", modelPath: "model.gguf", mmprojPath: null,
    baseArgs: ["--flash-attn", "auto", "--gpu-layers", "99", "--ctx-size", "4096", "--cache-ram", "128"],
    contextSize: 16384, kvType: "q8_0", timeoutMs: 1000,
    vramTotalMib: 8192, safetyFraction: 0.95, sharedConfirmMib: 500,
    metadata: {
      size_mib: blockCount * 200 + 500,
      gguf_block_count: blockCount,
      gguf_global_tensor_bytes: 500 * MiB,
      gguf_block_tensor_bytes: Array.from({ length: blockCount }, (_, block) => ({ block, bytes: 200 * MiB })),
    },
    planning: { runtimeReserveMib: 512, maxProbeCount: 4 },
  };
}

function probeResult(requested, fit, actual = requested) {
  return {
    requested_layers: requested, offloaded_layers: actual, total_layers: 40,
    ready: fit, load_ms: 100, vram_total_mib: 8192, vram_safe_cap_mib: 7782,
    vram_baseline_mib: 500, vram_ready_mib: fit ? 500 + requested * 250 : null,
    vram_run_mib: fit ? requested * 250 : null, process_vram_ready_mib: null,
    shared_growth_mib: fit ? 0 : null, cpu_model_mib: null,
    cuda_model_mib: null, kv_cache_mib: null, compute_cuda_mib: null,
    compute_host_mib: null, fit_under_safe_cap: fit, stable: fit,
    sample_count: fit ? 3 : 0, stderr: "", error: fit ? null : "exited",
  };
}

test("buildOffloadProbeArgs forces the calibrated allocation contract", () => {
  const args = buildOffloadProbeArgs({ ...payload(), mmprojPath: "mmproj.gguf", mmprojMib: 800 }, 17, 19001);
  assert.equal(args.filter((arg) => arg === "--gpu-layers").length, 1);
  assert.equal(args[args.indexOf("--gpu-layers") + 1], "17");
  assert.equal(args[args.indexOf("--ctx-size") + 1], "16384");
  assert.equal(args[args.indexOf("--fit") + 1], "off");
  assert.equal(args[args.indexOf("--cache-ram") + 1], "0");
  assert.ok(args.includes("--no-warmup"));
  assert.ok(args.includes("mmproj.gguf"));
});

test("calibrateOffload returns context mode when full offload is verified", async () => {
  const p = payload(4);
  p.metadata.size_mib = 1300;
  p.metadata.gguf_global_tensor_bytes = 500 * MiB;
  p.metadata.gguf_block_tensor_bytes = Array.from({ length: 4 }, (_, block) => ({ block, bytes: 200 * MiB }));
  const seen = [];
  const result = await calibrateOffload(p, {
    collectBaseline: async () => metric(500), findPort: async () => 19001,
    runProbe: async (request) => { seen.push(request.requestedLayers); return { ...probeResult(request.requestedLayers, true), total_layers: 4, offloaded_layers: request.requestedLayers }; },
  });
  assert.deepEqual(seen, [4]);
  assert.equal(result.mode, "context");
  assert.equal(result.verified_fit_layers, 4);
  assert.equal(result.calibrated, true);
});

test("calibrateOffload brackets a partial fit and returns dense candidates", async () => {
  const seen = [];
  const progress = [];
  const result = await calibrateOffload(payload(), {
    collectBaseline: async () => metric(500),
    findPort: async () => 19001 + seen.length,
    onProbe: (event) => progress.push(event),
    runProbe: async (request) => {
      seen.push(request.requestedLayers);
      return probeResult(request.requestedLayers, request.requestedLayers <= 19);
    },
  });
  assert.deepEqual(seen, [31, 15, 23, 19]);
  assert.equal(result.mode, "offload");
  assert.equal(result.verified_fit_layers, 19);
  assert.equal(result.first_spill_layers, 23);
  assert.deepEqual(result.benchmark_layers, [13, 16, 18, 19, 20, 22]);
  assert.equal(result.probe_count, 4);
  assert.equal(progress.length, 8);
  assert.deepEqual(progress.filter((event) => !event.result).map((event) => event.requestedLayers), seen);
  assert.equal(progress.at(-1).result.fit_under_safe_cap, true);
});

test("calibrateOffload falls back when no safe probe is verified", async () => {
  const result = await calibrateOffload({ ...payload(), planning: { maxProbeCount: 2 } }, {
    collectBaseline: async () => metric(500), findPort: async () => 19001,
    runProbe: async (request) => probeResult(request.requestedLayers, false),
  });
  assert.equal(result.mode, "fallback");
  assert.equal(result.calibrated, false);
  assert.equal(result.verified_fit_layers, null);
  assert.equal(result.probe_count, 2);
});
test("validateOffloadCalibrationPayload rejects incomplete contracts", () => {
  assert.equal(validateOffloadCalibrationPayload({}), "missing executable");
  assert.equal(validateOffloadCalibrationPayload(payload()), null);
});
