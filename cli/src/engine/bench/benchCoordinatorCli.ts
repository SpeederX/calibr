import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  runBenchCoordinator,
  stopActiveBenchServers,
  type BenchCoordinatorOutput,
  type BenchCoordinatorPayload,
} from "./benchCoordinator.js";

function failure(error: string): BenchCoordinatorOutput {
  return { ok: false, result: { ok: false, error }, runs: [], error };
}

async function main(): Promise<void> {
  const shutdown = () => {
    stopActiveBenchServers();
    process.exit(130);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const argv = process.argv.slice(2);
  const payloadIndex = argv.indexOf("--json-file");
  const resultIndex = argv.indexOf("--result-file");
  const payloadPath = payloadIndex >= 0 ? argv[payloadIndex + 1] ?? "" : "";
  const resultPath = resultIndex >= 0 ? argv[resultIndex + 1] ?? "" : "";
  if (!payloadPath || !resultPath) {
    process.stderr.write("usage: benchCoordinatorCli --json-file <payload> --result-file <result>\n");
    process.exitCode = 2;
    return;
  }
  let output: BenchCoordinatorOutput;
  try {
    const payload = JSON.parse(await readFile(payloadPath, "utf8")) as BenchCoordinatorPayload;
    output = await runBenchCoordinator(payload);
  } catch (error) {
    output = failure(error instanceof Error ? error.message : String(error));
  }
  await writeFile(resultPath, JSON.stringify(output), "utf8");
  if (!output.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
