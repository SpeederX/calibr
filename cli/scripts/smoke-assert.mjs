// Assertions run from inside a temp dir where `calibr` is installed via
// the tarball produced by `npm pack`. Imported by smoke-install.js;
// can also be run directly: `cd <tempdir> && node smoke-assert.mjs`.
//
// Asserts that the bundled install path is fully wired:
//   - findEngineLocation() picks the bundled engine, not a walk-up match
//   - calibr.ps1 + config.default.json exist where the CLI expects them
//   - the data dir resolves to %LOCALAPPDATA%\calibr
//   - readStatus() loads the bundled default config (catalog/plan empty)
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const mod = await import("calibr/dist/engine.js");

check("CALIBR_BUNDLED is true", mod.CALIBR_BUNDLED === true, `got ${mod.CALIBR_BUNDLED}`);

check(
  "engine root is inside node_modules/calibr/engine",
  mod.CALIBR_ROOT.replace(/\\/g, "/").endsWith("node_modules/calibr/engine"),
  mod.CALIBR_ROOT,
);

check("calibr.ps1 exists at engine root", existsSync(mod.CALIBR_PS1), mod.CALIBR_PS1);
check(
  "calibr.ps1 looks non-trivial (>1 KB)",
  existsSync(mod.CALIBR_PS1) && statSync(mod.CALIBR_PS1).size > 1024,
);
check("config.default.json exists", existsSync(mod.CALIBR_DEFAULT_CFG), mod.CALIBR_DEFAULT_CFG);

const expectedDataRoot = (process.env.LOCALAPPDATA || process.env.APPDATA || process.env.USERPROFILE || "");
check(
  "data dir resolves under the user's local app data",
  expectedDataRoot.length > 0 && mod.CALIBR_DATA_DIR.startsWith(expectedDataRoot),
  `dataDir=${mod.CALIBR_DATA_DIR} expected prefix=${expectedDataRoot}`,
);
check(
  "data dir ends with 'calibr'",
  mod.CALIBR_DATA_DIR.replace(/[\\/]+$/, "").endsWith(`${sep}calibr`),
  mod.CALIBR_DATA_DIR,
);
check(
  "data dir was created by the engine module",
  existsSync(mod.CALIBR_DATA_DIR),
  mod.CALIBR_DATA_DIR,
);

const status = mod.readStatus();
check("status reports bundled: true", status.bundled === true);
check(
  "status.dataDir matches CALIBR_DATA_DIR",
  status.dataDir === mod.CALIBR_DATA_DIR,
  `status=${status.dataDir} const=${mod.CALIBR_DATA_DIR}`,
);
check(
  "status.config loaded from the bundled default",
  status.config && typeof status.config === "object" && status.config.$schema_version === 1,
  `schema_version=${status.config?.$schema_version}`,
);
check(
  "catalog and plan are empty for a fresh install",
  status.catalogCount === 0 && status.planCount === 0,
  `catalog=${status.catalogCount} plan=${status.planCount}`,
);

if (failures.length > 0) {
  console.error(`\nsmoke-assert: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`\nsmoke-assert: all checks passed`);
