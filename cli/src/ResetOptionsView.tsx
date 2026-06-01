import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CALIBR_DATA_DIR,
  CALIBR_LOCAL_CFG,
} from "./engine.js";

interface Props {
  onRun: (args: string[], label: string) => void;
  onCancel: () => void;
}

// Each row in the form maps to one engine -flag. The 'count' / 'size'
// fields are filled in at mount time so the user can see how much state
// they'd be deleting before they pick.
interface Bucket {
  flag: string;          // PowerShell switch: '-Results', '-Catalog', ...
  label: string;         // short label in the form
  hint: string;          // one-line explanation
  exists: boolean;       // true → toggling has real effect
  countLabel: string;    // human-readable size / count summary
}

function readBuckets(): Bucket[] {
  const resultsDir   = join(CALIBR_DATA_DIR, "results");
  const logsDir      = join(CALIBR_DATA_DIR, "logs");
  const batsDir      = join(CALIBR_DATA_DIR, "bats");
  const catalogFile  = join(CALIBR_DATA_DIR, "catalog.json");
  const planFile     = join(CALIBR_DATA_DIR, "plan.json");
  const reportFile   = join(CALIBR_DATA_DIR, "report.html");
  const downloadsFile = join(CALIBR_DATA_DIR, "downloads.json");

  const countFiles = (dir: string, ext: string): number => {
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter(f => f.endsWith(ext)).length; }
    catch { return 0; }
  };
  const fileExists = (p: string) => { try { return existsSync(p); } catch { return false; } };
  const totalSizeGB = (paths: string[]): number => {
    let total = 0;
    for (const p of paths) {
      try { total += statSync(p).size; } catch {}
    }
    return total / (1024 ** 3);
  };

  // For DownloadedModels, read the manifest to know how many .gguf files
  // would be removed and how much disk that frees.
  let dlCount = 0;
  let dlGB = 0;
  if (fileExists(downloadsFile)) {
    try {
      const raw = readFileSync(downloadsFile, "utf8");
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const paths: string[] = [];
      for (const e of arr) {
        if (e?.model_path) paths.push(e.model_path);
        if (e?.mmproj_path) paths.push(e.mmproj_path);
      }
      dlCount = paths.filter(fileExists).length;
      dlGB = totalSizeGB(paths);
    } catch {}
  }

  const reportsArchiveDir = join(CALIBR_DATA_DIR, "reports");
  const results = countFiles(resultsDir, ".json");
  const logs    = countFiles(logsDir, ".log");
  const bats    = countFiles(batsDir, ".bat");
  const archived = countFiles(reportsArchiveDir, ".html");

  const reportCountParts: string[] = [];
  if (fileExists(reportFile)) reportCountParts.push("current present");
  if (archived > 0)            reportCountParts.push(`${archived} archived`);
  const reportLabel = reportCountParts.length > 0 ? reportCountParts.join(" + ") : "absent";

  return [
    { flag: "-Results",          label: "results",           hint: "data/results/*.json — bench cache",         exists: results > 0, countLabel: `${results} file${results === 1 ? "" : "s"}` },
    { flag: "-Catalog",          label: "catalog",           hint: "data/catalog.json — model index",            exists: fileExists(catalogFile), countLabel: fileExists(catalogFile) ? "present" : "absent" },
    { flag: "-Plan",             label: "plan",              hint: "data/plan.json — expanded bench configs",    exists: fileExists(planFile), countLabel: fileExists(planFile) ? "present" : "absent" },
    { flag: "-Report",           label: "report (+archive)", hint: "data/report.html + data/reports/*.html — current + auto-archived past reports", exists: fileExists(reportFile) || archived > 0, countLabel: reportLabel },
    { flag: "-Logs",             label: "logs",              hint: "data/logs/*.log — llama-server stderr",      exists: logs > 0, countLabel: `${logs} file${logs === 1 ? "" : "s"}` },
    { flag: "-Bats",             label: "bats",              hint: "data/bats/*.bat — winner launchers",         exists: bats > 0, countLabel: `${bats} file${bats === 1 ? "" : "s"}` },
    { flag: "-Downloads",        label: "downloads manifest",hint: "data/downloads.json — rotation tracking",    exists: fileExists(downloadsFile), countLabel: fileExists(downloadsFile) ? "present" : "absent" },
    { flag: "-DownloadedModels", label: "downloaded models", hint: "the .gguf+mmproj files calibr fetched (user-owned files NEVER touched)", exists: dlCount > 0, countLabel: dlCount > 0 ? `${dlCount} files, ~${dlGB.toFixed(1)} GB` : "none tracked" },
    { flag: "-LocalConfig",      label: "local config",      hint: "config.json (your overrides; default stays)",exists: existsSync(CALIBR_LOCAL_CFG), countLabel: existsSync(CALIBR_LOCAL_CFG) ? "present" : "absent" },
  ];
}

type Phase = { kind: "form" } | { kind: "confirm"; selected: Bucket[] };

export function ResetOptionsView({ onRun, onCancel }: Props) {
  const buckets = useMemo(readBuckets, []);
  const [checked, setChecked] = useState<boolean[]>(() => buckets.map(() => false));
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const toggle = (i: number) => setChecked(prev => prev.map((v, idx) => idx === i ? !v : v));
  const setAll = (v: boolean) => setChecked(buckets.map(() => v));

  const selectedBuckets = (): Bucket[] => buckets.filter((_, i) => checked[i]);

  const startConfirm = () => {
    const sel = selectedBuckets();
    if (sel.length === 0) return;
    setPhase({ kind: "confirm", selected: sel });
  };

  const fire = (sel: Bucket[]) => {
    const args = ["reset", ...sel.map(b => b.flag)];
    const label = "reset " + sel.map(b => b.flag.replace(/^-/, "")).join(" ");
    onRun(args, label);
  };

  useInput((input, key) => {
    if (phase.kind === "confirm") {
      if (key.escape || input === "q" || input === "n" || input === "N") { setPhase({ kind: "form" }); return; }
      if (key.return || input === "y" || input === "Y") { fire(phase.selected); return; }
      return;
    }
    if (key.upArrow)   { setCursor(c => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor(c => Math.min(buckets.length, c + 1)); return; }
    if (input === "a") { setAll(true); return; }
    if (input === "n") { setAll(false); return; }
    if (key.escape || input === "q") { onCancel(); return; }
    if (key.return || input === " ") {
      // cursor < buckets.length → toggle bucket; cursor === buckets.length → submit
      if (cursor < buckets.length) {
        toggle(cursor);
      } else {
        startConfirm();
      }
    }
  });

  if (phase.kind === "confirm") {
    return (
      <Box flexDirection="column">
        <Text bold color="red">reset confirmation</Text>
        <Box marginTop={1}><Text>This will permanently delete:</Text></Box>
        <Box marginTop={1} flexDirection="column">
          {phase.selected.map((b, i) => (
            <Text key={i} color="yellow">  · {b.label} <Text dimColor>({b.countLabel})</Text></Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text>Proceed? <Text color="cyan">[y/n]</Text></Text>
        </Box>
        <Box marginTop={1}><Text dimColor>y = wipe · n/esc = back to selection</Text></Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">reset — pick what to wipe</Text>
      <Box marginTop={1}>
        <Text dimColor>
          User-owned .gguf files in scan_paths are NEVER touched. Only files
          calibr itself fetched (tracked in data/downloads.json) can be
          removed, and only when 'downloaded models' is checked.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {buckets.map((b, i) => {
          const selected = i === cursor;
          const mark = checked[i] ? "[x]" : "[ ]";
          const color = b.exists ? (selected ? "cyan" : undefined) : "gray";
          return (
            <Text key={b.flag} color={color} inverse={selected} dimColor={!b.exists}>
              {selected ? "> " : "  "}{mark} {b.label.padEnd(20)} <Text dimColor>{b.countLabel.padEnd(22)}{b.hint}</Text>
            </Text>
          );
        })}
        <Text key="submit" color={cursor === buckets.length ? "cyan" : "green"} inverse={cursor === buckets.length}>
          {cursor === buckets.length ? "> " : "  "}{">"} reset selected
        </Text>
      </Box>
      <Box marginTop={1}><Text dimColor>↑/↓ move · space/enter toggle · a = all · n = none · enter on submit row · q/esc back</Text></Box>
    </Box>
  );
}
