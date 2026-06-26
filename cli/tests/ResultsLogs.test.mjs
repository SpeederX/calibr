import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { ResultsLogs } from "../dist/resultMenu/ResultsLogs.js";

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const logs = [{
  name: "model__ctx_16384.log",
  path: "C:\\logs\\model__ctx_16384.log",
  configId: "model__ctx_16384",
  kind: "config",
  sizeBytes: 4096,
  modifiedAt: "2026-06-21T20:00:00.000Z",
  runCount: 3,
}];

test("benchmark log browser lists entries and previews their tail", async () => {
  const listView = render(React.createElement(ResultsLogs, {
    onExit: () => {},
    logs,
    tailReader: () => ["===== RUN 2 =====", "[CMD] llama-server ...", "server complete"],
    opener: () => true,
    folderOpener: () => true,
    resultLabels: new Map(),
  }));
  await tick();
  assert.match(listView.lastFrame(), /benchmark run logs \(1\)/);
  assert.match(listView.lastFrame(), /model__ctx_16384/);
  listView.unmount();

  const previewView = render(React.createElement(ResultsLogs, {
    onExit: () => {},
    logs,
    tailReader: () => ["===== RUN 2 =====", "[CMD] llama-server ...", "server complete"],
    opener: () => true,
    folderOpener: () => true,
    resultLabels: new Map(),
    initialSelectedIndex: 0,
  }));
  await tick();
  assert.match(previewView.lastFrame(), /===== RUN 2 =====/);
  assert.match(previewView.lastFrame(), /server complete/);
  assert.match(previewView.lastFrame(), /open full log/);
  previewView.unmount();
});
