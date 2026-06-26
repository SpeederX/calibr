// Render tests for CustomScopeView v2 (search + ctx checkboxes + submit).
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { CustomScopeView } from "../dist/guidedRun/CustomScopeView.js";

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

test("renders models, the context-size set and the submit row", async () => {
  const { lastFrame, unmount } = render(
    React.createElement(CustomScopeView, { onSubmit: () => {}, onCancel: () => {} })
  );
  await tick();
  const f = lastFrame();
  assert.match(f, /custom — pick models/);
  assert.match(f, /context sizes/);
  assert.match(f, /16k/);
  assert.match(f, /256k/);
  assert.match(f, /bench selected/);
  unmount();
});

test("'/' enters search mode and live-narrows the catalog", async () => {
  const { lastFrame, stdin, unmount } = render(
    React.createElement(CustomScopeView, { onSubmit: () => {}, onCancel: () => {} })
  );
  await tick();
  stdin.write("/");            // enter search mode
  await tick(20);
  stdin.write("q"); stdin.write("w"); stdin.write("e"); stdin.write("n"); // "qwen"
  await tick(40);
  const f = lastFrame();
  assert.match(f, /search: qwen/);
  assert.match(f, /match/);     // shows "<n>/<total> match"
  unmount();
});
