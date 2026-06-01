import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  readModelCatalog,
  filterCatalog,
  downloadFootprintBytes,
  freeBytesOn,
  downloadDestination,
  formatBytes,
  loadConfig,
  cachedResultsCount,
  readPresetCatalog,
} from "./engine.js";

interface Props {
  onRun: (args: string[], label: string) => void;
  onCancel: () => void;
}

// Three phases:
//   form        - user toggles options for `calibr all`
//   gate        - shown only when -DownloadSamples is on; pre-flight
//                 disk-space check the user must accept
//   cachePrompt - shown only when result JSONs exist in data/results/;
//                 user picks 'use cache' / 're-run all' / 'cancel'
type Phase =
  | { kind: "form" }
  | { kind: "gate"; required: number; available: number; entryCount: number; sufficient: boolean }
  | { kind: "cachePrompt" };

export function AllOptionsView({ onRun, onCancel }: Props) {
  // 'all' is the typical "I want everything" path; defaulting fetch on
  // matches what most users want (download the curated catalog + bench it).
  // Users with their own .gguf collections in scan_paths toggle it off
  // in one keystroke.
  const [fetchCatalog, setFetchCatalog] = useState<boolean>(true);
  const [keepDownloads, setKeepDownloads] = useState<boolean>(false);
  const [preferSpeed, setPreferSpeed] = useState<boolean>(false);
  const [minimalPolling, setMinimalPolling] = useState<boolean>(false);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const catalog = useMemo(readModelCatalog, []);
  const cfg = useMemo(loadConfig, []);
  const destination = useMemo(() => downloadDestination(cfg), [cfg]);
  const cachedCount = useMemo(cachedResultsCount, []);
  // Presets: built-in (default_bench_presets.json) + user-saved
  // (data/user_bench_presets.json) merged into one dict.
  const presets = useMemo(readPresetCatalog, []);
  // Cycle order: all, low, middle, high, then any extra user-saved presets,
  // then 'custom' as the last sentinel that routes to CustomBenchView
  // (TODO: Phase C — for now it just behaves like 'all').
  const presetNames = useMemo<string[]>(() => {
    const builtin = ["all", "low", "middle", "high"].filter(n => presets[n]);
    const extras = Object.keys(presets).filter(n => !builtin.includes(n)).sort();
    return [...builtin, ...extras, "custom"];
  }, [presets]);
  const [presetIdx, setPresetIdx] = useState<number>(0);
  const currentPreset = presetNames[presetIdx];
  const presetCount = (() => {
    if (currentPreset === "custom") return null;
    const p = presets[currentPreset];
    if (!p) return null;
    if (p.models === "*") return catalog.length;
    return Array.isArray(p.models) ? p.models.length : 0;
  })();
  const presetLabel = (() => {
    if (currentPreset === "custom") return "custom (pick models + ctx — TODO Phase C)";
    const p = presets[currentPreset];
    if (!p) return currentPreset;
    return `${p.label} · ${presetCount ?? "?"} entries${p.max_ctx ? `, max ctx ${p.max_ctx}` : ""}`;
  })();

  const rows = [
    { kind: "fetch"    as const, label: `catalog:  ${fetchCatalog ? "fetch curated models first (-FetchCatalog)" : "off (use what's already in scan_paths)"}` },
    { kind: "preset"   as const, label: `preset:   ${presetLabel}`, disabled: !fetchCatalog },
    { kind: "rotate"   as const, label: `rotate:   ${keepDownloads ? "no (keep downloaded files after bench)" : "yes (default — delete each model after success)"}` },
    { kind: "prefer"   as const, label: `picker:   ${preferSpeed ? "speed (ignore WDDM safety)" : "safety (default — non-paging wins ties)"}` },
    { kind: "polling"  as const, label: `polling:  ${minimalPolling ? "minimal (lowest overhead, no live strip / power / RAM / disk)" : "full (default — live metrics strip + extended fields in results)"}` },
    { kind: "run"      as const, label: "> start all" },
    { kind: "cancel"   as const, label: "  cancel" },
  ];

  // Build args. rerunAll toggles -Force; chosen after the cache prompt
  // (or unconditionally false if the cache is empty and the prompt is skipped).
  const buildArgs = (rerunAll: boolean): { args: string[]; label: string } => {
    const args: string[] = ["all"];
    const parts: string[] = [];
    if (fetchCatalog) { args.push("-FetchCatalog"); parts.push("-FetchCatalog"); }
    // 'all' / 'custom' are not passed as -Preset; 'all' is a no-op filter and
    // 'custom' would route to CustomBenchView (Phase C — not yet wired here).
    if (fetchCatalog && currentPreset !== "all" && currentPreset !== "custom") {
      args.push("-Preset", currentPreset);
      parts.push(`-Preset ${currentPreset}`);
    }
    if (keepDownloads)   { args.push("-KeepDownloads");   parts.push("-KeepDownloads"); }
    if (rerunAll)        { args.push("-Force");           parts.push("-Force"); }
    if (preferSpeed)     { args.push("-PreferSpeed");     parts.push("-PreferSpeed"); }
    if (minimalPolling)  { args.push("-MinimalPolling");  parts.push("-MinimalPolling"); }
    return { args, label: parts.length ? `all ${parts.join(" ")}` : "all" };
  };

  // Decide which phase comes next after the user clears the current step.
  // Order: disk gate (if fetching) → cache prompt (if cache exists) →
  // launch.
  const advanceFromGate = () => {
    if (cachedCount > 0) {
      setPhase({ kind: "cachePrompt" });
    } else {
      const { args, label } = buildArgs(false);
      onRun(args, label);
    }
  };

  const runGate = () => {
    const filtered = filterCatalog(catalog, {});
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

  const activate = (i: number) => {
    const row = rows[i];
    switch (row.kind) {
      case "fetch":    setFetchCatalog(!fetchCatalog); break;
      case "preset":   if (fetchCatalog) setPresetIdx((presetIdx + 1) % presetNames.length); break;
      case "rotate":   setKeepDownloads(!keepDownloads); break;
      case "prefer":   setPreferSpeed(!preferSpeed); break;
      case "polling":  setMinimalPolling(!minimalPolling); break;
      case "run": {
        if (fetchCatalog) {
          runGate();
        } else if (cachedCount > 0) {
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
