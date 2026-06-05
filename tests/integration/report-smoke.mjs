// Render-time smoke test for report.template.html: extract the <script>
// block, fill the four placeholders with a small canned dataset, then run
// it under a stubbed DOM. Asserts the script reaches the end (i.e. the
// initial `rerender()` call doesn't throw).
//
// Run: node tests/integration/report-smoke.mjs
// Exit 0 = pass, exit 1 = fail with stack trace.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE     = dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = dirname(dirname(HERE));
const TPL_PATH = join(LAB_ROOT, "report.template.html");

const tpl = await readFile(TPL_PATH, "utf8");

// Pull out the contents of the single <script> block. Crude regex is fine
// because the template only has one script element.
const m = tpl.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("FAIL: no <script> block found in template"); process.exit(1); }
let body = m[1];

// Two configs, two models. One with full extended metrics, one minimal —
// so we exercise both branches of the scorers (efficiency falls back to
// speed for the minimal record).
const DATA = [
  { id:"a", label:"ctx16k_kv_q8", model:"M1", series:"M", variant:"Q8", tier:"A",
    prompt_tps:100, eval_tps:50, vram_peak_mib:2000, shared_peak_mib:0, load_sec:2,
    layers_offloaded:"32/32", fit_status:"success", wddm_vram_saturation:0.2,
    wddm_flag_high_vram:false, wddm_flag_shared_pos:false, extra_args:"--ctx-size 16384",
    ok:true, time_total_sec:3.2, headroom_mib:6192, ctx_size:16384, kv_cache_mib:50,
    ttft_sec:0.4, gpu_power_peak_w:120, gpu_temp_peak_c:65, gpu_util_avg_pct:92,
    ram_used_peak_mib:1024, ram_baseline_mib:512,
    model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
  { id:"b", label:"ctx32k_kv_q8", model:"M2", series:"M", variant:"Q4", tier:"B",
    prompt_tps:80, eval_tps:40, vram_peak_mib:4096, shared_peak_mib:600, load_sec:3,
    layers_offloaded:"32/32", fit_status:"failed_but_running", wddm_vram_saturation:0.6,
    wddm_flag_high_vram:false, wddm_flag_shared_pos:true, extra_args:"--ctx-size 32768",
    ok:true, time_total_sec:5.1, headroom_mib:4096, ctx_size:32768, kv_cache_mib:80,
    ttft_sec:null, gpu_power_peak_w:null, gpu_temp_peak_c:null, gpu_util_avg_pct:null,
    ram_used_peak_mib:null, ram_baseline_mib:null,
    model_path:"C:\\fake\\m2.gguf", mmproj_path:null },
  // ok=false with an unsupported architecture — exercises the no-winner /
  // failure-label rendering path that the user hit on Gemma-4-E4B / Granite.
  { id:"c", label:"ctx16k_kv_q8", model:"M3", series:"M", variant:"Q4", tier:"A",
    prompt_tps:0, eval_tps:0, vram_peak_mib:808, shared_peak_mib:0, load_sec:6,
    layers_offloaded:null, fit_status:"unknown", wddm_vram_saturation:0.1,
    wddm_flag_high_vram:false, wddm_flag_shared_pos:false, extra_args:"--ctx-size 16384",
    ok:false, time_total_sec:null, headroom_mib:7384, ctx_size:16384, kv_cache_mib:0,
    ttft_sec:null, gpu_power_peak_w:31, gpu_temp_peak_c:45, gpu_util_avg_pct:1,
    ram_used_peak_mib:1, ram_baseline_mib:13000,
    model_path:"C:\\fake\\m3.gguf", mmproj_path:null,
    failure_reason:"unsupported_arch", unsupported_architecture:"fakearch_v2", ready:false },
];
const WINNERS = [{ model:"M1", winner_id:"a", bat:"M1.bat" }, { model:"M2", winner_id:"b", bat:"M2.bat" }];
const CFG = {
  llama_server_exe:"C:\\fake\\llama-server.exe",
  hardware:{ gpu_name:"Fake GPU", vram_total_mib:8192, gpu_compute_cap:"7.5",
             cpu_cores_physical:6, cpu_threads_logical:12, vram_safety_budget_mib:7782 },
  wddm_detection:{ shared_delta_confirm_mib:500 },
};

body = body.replace(/%%DATA%%/, JSON.stringify(DATA))
           .replace(/%%WINNERS%%/, JSON.stringify(WINNERS))
           .replace(/%%CFG%%/, JSON.stringify(CFG));

// DOM stub. Each "element" is an object that swallows the mutations the
// template performs. We track innerHTML writes so we can assert at least
// SOMETHING was rendered into each known container.
const writes = {};
const fakeEl = (id) => {
  const el = {
    id, _html: "", _text: "",
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = v; if (id) writes[id] = (writes[id] || 0) + 1; },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; if (id) writes[id] = (writes[id] || 0) + 1; },
    insertAdjacentHTML(_pos, html) { el._html += html; if (id) writes[id] = (writes[id] || 0) + 1; },
    addEventListener() {},
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    dataset: {},
    appendChild() {}, removeChild() {},
    closest() { return null; },
  };
  return el;
};
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

// Execute the template script inside a Function so it sees our stub
// document instead of node globals.
try {
  const fn = new Function(...Object.keys(sandbox), body);
  fn(...Object.values(sandbox));
} catch (e) {
  console.error("FAIL: script threw during initial render:");
  console.error(e.stack || e);
  process.exit(1);
}

// Best-effort assertion that the main containers got written. Stubbed
// element identity means writes share a single key per id; existence > 0
// per known container is enough to know rerender() walked them.
const expected = ["hw", "overall-pct", "models-list", "scatter", "bars", "wddm-list"];
const missing  = expected.filter(id => !writes[id]);
if (missing.length) {
  console.error("FAIL: these containers received no writes:", missing);
  console.error("All writes seen:", writes);
  process.exit(1);
}

console.log("OK: report.template.html renders without throwing (" +
            Object.keys(writes).length + " containers populated)");
