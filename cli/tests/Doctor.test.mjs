// Component tests for Doctor. The engine is mocked via the injectable
// `runner`/`exporter` props, so these run fast and need no pwsh/llama-server.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Doctor } from "../dist/help/Doctor.js";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const DOWN = "[B";

const MOCK_REPORT = {
  schemaVersion: 1,
  calibrVersion: "0.0.0-test",
  generatedAt: "2026-01-01T00:00:00Z",
  extended: false,
  overallStatus: "degraded",
  inference: { gpuOffloadPossible: true, recommendedBackend: "vulkan", reason: "test" },
  systemInfo: {
    os: { platform: "linux", name: "Ubuntu 24.04", kernel: "6.8.0" },
    cpu: { model: "Test CPU", arch: "X64", coresPhysical: 4, threadsLogical: 4, flags: { avx: true, avx2: false } },
    ram: { totalMib: 8000, availableMib: 4000 },
    gpus: [{ name: "Test GPU", vendor: "AMD", vramTotalMib: 4096, kernelDriver: "amdgpu", powerW: null, vulkanDevice: "RADV (hardware)" }],
  },
  deps: [
    { name: "powershell", kind: "runtime", required: true, present: true, version: "7.6", check: "ok", detail: "ok" },
    { name: "cpu-instructions", kind: "cpu", required: false, present: true, check: "warning",
      detail: "CPU lacks: avx2", remediation: "build with -DGGML_AVX2=OFF" },
    { name: "mystery-dep", kind: "runtime", required: true, present: false, check: "fail",
      detail: "exploded for unknown reasons", remediation: null },
  ],
};

const mockRunner = async () => ({ report: MOCK_REPORT });
const mockExporter = async () => ({ path: "/tmp/doctor-report.json" });

test("menu lists the three actions", async () => {
  const { lastFrame, unmount } = render(
    React.createElement(Doctor, { onExit: () => {}, runner: mockRunner, exporter: mockExporter })
  );
  await tick();
  const f = lastFrame();
  assert.match(f, /run check/);
  assert.match(f, /run check \(extended\)/);
  assert.match(f, /export sanity check/);
  unmount();
});

test("running the check renders the report with status, system info and a remediation", async () => {
  const { lastFrame, stdin, unmount } = render(
    React.createElement(Doctor, { onExit: () => {}, runner: mockRunner, exporter: mockExporter })
  );
  await tick();
  stdin.write("\r"); // enter on "run check"
  await tick(80);
  const f = lastFrame();
  assert.match(f, /status:/);
  assert.match(f, /degraded/);
  assert.match(f, /powershell/);
  assert.match(f, /cpu-instructions/);
  // The focused row (first dep) detail panel; navigate to the warning row.
  stdin.write(DOWN);
  await tick(40);
  const f2 = lastFrame();
  assert.match(f2, /fix:/);
  assert.match(f2, /GGML_AVX2=OFF/);
  unmount();
});

test("a failing dep with no remediation surfaces the open-an-issue hint", async () => {
  const { lastFrame, stdin, unmount } = render(
    React.createElement(Doctor, { onExit: () => {}, runner: mockRunner, exporter: mockExporter })
  );
  await tick();
  stdin.write("\r");        // run
  await tick(80);
  stdin.write(DOWN);        // -> cpu-instructions
  await tick(20);
  stdin.write(DOWN);        // -> mystery-dep (fail, no remediation)
  await tick(40);
  const f = lastFrame();
  assert.match(f, /No known fix/);
  assert.match(f, /issue/i);
  unmount();
});

test("export action shows the written path", async () => {
  const { lastFrame, stdin, unmount } = render(
    React.createElement(Doctor, { onExit: () => {}, runner: mockRunner, exporter: mockExporter })
  );
  await tick();
  stdin.write(DOWN); // run check (extended)
  await tick(20);
  stdin.write(DOWN); // export sanity check
  await tick(20);
  stdin.write("\r");
  await tick(60);
  const f = lastFrame();
  assert.match(f, /doctor-report\.json/);
  unmount();
});
