import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  superviseServer,
  type ServerLifecyclePayload,
  type ServerLifecycleStatus,
} from "./serverLifecycle.js";

function failure(message: string): ServerLifecycleStatus {
  return {
    state: "error",
    supervisorPid: process.pid,
    serverPid: null,
    startedAt: new Date().toISOString(),
    loadMs: null,
    exitCode: null,
    error: message,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf("--json-file");
  const path = fileIndex >= 0 ? (argv[fileIndex + 1] ?? "") : "";
  if (!path) {
    process.stdout.write(JSON.stringify(failure("usage: serverLifecycleCli --json-file <path>")) + "\n");
    process.exitCode = 2;
    return;
  }

  let payload: ServerLifecyclePayload;
  try {
    payload = JSON.parse(await readFile(path, "utf8")) as ServerLifecyclePayload;
  } catch (error) {
    process.stdout.write(JSON.stringify(failure(error instanceof Error ? error.message : String(error))) + "\n");
    process.exitCode = 2;
    return;
  }

  const result = await superviseServer(payload);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.state === "error") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
