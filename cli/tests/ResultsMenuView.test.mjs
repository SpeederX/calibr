import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { ResultsMenuView } from "../dist/ResultsMenuView.js";

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// Render smoke only: the component wires the menu to Ink and renders both
// entries. The navigation/selection behaviour lives in the pure reduceResultsMenu
// reducer and is covered deterministically in resultsMenu.test.mjs, so this test
// does not drive keystrokes through the async render/input pipeline.
test("results submenu renders both entries", async () => {
  const { lastFrame, unmount } = render(React.createElement(ResultsMenuView, {
    onResults: () => {},
    onLogs: () => {},
    onExit: () => {},
  }));
  await tick();
  assert.match(lastFrame(), /benchmark results/);
  assert.match(lastFrame(), /benchmark run logs/);
  unmount();
});
