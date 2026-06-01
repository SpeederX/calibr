import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { CALIBR_CATALOG, loadConfig, cachedResultsCount } from "./engine.js";

interface Props {
  onRun: (args: string[], label: string) => void;
  onCancel: () => void;
}

interface CatalogEntry {
  model?: string;
  tier?: "A" | "B" | "C" | string;
}

function readCatalogModels(): string[] {
  if (!existsSync(CALIBR_CATALOG)) return [];
  try {
    let raw = readFileSync(CALIBR_CATALOG, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const arr = JSON.parse(raw) as CatalogEntry[];
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of arr) {
      if (m?.model && !seen.has(m.model)) {
        seen.add(m.model);
        out.push(m.model);
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

const TIERS: Array<"" | "A" | "B" | "C"> = ["", "A", "B", "C"];
const RUNS_VALUES: number[] = [0, 1, 3, 5];

// Short summary of what each tier means; mirrors the engine's tier
// classification in calibr.ps1 Get-Tier and Invoke-Plan.
const TIER_DESCRIPTIONS: Record<string, string> = {
  "":  "all tiers",
  "A": "A — fits fully on GPU; sweep (ctx_size, KV quant) pairs",
  "B": "B — MoE; sweep --n-cpu-moe values",
  "C": "C — partial offload required; sweep --gpu-layers values",
};

function next<T>(values: T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

function fmt(s: string | null, fallback: string): string {
  return s === null || s === "" ? fallback : s;
}

type Phase =
  | { kind: "form" }
  | { kind: "cachePrompt" };

export function BenchOptionsView({ onRun, onCancel }: Props) {
  const models = useMemo(readCatalogModels, []);
  const modelChoices = useMemo<(string | null)[]>(() => [null, ...models], [models]);
  const cachedCount = useMemo(cachedResultsCount, []);
  // Read the engine's default runs-per-config so the form shows the actual
  // value (e.g. 3) instead of just saying 'default (config)'.
  const configRunsDefault = useMemo<number>(() => {
    const cfg = loadConfig();
    const v = cfg?.bench?.runs_per_config;
    return typeof v === "number" && v > 0 ? v : 3;
  }, []);
  const [model, setModel] = useState<string | null>(null);
  const [tier, setTier] = useState<"" | "A" | "B" | "C">("");
  const [runs, setRuns] = useState<number>(0);
  const [keepDownloads, setKeepDownloads] = useState<boolean>(false);
  const [minimalPolling, setMinimalPolling] = useState<boolean>(false);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const runsLabel = runs === 0
    ? `default (${configRunsDefault} from config)`
    : String(runs);

  const rows = [
    { kind: "model" as const,    label: `model:   ${fmt(model, "all (no filter)")}` },
    { kind: "tier" as const,     label: `tier:    ${TIER_DESCRIPTIONS[tier] ?? tier}` },
    { kind: "runs" as const,     label: `runs:    ${runsLabel}` },
    { kind: "rotate" as const,   label: `rotate:  ${keepDownloads ? "no (keep downloaded files)" : "yes (delete each model after its configs succeed)"}` },
    { kind: "polling" as const,  label: `polling: ${minimalPolling ? "minimal (lowest overhead, no live strip / power / RAM / disk)" : "full (default — live metrics strip + extended fields in results)"}` },
    { kind: "run" as const,      label: "> start bench" },
    { kind: "cancel" as const,   label: "  cancel" },
  ];

  // Build the args for the engine. The cache choice (use cache vs re-run all)
  // is made AFTER form submit, via the cachePrompt phase, and decides whether
  // we tack on -Force or not.
  const buildArgs = (rerunAll: boolean): { args: string[]; label: string } => {
    const args: string[] = ["bench"];
    const parts: string[] = [];
    if (model) { args.push("-Model", model); parts.push(`-Model "${model}"`); }
    if (tier) { args.push("-Tier", tier); parts.push(`-Tier ${tier}`); }
    if (runs > 0) { args.push("-Runs", String(runs)); parts.push(`-Runs ${runs}`); }
    if (rerunAll) { args.push("-Force"); parts.push("-Force"); }
    if (keepDownloads) { args.push("-KeepDownloads"); parts.push("-KeepDownloads"); }
    if (minimalPolling) { args.push("-MinimalPolling"); parts.push("-MinimalPolling"); }
    return { args, label: parts.length ? `bench ${parts.join(" ")}` : "bench" };
  };

  const activate = (i: number) => {
    const row = rows[i];
    switch (row.kind) {
      case "model":  setModel(next(modelChoices, model)); break;
      case "tier":   setTier(next(TIERS, tier)); break;
      case "runs":   setRuns(next(RUNS_VALUES, runs)); break;
      case "rotate":  setKeepDownloads(!keepDownloads); break;
      case "polling": setMinimalPolling(!minimalPolling); break;
      case "run": {
        // No cache → launch immediately. Cache present → ask y/n.
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
      if (input === "y" || input === "Y") {
        const r = buildArgs(false);
        onRun(r.args, r.label);
        return;
      }
      if (input === "n" || input === "N") {
        const r = buildArgs(true);
        onRun(r.args, r.label);
        return;
      }
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
      <Box marginTop={1}><Text dimColor>{models.length} models in catalog</Text></Box>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => {
          const selected = i === cursor;
          return (
            <Text key={row.kind} color={selected ? "cyan" : undefined} inverse={selected}>
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
