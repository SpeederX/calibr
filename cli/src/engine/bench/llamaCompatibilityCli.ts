#!/usr/bin/env node
import { inspectLlamaServer } from "./llamaCompatibility.js";

const executable = process.argv[2];
if (!executable) {
  console.error("usage: llamaCompatibilityCli <llama-server>");
  process.exit(2);
}

const result = inspectLlamaServer(executable);
process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
