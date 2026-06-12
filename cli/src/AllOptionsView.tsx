import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
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
  traceAction,
  type LlamaServerCandidate,
  type TraceContext,
} from "./engine.js";
import { CustomBenchView } from "./CustomBenchView.js";

interface Props {
  onRun: (args: string[], label: string, trace?: TraceContext) => void;
  onCancel: () => void;
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

function next<T>(values: readonly T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

export type LlamaDecisionLike =
  | { kind: "download"; build: string }
  | { kind: "local"; path: string }
  | null;

export interface AllArgsOpts {
  decision: LlamaDecisionLike;
  fetchCatalog: boolean;
  model: string | null;
  customIds: string;
  currentPreset: string;
  runs: number;
  keepDownloads: boolean;
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
  if (o.fetchCatalog) { args.push("-FetchCatalog"); parts.push("-FetchCatalog"); }
  if (o.model) {
    args.push("-Model", o.model); parts.push(`-Model "${o.model}"`);
  } else if (o.fetchCatalog && o.customIds) {
    args.push("-CatalogId", o.customIds); parts.push(`-CatalogId "${o.customIds}"`);
  } else if (o.fetchCatalog && o.currentPreset !== "all" && o.currentPreset !== "custom") {
    args.push("-Preset", o.currentPreset); parts.push(`-Preset ${o.currentPreset}`);
  }
  if (o.contextSizes && o.contextSizes.length > 0) {
    const csv = o.contextSizes.join(",");
    args.push("-ContextSizes", csv); parts.push(`-ContextSizes ${csv}`);
  }
  if (o.runs > 0)        { args.push("-Runs", String(o.runs)); parts.push(`-Runs ${o.runs}`); }
  if (o.keepDownloads)   { args.push("-KeepDownloads");  parts.push("-KeepDownloads"); }
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
  | { kind: "gate"; required: number; available: number; entryCount: number; sufficient: boolean }
  | { kind: "cachePrompt" };

type LlamaDecision =
  | { kind: "download"; build: string }
  | { kind: "local"; path: string };

export function AllOptionsView({ onRun, onCancel }: Props) {
  // 'all' is the typical "I want everything" path; defaulting fetch on
  // matches what most users want (download the curated catalog + bench it).
  // Users with their own .gguf collections in scan_paths toggle it off
  // in one keystroke.
  const [fetchCatalog, setFetchCatalog] = useState<boolean>(true);
  const [keepDownloads, setKeepDownloads] = useState<boolean>(false);
  const [preferSpeed, setPreferSpeed] = useState<boolean>(false);
  const [minimalPolling, setMinimalPolling] = useState<boolean>(false);
  const [model, setModel] = useState<string | null>(null);
  const [runs, setRuns] = useState<number>(0);
  const [llamaDecision, setLlamaDecision] = useState<LlamaDecision | null>(null);
  const [llamaVersionInput, setLlamaVersionInput] = useState<string>("");
  const [llamaCandidates, setLlamaCandidates] = useState<LlamaServerCandidate[]>([]);
  const [llamaSourceCursor, setLlamaSourceCursor] = useState(0);
  const [llamaCursor, setLlamaCursor] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const catalog = useMemo(readModelCatalog, []);
  const cfg = useMemo(loadConfig, []);
  // Model filter spans every known model: discovered (on disk) ∪ curated.
  const models = useMemo<string[]>(() => {
    const names = new Set<string>(readDiscoveredModelNames());
    for (const e of catalog) if (e?.model) names.add(e.model);
    return [...names].sort();
  }, [catalog]);
  const modelChoices = useMemo<(string | null)[]>(() => [null, ...models], [models]);
  const runsDefault = useMemo<number>(() => {
    const v = cfg?.bench?.runs_per_config;
    return typeof v === "number" && v > 0 ? v : 3;
  }, [cfg]);
  const llamaConfigured = Boolean(cfg.llama_server_exe && existsSync(cfg.llama_server_exe));
  const llamaLabel = (() => {
    if (llamaConfigured) return `configured (${cfg.llama_server_exe})`;
    if (llamaDecision?.kind === "download") return llamaDecision.build ? `download ${llamaDecision.build}` : "download latest";
    if (llamaDecision?.kind === "local") return `use local (${llamaDecision.path})`;
    return "choose when missing";
  })();
  const destination = useMemo(() => downloadDestination(cfg), [cfg]);
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
    const builtin = ["all", "low", "middle", "high", "ultra"].filter(n => n === "all" || presets[n]);
    const extras = Object.keys(presets).filter(n => !builtin.includes(n)).sort();
    return [...builtin, ...extras, "custom"];
  }, [presets]);
  const [presetIdx, setPresetIdx] = useState<number>(() => {
    const starterIdx = presetNames.indexOf("low");
    return starterIdx >= 0 ? starterIdx : 0;
  });
  const currentPreset = presetNames[presetIdx];
  const presetCount = (() => {
    if (currentPreset === "custom") return null;
    const p = presets[currentPreset];
    if (!p) return null;
    if (p.models === "*") return catalog.length;
    return Array.isArray(p.models) ? p.models.length : 0;
  })();
  const presetLabel = (() => {
    if (currentPreset === "custom") return "custom (pick models)";
    const p = presets[currentPreset];
    if (!p) return currentPreset;
    return `${p.label} · ${presetCount ?? "?"} entries${p.max_ctx ? `, max ctx ${p.max_ctx}` : ""}`;
  })();

  const rows = [
    { kind: "llama"    as const, label: `llama.cpp:       ${llamaLabel}` },
    { kind: "fetch"    as const, label: `model catalog:   ${fetchCatalog ? "yes — fetch curated models from HuggingFace before bench" : "no  — only bench what's already in scan_paths"}` },
    { kind: "preset"   as const, label: `which models:    ${presetLabel}`, disabled: !fetchCatalog || model !== null },
    { kind: "model"    as const, label: `model filter:    ${model === null ? "all (use 'which models')" : model}` },
    { kind: "runs"     as const, label: `runs per config: ${runs === 0 ? `default (${runsDefault} from config)` : String(runs)}` },
    { kind: "rotate"   as const, label: `auto-cleanup:    ${keepDownloads ? "no  (keep downloaded models on disk after bench)" : "yes (delete each downloaded model when its bench finishes)"}` },
    { kind: "prefer"   as const, label: `winner rule:     ${preferSpeed ? "speed   (pick the fastest config even if it spills VRAM into RAM)" : "balanced (default — prefer configs that don't spill VRAM; speed breaks ties)"}` },
    { kind: "polling"  as const, label: `live metrics:    ${minimalPolling ? "minimal (lowest overhead; no GPU power / temp / RAM / disk strip)" : "full    (default — GPU/RAM/disk strip + extended fields in results)"}` },
    { kind: "run"      as const, label: "> start all" },
    { kind: "cancel"   as const, label: "  cancel" },
  ];

  // Custom selection (CustomBenchView) writes its result here; when set,
  // buildArgs ignores the named preset and passes -CatalogId with the
  // comma-list of picked catalog ids.
  const [customIds, setCustomIds] = useState<string>("");
  const [customCtxSizes, setCustomCtxSizes] = useState<number[] | null>(null);

  // Build args. rerunAll toggles -Force; chosen after the cache prompt
  // (or unconditionally false if the cache is empty and the prompt is skipped).
  const buildArgs = (rerunAll: boolean, decision: LlamaDecision | null = llamaDecision) =>
    buildAllArgs({ decision, fetchCatalog, model, customIds, currentPreset, runs, keepDownloads, preferSpeed, minimalPolling, rerunAll, contextSizes: customCtxSizes });

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
        fetchCatalog,
        preset: currentPreset,
        model,
        customIds,
        contextSizes: customCtxSizes,
        runs,
        keepDownloads,
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
    switch (row.kind) {
      case "llama":    setLlamaSourceCursor(0); setPhase({ kind: "llamaSource" }); break;
      case "fetch":    setFetchCatalog(!fetchCatalog); break;
      case "preset": {
        if (!fetchCatalog || model !== null) break;   // disabled when a model is fixed
        const nextIdx = (presetIdx + 1) % presetNames.length;
        setPresetIdx(nextIdx);
        // Stepping off 'custom' clears any prior custom selection so
        // subsequent runs use the named preset's expansion, not the
        // stale picked-ids list.
        if (presetNames[nextIdx] !== "custom" && customIds) setCustomIds("");
        break;
      }
      case "model":    setModel(next(modelChoices, model)); break;
      case "runs":     setRuns(next(ALL_RUNS_VALUES, runs)); break;
      case "rotate":   setKeepDownloads(!keepDownloads); break;
      case "prefer":   setPreferSpeed(!preferSpeed); break;
      case "polling":  setMinimalPolling(!minimalPolling); break;
      case "run": startRun(); break;
      case "cancel": onCancel(); break;
    }
  };

  useInput((input, key) => {
    // The custom phase delegates all input handling to CustomBenchView
    // (which has its own useInput inside) so we MUST not also consume
    // keystrokes here — otherwise the picker can't toggle.
    if (phase.kind === "custom") return;
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
              have {formatBytes(phase.available)}. Free up space or change scan_paths[0].
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
