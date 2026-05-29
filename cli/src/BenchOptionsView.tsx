import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { CALIBR_CATALOG } from "./engine.js";

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

function next<T>(values: T[], current: T): T {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length];
}

function fmt(s: string | null, fallback: string): string {
  return s === null || s === "" ? fallback : s;
}

export function BenchOptionsView({ onRun, onCancel }: Props) {
  const models = useMemo(readCatalogModels, []);
  const modelChoices = useMemo<(string | null)[]>(() => [null, ...models], [models]);
  const [model, setModel] = useState<string | null>(null);
  const [tier, setTier] = useState<"" | "A" | "B" | "C">("");
  const [runs, setRuns] = useState<number>(0);
  const [force, setForce] = useState<boolean>(false);
  const [keepDownloads, setKeepDownloads] = useState<boolean>(false);
  const [cursor, setCursor] = useState(0);

  const rows = [
    { kind: "model" as const,    label: `model:   ${fmt(model, "all (no filter)")}` },
    { kind: "tier" as const,     label: `tier:    ${fmt(tier, "all")}` },
    { kind: "runs" as const,     label: `runs:    ${runs === 0 ? "default (config)" : String(runs)}` },
    { kind: "force" as const,    label: `force:   ${force ? "yes (re-run completed configs)" : "no (skip cached)"}` },
    { kind: "rotate" as const,   label: `rotate:  ${keepDownloads ? "no (keep downloaded files)" : "yes (delete each model after its configs succeed)"}` },
    { kind: "run" as const,      label: "> start bench" },
    { kind: "cancel" as const,   label: "  cancel" },
  ];

  const activate = (i: number) => {
    const row = rows[i];
    switch (row.kind) {
      case "model":  setModel(next(modelChoices, model)); break;
      case "tier":   setTier(next(TIERS, tier)); break;
      case "runs":   setRuns(next(RUNS_VALUES, runs)); break;
      case "force":  setForce(!force); break;
      case "rotate": setKeepDownloads(!keepDownloads); break;
      case "run": {
        const args: string[] = ["bench"];
        if (model) args.push("-Model", model);
        if (tier) args.push("-Tier", tier);
        if (runs > 0) args.push("-Runs", String(runs));
        if (force) args.push("-Force");
        if (keepDownloads) args.push("-KeepDownloads");
        const parts: string[] = [];
        if (model) parts.push(`-Model "${model}"`);
        if (tier) parts.push(`-Tier ${tier}`);
        if (runs > 0) parts.push(`-Runs ${runs}`);
        if (force) parts.push("-Force");
        if (keepDownloads) parts.push("-KeepDownloads");
        const label = parts.length ? `bench ${parts.join(" ")}` : "bench";
        onRun(args, label);
        break;
      }
      case "cancel": onCancel(); break;
    }
  };

  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow || input === "j") setCursor(c => Math.min(rows.length - 1, c + 1));
    else if (key.return || input === " ") activate(cursor);
    else if (key.escape || input === "q") onCancel();
  });

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
      <Box marginTop={1}><Text dimColor>↑/↓ move · enter cycles or runs · q/esc back</Text></Box>
    </Box>
  );
}
