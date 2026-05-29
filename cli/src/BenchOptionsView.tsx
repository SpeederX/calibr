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
  | { kind: "cachePrompt"; pendingArgs: string[]; pendingLabel: string; cursor: number };

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
    return { args, label: parts.length ? `bench ${parts.join(" ")}` : "bench" };
  };

  const activate = (i: number) => {
    const row = rows[i];
    switch (row.kind) {
      case "model":  setModel(next(modelChoices, model)); break;
      case "tier":   setTier(next(TIERS, tier)); break;
      case "runs":   setRuns(next(RUNS_VALUES, runs)); break;
      case "rotate": setKeepDownloads(!keepDownloads); break;
      case "run": {
        // If there are no cached results, launch immediately with the
        // 'use cache' shape (no -Force). Otherwise route through the
        // cache prompt so the user makes the choice explicitly.
        if (cachedCount > 0) {
          const built = buildArgs(false);
          setPhase({ kind: "cachePrompt", pendingArgs: built.args, pendingLabel: built.label, cursor: 0 });
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
      const choices: Array<"use" | "rerun" | "cancel"> = ["use", "rerun", "cancel"];
      if (key.upArrow)        { setPhase({ ...phase, cursor: Math.max(0, phase.cursor - 1) }); return; }
      if (key.downArrow)      { setPhase({ ...phase, cursor: Math.min(choices.length - 1, phase.cursor + 1) }); return; }
      if (key.escape || input === "q") { setPhase({ kind: "form" }); return; }
      if (key.return || input === " ") {
        const choice = choices[phase.cursor];
        if (choice === "cancel")     { setPhase({ kind: "form" }); return; }
        if (choice === "use")        { onRun(phase.pendingArgs, phase.pendingLabel); return; }
        if (choice === "rerun")      { const r = buildArgs(true); onRun(r.args, r.label); return; }
      }
      return;
    }
    if (key.upArrow || input === "k") setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor(c => Math.min(rows.length - 1, c + 1));
    else if (key.return || input === " ") activate(cursor);
    else if (key.escape || input === "q") onCancel();
  });

  if (phase.kind === "cachePrompt") {
    const promptRows = [
      { label: `use cache (skip ${cachedCount} cached result${cachedCount === 1 ? "" : "s"}, only bench new configs)` },
      { label: `re-run all (force fresh runs for everything; overrides the cache)` },
      { label: `cancel (back to the form)` },
    ];
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">cache found</Text>
        <Box marginTop={1}>
          <Text>
            {cachedCount} result file{cachedCount === 1 ? "" : "s"} already in <Text color="cyan">data\results\</Text>.
            Configs that match will be skipped unless you re-run all.
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {promptRows.map((row, i) => {
            const selected = i === phase.cursor;
            return (
              <Text key={i} color={selected ? "cyan" : undefined} inverse={selected}>
                {selected ? "> " : "  "}{row.label}
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}><Text dimColor>↑/↓ move · enter to choose · q/esc back to form</Text></Box>
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
