import test from "node:test";
import assert from "node:assert/strict";
import { RESULTS_MENU_ITEMS, reduceResultsMenu } from "../dist/resultMenu/resultsMenu.js";

test("down/j moves the cursor toward logs and clamps at the last item", () => {
  assert.deepEqual(reduceResultsMenu(0, { input: "j" }), { type: "move", cursor: 1 });
  assert.deepEqual(reduceResultsMenu(0, { input: "", downArrow: true }), { type: "move", cursor: 1 });
  // Already on the last item: stays put instead of running off the end.
  assert.deepEqual(reduceResultsMenu(1, { input: "j" }), { type: "move", cursor: 1 });
});

test("up/k moves the cursor toward results and clamps at the first item", () => {
  assert.deepEqual(reduceResultsMenu(1, { input: "k" }), { type: "move", cursor: 0 });
  assert.deepEqual(reduceResultsMenu(1, { input: "", upArrow: true }), { type: "move", cursor: 0 });
  assert.deepEqual(reduceResultsMenu(0, { input: "k" }), { type: "move", cursor: 0 });
});

test("selecting maps the cursor to results (index 0) or logs (otherwise)", () => {
  assert.deepEqual(reduceResultsMenu(0, { input: " " }), { type: "select", target: "results" });
  assert.deepEqual(reduceResultsMenu(0, { input: "", return: true }), { type: "select", target: "results" });
  assert.deepEqual(reduceResultsMenu(1, { input: " " }), { type: "select", target: "logs" });
  assert.deepEqual(reduceResultsMenu(1, { input: "", return: true }), { type: "select", target: "logs" });
});

test("escape / q / left / h exits the submenu", () => {
  for (const key of [{ input: "q" }, { input: "h" }, { input: "", escape: true }, { input: "", leftArrow: true }]) {
    assert.deepEqual(reduceResultsMenu(0, key), { type: "exit" });
  }
});

test("unrelated keys are a no-op", () => {
  assert.deepEqual(reduceResultsMenu(1, { input: "x" }), { type: "none" });
});

test("the submenu exposes exactly the results and logs entries", () => {
  assert.deepEqual(
    RESULTS_MENU_ITEMS.map((item) => item.label),
    ["benchmark results", "benchmark run logs"],
  );
});
