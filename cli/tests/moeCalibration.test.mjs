import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMoeBenchmarkCandidates,
  buildMoeProbeArgs,
  calibrateMoe,
  estimateInitialCpuMoe,
} from "../dist/engine/planning/moeCalibration.js";
import { validateMoeCalibrationPayload } from "../dist/engine/planning/moeCalibrationCli.js";

const metadata = {
  size_mib: 6000,
  gguf_block_count: 6,
  gguf_tensor_bytes: 6 * 1024 * 1024 * 1024,
  gguf_global_tensor_bytes: 512 * 1024 * 1024,
  gguf_expert_tensor_bytes: 4.5 * 1024 * 1024 * 1024,
  gguf_block_tensor_bytes: Array.from({ length: 6 }, (_, block) => ({
    block, bytes: 900 * 1024 * 1024, expert_bytes: 768 * 1024 * 1024,
  })),
};

const metric = (gpu_mem_mib) => ({
  at_ms: 0, gpu_mem_mib, process_vram_mib: null, shared_mib: 0,
  gpu_power_w: 0, gpu_temp_c: 0, gpu_util_pct: 0,
  cpu_util_pct: 0, ram_available_mib: 0, disk_read_bytes_sec: 0,
});

function probeResult(requested, vram, fit) {
  return {
    requested_layers: requested, offloaded_layers: null, total_layers: null,
    ready: true, load_ms: 10, vram_total_mib: 8192, vram_safe_cap_mib: 7782,
    vram_baseline_mib: 500, vram_ready_mib: vram, vram_run_mib: vram - 500,
    process_vram_ready_mib: null, shared_growth_mib: 0,
    cpu_model_mib: null, cuda_model_mib: null, kv_cache_mib: null,
    compute_cuda_mib: null, compute_host_mib: null, fit_under_safe_cap: fit,
    stable: true, sample_count: 3, stderr: "", error: null,
  };
}

test("estimateInitialCpuMoe moves the first expert blocks until the structural budget fits", () => {
  const result = estimateInitialCpuMoe(metadata, 4096, 512);
  assert.equal(result.expertBlockCount, 6);
  assert.equal(result.nCpuMoe, 4);
});

test("buildMoeProbeArgs forces exact n-cpu-moe allocation without inference helpers", () => {
  const args = buildMoeProbeArgs({
    executable: "llama-server", modelPath: "model.gguf",
    baseArgs: ["--gpu-layers", "auto", "--n-cpu-moe", "2", "--parallel", "1"],
    contextSize: 16384, kvType: "q8_0", timeoutMs: 1000,
    vramTotalMib: 8192, safetyFraction: 0.95, metadata,
  }, 4, 18080);
  assert.equal(args.filter((arg) => arg === "--n-cpu-moe").length, 1);
  assert.equal(args[args.indexOf("--n-cpu-moe") + 1], "4");
  assert.equal(args[args.indexOf("--fit") + 1], "off");
  assert.ok(args.includes("--no-warmup"));
});

test("buildMoeBenchmarkCandidates covers the load anchor and CPU-heavy performance region", () => {
  assert.deepEqual(
    buildMoeBenchmarkCandidates(0, 31),
    [0, 1, 3, 16, 23, 28, 30, 31],
  );
  assert.deepEqual(
    buildMoeBenchmarkCandidates(13, 40),
    [10, 12, 13, 14, 16, 20, 30, 37, 39, 40],
  );
});

test("calibrateMoe returns the load-fit anchor and a broad performance sweep", async () => {
  const seen = [];
  const progress = [];
  const result = await calibrateMoe({
    executable: "llama-server", modelPath: "model.gguf", baseArgs: [],
    contextSize: 16384, kvType: "q8_0", timeoutMs: 1000,
    vramTotalMib: 8192, safetyFraction: 0.95, metadata,
    planning: { maxProbeCount: 4 },
  }, {
    collectBaseline: async () => metric(500),
    findPort: async () => 18080 + seen.length,
    onProbe: (event) => progress.push(event),
    runProbe: async (payload) => {
      const gpuExperts = payload.requestedLayers;
      seen.push(gpuExperts);
      return probeResult(gpuExperts, 3500 + gpuExperts * 800, gpuExperts <= 5);
    },
  });
  assert.equal(result.calibrated, true);
  assert.equal(result.verified_n_cpu_moe, 1);
  assert.ok(result.benchmark_n_cpu_moe.includes(1));
  assert.ok(result.benchmark_n_cpu_moe.includes(0));
  assert.ok(result.benchmark_n_cpu_moe.includes(6));
  assert.equal(progress.length, seen.length * 2);
  assert.deepEqual(progress.filter((event) => !event.result).map((event) => event.expertGpuLayers), seen);
});

test("validateMoeCalibrationPayload rejects unsafe contracts", () => {
  assert.equal(validateMoeCalibrationPayload({}), "missing executable");
});
