#!/usr/bin/env node
// Smoke-test the Ink key path without a real terminal. It renders
// AllOptionsView, simulates key presses, and asserts the guided llama.cpp
// setup choices become explicit engine args.
import React from "react";
import { render } from "ink";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Writable } from "node:stream";

const dataDir = mkdtempSync(join(tmpdir(), "calibr-keypress-data-"));
process.env.CALIBR_DATA_DIR = dataDir;
process.env.CALIBR_CONFIG = join(dataDir, "config.json");
process.env.CALIBR_LLAMA_SCAN_ROOTS_ONLY = "1";

const { AllOptionsView } = await import("../dist/AllOptionsView.js");

function makeInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => {};
  input.unref = () => {};
  return input;
}

function makeOutput() {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  output.isTTY = true;
  output.columns = 160;
  output.rows = 50;
  return output;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function press(stdin, value, delay = 25) {
  stdin.write(value);
  await wait(delay);
}

async function openGuidedLlamaPrompt(stdin) {
  await wait(50);
  // Cursor starts on row 0 (`llama.cpp`). Move to row 1 (`model catalog`),
  // toggle it off so the disk gate is skipped, then move to `start all`.
  await press(stdin, "j");
  await press(stdin, " ");
  for (let i = 0; i < 7; i++) await press(stdin, "j", 15);
  await press(stdin, "\r", 50);
}

function makeStubServer(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  writeFileSync(file, "stub");
  return file;
}

async function runScenario(name, setup, drive, assert) {
  const tempRoot = mkdtempSync(join(tmpdir(), `calibr-keypress-${name}-`));
  let captured = null;
  let app = null;
  const stdin = makeInput();
  const stdout = makeOutput();

  try {
    const context = setup(tempRoot) ?? {};
    app = render(
      React.createElement(AllOptionsView, {
        onRun: (args, label) => {
          captured = { args, label };
          app.unmount();
        },
        onCancel: () => {
          throw new Error("unexpected cancel");
        },
      }),
      { stdin, stdout, stderr: stdout, debug: false, exitOnCtrlC: false },
    );

    await openGuidedLlamaPrompt(stdin);
    await drive(stdin, context);

    const deadline = Date.now() + 1500;
    while (!captured && Date.now() < deadline) await wait(20);
    if (!captured) throw new Error(`${name}: key path did not call onRun`);
    assert(captured, context);
    console.log(`[keypress] PASS: ${name}`);
  } finally {
    if (app) app.unmount();
    delete process.env.CALIBR_LLAMA_SCAN_ROOTS;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await runScenario(
  "download-latest",
  () => ({}),
  async (stdin) => {
    // llama source: download -> version prompt -> empty enter means latest.
    await press(stdin, "\r");
    await press(stdin, "\r");
  },
  ({ args, label }) => {
    if (!args.includes("-AutoFetchLlama")) throw new Error(`missing -AutoFetchLlama: ${JSON.stringify(args)}`);
    if (args.includes("-LlamaCppBuild")) throw new Error(`latest should not pass -LlamaCppBuild: ${JSON.stringify(args)}`);
    if (args.includes("-FetchCatalog")) throw new Error(`catalog should be toggled off: ${JSON.stringify(args)}`);
    if (!label.includes("-AutoFetchLlama")) throw new Error(`label missing -AutoFetchLlama: ${label}`);
  },
);

await runScenario(
  "download-specific-build",
  () => ({}),
  async (stdin) => {
    await press(stdin, "\r");
    for (const ch of "9360") await press(stdin, ch, 10);
    await press(stdin, "\r");
  },
  ({ args }) => {
    const idx = args.indexOf("-LlamaCppBuild");
    if (idx < 0 || args[idx + 1] !== "b9360") {
      throw new Error(`expected -LlamaCppBuild b9360, got ${JSON.stringify(args)}`);
    }
  },
);

await runScenario(
  "single-local-server",
  (root) => {
    const server = makeStubServer(root, "b9360-cuda");
    process.env.CALIBR_LLAMA_SCAN_ROOTS = root;
    return { server };
  },
  async (stdin) => {
    // llama source: scan existing. One candidate skips the picker.
    await press(stdin, "j");
    await press(stdin, "\r");
  },
  ({ args }, { server }) => {
    const idx = args.indexOf("-LlamaServer");
    if (idx < 0 || args[idx + 1] !== server) {
      throw new Error(`expected single local server ${server}, got ${JSON.stringify(args)}`);
    }
    if (args.includes("-AutoFetchLlama")) throw new Error(`local choice should not fetch: ${JSON.stringify(args)}`);
  },
);

await runScenario(
  "multiple-local-server-pick",
  (root) => {
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    const first = makeStubServer(firstRoot, "b9000-cpu");
    const second = makeStubServer(secondRoot, "b9360-cuda");
    process.env.CALIBR_LLAMA_SCAN_ROOTS = [firstRoot, secondRoot].join(delimiter);
    return { first, second };
  },
  async (stdin) => {
    // llama source: scan existing -> picker -> choose second.
    await press(stdin, "j");
    await press(stdin, "\r");
    await press(stdin, "j");
    await press(stdin, "\r");
  },
  ({ args }, { second }) => {
    const idx = args.indexOf("-LlamaServer");
    if (idx < 0 || args[idx + 1] !== second) {
      throw new Error(`expected picked second local server ${second}, got ${JSON.stringify(args)}`);
    }
  },
);

rmSync(dataDir, { recursive: true, force: true });
