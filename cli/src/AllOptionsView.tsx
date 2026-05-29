import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  readSamples,
  filterSamples,
  downloadFootprintBytes,
  freeBytesOn,
  downloadDestination,
  formatBytes,
  loadConfig,
  cachedResultsCount,
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
  | { kind: "gate"; required: number; available: number; sampleCount: number; sufficient: boolean }
  | { kind: "cachePrompt"; cursor: number };

export function AllOptionsView({ onRun, onCancel }: Props) {
  // 'all' is the typical "I want everything" path; defaulting samples on
  // matches what most users want (download the curated set + bench it).
  // Users with their own .gguf collections in scan_paths toggle it off
  // in one keystroke.
  const [downloadSamples, setDownloadSamples] = useState<boolean>(true);
  const [keepDownloads, setKeepDownloads] = useState<boolean>(false);
  const [preferSpeed, setPreferSpeed] = useState<boolean>(false);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const samples = useMemo(readSamples, []);
  const cfg = useMemo(loadConfig, []);
  const destination = useMemo(() => downloadDestination(cfg), [cfg]);
  const cachedCount = useMemo(cachedResultsCount, []);

  const rows = [
    { kind: "download" as const, label: `samples:  ${downloadSamples ? "download curated set first (-DownloadSamples)" : "off (use catalog as-is)"}` },
    { kind: "rotate"   as const, label: `rotate:   ${keepDownloads ? "no (keep downloaded files after bench)" : "yes (default — delete each model after success)"}` },
    { kind: "prefer"   as const, label: `picker:   ${preferSpeed ? "speed (ignore WDDM safety)" : "safety (default — non-paging wins ties)"}` },
    { kind: "run"      as const, label: "> start all" },
    { kind: "cancel"   as const, label: "  cancel" },
  ];

  // Build args. rerunAll toggles -Force; chosen after the cache prompt
  // (or unconditionally false if the cache is empty and the prompt is skipped).
  const buildArgs = (rerunAll: boolean): { args: string[]; label: string } => {
    const args: string[] = ["all"];
    const parts: string[] = [];
    if (downloadSamples) { args.push("-DownloadSamples"); parts.push("-DownloadSamples"); }
    if (keepDownloads)   { args.push("-KeepDownloads");   parts.push("-KeepDownloads"); }
    if (rerunAll)        { args.push("-Force");           parts.push("-Force"); }
    if (preferSpeed)     { args.push("-PreferSpeed");     parts.push("-PreferSpeed"); }
    return { args, label: parts.length ? `all ${parts.join(" ")}` : "all" };
  };

  // Decide which phase comes next after the user clears the current step.
  // Order: disk gate (if downloading) → cache prompt (if cache exists) →
  // launch.
  const advanceFromGate = () => {
    if (cachedCount > 0) {
      setPhase({ kind: "cachePrompt", cursor: 0 });
    } else {
      const { args, label } = buildArgs(false);
      onRun(args, label);
    }
  };

  const runGate = () => {
    const filtered = filterSamples(samples, {});
    const { maxFileBytes } = downloadFootprintBytes(filtered);
    const available = freeBytesOn(destination);
    const required = maxFileBytes;
    setPhase({
      kind: "gate",
      required,
      available,
      sampleCount: filtered.length,
      sufficient: available < 0 ? false : available >= required,
    });
  };

  const activate = (i: number) => {
    const row = rows[i];
    switch (row.kind) {
      case "download": setDownloadSamples(!downloadSamples); break;
      case "rotate":   setKeepDownloads(!keepDownloads); break;
      case "prefer":   setPreferSpeed(!preferSpeed); break;
      case "run": {
        if (downloadSamples) {
          runGate();
        } else if (cachedCount > 0) {
          setPhase({ kind: "cachePrompt", cursor: 0 });
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
      const choices: Array<"use" | "rerun" | "cancel"> = ["use", "rerun", "cancel"];
      if (key.upArrow)   { setPhase({ ...phase, cursor: Math.max(0, phase.cursor - 1) }); return; }
      if (key.downArrow) { setPhase({ ...phase, cursor: Math.min(choices.length - 1, phase.cursor + 1) }); return; }
      if (key.escape || input === "q") { setPhase({ kind: "form" }); return; }
      if (key.return || input === " ") {
        const choice = choices[phase.cursor];
        if (choice === "cancel") { setPhase({ kind: "form" }); return; }
        const r = buildArgs(choice === "rerun");
        onRun(r.args, r.label);
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
          <Text>samples in scope: <Text color="cyan">{phase.sampleCount}</Text></Text>
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
      <Text bold color="cyan">all — configure</Text>
      <Box marginTop={1}><Text dimColor>destination: {destination}</Text></Box>
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
