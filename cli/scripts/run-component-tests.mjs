import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const testsDir = join(process.cwd(), "tests");
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("tests", name));

if (files.length === 0) {
  console.error("No component tests found under cli/tests/*.test.mjs");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: process.cwd(),
  stdio: "inherit",
});

process.exit(result.status ?? 1);
