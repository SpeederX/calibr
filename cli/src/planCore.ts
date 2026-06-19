export interface PlanMeta {
  path: string;
  model: string;
  variant: string;
  series: string;
  size_mib: number;
  is_moe: boolean;
  mmproj?: string | null;
  mmproj_mib?: number | null;
  reasoning_mode?: string | null;
  template_note?: string | null;
  gguf_context_length?: number | null;
  gguf_architecture?: string | null;
}

export interface PlanConfig {
  hardware?: {
    vram_safety_budget_mib?: number | null;
    cpu_cores_physical?: number | null;
    cpu_threads_logical?: number | null;
  };
  planning?: {
    overhead_mib?: number | null;
    moecpu_sweep?: number[] | null;
    offload_sweep?: number[] | null;
  };
  context_candidates?: Array<{ ctx: number; kv: string }> | null;
  max_context_cap?: number | null;
  base_args?: string | null;
}

export interface CatalogEntry {
  id?: string;
  hf_file?: string;
  max_context?: number | null;
}

export interface Preset {
  label?: string;
  models?: "*" | string[];
  max_ctx?: number | null;
  context_sizes?: number[] | null;
}

export interface PlanOptions {
  model?: string | null;
  level?: string | null;
  contextSizes?: number[] | null;
  presetMaxCtx?: number | null;
  presetCtxSizes?: number[] | null;
}

export interface PlanItem {
  id: string;
  model_path: string;
  mmproj_path: string | null | undefined;
  model: string;
  variant: string;
  series: string;
  sweep: "context" | "moe-cpu" | "offload";
  level: string | null;
  reasoning_mode: string | null | undefined;
  template_note: string | null | undefined;
  gguf_context_length: number | null | undefined;
  gguf_architecture: string | null | undefined;
  workload_kind: "baseline" | "prefill" | "kv-fill";
  prefill_target_tokens: number;
  kv_fill_target_tokens: number;
  label: string;
  extra_args: string;
}

function asInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || "";
}

export function getSweepKind(meta: Pick<PlanMeta, "is_moe" | "size_mib" | "mmproj_mib">, cfg: PlanConfig): PlanItem["sweep"] {
  if (meta.is_moe) return "moe-cpu";
  const budget = asInt(cfg.hardware?.vram_safety_budget_mib);
  const overhead = asInt(cfg.planning?.overhead_mib);
  const needed = asInt(meta.size_mib) + asInt(meta.mmproj_mib) + overhead;
  return needed < budget ? "context" : "offload";
}

export function getCatalogLevelMap(catalog: CatalogEntry[], presets: Record<string, Preset>): Record<string, string> {
  const byId: Record<string, string> = {};
  for (const entry of catalog) {
    if (entry.id && entry.hf_file) byId[entry.id] = entry.hf_file;
  }
  const out: Record<string, string> = {};
  for (const level of ["low", "middle", "high", "ultra"]) {
    const preset = presets[level];
    if (!preset || preset.models === "*" || !Array.isArray(preset.models)) continue;
    for (const id of preset.models) {
      const file = byId[id];
      if (file) out[file.toLowerCase()] = level;
    }
  }
  return out;
}

export function getCatalogMaxContextMap(catalog: CatalogEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of catalog) {
    if (entry.hf_file && entry.max_context != null && entry.max_context > 0) {
      out[entry.hf_file.toLowerCase()] = asInt(entry.max_context);
    }
  }
  return out;
}

export function testCtxAllowedForModel(ctx: number, globalCap: number, perModelCap: number): boolean {
  if (globalCap > 0 && ctx > globalCap) return false;
  if (perModelCap > 0 && ctx > perModelCap) return false;
  return true;
}

export interface PlanWorkload {
  kind?: PlanItem["workload_kind"];
  prefillTokens?: number;
  kvFillTokens?: number;
}

export function planWorkloadIdentity(workload: PlanWorkload = {}): string {
  const kind = workload.kind ?? "baseline";
  if (kind === "baseline") return "";
  return `workload=${kind}_prefill=${asInt(workload.prefillTokens)}_kvfill=${asInt(workload.kvFillTokens)}`;
}

export function newPlanItem(
  meta: PlanMeta,
  sweep: PlanItem["sweep"],
  level: string | null,
  extraArgs: string,
  label: string,
  workload: PlanWorkload = {},
): PlanItem {
  const sanitizedModel = `${meta.model}_${meta.variant}`.replace(/[^\w]/g, "_").slice(0, 40);
  const workloadKind = workload.kind ?? "baseline";
  const workloadIdentity = planWorkloadIdentity(workload);
  const identityLabel = workloadIdentity ? `${label}_${workloadIdentity}` : label;
  const sanitizedLabel = identityLabel.replace(/[^\w]/g, "_").slice(0, 80);
  return {
    id: `${sanitizedModel}__${sanitizedLabel}`,
    model_path: meta.path,
    mmproj_path: meta.mmproj,
    model: meta.model,
    variant: meta.variant,
    series: meta.series,
    sweep,
    level,
    reasoning_mode: meta.reasoning_mode,
    template_note: meta.template_note,
    gguf_context_length: meta.gguf_context_length,
    gguf_architecture: meta.gguf_architecture,
    workload_kind: workloadKind,
    prefill_target_tokens: asInt(workload.prefillTokens),
    kv_fill_target_tokens: asInt(workload.kvFillTokens),
    label: `${meta.model} ${meta.variant} @ ${label}`,
    extra_args: extraArgs,
  };
}

export function invokePlan(
  catalog: PlanMeta[],
  cfg: PlanConfig,
  modelsCatalog: CatalogEntry[],
  presets: Record<string, Preset>,
  opts: PlanOptions = {},
): PlanItem[] {
  let globalCtxCap = asInt(cfg.max_context_cap);
  if (opts.presetMaxCtx && opts.presetMaxCtx > 0 && (globalCtxCap === 0 || opts.presetMaxCtx < globalCtxCap)) {
    globalCtxCap = opts.presetMaxCtx;
  }

  const threads = cfg.hardware?.cpu_cores_physical
    ? ` --threads ${cfg.hardware.cpu_cores_physical} --threads-batch ${cfg.hardware.cpu_threads_logical ?? cfg.hardware.cpu_cores_physical}`
    : "";
  const base = `${cfg.base_args ?? ""}${threads}`;
  const suffix = base ? ` ${base}` : "";
  const levelMap = getCatalogLevelMap(modelsCatalog, presets);
  const contextMap = getCatalogMaxContextMap(modelsCatalog);

  let ctxCandidates = cfg.context_candidates ?? [];
  const ctxOverride = opts.contextSizes?.length ? opts.contextSizes : (opts.presetCtxSizes?.length ? opts.presetCtxSizes : null);
  if (ctxOverride) {
    const kvByCtx: Record<number, string> = {};
    for (const candidate of cfg.context_candidates ?? []) kvByCtx[candidate.ctx] = candidate.kv;
    ctxCandidates = ctxOverride.map((ctx) => ({ ctx, kv: kvByCtx[ctx] ?? "q8_0" }));
  }

  const plan: PlanItem[] = [];
  for (const meta of catalog) {
    if (opts.model && !new RegExp(opts.model, "i").test(meta.model)) continue;

    const sweep = getSweepKind(meta, cfg);
    const name = baseName(meta.path).toLowerCase();
    const level = name && levelMap[name] ? levelMap[name] : null;
    if (opts.level && level !== opts.level) continue;

    const perModelCap = name && contextMap[name] ? contextMap[name] : asInt(meta.gguf_context_length);
    if (sweep === "context") {
      let modelCandidates = ctxCandidates;
      if (!ctxOverride && perModelCap > 0 && (globalCtxCap === 0 || perModelCap <= globalCtxCap)
        && !ctxCandidates.some((candidate) => candidate.ctx === perModelCap)) {
        const next = ctxCandidates.find((candidate) => candidate.ctx > perModelCap);
        const fallback = ctxCandidates.at(-1);
        modelCandidates = [...ctxCandidates, {
          ctx: perModelCap,
          kv: next?.kv ?? fallback?.kv ?? "q8_0",
        }].sort((a, b) => a.ctx - b.ctx);
      }
      for (const candidate of modelCandidates) {
        if (!testCtxAllowedForModel(candidate.ctx, globalCtxCap, perModelCap)) continue;
        const label = `ctx=${candidate.ctx}_kv=${candidate.kv}`;
        const args = `--ctx-size ${candidate.ctx} --gpu-layers 99 --cache-type-k ${candidate.kv} --cache-type-v ${candidate.kv}${suffix}`;
        plan.push(newPlanItem(meta, sweep, level, args, label));
      }
    } else if (sweep === "moe-cpu") {
      for (const n of cfg.planning?.moecpu_sweep ?? [28, 30, 32, 34, 36]) {
        const args = `--ctx-size 16384 --gpu-layers 99 --n-cpu-moe ${n} --cache-type-k q8_0 --cache-type-v q8_0${suffix}`;
        plan.push(newPlanItem(meta, sweep, level, args, `ncpumoe_${n}`));
      }
    } else {
      for (const n of cfg.planning?.offload_sweep ?? [20, 24, 28, 32, 36]) {
        const args = `--ctx-size 16384 --gpu-layers ${n} --cache-type-k q8_0 --cache-type-v q8_0${suffix}`;
        plan.push(newPlanItem(meta, sweep, level, args, `ngl_${n}`));
      }
    }
  }
  return plan;
}
