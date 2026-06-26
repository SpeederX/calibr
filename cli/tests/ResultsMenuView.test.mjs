import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { ResultsMenuView } from "../dist/ResultsMenuView.js";

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll the rendered frame until `predicate` holds, so the test does not depend
// on a fixed delay being long enough for a re-render to flush on slow CI hosts.
async function waitForFrame(lastFrame, predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(lastFrame())) return;
    await tick(10);
  }
  assert.fail(`frame condition not met within ${timeout}ms; last frame:\n${lastFrame()}`);
}

test("results submenu exposes benchmark results and benchmark run logs", async () => {
  let selected = "";
  const { lastFrame, stdin, unmount } = render(React.createElement(ResultsMenuView, {
    onResults: () => { selected = "results"; },
    onLogs: () => { selected = "logs"; },
    onExit: () => { selected = "exit"; },
  }));
  // Let the component mount and register its input handler before sending keys,
  // otherwise the first keypress is dropped.
  await tick();
  assert.match(lastFrame(), /benchmark results/);
  assert.match(lastFrame(), /benchmark run logs/);

  stdin.write("j");
  // Two-step settle: first wait for the render that moves the cursor, then give
  // Ink's useInput effect a tick to re-register with the new cursor. The frame
  // commits before the effect re-runs, so pressing the selection key on the bare
  // frame match would still hit the stale handler.
  await waitForFrame(lastFrame, (frame) => /> benchmark run logs/.test(frame));
  await tick();
  stdin.write(" ");
  await waitForFrame(lastFrame, () => selected !== "");
  assert.equal(selected, "logs");
  unmount();
});
