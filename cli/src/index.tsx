#!/usr/bin/env node
// Supported engines: Windows PowerShell on win32, PowerShell Core (pwsh) on
// Linux. The engine adapts at runtime — WDDM/WMI probes run only on Windows;
// on Linux it reads /proc + sysfs and skips WDDM paging detection. macOS is
// untested (no /proc) but allowed best-effort if pwsh is installed.
if (process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin") {
  process.stderr.write(
    `calibr does not support platform '${process.platform}'.\n` +
    "Supported: Windows (powershell) and Linux (pwsh).\n"
  );
  process.exit(2);
}

const { default: React } = await import("react");
const { render } = await import("ink");
const { App } = await import("./App.js");

render(React.createElement(App));
