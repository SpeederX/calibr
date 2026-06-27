import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "calibr-guided-scope-"));
process.env.CALIBR_DATA_DIR = dataDir;
process.env.CALIBR_CONFIG = join(dataDir, "config.json");

const { GuidedRunView } = await import("../dist/guidedRun/GuidedRunView.js");

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test("scope row opens the guided catalog scope selector", async () => {
  const { lastFrame, stdin, unmount } = render(
    React.createElement(GuidedRunView, {
      onRun: () => { throw new Error("scope selector navigation should not launch a run"); },
      onCancel: () => {},
    }),
  );
  try {
    await tick();
    stdin.write("\x1B[B"); // folder
    await tick(15);
    stdin.write("\x1B[B"); // source
    await tick(15);
    stdin.write("\x1B[B"); // scope
    await tick(15);
    stdin.write("\r");
    await tick(50);
    const frame = lastFrame();
    assert.match(frame, /benchmark scope/);
    assert.match(frame, /Pick one or more catalog tiers/);
    assert.match(frame, /custom: pick exact models/);
  } finally {
    unmount();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("scope row keeps quick left/right tier cycling", async () => {
  const { lastFrame, stdin, unmount } = render(
    React.createElement(GuidedRunView, {
      onRun: () => { throw new Error("scope arrow navigation should not launch a run"); },
      onCancel: () => {},
    }),
  );
  try {
    await tick();
    stdin.write("\x1B[B"); // folder
    await tick(15);
    stdin.write("\x1B[B"); // source
    await tick(15);
    stdin.write("\x1B[B"); // scope
    await tick(15);
    stdin.write("\x1B[C"); // right: low -> middle
    await tick(50);
    assert.match(lastFrame(), /scope:\s+desktop-consumer-middle/);
  } finally {
    unmount();
  }
});

test("scope arrow from a custom selection resets to all models", async () => {
  const { lastFrame, stdin, unmount } = render(
    React.createElement(GuidedRunView, {
      session: { currentPreset: "all", customIds: "qwen3-0.6b-q4km" },
      onRun: () => { throw new Error("scope arrow navigation should not launch a run"); },
      onCancel: () => {},
    }),
  );
  try {
    await tick();
    assert.match(lastFrame(), /custom selection/);
    stdin.write("\x1B[B"); // folder
    await tick(15);
    stdin.write("\x1B[B"); // source
    await tick(15);
    stdin.write("\x1B[B"); // scope
    await tick(15);
    stdin.write("\x1B[C"); // right: custom -> all
    await tick(50);
    assert.match(lastFrame(), /scope:\s+all/);
    assert.doesNotMatch(lastFrame(), /custom selection/);
  } finally {
    unmount();
  }
});
