import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { calibrateMoe, type MoeCalibrationPayload } from "./moeCalibration.js";

export function validateMoeCalibrationPayload(payload: Partial<MoeCalibrationPayload>): string | null {
  if (!payload.executable) return "missing executable";
  if (!payload.modelPath) return "missing modelPath";
  if (!Array.isArray(payload.baseArgs)) return "baseArgs must be an array";
  if (!Number.isFinite(payload.contextSize) || Number(payload.contextSize) <= 0) return "contextSize must be positive";
  if (!payload.kvType) return "missing kvType";
  if (!Number.isFinite(payload.vramTotalMib) || Number(payload.vramTotalMib) <= 0) return "vramTotalMib must be positive";
  if (!Number.isFinite(payload.safetyFraction) || Number(payload.safetyFraction) <= 0 || Number(payload.safetyFraction) > 1) {
    return "safetyFraction must be within (0, 1]";
  }
  return null;
}

async function main(): Promise<void> {
  const index = process.argv.indexOf("--json-file");
  const file = index >= 0 ? process.argv[index + 1] : "";
  if (!file) {
    process.stdout.write(`${JSON.stringify({ calibrated: false, mode: "fallback", reason: "usage: moeCalibrationCli --json-file <path>" })}\n`);
    process.exitCode = 2;
    return;
  }
  const payload = JSON.parse(await readFile(file, "utf8")) as MoeCalibrationPayload;
  const validation = validateMoeCalibrationPayload(payload);
  if (validation) {
    process.stdout.write(`${JSON.stringify({ calibrated: false, mode: "fallback", reason: validation })}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await calibrateMoe(payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.calibrated) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
