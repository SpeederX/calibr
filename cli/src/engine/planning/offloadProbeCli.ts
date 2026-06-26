import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runLoadProbe, type LoadProbePayload, type LoadProbeResult } from "./offloadProbe.js";

function failure(message: string): LoadProbeResult {
  return {
    requested_layers: 0, offloaded_layers: null, total_layers: null,
    ready: false, load_ms: null, vram_total_mib: 0, vram_safe_cap_mib: 0,
    vram_baseline_mib: null, vram_ready_mib: null, vram_run_mib: null,
    process_vram_ready_mib: null, shared_growth_mib: null,
    cpu_model_mib: null, cuda_model_mib: null, kv_cache_mib: null,
    compute_cuda_mib: null, compute_host_mib: null,
    fit_under_safe_cap: false, stable: false, sample_count: 0,
    stderr: "", error: message,
  };
}

export function validateLoadProbePayload(payload: Partial<LoadProbePayload>): string | null {
  if (!payload.executable) return "missing executable";
  if (!Array.isArray(payload.args)) return "args must be an array";
  if (!payload.baseUrl) return "missing baseUrl";
  if (!Number.isFinite(payload.timeoutMs) || Number(payload.timeoutMs) <= 0) return "timeoutMs must be positive";
  if (!Number.isFinite(payload.requestedLayers) || Number(payload.requestedLayers) < 0) return "requestedLayers must be non-negative";
  if (!Number.isFinite(payload.vramTotalMib) || Number(payload.vramTotalMib) <= 0) return "vramTotalMib must be positive";
  if (!Number.isFinite(payload.safetyFraction) || Number(payload.safetyFraction) <= 0 || Number(payload.safetyFraction) > 1) {
    return "safetyFraction must be within (0, 1]";
  }
  return null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf("--json-file");
  const path = fileIndex >= 0 ? (argv[fileIndex + 1] ?? "") : "";
  if (!path) {
    process.stdout.write(`${JSON.stringify(failure("usage: offloadProbeCli --json-file <path>"))}\n`);
    process.exitCode = 2;
    return;
  }

  let payload: LoadProbePayload;
  try {
    payload = JSON.parse(await readFile(path, "utf8")) as LoadProbePayload;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(error instanceof Error ? error.message : String(error)))}\n`);
    process.exitCode = 2;
    return;
  }
  const validation = validateLoadProbePayload(payload);
  if (validation) {
    process.stdout.write(`${JSON.stringify(failure(validation))}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await runLoadProbe(payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}