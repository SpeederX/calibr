#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function usageText(): string {
  return [
    `calibr ${packageVersion()}`,
    "",
    "Find the fastest safe llama.cpp model/configuration on your hardware.",
    "",
    "Usage:",
    "  calibr              open the interactive console",
    "  calibr --help       show this help",
    "  calibr --version    print the package version",
    "",
    "Supported platforms:",
    "  Windows 10/11 with Windows PowerShell",
    "  Linux with PowerShell Core (`pwsh`)",
    "",
    "The npm command opens the guided console. For raw engine flags, run",
    "`calibr.ps1` from a repo checkout.",
    "",
  ].join("\n");
}

const cliArgs = process.argv.slice(2);
if (cliArgs.some(arg => arg === "--help" || arg === "-h" || arg === "help")) {
  process.stdout.write(usageText());
  process.exit(0);
}
if (cliArgs.some(arg => arg === "--version" || arg === "-v" || arg === "version")) {
  process.stdout.write(`${packageVersion()}\n`);
  process.exit(0);
}
if (cliArgs.length > 0) {
  process.stderr.write(`Unknown argument(s): ${cliArgs.join(" ")}\n\n${usageText()}`);
  process.exit(2);
}

// Supported engines: Windows PowerShell on win32, PowerShell Core (pwsh) on
// Linux. The engine adapts at runtime: WDDM/WMI probes run only on Windows;
// on Linux it reads /proc + sysfs and, when radeontop is present, AMD GTT as
// the Linux spill signal.
if (process.platform !== "win32" && process.platform !== "linux") {
  process.stderr.write(
    `calibr does not support platform '${process.platform}'.\n` +
    "Supported: Windows (powershell) and Linux (pwsh).\n"
  );
  process.exit(2);
}

if (process.platform === "linux") {
  const res = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8", windowsHide: true },
  );
  const err = res.error as NodeJS.ErrnoException | undefined;
  if (err?.code === "ENOENT") {
    process.stderr.write(
      "calibr requires PowerShell Core (`pwsh`) on this platform.\n" +
      "Install it first, then retry `calibr`:\n" +
      "  https://github.com/PowerShell/PowerShell\n"
    );
    process.exit(2);
  }
  if (res.status !== 0) {
    process.stderr.write(
      "calibr found `pwsh`, but it did not start successfully.\n" +
      `exit: ${res.status ?? "unknown"}\n` +
      `${res.stderr || res.stdout || ""}`
    );
    process.exit(2);
  }
}

const { default: React } = await import("react");
const { render } = await import("ink");
const { App } = await import("./App.js");

render(React.createElement(App));
