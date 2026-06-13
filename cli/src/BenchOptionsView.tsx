import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { CALIBR_CATALOG, loadConfig, cachedResultsCount, readModelCatalog } from "./engine.js";
import type { DownloadRetention } from "./AllOptionsView.js";

interface Props {
  onRun: (args: string[], label: string) => void;
  onCancel: () => void;
}

interface CatalogEntry {
  model?: string;
}

// Models discovered on disk (data/catalog.json). These can be benched in place
// (no download needed). Returned as a Set for "is this model on disk?" checks.
function readDiscoveredModels(): Set<string> {
  const out = new Set<string>();
  if (!existsSync(CALIBR_CATALOG)) return out;
  try {
    let raw = readFileSync(CALIBR_CATALOG, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const arr = JSON.parse(raw) as CatalogEntry[];
    if (Array.isArray(arr)) for (const m of arr) if (m?.model) out.add(m.model);
  } catch { /* ignore */ }
  return out;
}

const LEVELS = ["all", "low", "middle", "high", "ultra"] as const;
type Level = (typeof LEVELS)[number];
const RUNS_VALUES: number[] = [0, 1, 3, 5];
const DOWNLOAD_RETENTION_VALUES = ["cleanup", "keep-all", "keep-top-3", "keep-top-1"] as const;

function next<T>(values: readonly T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

function retentionLabel(policy: DownloadRetention): string {
  switch (policy) {
    case "keep-all": return "keep all (store downloaded models in the model folder)";
    case "keep-top-3": return "keep top 3 results";
    case "keep-top-1": return "keep top 1 result";
    default: return "yes (delete each downloaded model when its configs finish)";
  }
}

export interface BenchArgsOpts {
  model: string | null;
  modelOnDisk: boolean;
  level: Level;
  runs: number;
  downloadRetention: DownloadRetention;
  minimalPolling: boolean;
  rerunAll: boolean;
}

// Pure arg builder (exported for tests). Scope resolution:
//   - a specific model on disk       -> -Model X           (bench in place)
//   - a specific model, curated only -> -Model X -Fetch    (download then bench)
//   - all models, a level chosen     -> -Level L -Fetch    (download + bench level)
//   - all models, level 'all'        -> (nothing)          (bench the existing plan)
export function buildBenchArgs(o: BenchArgsOpts): { args: string[]; label: string } {
  const args: string[] = ["bench"];
  const parts: string[] = [];
  if (o.model) {
    args.push("-Model", o.model); parts.push(`-Model "${o.model}"`);
    if (!o.modelOnDisk) { args.push("-Fetch"); parts.push("-Fetch"); }
  } else if (o.level !== "all") {
    args.push("-Level", o.level, "-Fetch"); parts.push(`-Level ${o.level}`, "-Fetch");
  }
  if (o.runs > 0) { args.push("-Runs", String(o.runs)); parts.push(`-Runs ${o.runs}`); }
  if (o.rerunAll) { args.push("-Force"); parts.push("-Force"); }
  if (o.downloadRetention !== "cleanup") {
    args.push("-DownloadRetention", o.downloadRetention);
    parts.push(`-DownloadRetention ${o.downloadRetention}`);
  }
  if (o.minimalPolling) { args.push("-MinimalPolling"); parts.push("-MinimalPolling"); }
  return { args, label: parts.length ? `bench ${parts.join(" ")}` : "bench" };
}

type Phase =
  | { kind: "form" }
  | { kind: "cachePrompt" };

export function BenchOptionsView({ onRun, onCancel }: Props) {
  // The model filter spans every model we know: discovered (on disk) ∪ curated
  // (models_catalog.json, downloadable). On-disk models bench in place; curated-
  // only models are fetched first (-Fetch). User-owned models live only in the
  // discovered set, so picking one always benches the local file.
  const discovered = useMemo(readDiscoveredModels, []);
  const models = useMemo<string[]>(() => {
    const names = new Set<string>(discovered);
    for (const e of readModelCatalog()) if (e?.model) names.add(e.model);
    return [...names].sort();
  }, [discovered]);
  const modelChoices = useMemo<(string | null)[]>(() => [null, ...models], [models]);
  const cachedCount = useMemo(cachedResultsCount, []);
  const configRunsDefault = useMemo<number>(() => {
    const cfg = loadConfig();
    const v = cfg?.bench?.runs_per_config;
    return typeof v === "number" && v > 0 ? v : 3;
  }, []);

  const [model, setModel] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>("all");
  const [runs, setRuns] = useState<number>(0);
  const [downloadRetention, setDownloadRetention] = useState<DownloadRetention>("cleanup");
  const [minimalPolling, setMinimalPolling] = useState<boolean>(false);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const runsLabel = runs === 0 ? `default (${configRunsDefault} from config)` : String(runs);
  const modelOnDisk = model !== null && discovered.has(model);
  // A specific model fixes the scope, so the level selector is inherited from it.
  const levelDisabled = model !== null;

  const levelLabel = levelDisabled
    ? `inherited from model`
    : level === "all"
      ? "all (bench what's on disk)"
      : `${level} — download + bench this level`;

  const modelLabel = model === null
    ? "all models"
    : modelOnDisk ? `${model}` : `${model} (will download)`;

  const rows = [
    { kind: "model" as const,   disabled: false,        label: `model filter:    ${modelLabel}` },
    { kind: "level" as const,   disabled: levelDisabled, label: `which models:    ${levelLabel}` },
    { kind: "runs" as const,    disabled: false,        label: `runs per config: ${runsLabel}` },
    { kind: "rotate" as const,  disabled: false,        label: `auto-cleanup:    ${retentionLabel(downloadRetention)}` },
    { kind: "polling" as const, disabled: false,        label: `live metrics:    ${minimalPolling ? "minimal (lowest overhead; no GPU power / temp / RAM / disk strip)" : "full    (default — GPU/RAM/disk strip + extended fields in results)"}` },
    { kind: "run" as const,     disabled: false,        label: "> start bench" },
    { kind: "cancel" as const,  disabled: false,        label: "  cancel" },
  ];

  const buildArgs = (rerunAll: boolean) =>
    buildBenchArgs({ model, modelOnDisk, level, runs, downloadRetention, minimalPolling, rerunAll });

  const activate = (i: number) => {
    const row = rows[i];
    if (row.disabled) return;
    switch (row.kind) {
      case "model":   setModel(next(modelChoices, model)); break;
      case "level":   setLevel(next(LEVELS, level)); break;
      case "runs":    setRuns(next(RUNS_VALUES, runs)); break;
      case "rotate":  setDownloadRetention(next(DOWNLOAD_RETENTION_VALUES, downloadRetention)); break;
      case "polling": setMinimalPolling(!minimalPolling); break;
      case "run": {
        if (cachedCount > 0) {
          setPhase({ kind: "cachePrompt" });
        } else {
          const { args, label } = buildArgs(false);
          onRun(args, label);
        }
        break;
      }
      case "cancel": onCancel(); break;
    }
  };

  useInput((input, key) => {
    if (phase.kind === "cachePrompt") {
      if (key.escape || input === "q") { setPhase({ kind: "form" }); return; }
      if (input === "y" || input === "Y") { const r = buildArgs(false); onRun(r.args, r.label); return; }
      if (input === "n" || input === "N") { const r = buildArgs(true); onRun(r.args, r.label); return; }
      return;
    }
    if (key.upArrow || input === "k") setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor(c => Math.min(rows.length - 1, c + 1));
    else if (key.return || input === " ") activate(cursor);
    else if (key.escape || input === "q") onCancel();
  });

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
      <Text bold color="cyan">bench — configure</Text>
      <Box marginTop={1}><Text dimColor>{models.length} models known ({discovered.size} on disk)</Text></Box>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => {
          const selected = i === cursor;
          if (row.disabled) {
            return (
              <Text key={row.kind} dimColor>
                {selected ? "> " : "  "}{row.label}
              </Text>
            );
          }
          return (
            <Text key={row.kind} color={selected ? "cyan" : undefined} inverse={selected}>
              {selected ? "> " : "  "}{row.label}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          a level (or a curated model not yet on disk) downloads first, then benches,
          deleting each model when its configs finish (peak disk ≈ one model).
        </Text>
        <Text dimColor>
          tip: close other apps before launching — parallel heavy workloads make results
          unreliable and can freeze the system if VRAM is already tight.
        </Text>
      </Box>
      <Box marginTop={1}><Text dimColor>↑/↓ move · enter cycles or runs · q/esc back</Text></Box>
    </Box>
  );
}
