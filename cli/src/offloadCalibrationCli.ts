import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { calibrateOffload, type OffloadCalibrationPayload, type OffloadCalibrationResult } from "./offloadCalibration.js";

function failure(message: string): OffloadCalibrationResult {
  return {
    mode: "fallback", calibrated: false, block_count: 0,
    baseline_vram_mib: null, safe_cap_mib: 0, available_mib: 0,
    structural_estimate_layers: 0, predicted_fit_layers: 0,
    verified_fit_layers: null, first_spill_layers: null,
    benchmark_layers: [], probe_count: 0, probes: [], reason: message,
  };
}

export function validateOffloadCalibrationPayload(payload: Partial<OffloadCalibrationPayload>): string | null {
  if (!payload.executable) return "missing executable";
  if (!payload.modelPath) return "missing modelPath";
  if (!Array.isArray(payload.baseArgs)) return "baseArgs must be an array";
  if (!Number.isFinite(payload.contextSize) || Number(payload.contextSize) <= 0) return "contextSize must be positive";
  if (!payload.kvType) return "missing kvType";
  if (!Number.isFinite(payload.timeoutMs) || Number(payload.timeoutMs) <= 0) return "timeoutMs must be positive";
  if (!Number.isFinite(payload.vramTotalMib) || Number(payload.vramTotalMib) <= 0) return "vramTotalMib must be positive";
  if (!Number.isFinite(payload.safetyFraction) || Number(payload.safetyFraction) <= 0 || Number(payload.safetyFraction) > 1) {
    return "safetyFraction must be within (0, 1]";
  }
  if (!payload.metadata || !Number.isFinite(payload.metadata.gguf_block_count) || Number(payload.metadata.gguf_block_count) <= 0) {
    return "metadata.gguf_block_count must be positive";
  }
  return null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf("--json-file");
  const path = fileIndex >= 0 ? (argv[fileIndex + 1] ?? "") : "";
  if (!path) {
    process.stdout.write(`${JSON.stringify(failure("usage: offloadCalibrationCli --json-file <path>"))}\n`);
    process.exitCode = 2;
    return;
  }
  let payload: OffloadCalibrationPayload;
  try {
    payload = JSON.parse(await readFile(path, "utf8")) as OffloadCalibrationPayload;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failure(error instanceof Error ? error.message : String(error)))}\n`);
    process.exitCode = 2;
    return;
  }
  const validation = validateOffloadCalibrationPayload(payload);
  if (validation) {
    process.stdout.write(`${JSON.stringify(failure(validation))}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await calibrateOffload(payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.calibrated) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();