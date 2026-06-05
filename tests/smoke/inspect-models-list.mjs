// Diagnostic: load the real report.html, run the embedded script under a
// stubbed DOM, and dump the HTML that gets written into #models-list so
// we can see what each <details> row would look like in a browser.
//
// Run: node tests/inspect-models-list.mjs

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB  = dirname(HERE);

const html = await readFile(join(LAB, "data", "report.html"), "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("no script in report.html"); process.exit(1); }
const body = m[1];

// Capture innerHTML writes per id.
const writes = {};
const fakeEl = (id) => ({
  id, _html: "", _text: "",
  get innerHTML() { return this._html; },
  set innerHTML(v) { this._html = v; if (id) writes[id] = v; },
  get textContent() { return this._text; },
  set textContent(v) { this._text = v; },
  insertAdjacentHTML(_pos, v) { this._html += v; if (id) writes[id] = this._html; },
  addEventListener() {},
  querySelector() { return fakeEl(); },
  querySelectorAll() { return []; },
  classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
  dataset: {},
  appendChild() {}, removeChild() {},
  closest() { return null; },
});
const fakeDoc = {
  getElementById(id) { return fakeEl(id); },
  querySelector(sel) { return fakeEl(sel); },
  querySelectorAll() { return []; },
  createElement() { return fakeEl(); },
  addEventListener() {},
  body: { appendChild() {}, removeChild() {} },
};

const sandbox = {
  document: fakeDoc,
  URL:  { createObjectURL: () => "blob:", revokeObjectURL: () => {} },
  Blob: function () {},
  setTimeout: globalThis.setTimeout,
  console: globalThis.console,
};

try {
  const fn = new Function(...Object.keys(sandbox), body);
  fn(...Object.values(sandbox));
} catch (e) {
  console.error("script threw:", e.stack || e);
  process.exit(1);
}

const ml = writes["models-list"];
if (!ml) { console.error("models-list got no writes"); process.exit(1); }

// Pretty-print: each <details> on its own block.
const pretty = ml
  .replace(/<details/g, "\n\n<details")
  .replace(/<\/details>/g, "</details>\n");
console.log(pretty);
