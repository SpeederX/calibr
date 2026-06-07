// Generate report_ui/demo-report.html from synthetic data so the redesign
// can be eyeballed in a browser without running a real bench. 7 models,
// 21 configs, varied levels / WDDM flags / power data so every section of
// the UI has something to render.
//
// Run: node tests/smoke/generate-demo-report.mjs
// Output: report_ui/demo-report.html (gitignored alongside the screenshot).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE     = dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = dirname(dirname(HERE));
const TPL_PATH = join(LAB_ROOT, "report.template.html");
const OUT_DIR  = join(LAB_ROOT, "report_ui");
const OUT_PATH = join(OUT_DIR, "demo-report.html");

const tpl = await readFile(TPL_PATH, "utf8");

// Pseudo-randomish but reproducible. Each model gets 3 configs spanning
// the ctx axis; power/temp/util are filled for most rows so the
// efficiency scorer has data to work with, but two rows leave them null
// to exercise the speed-fallback branch.
const MODELS = [
  { m:"Qwen3.5-2B-Q8",  s:"Qwen3.5",  v:"Q8_0",  level:"middle", sweep:"context", vramBase:2400, tps:55  },
  { m:"Gemma-4-E4B-Q4", s:"Gemma",    v:"Q4_K_M",level:"middle", sweep:"context", vramBase:3100, tps:48  },
  { m:"Phi-3.5-mini",   s:"Phi",      v:"Q5_K_M",level:"low",    sweep:"context", vramBase:2700, tps:62  },
  { m:"Qwen3.5-9B-Q4",  s:"Qwen3.5",  v:"Q4_K_M",level:"high",   sweep:"moe-cpu", vramBase:6200, tps:28  },
  { m:"Gemma-4-E12B-Q4",s:"Gemma",    v:"Q4_K_M",level:"high",   sweep:"moe-cpu", vramBase:7300, tps:22  },
  { m:"Llama-3.2-3B",   s:"Llama",    v:"Q4_K_M",level:"low",    sweep:"context", vramBase:2200, tps:71  },
  { m:"Phi-2-2.7B",     s:"Phi",      v:"Q4_K_M",level:"low",    sweep:"context", vramBase:2000, tps:81  },
];
const CTXES = [16384, 32768, 65536];

const DATA = [];
let i = 0;
for (const md of MODELS) {
  for (const ctx of CTXES) {
    i++;
    const ctxRatio = ctx / 16384;
    const vram = Math.round(md.vramBase + 250 * Math.log2(ctxRatio + 1));
    const tps  = +(md.tps * (1 - 0.07 * Math.log2(ctxRatio + 1))).toFixed(2);
    // Last config of high-level models tips into WDDM paging for variety.
    const pages = (md.level === "high" && ctx === 65536);
    const shared = pages ? 1200 : 0;
    const fit = pages ? "failed_but_running" : (vram > 7000 ? "unknown" : "success");
    // Skip extended metrics on two rows to exercise the speed-fallback.
    const hasExt = !(i === 5 || i === 14);
    const label = `ctx_${ctx}_kv_q8_0`;
    const args = `--ctx-size ${ctx} --gpu-layers 99 --cache-type-k q8_0 --cache-type-v q8_0`;
    DATA.push({
      id: `T${String(i).padStart(3,"0")}_${md.m.replace(/[^\w]/g,"_")}_${label}`,
      label,
      model: md.m, series: md.s, variant: md.v, level: md.level, sweep: md.sweep,
      prompt_tps: tps * 6,
      eval_tps: tps,
      vram_peak_mib: vram,
      shared_peak_mib: shared,
      load_sec: 1.8 + Math.random() * 1.5,
      layers_offloaded: "32/32",
      fit_status: fit,
      wddm_vram_saturation: vram / 8192,
      wddm_flag_high_vram: vram > 7800 && !pages,
      wddm_flag_shared_pos: pages,
      extra_args: args,
      ok: true,
      time_total_sec: +(128 / tps + 80 / (tps * 6)).toFixed(2),
      headroom_mib: Math.max(0, 8192 - vram),
      ctx_size: ctx,
      kv_cache_mib: 50 * ctxRatio,
      ttft_sec:          hasExt ? +(0.3 + 0.02 * ctxRatio).toFixed(2) : null,
      gpu_power_peak_w:  hasExt ? Math.round(120 + 18 * Math.log2(ctxRatio + 1)) : null,
      gpu_temp_peak_c:   hasExt ? 62 + Math.round(ctxRatio) : null,
      gpu_util_avg_pct:  hasExt ? 88 + Math.round(ctxRatio) : null,
      ram_used_peak_mib: hasExt ? Math.round(1000 + 200 * ctxRatio) : null,
      ram_baseline_mib:  hasExt ? 600 : null,
      model_path:        `D:\\models\\${md.m.toLowerCase()}.gguf`,
      mmproj_path:       null,
    });
  }
}

// Engine winner = safety-first speed. Compute it here too so the
// "default bat" links in the rendered models list resolve.
const winnersByModel = {};
for (const d of DATA) {
  if (!d.ok || d.shared_peak_mib > 500) continue;
  if (!winnersByModel[d.model] || d.eval_tps > winnersByModel[d.model].eval_tps) {
    winnersByModel[d.model] = d;
  }
}
const WINNERS = Object.entries(winnersByModel).map(([model, w]) => ({
  model, winner_id: w.id, bat: model.replace(/[^\w.-]/g, "_") + ".bat",
}));

const CFG = {
  llama_server_exe: "C:\\Tools\\llama.cpp\\llama-server.exe",
  hardware: {
    gpu_name: "NVIDIA GeForce RTX 2070",
    vram_total_mib: 8192,
    gpu_compute_cap: "7.5",
    cpu_cores_physical: 6,
    cpu_threads_logical: 12,
    vram_safety_budget_mib: 7782,
  },
  wddm_detection: { shared_delta_confirm_mib: 500 },
};

await mkdir(OUT_DIR, { recursive: true });
const html = tpl
  .replace(/%%NOW%%/, new Date().toISOString().slice(0, 16).replace("T", " ") + " (demo)")
  .replace(/%%DATA%%/, JSON.stringify(DATA))
  .replace(/%%WINNERS%%/, JSON.stringify(WINNERS))
  .replace(/%%CFG%%/, JSON.stringify(CFG));

await writeFile(OUT_PATH, html, "utf8");
console.log(`wrote ${OUT_PATH} (${DATA.length} configs across ${MODELS.length} models)`);
