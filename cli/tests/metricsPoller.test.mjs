import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseComputeAppsQuery,
  parseGpuQuery,
  parseStandardNvidiaSmi,
  parseTypeperfGpuProcessMemory,
} from "../dist/metricsPoller.js";

test("parseGpuQuery reads nvidia-smi GPU metrics", () => {
  assert.deepEqual(parseGpuQuery("4668, 117.25, 48, 20\n"), {
    gpu_mem_mib: 4668,
    gpu_power_w: 117.25,
    gpu_temp_c: 48,
    gpu_util_pct: 20,
  });
});

test("parseComputeAppsQuery sums matching PID memory", () => {
  const out = [
    "1234, C:\\fake\\llama-server.exe, 2048",
    "9999, C:\\fake\\other.exe, 100",
    "1234, C:\\fake\\llama-server.exe, 512",
  ].join("\n");
  assert.equal(parseComputeAppsQuery(out, 1234), 2560);
  assert.equal(parseComputeAppsQuery(out, 42), -1);
});

test("parseStandardNvidiaSmi falls back to llama-server rows for the target PID", () => {
  const out = `
|    0   N/A  N/A      1234    C+G   C:\\fake\\llama-server.exe       N/A      3150MiB |
|    0   N/A  N/A      12345   C+G   C:\\fake\\not-llama.exe          N/A      7777MiB |
|    0   N/A  N/A      9999    C+G   C:\\fake\\llama-server.exe       N/A      100MiB |
`;
  assert.equal(parseStandardNvidiaSmi(out, 1234), 3150);
  assert.equal(parseStandardNvidiaSmi(out, 123), -1);
});

test("parseTypeperfGpuProcessMemory sums WDDM GPU Process Memory rows for the target PID", () => {
  const out = [
    '"(PDH-CSV 4.0)","\\\\DESKTOP\\GPU Process Memory(pid_1234_luid_0x00000000_0x00000000_phys_0_eng_0_engtype_3D)\\Dedicated Usage","\\\\DESKTOP\\GPU Process Memory(pid_9999_luid_0x00000000_0x00000000_phys_0_eng_0_engtype_3D)\\Dedicated Usage","\\\\DESKTOP\\GPU Process Memory(pid_1234_luid_0x00000000_0x00000001_phys_0_eng_0_engtype_Compute)\\Dedicated Usage"',
    '"06/17/2026 18:05:52.215","1048576.000000","999.000000","2097152.000000"',
  ].join("\n");
  assert.equal(parseTypeperfGpuProcessMemory(out, 1234), 3);
  assert.equal(parseTypeperfGpuProcessMemory(out, 42), -1);
});
