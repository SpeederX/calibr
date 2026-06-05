#!/usr/bin/env node
// Smoke-test the Ink key path without a real terminal. It renders
// AllOptionsView, simulates key presses, and asserts that the default-on
// llama.cpp auto-fetch toggle reaches the engine args when the user starts
// the guided run.
import React from "react";
import { render } from "ink";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

const dataDir = mkdtempSync(join(tmpdir(), "calibr-keypress-"));
process.env.CALIBR_DATA_DIR = dataDir;

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
  output.columns = 120;
  output.rows = 40;
  return output;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let captured = null;
const stdin = makeInput();
const stdout = makeOutput();
const app = render(
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

try {
  await wait(50);
  // Cursor starts on row 0 (`llama.cpp`). Move to row 1 (`model catalog`),
  // toggle it off so the disk gate is skipped, then move to `start all`.
  stdin.write("j");
  await wait(30);
  stdin.write(" ");
  await wait(50);
  for (let i = 0; i < 5; i++) {
    stdin.write("j");
    await wait(15);
  }
  stdin.write("\r");

  const deadline = Date.now() + 1000;
  while (!captured && Date.now() < deadline) await wait(20);
  if (!captured) throw new Error("start all key path did not call onRun");

  const { args, label } = captured;
  if (args[0] !== "all") throw new Error(`expected all command, got ${JSON.stringify(args)}`);
  if (!args.includes("-AutoFetchLlama")) {
    throw new Error(`expected -AutoFetchLlama in args, got ${JSON.stringify(args)}`);
  }
  if (args.includes("-FetchCatalog")) {
    throw new Error(`expected catalog toggle to be off after keypress, got ${JSON.stringify(args)}`);
  }
  if (!label.includes("-AutoFetchLlama")) {
    throw new Error(`expected label to include -AutoFetchLlama, got ${label}`);
  }

  console.log("[keypress] PASS: guided run start includes -AutoFetchLlama");
} finally {
  app.unmount();
  rmSync(dataDir, { recursive: true, force: true });
}
