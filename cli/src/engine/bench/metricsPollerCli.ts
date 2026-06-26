import { pathToFileURL } from "node:url";
import { startMetricPoller } from "./metricsPoller.js";

interface Args {
  pid: number;
  outFile: string;
  intervalMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? (argv[idx + 1] ?? "") : "";
  };
  return {
    pid: Number(get("--pid")),
    outFile: get("--out-file"),
    intervalMs: Number(get("--interval-ms") || 150),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.pid) || args.pid <= 0 || !args.outFile) {
    process.stderr.write("usage: metricsPollerCli --pid <pid> --out-file <path> [--interval-ms 150]\n");
    process.exitCode = 2;
    return;
  }

  const stop = startMetricPoller(args);
  const shutdown = () => {
    stop();
    setTimeout(() => process.exit(0), 20).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive; sampling is scheduled by startMetricPoller.
  setInterval(() => undefined, 60_000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
