import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  CALIBR_CATALOG,
  readModelCatalog,
  filterCatalog,
  downloadFootprintBytes,
  freeBytesOn,
  downloadDestination,
  formatBytes,
  loadConfig,
  cachedResultsCount,
  readPresetCatalog,
  findLlamaServerCandidates,
  normalizeLlamaBuildInput,
  pickFolderSync,
  traceAction,
  updateLocalConfigField,
  type CatalogEntry,
  type LlamaServerCandidate,
  type Preset,
  type TraceContext,
} from "./engine.js";
import { CustomBenchView } from "./CustomBenchView.js";

const SINGLE_MODEL_SCOPE = "single";

interface Props {
  onRun: (args: string[], label: string, trace?: TraceContext) => void;
  onCancel: () => void;
  session?: GuidedRunSession;
  onSessionChange?: (patch: Partial<GuidedRunSession>) => void;
}

// Model names discovered on disk (data/catalog.json), unioned with the curated
// catalog to give the guided-run model filter every model we know.
function readDiscoveredModelNames(): string[] {
  if (!existsSync(CALIBR_CATALOG)) return [];
  try {
    let raw = readFileSync(CALIBR_CATALOG, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const arr = JSON.parse(raw) as Array<{ model?: string }>;
    return Array.isArray(arr) ? arr.map(m => m?.model).filter((m): m is string => !!m) : [];
  } catch {
    return [];
  }
}

const ALL_RUNS_VALUES: number[] = [0, 1, 3, 5];
const DOWNLOAD_RETENTION_VALUES = ["cleanup", "keep-all", "keep-top-3", "keep-top-1"] as const;
export type DownloadRetention = (typeof DOWNLOAD_RETENTION_VALUES)[number];

function next<T>(values: readonly T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

function retentionLabel(policy: DownloadRetention): string {
  switch (policy) {
    case "keep-all": return "keep all (store downloaded models in the model folder)";
    case "keep-top-3": return "keep top 3 results";
    case "keep-top-1": return "keep top 1 result";
    default: return "yes (delete each downloaded model when its bench finishes)";
  }
}

export function modelNameFromGgufFileName(fileName: string): string {
  const base = fileName.replace(/\.gguf$/i, "");
  const patterns = [
    /^(.+?)[.-](UD-Q\d+_K_XL)$/i,
    /^(.+?)[.-](UD-Q\d+_K_M)$/i,
    /^(.+?)[.-](UD-Q\d+_K_S)$/i,
    /^(.+?)[.-](Q\d+_K_[A-Z]+)$/i,
    /^(.+?)[.-](Q\d+_\d+)$/i,
    /^(.+?)[.-](IQ\d+_[A-Z_]+)$/i,
    /^(.+?)[.-](BF16|F16|F32)$/i,
  ];
  for (const pattern of patterns) {
    const match = base.match(pattern);
    if (match?.[1]) return match[1];
  }
  return base;
}

export function scanLocalModelNames(root: string): string[] {
  if (!root.trim() || !existsSync(root)) return [];
  const stack = [root];
  const names = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry);
      try {
        const st = statSync(path);
        if (st.isDirectory()) stack.push(path);
        else if (st.isFile() && entry.toLowerCase().endsWith(".gguf")) names.add(modelNameFromGgufFileName(entry));
      } catch {
        // Ignore files that disappear or cannot be read during the scan.
      }
    }
  }
  return [...names].sort();
}

export function catalogModelNamesForScope(
  catalog: CatalogEntry[],
  presets: Record<string, Preset>,
  scope: string,
): string[] {
  const entries = (() => {
    if (scope === "all" || scope === SINGLE_MODEL_SCOPE || scope === "custom") return catalog;
    const preset = presets[scope];
    if (!preset) return catalog;
    if (preset.models === "*") return catalog;
    if (Array.isArray(preset.models)) return filterCatalog(catalog, { catalogId: preset.models.join(",") });
    return catalog;
  })();
  return [...new Set(entries.map(e => e.model).filter(Boolean))].sort();
}

function compactPath(path: string, max = 58): string {
  if (path.length <= max) return path;
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const tail = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    const prefix = /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 2) : "";
    return `${prefix}/.../${tail}`;
  }
  return `...${path.slice(Math.max(0, path.length - max + 3))}`;
}

export function countGgufModels(root: string): number {
  if (!root.trim() || !existsSync(root)) return 0;
  const stack = [root];
  let count = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = resolve(dir, entry);
      try {
        const st = statSync(path);
        if (st.isDirectory()) stack.push(path);
        else if (st.isFile() && entry.toLowerCase().endsWith(".gguf")) count++;
      } catch {
        // Ignore files that disappear or cannot be read during the scan.
      }
    }
  }
  return count;
}

export type LlamaDecisionLike =
  | { kind: "download"; build: string }
  | { kind: "local"; path: string }
  | null;

export interface AllArgsOpts {
  decision: LlamaDecisionLike;
  modelFolder: string;
  fetchCatalog: boolean;
  model: string | null;
  customIds: string;
  currentPreset: string;
  runs: number;
  downloadRetention: DownloadRetention;
  preferSpeed: boolean;
  minimalPolling: boolean;
  rerunAll: boolean;
  contextSizes?: number[] | null;
}

// Pure arg builder for `all` (exported for tests). A fixed model overrides the
// preset/custom pool (-Model narrows to it); otherwise custom picks or the named
// preset apply. -Runs passes the per-config run count through.
export function buildAllArgs(o: AllArgsOpts): { args: string[]; label: string } {
  const args: string[] = ["all"];
  const parts: string[] = [];
  if (o.decision?.kind === "download") {
    args.push("-AutoFetchLlama"); parts.push("-AutoFetchLlama");
    if (o.decision.build) { args.push("-LlamaCppBuild", o.decision.build); parts.push(`-LlamaCppBuild ${o.decision.build}`); }
  } else if (o.decision?.kind === "local") {
    args.push("-LlamaServer", o.decision.path); parts.push(`-LlamaServer "${o.decision.path}"`);
  }
  const folder = o.modelFolder.trim();
  if (folder) {
    args.push("-ScanPath", folder); parts.push(`-ScanPath "${folder}"`);
    if (o.fetchCatalog) {
      args.push("-Destination", folder); parts.push(`-Destination "${folder}"`);
    }
  }
  if (o.fetchCatalog) { args.push("-FetchCatalog"); parts.push("-FetchCatalog"); }
  if (o.model) {
    args.push("-Model", o.model); parts.push(`-Model "${o.model}"`);
  } else if (o.fetchCatalog && o.customIds) {
    args.push("-CatalogId", o.customIds); parts.push(`-CatalogId "${o.customIds}"`);
  } else if (o.fetchCatalog && o.currentPreset !== "all" && o.currentPreset !== "custom" && o.currentPreset !== SINGLE_MODEL_SCOPE) {
    args.push("-Preset", o.currentPreset); parts.push(`-Preset ${o.currentPreset}`);
  }
  if (o.contextSizes && o.contextSizes.length > 0) {
    const csv = o.contextSizes.join(",");
    args.push("-ContextSizes", csv); parts.push(`-ContextSizes ${csv}`);
  }
  if (o.runs > 0)        { args.push("-Runs", String(o.runs)); parts.push(`-Runs ${o.runs}`); }
  if (o.downloadRetention !== "cleanup") {
    args.push("-DownloadRetention", o.downloadRetention);
    parts.push(`-DownloadRetention ${o.downloadRetention}`);
  }
  if (o.rerunAll)        { args.push("-Force");          parts.push("-Force"); }
  if (o.preferSpeed)     { args.push("-PreferSpeed");    parts.push("-PreferSpeed"); }
  if (o.minimalPolling)  { args.push("-MinimalPolling"); parts.push("-MinimalPolling"); }
  return { args, label: parts.length ? `all ${parts.join(" ")}` : "all" };
}

// Three phases:
//   form        - user toggles options for `calibr all`
//   gate        - shown only when -DownloadSamples is on; pre-flight
//                 disk-space check the user must accept
//   cachePrompt - shown only when result JSONs exist in data/results/;
//                 user picks 'use cache' / 're-run all' / 'cancel'
type Phase =
  | { kind: "form" }
  | { kind: "custom" }   // CustomBenchView for model multi-pick
  | { kind: "llamaSource" }
  | { kind: "llamaDownloadVersion"; error?: string }
  | { kind: "llamaLocalPick" }
  | { kind: "llamaNoLocal" }
  | { kind: "modelFolderInput"; error?: string }
  | { kind: "modelFolderCreate"; path: string }
  | { kind: "modelFolderSaved"; path: string; count: number; created: boolean }
  | { kind: "gate"; required: number; available: number; entryCount: number; sufficient: boolean }
  | { kind: "cachePrompt" };

type LlamaDecision =
  | { kind: "download"; build: string }
  | { kind: "local"; path: string };

export interface GuidedRunSession {
  fetchCatalog?: boolean;
  modelFolder?: string;
  model?: string | null;
  currentPreset?: string;
  customIds?: string;
  customCtxSizes?: number[] | null;
  runs?: number;
  downloadRetention?: DownloadRetention;
  preferSpeed?: boolean;
  minimalPolling?: boolean;
  llamaDecision?: LlamaDecision | null;
}

export function AllOptionsView({ onRun, onCancel, session, onSessionChange }: Props) {
  // 'all' is the typical "I want everything" path; defaulting fetch on
  // matches what most users want (download the curated catalog + bench it).
  // Users with their own .gguf collections in the model folder toggle it off
  // in one keystroke.
  const [fetchCatalog, setFetchCatalog] = useState<boolean>(session?.fetchCatalog ?? true);
  const currentPath = process.cwd();
  const cfg = useMemo(loadConfig, []);
  const configuredModelFolder = useMemo(() => {
    const paths = cfg.scan_paths;
    return Array.isArray(paths) && paths.length > 0 && paths[0] ? paths[0] : "";
  }, [cfg]);
  const [modelFolder, setModelFolder] = useState<string>(() => session?.modelFolder || configuredModelFolder || currentPath);
  const [modelFolderDraft, setModelFolderDraft] = useState<string>("");
  const [downloadRetention, setDownloadRetention] = useState<DownloadRetention>(session?.downloadRetention ?? "cleanup");
  const [preferSpeed, setPreferSpeed] = useState<boolean>(session?.preferSpeed ?? false);
  const [minimalPolling, setMinimalPolling] = useState<boolean>(session?.minimalPolling ?? false);
  const [model, setModel] = useState<string | null>(session?.model ?? null);
  const [runs, setRuns] = useState<number>(session?.runs ?? 0);
  const [llamaDecision, setLlamaDecision] = useState<LlamaDecision | null>(session?.llamaDecision ?? null);
  const [llamaVersionInput, setLlamaVersionInput] = useState<string>("");
  const [llamaCandidates, setLlamaCandidates] = useState<LlamaServerCandidate[]>([]);
  const [llamaSourceCursor, setLlamaSourceCursor] = useState(0);
  const [llamaCursor, setLlamaCursor] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const catalog = useMemo(readModelCatalog, []);
  const destination = modelFolder.trim() || currentPath;
  const modelFolderDisplay = configuredModelFolder || modelFolder !== currentPath ? compactPath(destination) : "<CURRENT_PATH>";
  const localModels = useMemo<string[]>(() => scanLocalModelNames(destination), [destination]);
  const runsDefault = useMemo<number>(() => {
    const v = cfg?.bench?.runs_per_config;
    return typeof v === "number" && v > 0 ? v : 3;
  }, [cfg]);
  const llamaConfigured = Boolean(cfg.llama_server_exe && existsSync(cfg.llama_server_exe));
  const llamaLabel = (() => {
    if (llamaConfigured) return `configured (${compactPath(cfg.llama_server_exe ?? "")})`;
    if (llamaDecision?.kind === "download") return llamaDecision.build ? `download ${llamaDecision.build}` : "download latest";
    if (llamaDecision?.kind === "local") return `use local (${compactPath(llamaDecision.path)})`;
    return "choose when missing";
  })();
  const cachedCount = useMemo(cachedResultsCount, []);
  // Presets: built-in (default_bench_presets.json) + user-saved
  // (data/user_bench_presets.json) merged into one dict.
  const presets = useMemo(readPresetCatalog, []);
  // Cycle order: all, low, middle, high, ultra, then any extra user-saved presets,
  // then 'custom' as the last sentinel that routes to CustomBenchView.
  const presetNames = useMemo<string[]>(() => {
    // Keep 'all' as a non-custom fallback even if default_bench_presets.json is
    // missing/unreadable. A broken preset file should not dump a first-time
    // user straight into CustomBenchView.
    const builtin = ["all", SINGLE_MODEL_SCOPE, "low", "middle", "high", "ultra"].filter(n => n === "all" || n === SINGLE_MODEL_SCOPE || presets[n]);
    const extras = Object.keys(presets).filter(n => !builtin.includes(n)).sort();
    return [...builtin, ...extras, "custom"];
  }, [presets]);
  const [presetIdx, setPresetIdx] = useState<number>(() => {
    const rememberedIdx = session?.currentPreset ? presetNames.indexOf(session.currentPreset) : -1;
    if (rememberedIdx >= 0) return rememberedIdx;
    const starterIdx = presetNames.indexOf("low");
    return starterIdx >= 0 ? starterIdx : 0;
  });
  const currentPreset = presetNames[presetIdx] ?? "all";
  const singleModelMode = fetchCatalog && currentPreset === SINGLE_MODEL_SCOPE;
  const scopedCatalogModels = useMemo<string[]>(
    () => catalogModelNamesForScope(catalog, presets, currentPreset),
    [catalog, presets, currentPreset],
  );
  // In catalog mode, model selection is only enabled for the explicit single-model scope.
  // In local-folder mode, it lists local .gguf models found in the selected folder.
  const models = useMemo<string[]>(() => {
    if (!fetchCatalog) return localModels;
    if (currentPreset !== SINGLE_MODEL_SCOPE) return [];
    const names = new Set<string>(scopedCatalogModels);
    for (const name of readDiscoveredModelNames()) names.add(name);
    return [...names].sort();
  }, [currentPreset, fetchCatalog, localModels, scopedCatalogModels]);
  const modelChoices = useMemo<(string | null)[]>(() => [null, ...models], [models]);
  const modelRequired = singleModelMode && model === null;
  const presetCount = (() => {
    if (currentPreset === SINGLE_MODEL_SCOPE) return models.length;
    if (currentPreset === "custom") return null;
    const p = presets[currentPreset];
    if (!p) return null;
    if (p.models === "*") return catalog.length;
    return Array.isArray(p.models) ? p.models.length : 0;
  })();
  const presetLabel = (() => {
    if (currentPreset === SINGLE_MODEL_SCOPE) return "single model";
    if (currentPreset === "custom") return "custom (pick models)";
    const p = presets[currentPreset];
    if (!p) return currentPreset;
    return `${p.label} · ${presetCount ?? "?"} entries${p.max_ctx ? `, max ctx ${p.max_ctx}` : ""}`;
  })();

  const rows = [
    { kind: "llama"    as const, label: `llama.cpp:       ${llamaLabel}`, disabled: llamaConfigured },
    { kind: "folder"   as const, label: `local folder:    ${modelFolderDisplay}` },
    { kind: "fetch"    as const, label: `source:          ${fetchCatalog ? "catalog downloads" : "local folder"}` },
    { kind: "preset"   as const, label: `scope:           ${presetLabel}`, disabled: !fetchCatalog },
    { kind: "model"    as const, label: `model:           ${model === null ? (singleModelMode ? "choose one" : fetchCatalog ? "not used" : "all local models") : model}`, disabled: fetchCatalog && !singleModelMode },
    { kind: "runs"     as const, label: `runs per config: ${runs === 0 ? `default (${runsDefault} from config)` : String(runs)}` },
    { kind: "rotate"   as const, label: `auto-cleanup:    ${retentionLabel(downloadRetention)}` },
    { kind: "prefer"   as const, label: `winner rule:     ${preferSpeed ? "speed   (pick the fastest config even if it spills VRAM into RAM)" : "balanced (default — prefer configs that don't spill VRAM; speed breaks ties)"}` },
    { kind: "polling"  as const, label: `live metrics:    ${minimalPolling ? "minimal (lowest overhead; no GPU power / temp / RAM / disk strip)" : "full    (default — GPU/RAM/disk strip + extended fields in results)"}` },
    { kind: "run"      as const, label: modelRequired ? "> start all   (choose a model first)" : "> start all", disabled: modelRequired },
    { kind: "cancel"   as const, label: "  cancel" },
  ];

  // Custom selection (CustomBenchView) writes its result here; when set,
  // buildArgs ignores the named preset and passes -CatalogId with the
  // comma-list of picked catalog ids.
  const [customIds, setCustomIds] = useState<string>(session?.customIds ?? "");
  const [customCtxSizes, setCustomCtxSizes] = useState<number[] | null>(session?.customCtxSizes ?? null);

  // Build args. rerunAll toggles -Force; chosen after the cache prompt
  // (or unconditionally false if the cache is empty and the prompt is skipped).
  const buildArgs = (rerunAll: boolean, decision: LlamaDecision | null = llamaDecision) =>
    buildAllArgs({ decision, modelFolder: destination, fetchCatalog, model, customIds, currentPreset, runs, downloadRetention, preferSpeed, minimalPolling, rerunAll, contextSizes: customCtxSizes });

  const traceForRun = (rerunAll: boolean, decision: LlamaDecision | null = llamaDecision): TraceContext => {
    const setup = llamaConfigured
      ? "configured llama.cpp"
      : decision?.kind === "download"
        ? "llama.cpp download"
        : decision?.kind === "local"
          ? "local llama.cpp"
          : "llama.cpp unresolved";
    const modelScope = model
      ? `model ${model}`
      : currentPreset === "custom"
        ? `custom picks ${customIds || "(pending)"}`
        : `preset ${currentPreset}`;
    return {
      flow: "guided run",
      action: "start",
      message: `guided run > start (${setup}, ${fetchCatalog ? "catalog download enabled" : "local models only"}, ${modelScope})`,
      details: {
        setup,
        llamaDecision: decision,
        modelFolder: "<model_folder_dir>",
        fetchCatalog,
        preset: currentPreset,
        model,
        customIds,
        contextSizes: customCtxSizes,
        runs,
        downloadRetention,
        preferSpeed,
        minimalPolling,
        rerunAll,
      },
    };
  };

  // Decide which phase comes next after the user clears the current step.
  // Order: disk gate (if fetching) → cache prompt (if cache exists) →
  // launch.
  const advanceFromGate = () => {
    if (cachedCount > 0) {
      setPhase({ kind: "cachePrompt" });
    } else {
      const { args, label } = buildArgs(false);
      onRun(args, label, traceForRun(false));
    }
  };

  const catalogScopeForGate = (pickedIds?: string): typeof catalog => {
    // A fixed model narrows the footprint to that one model.
    if (model) return filterCatalog(catalog, { model });

    const ids = pickedIds ?? customIds;
    if (ids) return filterCatalog(catalog, { catalogId: ids });

    if (currentPreset !== "all" && currentPreset !== "custom") {
      const preset = presets[currentPreset];
      if (preset?.models === "*") return catalog;
      if (Array.isArray(preset?.models)) return filterCatalog(catalog, { catalogId: preset.models.join(",") });
    }

    return catalog;
  };

  const runGate = (pickedIds?: string) => {
    const filtered = catalogScopeForGate(pickedIds);
    const { maxFileBytes } = downloadFootprintBytes(filtered);
    const available = freeBytesOn(destination);
    const required = maxFileBytes;
    setPhase({
      kind: "gate",
      required,
      available,
      entryCount: filtered.length,
      sufficient: available < 0 ? false : available >= required,
    });
  };

  const startAfterLlamaSetup = (decision: LlamaDecision | null = llamaDecision) => {
    // A fixed model overrides the custom-picker route.
    if (fetchCatalog && !model && currentPreset === "custom" && !customIds) {
      setPhase({ kind: "custom" });
      return;
    }
    if (fetchCatalog) {
      runGate();
    } else if (cachedCount > 0) {
      setPhase({ kind: "cachePrompt" });
    } else {
      const { args, label } = buildArgs(false, decision);
      onRun(args, label, traceForRun(false, decision));
    }
  };

  const startRun = () => {
    if (!llamaConfigured && !llamaDecision) {
      setLlamaSourceCursor(0);
      setPhase({ kind: "llamaSource" });
      return;
    }
    startAfterLlamaSetup();
  };

  const submitDownloadVersion = () => {
    const build = normalizeLlamaBuildInput(llamaVersionInput);
    if (build === null) {
      traceAction({
        flow: "guided run",
        action: "llama.cpp download",
        status: "failed",
        message: "guided run > llama.cpp > download rejected: invalid build tag",
        details: { input: llamaVersionInput },
      });
      setPhase({ kind: "llamaDownloadVersion", error: "Use bNNNN or NNNN (1-4 digits), or leave empty for latest." });
      return;
    }
    const decision: LlamaDecision = { kind: "download", build };
    traceAction({
      flow: "guided run",
      action: "llama.cpp download",
      status: "selected",
      message: `guided run > llama.cpp > download selected (${build || "latest"})`,
      details: { build: build || "latest" },
    });
    setLlamaDecision(decision);
    onSessionChange?.({ llamaDecision: decision });
    startAfterLlamaSetup(decision);
  };

  const chooseLocalLlama = () => {
    const candidates = findLlamaServerCandidates();
    if (candidates.length === 0) {
      traceAction({
        flow: "guided run",
        action: "llama.cpp scan local",
        status: "failed",
        message: "guided run > llama.cpp > scan local found no llama-server",
      });
      setLlamaCandidates([]);
      setPhase({ kind: "llamaNoLocal" });
      return;
    }
    if (candidates.length === 1) {
      const decision: LlamaDecision = { kind: "local", path: candidates[0]!.path };
      traceAction({
        flow: "guided run",
        action: "llama.cpp scan local",
        status: "selected",
        message: "guided run > llama.cpp > scan local selected the only candidate",
        details: { path: decision.path, candidateCount: 1 },
      });
      setLlamaDecision(decision);
      onSessionChange?.({ llamaDecision: decision });
      startAfterLlamaSetup(decision);
      return;
    }
    traceAction({
      flow: "guided run",
      action: "llama.cpp scan local",
      status: "completed",
      message: `guided run > llama.cpp > scan local found ${candidates.length} candidates`,
      details: { candidateCount: candidates.length },
    });
    setLlamaCandidates(candidates);
    setLlamaCursor(0);
    setPhase({ kind: "llamaLocalPick" });
  };

  const activate = (i: number) => {
    const row = rows[i];
    if ((row as { disabled?: boolean }).disabled) return;
    switch (row.kind) {
      case "llama":    setLlamaSourceCursor(0); setPhase({ kind: "llamaSource" }); break;
      case "folder":   chooseModelFolder(); break;
      case "fetch": {
        const nextFetch = !fetchCatalog;
        const nextModel = nextFetch ? null : (model && localModels.includes(model) ? model : null);
        setFetchCatalog(nextFetch);
        if (nextModel !== model) setModel(nextModel);
        onSessionChange?.({ fetchCatalog: nextFetch, model: nextModel });
        break;
      }
      case "preset": {
        if (!fetchCatalog) break;
        const nextIdx = (presetIdx + 1) % presetNames.length;
        setPresetIdx(nextIdx);
        const nextPreset = presetNames[nextIdx] ?? "all";
        const nextModel = nextPreset === SINGLE_MODEL_SCOPE ? model : null;
        if (nextModel !== model) setModel(nextModel);
        onSessionChange?.({ currentPreset: nextPreset, model: nextModel });
        // Stepping off 'custom' clears any prior custom selection so
        // subsequent runs use the named preset's expansion, not the
        // stale picked-ids list.
        if (nextPreset !== "custom" && customIds) {
          setCustomIds("");
          onSessionChange?.({ customIds: "", customCtxSizes: null });
        }
        break;
      }
      case "model": {
        const nextModel = next(modelChoices, model);
        setModel(nextModel);
        onSessionChange?.({ model: nextModel });
        break;
      }
      case "runs": {
        const nextRuns = next(ALL_RUNS_VALUES, runs);
        setRuns(nextRuns);
        onSessionChange?.({ runs: nextRuns });
        break;
      }
      case "rotate": {
        const nextRetention = next(DOWNLOAD_RETENTION_VALUES, downloadRetention);
        setDownloadRetention(nextRetention);
        onSessionChange?.({ downloadRetention: nextRetention });
        break;
      }
      case "prefer": {
        const nextPrefer = !preferSpeed;
        setPreferSpeed(nextPrefer);
        onSessionChange?.({ preferSpeed: nextPrefer });
        break;
      }
      case "polling": {
        const nextPolling = !minimalPolling;
        setMinimalPolling(nextPolling);
        onSessionChange?.({ minimalPolling: nextPolling });
        break;
      }
      case "run": startRun(); break;
      case "cancel": onCancel(); break;
    }
  };

  function normalizedModelFolder(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "<CURRENT_PATH>") return currentPath;
    return resolve(trimmed);
  }

  function saveModelFolder(path: string, created: boolean) {
    const count = countGgufModels(path);
    const names = scanLocalModelNames(path);
    updateLocalConfigField("scan_paths", [path]);
    setModelFolder(path);
    if (!fetchCatalog && model && !names.includes(model)) {
      setModel(null);
      onSessionChange?.({ modelFolder: path, model: null });
    } else {
      onSessionChange?.({ modelFolder: path });
    }
    traceAction({
      flow: "guided run",
      action: "model folder",
      status: "completed",
      message: `guided run > model folder selected (${count} model${count === 1 ? "" : "s"} found)`,
      details: {
        modelFolder: "<model_folder_dir>",
        modelCount: count,
        created,
      },
    });
    setPhase({ kind: "modelFolderSaved", path, count, created });
  }

  function chooseModelFolder() {
    if (process.platform !== "win32") {
      setModelFolderDraft(modelFolderDisplay);
      setPhase({ kind: "modelFolderInput" });
      return;
    }
    const picked = pickFolderSync({
      description: "Select the folder containing local .gguf models",
      initialDir: destination,
    });
    if (!picked) {
      traceAction({
        flow: "guided run",
        action: "model folder",
        status: "cancelled",
        message: "guided run > model folder picker cancelled",
      });
      return;
    }
    saveModelFolder(picked, false);
  }

  useInput((input, key) => {
    // The custom phase delegates all input handling to CustomBenchView
    // (which has its own useInput inside) so we MUST not also consume
    // keystrokes here — otherwise the picker can't toggle.
    if (phase.kind === "custom") return;
    if (phase.kind === "modelFolderInput") {
      if (key.escape) { setPhase({ kind: "form" }); return; }
      if (key.return) {
        if (!modelFolderDraft.trim()) {
          setPhase({ kind: "modelFolderInput", error: "Type or paste a folder path, or press esc to cancel." });
          return;
        }
        const nextFolder = normalizedModelFolder(modelFolderDraft);
        if (!existsSync(nextFolder)) {
          traceAction({
            flow: "guided run",
            action: "model folder",
            status: "selected",
            message: "guided run > model folder missing; asking to create",
            details: { modelFolder: "<model_folder_dir>" },
          });
          setPhase({ kind: "modelFolderCreate", path: nextFolder });
          return;
        }
        try {
          if (!statSync(nextFolder).isDirectory()) {
            setPhase({ kind: "modelFolderInput", error: "That path exists but is not a folder." });
            return;
          }
        } catch {
          setPhase({ kind: "modelFolderInput", error: "Cannot read that path. Check permissions or choose another folder." });
          return;
        }
        saveModelFolder(nextFolder, false);
        return;
      }
      if (key.backspace || key.delete || input === "\u007f") {
        setModelFolderDraft(v => v.slice(0, -1));
        setPhase({ kind: "modelFolderInput" });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setModelFolderDraft(v => v + input);
        setPhase({ kind: "modelFolderInput" });
      }
      return;
    }
    if (phase.kind === "modelFolderCreate") {
      if (key.escape || input === "q" || input === "n" || input === "N") {
        traceAction({
          flow: "guided run",
          action: "model folder create",
          status: "cancelled",
          message: "guided run > model folder create cancelled",
          details: { modelFolder: "<model_folder_dir>" },
        });
        setPhase({ kind: "modelFolderInput" });
        return;
      }
      if (key.return || input === "y" || input === "Y") {
        try {
          mkdirSync(phase.path, { recursive: true });
          traceAction({
            flow: "guided run",
            action: "model folder create",
            status: "completed",
            message: "guided run > model folder create completed",
            details: { modelFolder: "<model_folder_dir>" },
          });
          saveModelFolder(phase.path, true);
        } catch (error) {
          traceAction({
            flow: "guided run",
            action: "model folder create",
            status: "failed",
            message: "guided run > model folder create failed",
            details: { modelFolder: "<model_folder_dir>", error: error instanceof Error ? error.message : String(error) },
          });
          setPhase({ kind: "modelFolderInput", error: "Could not create that folder. Check the path or permissions." });
        }
      }
      return;
    }
    if (phase.kind === "modelFolderSaved") {
      setPhase({ kind: "form" });
      return;
    }
    if (phase.kind === "llamaSource") {
      if (key.escape || input === "q") { setPhase({ kind: "form" }); return; }
      if (key.upArrow || input === "k") { setLlamaSourceCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow || input === "j") { setLlamaSourceCursor(c => Math.min(2, c + 1)); return; }
      if (key.return || input === " ") {
        if (llamaSourceCursor === 0) {
          setLlamaVersionInput("");
          setPhase({ kind: "llamaDownloadVersion" });
        } else if (llamaSourceCursor === 1) {
          chooseLocalLlama();
        } else {
          setPhase({ kind: "form" });
        }
      }
      return;
    }
    if (phase.kind === "llamaDownloadVersion") {
      if (key.escape) { setLlamaSourceCursor(0); setPhase({ kind: "llamaSource" }); return; }
      if (key.return) { submitDownloadVersion(); return; }
      if (key.backspace || key.delete) {
        setLlamaVersionInput(v => v.slice(0, -1));
        setPhase({ kind: "llamaDownloadVersion" });
        return;
      }
      if (input && /^[bB0-9]+$/.test(input)) {
        setLlamaVersionInput(v => (v + input).slice(0, 5));
        setPhase({ kind: "llamaDownloadVersion" });
      }
      return;
    }
    if (phase.kind === "llamaLocalPick") {
      if (key.escape || input === "q") { setLlamaSourceCursor(1); setPhase({ kind: "llamaSource" }); return; }
      if (key.upArrow || input === "k") { setLlamaCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow || input === "j") { setLlamaCursor(c => Math.min(llamaCandidates.length - 1, c + 1)); return; }
      if (key.return || input === " ") {
        const picked = llamaCandidates[llamaCursor];
        if (picked) {
          const decision: LlamaDecision = { kind: "local", path: picked.path };
          traceAction({
            flow: "guided run",
            action: "llama.cpp pick local",
            status: "selected",
            message: "guided run > llama.cpp > pick local selected candidate",
            details: { path: picked.path, label: picked.label },
          });
          setLlamaDecision(decision);
          onSessionChange?.({ llamaDecision: decision });
          startAfterLlamaSetup(decision);
        }
      }
      return;
    }
    if (phase.kind === "llamaNoLocal") {
      if (key.escape || input === "q") { setLlamaSourceCursor(1); setPhase({ kind: "llamaSource" }); return; }
      if (input === "d" || input === "D" || key.return) {
        setLlamaVersionInput("");
        setPhase({ kind: "llamaDownloadVersion" });
      }
      return;
    }
    if (phase.kind === "gate") {
      if (key.escape || input === "q" || input === "n" || input === "N") {
        setPhase({ kind: "form" });
        return;
      }
      if (phase.sufficient && (key.return || input === "y" || input === "Y" || input === " ")) {
        advanceFromGate();
      }
      return;
    }
    if (phase.kind === "cachePrompt") {
      if (key.escape || input === "q") { setPhase({ kind: "form" }); return; }
      if (input === "y" || input === "Y") {
        const r = buildArgs(false);
        onRun(r.args, r.label, traceForRun(false));
        return;
      }
      if (input === "n" || input === "N") {
        const r = buildArgs(true);
        onRun(r.args, r.label, traceForRun(true));
        return;
      }
      return;
    }
    if (key.upArrow || input === "k") setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor(c => Math.min(rows.length - 1, c + 1));
    else if (key.return || input === " ") activate(cursor);
    else if (key.escape || input === "q") onCancel();
  });

  if (phase.kind === "llamaSource") {
    const sourceRows = [
      "download official llama.cpp",
      "scan existing llama-server",
      "back",
    ];
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">llama.cpp setup</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>llama_server_exe is not configured. Choose how guided run should continue.</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {sourceRows.map((label, i) => {
            const selected = i === llamaSourceCursor;
            return (
              <Text key={label} color={selected ? "cyan" : undefined} inverse={selected}>
                {selected ? "> " : "  "}{label}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}><Text dimColor>up/down to move | enter to select | q/esc back</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "modelFolderInput") {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">model folder</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Paste or type the folder that contains local .gguf files.</Text>
          <Text dimColor>Catalog downloads are also stored here when you choose to keep them.</Text>
          <Text dimColor>Use <Text color="cyan">&lt;CURRENT_PATH&gt;</Text> for the folder where calibr was launched.</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text>path: <Text color="cyan">{modelFolderDraft || "(empty)"}</Text></Text>
          {phase.error && <Text color="red">{phase.error}</Text>}
        </Box>
        <Box marginTop={1}><Text dimColor>enter saves | backspace edits | esc cancels</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "modelFolderCreate") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">model folder does not exist</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>calibr could not find this folder:</Text>
          <Text color="cyan">{phase.path}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>Create it now? <Text color="cyan">[y/n]</Text></Text>
        </Box>
        <Box marginTop={1}><Text dimColor>enter/y creates | n/q/esc back</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "modelFolderSaved") {
    return (
      <Box flexDirection="column">
        <Text bold color="green">model folder saved</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>folder: <Text color="cyan">{phase.path}</Text></Text>
          <Text>
            In the path provided, we found <Text color="cyan">{phase.count}</Text>{" "}
            model{phase.count === 1 ? "" : "s"} available.
          </Text>
          {phase.created && <Text dimColor>The folder was created because it did not exist.</Text>}
        </Box>
        <Box marginTop={1}><Text dimColor>press any key to return</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "llamaDownloadVersion") {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">download llama.cpp</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>build tag: <Text color="cyan">{llamaVersionInput || "(latest)"}</Text></Text>
          <Text dimColor>Enter bNNNN or NNNN, 1-4 digits. Leave empty for latest.</Text>
          {phase.error && <Text color="red">{phase.error}</Text>}
        </Box>
        <Box marginTop={1}><Text dimColor>type build | enter continue | backspace edit | esc back</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "llamaLocalPick") {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">choose local llama-server</Text>
        <Box marginTop={1} flexDirection="column">
          {llamaCandidates.map((candidate, i) => {
            const selected = i === llamaCursor;
            return (
              <Text key={candidate.path} color={selected ? "cyan" : undefined} inverse={selected}>
                {selected ? "> " : "  "}{candidate.label}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}><Text dimColor>up/down to move | enter to use | q/esc back</Text></Box>
      </Box>
    );
  }

  if (phase.kind === "llamaNoLocal") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">no local llama-server found</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>calibr did not find llama-server on PATH, in its llama-bin folder, or nearby folders.</Text>
          <Text>Press <Text color="cyan">enter</Text> to download official llama.cpp, or <Text color="cyan">q</Text> to go back.</Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "gate") {
    const sufficient = phase.sufficient;
    return (
      <Box flexDirection="column">
        <Text bold color={sufficient ? "yellow" : "red"}>pre-flight: download space check</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>destination: <Text color="cyan">{destination}</Text></Text>
          <Text>catalog entries in scope: <Text color="cyan">{phase.entryCount}</Text></Text>
          <Text>peak working-set (largest single file): <Text color="cyan">{formatBytes(phase.required)}</Text></Text>
          <Text>free on destination: <Text color={sufficient ? "green" : "red"}>{formatBytes(phase.available)}</Text></Text>
        </Box>
        <Box marginTop={1}>
          {sufficient ? (
            <Text color="yellow">
              Rotation will hold up to {formatBytes(phase.required)} on disk at peak (one
              model at a time). Proceed?
            </Text>
          ) : (
            <Text color="red">
              Not enough free space on {destination}: need {formatBytes(phase.required)},
              have {formatBytes(phase.available)}. Free up space or change the model folder.
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {sufficient ? "y/enter to proceed · n/esc to back out" : "esc/q to go back"}
          </Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "custom") {
    return (
      <CustomBenchView
        onSubmit={(idList, ctxSizes) => {
          setCustomIds(idList);
          setCustomCtxSizes(ctxSizes && ctxSizes.length > 0 ? ctxSizes : null);
          onSessionChange?.({ customIds: idList, customCtxSizes: ctxSizes && ctxSizes.length > 0 ? ctxSizes : null });
          // After picking, go straight to the disk gate; the user already
          // accepted the form's other choices when they hit '> start all'.
          runGate(idList);
        }}
        onCancel={() => setPhase({ kind: "form" })}
      />
    );
  }

  if (phase.kind === "cachePrompt") {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          {cachedCount} cached result{cachedCount === 1 ? "" : "s"} found in data\results\.
        </Text>
        <Box marginTop={1}>
          <Text>
            Use the cached results and only bench the new configs?{" "}
            <Text color="cyan">[y/n]</Text>
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>y = use cache, bench only new · n = re-run every config from scratch · q/esc = back</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">all — configure</Text>
      <Box marginTop={1}><Text dimColor>destination: {destination}</Text></Box>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => {
          const selected = i === cursor;
          const isDisabled = (row as { disabled?: boolean }).disabled === true;
          return (
            <Text key={row.kind} color={selected ? "cyan" : undefined} inverse={selected} dimColor={isDisabled}>
              {selected ? "> " : "  "}{row.label}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          tip: close other apps before launching. results are not reliable when heavy workloads
          (video rendering, builds, games, large downloads) run in parallel, and the bench
          can freeze the system if VRAM is already tight.
        </Text>
        <Text dimColor>
          calibr uses ~150 MB RAM and 1–3% CPU on a polling thread, and does NOT touch the GPU.
        </Text>
      </Box>
      <Box marginTop={1}><Text dimColor>↑/↓ move · enter cycles or runs · q/esc back</Text></Box>
    </Box>
  );
}
