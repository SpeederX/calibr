import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseComputeAppsQuery,
  parseGpuQuery,
  parsePmonQuery,
  parseStandardNvidiaSmi,
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

test("parsePmonQuery detects target process SM and memory utilization", () => {
  const out = [
    "# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command",
    "# Idx           #    C/G      %      %      %      %      %      %    name",
    "    0       1184   C+G      -      -      -      -      -      -    Telegram.exe",
    "    0       1234     C     71     47      -      -      -      -    llama-server.ex",
  ].join("\n");
  assert.deepEqual(parsePmonQuery(out, 1234), {
    process_gpu_active: true,
    process_sm_pct: 71,
    process_mem_pct: 47,
  });
  assert.deepEqual(parsePmonQuery(out, 42), {
    process_gpu_active: false,
    process_sm_pct: -1,
    process_mem_pct: -1,
  });
});
