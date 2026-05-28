#!/usr/bin/env node
if (process.platform !== "win32") {
  // The engine drives Windows-specific tooling (PowerShell, WDDM perf
  // counters, WMI hardware probes). Until a non-Windows engine adapter
  // exists, fail loudly with a useful message instead of crashing later
  // when we try to spawn powershell.exe.
  process.stderr.write(
    "calibr currently requires Windows.\n" +
    `Detected platform: ${process.platform}. The engine wraps a PowerShell script\n` +
    "that uses Windows-only counters (Get-Counter for WDDM shared VRAM, WMI for\n" +
    "hardware probes). Cross-platform support is on the roadmap.\n"
  );
  process.exit(2);
}

const { default: React } = await import("react");
const { render } = await import("ink");
const { App } = await import("./App.js");

render(React.createElement(App));
