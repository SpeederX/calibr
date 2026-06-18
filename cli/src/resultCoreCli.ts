import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  aggregateBenchResult,
  buildReportRows,
  deriveResultFields,
  finalizeBenchRun,
  getFailureReason,
  runStats,
} from "./resultCore.js";

type ResultCoreAction = "aggregate" | "finalize-run" | "derive" | "failure" | "run-stats" | "report-fields";

interface ResultCorePayload {
  action: ResultCoreAction;
  item?: unknown;
  cfg?: unknown;
  runs?: unknown;
  run?: unknown;
  stderr?: string;
  result?: Record<string, unknown>;
  results?: Array<Record<string, unknown>>;
  vramTotalMib?: number;
  sharedConfirmMib?: number;
  session?: unknown;
}

function failure(error: string): Record<string, unknown> {
  return { ok: false, error };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function readPayload(): Promise<string> {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf("--json");
  const jsonFileIdx = argv.indexOf("--json-file");
  if (jsonIdx >= 0) return argv[jsonIdx + 1] ?? "";
  if (jsonFileIdx >= 0) return readFile(argv[jsonFileIdx + 1] ?? "", "utf8");
  return readStdin();
}

function handle(payload: ResultCorePayload): Record<string, unknown> {
  if (payload.action === "aggregate") {
    if (!payload.item || !payload.cfg || !Array.isArray(payload.runs)) {
      return failure("aggregate requires item, cfg, and runs[]");
    }
    return {
      ok: true,
      result: aggregateBenchResult({
        item: payload.item as never,
        cfg: payload.cfg as never,
        runs: payload.runs as never,
        session: payload.session as never,
      }),
    };
  }
  if (payload.action === "finalize-run") {
    if (!payload.run || !payload.cfg || typeof payload.stderr !== "string") {
      return failure("finalize-run requires run, cfg, and stderr");
    }
    return {
      ok: true,
      result: finalizeBenchRun({
        run: payload.run as never,
        cfg: payload.cfg as never,
        stderr: payload.stderr,
      }),
    };
  }
  if (payload.action === "derive") {
    if (!payload.result) return failure("derive requires result");
    return {
      ok: true,
      result: deriveResultFields(payload.result, payload.vramTotalMib ?? 0),
    };
  }
  if (payload.action === "failure") {
    if (!payload.result) return failure("failure requires result");
    return {
      ok: true,
      result: getFailureReason(payload.result, payload.sharedConfirmMib ?? 500),
    };
  }
  if (payload.action === "run-stats") {
    if (!payload.result) return failure("run-stats requires result");
    return {
      ok: true,
      result: runStats(payload.result),
    };
  }
  if (payload.action === "report-fields") {
    if (!Array.isArray(payload.results)) return failure("report-fields requires results[]");
    return {
      ok: true,
      result: buildReportRows(payload.results, payload.vramTotalMib ?? 0),
    };
  }
  return failure(`unknown action: ${String(payload.action)}`);
}

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = await readPayload();
  } catch (error) {
    process.stdout.write(JSON.stringify(failure(`could not read payload: ${error instanceof Error ? error.message : String(error)}`)) + "\n");
    return;
  }

  let payload: ResultCorePayload;
  try {
    payload = JSON.parse(raw) as ResultCorePayload;
  } catch {
    process.stdout.write(JSON.stringify(failure("invalid payload json")) + "\n");
    return;
  }

  try {
    process.stdout.write(JSON.stringify(handle(payload)) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify(failure(error instanceof Error ? error.message : String(error))) + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
