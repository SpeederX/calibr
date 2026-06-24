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
  { id:"a", label:"ctx16k_kv_q8", model:"M1", series:"M", variant:"Q8", level:"low", sweep:"context",
    prompt_tps:100, eval_tps:50, vram_peak_mib:3500, vram_total_peak_mib:3500,
    vram_baseline_mib:1500, shared_peak_mib:108, load_sec:2,
    layers_offloaded:"32/32", fit_status:"success", wddm_vram_saturation:0.2,
    wddm_flag_high_vram:false, wddm_flag_shared_pos:false, extra_args:"--ctx-size 16384",
    ok:true, time_total_sec:3.2, headroom_mib:6192, ctx_size:16384, kv_cache_mib:50,
    ttft_sec:0.4, gpu_power_peak_w:120, gpu_temp_peak_c:65, gpu_util_avg_pct:92,
    prompt_ms:310, ttfr_ms:120, e2e_ttft_ms:400, total_request_ms:3200, latency_total_request_ms:520,
    ram_used_peak_mib:1024, ram_baseline_mib:512,
    runs:[{ run_index:1, telemetry:[
      { elapsed_ms:0, phase:"warmup", token_index:null, rolling_tps:null, vram_total_mib:1500, vram_run_mib:0, ram_used_mib:0, shared_mib:0, gpu_util_pct:1, cpu_util_pct:4 },
      { elapsed_ms:500, phase:"throughput", token_index:null, rolling_tps:null, vram_total_mib:3400, vram_run_mib:1900, ram_used_mib:500, shared_mib:20, gpu_util_pct:90, cpu_util_pct:20 },
      { elapsed_ms:900, phase:"latency_prompt", token_index:null, rolling_tps:null, vram_total_mib:3500, vram_run_mib:2000, ram_used_mib:600, shared_mib:25, gpu_util_pct:95, cpu_util_pct:25 },
      { elapsed_ms:1100, phase:"latency_eval", token_index:1, rolling_tps:null, vram_total_mib:3500, vram_run_mib:2000, ram_used_mib:610, shared_mib:25, gpu_util_pct:96, cpu_util_pct:24 },
      { elapsed_ms:1150, phase:"latency_eval", token_index:2, rolling_tps:20, vram_total_mib:3500, vram_run_mib:2000, ram_used_mib:615, shared_mib:25, gpu_util_pct:97, cpu_util_pct:24 }
    ]}],
    model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
  { id:"a2", label:"ctx65k_kv_q8", model:"M1", series:"M", variant:"Q8", level:"low", sweep:"context",
    prompt_tps:100, eval_tps:48, vram_peak_mib:2500, shared_peak_mib:0, load_sec:2,
    layers_offloaded:"32/32", fit_status:"success", wddm_vram_saturation:0.3,
    wddm_flag_high_vram:false, wddm_flag_shared_pos:false, extra_args:"--ctx-size 65536",
    ok:true, time_total_sec:3.4, headroom_mib:5692, ctx_size:65536, kv_cache_mib:90,
    ttft_sec:0.4, gpu_power_peak_w:122, gpu_temp_peak_c:65, gpu_util_avg_pct:92,
    prompt_ms:330, ttfr_ms:130, e2e_ttft_ms:410, total_request_ms:3400, latency_total_request_ms:530,
    ram_used_peak_mib:1030, ram_baseline_mib:512,
    model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
  { id:"b", label:"ctx32k_kv_q8", model:"M2", series:"M", variant:"Q4", level:"high", sweep:"moe-cpu",
    prompt_tps:80, eval_tps:40, vram_peak_mib:4096, shared_peak_mib:600, load_sec:3,
    layers_offloaded:"32/32", fit_status:"failed_but_running", wddm_vram_saturation:0.6,
    wddm_flag_high_vram:false, wddm_flag_shared_pos:true, extra_args:"--ctx-size 32768",
    ok:true, time_total_sec:5.1, headroom_mib:4096, ctx_size:32768, kv_cache_mib:80,
    ttft_sec:null, gpu_power_peak_w:null, gpu_temp_peak_c:null, gpu_util_avg_pct:null,
    prompt_ms:null, ttfr_ms:null, e2e_ttft_ms:null, total_request_ms:null, latency_total_request_ms:null,
    ram_used_peak_mib:null, ram_baseline_mib:null,
    model_path:"C:\\fake\\m2.gguf", mmproj_path:null },
  // ok=false with an unsupported architecture — exercises the no-winner /
  // failure-label rendering path that the user hit on Gemma-4-E4B / Granite.
  { id:"c", label:"ctx16k_kv_q8", model:"M3", series:"M", variant:"Q4", level:"low", sweep:"context",
    prompt_tps:0, eval_tps:0, vram_peak_mib:808, shared_peak_mib:0, load_sec:6,
    layers_offloaded:null, fit_status:"unknown", wddm_vram_saturation:0.1,
    wddm_flag_high_vram:false, wddm_flag_shared_pos:false, extra_args:"--ctx-size 16384",
    ok:false, time_total_sec:null, headroom_mib:7384, ctx_size:16384, kv_cache_mib:0,
    ttft_sec:null, gpu_power_peak_w:31, gpu_temp_peak_c:45, gpu_util_avg_pct:1,
    prompt_ms:null, ttfr_ms:null, e2e_ttft_ms:null, total_request_ms:null, latency_total_request_ms:null,
    ram_used_peak_mib:1, ram_baseline_mib:13000,
    model_path:"C:\\fake\\m3.gguf", mmproj_path:null,
    failure_reason:"unsupported_arch", unsupported_architecture:"fakearch_v2", ready:false },
  // M1 vanilla control + load-curve rows: exercise the comparison radar and
  // the prefill/KV-fill chart. All are winner-ineligible (control / non-baseline
  // workload), so M1's winner must stay "a2".
  { id:"a_v", label:"vanilla_llama_cpp", model:"M1", series:"M", variant:"Q8", level:"low", sweep:"context",
    control_kind:"vanilla", prompt_tps:120, eval_tps:56, vram_peak_mib:3600, vram_total_peak_mib:3600,
    vram_baseline_mib:1500, shared_peak_mib:0, load_sec:2, layers_offloaded:null, fit_status:"success",
    extra_args:"", ok:true, ctx_size:16384, kv_cache_mib:50, gpu_power_peak_w:128, gpu_temp_peak_c:66,
    ram_used_peak_mib:1100, requested_context_size:null, effective_context_size:4096,
    effective_parallel_slots:4, effective_n_parallel:4, model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
  { id:"a_p1", label:"ctx16k_kv_q8", model:"M1", series:"M", variant:"Q8", level:"low", sweep:"context",
    workload_kind:"prefill", prefill_target_tokens:2048, workload_prompt_tokens:2048,
    prompt_tps:118, eval_tps:50, vram_peak_mib:3500, vram_baseline_mib:1500, shared_peak_mib:0,
    fit_status:"success", ok:true, ctx_size:16384, model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
  { id:"a_p2", label:"ctx16k_kv_q8", model:"M1", series:"M", variant:"Q8", level:"low", sweep:"context",
    workload_kind:"prefill", prefill_target_tokens:8192, workload_prompt_tokens:8192,
    prompt_tps:92, eval_tps:49, vram_peak_mib:3520, vram_baseline_mib:1500, shared_peak_mib:0,
    fit_status:"success", ok:true, ctx_size:16384, model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
  { id:"a_k1", label:"ctx16k_kv_q8", model:"M1", series:"M", variant:"Q8", level:"low", sweep:"context",
    workload_kind:"kv-fill", kv_fill_target_tokens:4096, kv_fill_cached_tokens:4096,
    prompt_tps:110, eval_tps:46, vram_peak_mib:3550, vram_baseline_mib:1500, shared_peak_mib:0,
    fit_status:"success", ok:true, ctx_size:16384, model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
  { id:"a_k2", label:"ctx16k_kv_q8", model:"M1", series:"M", variant:"Q8", level:"low", sweep:"context",
    workload_kind:"kv-fill", kv_fill_target_tokens:12288, kv_fill_cached_tokens:12288,
    prompt_tps:108, eval_tps:38, vram_peak_mib:3580, vram_baseline_mib:1500, shared_peak_mib:0,
    fit_status:"success", ok:true, ctx_size:16384, model_path:"C:\\fake\\m1.gguf", mmproj_path:null },
];
const WINNERS = [{ model:"M1", winner_id:"a", bat:"M1.bat" }, { model:"M2", winner_id:"b", bat:"M2.bat" }];
const CFG = {
  llama_server_exe:"C:\\fake\\llama-server.exe",
  hardware:{ gpu_name:"Fake GPU", vram_total_mib:8192, gpu_compute_cap:"7.5",
             cpu_cores_physical:6, cpu_threads_logical:12, vram_safety_budget_mib:7782,
             system_ram_total_mib:32768 },
  wddm_detection:{ shared_delta_confirm_mib:500 },
};

body = body.replace(/%%DATA%%/, JSON.stringify(DATA))
           .replace(/%%WINNERS%%/, JSON.stringify(WINNERS))
           .replace(/%%CFG%%/, JSON.stringify(CFG));
body += "\nglobalThis.__currentWinners = currentWinners;\nglobalThis.__state = STATE;\n";
body += "globalThis.__reportMetrics = { benchmarkVramUsedMib, systemVramPeakMib, confirmedSharedMib, effectiveMemoryUsedMib };\n";

// DOM stub. Each "element" is an object that swallows the mutations the
// template performs. We track innerHTML writes so we can assert at least
// SOMETHING was rendered into each known container.
const writes = {};
const rendered = {};
const fakeEl = (id) => {
  const el = {
    id, _html: "", _text: "",
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = v; if (id) { writes[id] = (writes[id] || 0) + 1; rendered[id] = v; } },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; if (id) writes[id] = (writes[id] || 0) + 1; },
    insertAdjacentHTML(_pos, html) { el._html += html; if (id) { writes[id] = (writes[id] || 0) + 1; rendered[id] = el._html; } },
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
  globalThis: {},
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

if (sandbox.globalThis.__state.filter !== "safety") {
  console.error("FAIL: report should default to the safety-balanced filter");
  process.exit(1);
}
if (rendered.hw?.includes("C:\\fake")) {
  console.error("FAIL: hardware header exposed an absolute llama-server path");
  process.exit(1);
}
if (!rendered.hw?.includes("&lt;llama_server_path&gt;")) {
  console.error("FAIL: hardware header did not render the redacted llama-server placeholder");
  process.exit(1);
}
if (sandbox.globalThis.__reportMetrics.systemVramPeakMib(DATA[0]) !== 3500) {
  console.error("FAIL: system VRAM peak should include the pre-run baseline");
  process.exit(1);
}
if (sandbox.globalThis.__reportMetrics.benchmarkVramUsedMib(DATA[0]) !== 2000) {
  console.error("FAIL: run VRAM should subtract the 1500 MiB baseline");
  process.exit(1);
}
if (sandbox.globalThis.__reportMetrics.confirmedSharedMib(DATA[0]) !== 0) {
  console.error("FAIL: sub-threshold shared-memory drift should be hidden");
  process.exit(1);
}
if (sandbox.globalThis.__reportMetrics.effectiveMemoryUsedMib(DATA[0], true) !== 3500) {
  console.error("FAIL: RAM should not be added while total memory remains within GPU VRAM");
  process.exit(1);
}
if (sandbox.globalThis.__reportMetrics.effectiveMemoryUsedMib({ ...DATA[0], ram_used_peak_mib: 6000 }, true) !== 9500) {
  console.error("FAIL: RAM should be added after the GPU VRAM boundary is exceeded");
  process.exit(1);
}
if (sandbox.globalThis.__currentWinners.M1?.id !== "a2") {
  console.error("FAIL: safety-balanced near-tie should prefer the larger context config");
  console.error("Winner seen:", sandbox.globalThis.__currentWinners.M1);
  process.exit(1);
}

console.log("OK: report.template.html renders without throwing (" +
            Object.keys(writes).length + " containers populated)");
