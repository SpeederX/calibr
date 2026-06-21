import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { ResultsMenuView } from "../dist/ResultsMenuView.js";

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const DOWN = "\u001b[B";

test("results submenu exposes benchmark results and benchmark run logs", async () => {
  let selected = "";
  const { lastFrame, stdin, unmount } = render(React.createElement(ResultsMenuView, {
    onResults: () => { selected = "results"; },
    onLogs: () => { selected = "logs"; },
    onExit: () => { selected = "exit"; },
  }));
  await tick();
  assert.match(lastFrame(), /benchmark results/);
  assert.match(lastFrame(), /benchmark run logs/);
  stdin.write(DOWN);
  await tick();
  stdin.write("\r");
  await tick();
  assert.equal(selected, "logs");
  unmount();
});
