import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { runEngine } from "./engine.js";

interface Props {
  args: string[];
  label: string;
  onExit: () => void;
}

const MAX_LINES = 500;
const VIEWPORT = 30;

// Match the engine's `Write-Host "[X/Y] <label>"` progress lines.
// Source: calibr.ps1 Invoke-Bench inner loop.
const PROGRESS_RE = /^\s*\[(\d+)\/(\d+)\]\s+(.+?)\s*$/;

// Outer-level progress emitted by the 'all -DownloadSamples' per-sample
// loop in calibr.ps1: `[sample X/N] sampleId`. Lets us show two-level
// progress so the inner [config X/Y] doesn't look like it 'reset' every
// time a new sample's bench begins.
const SAMPLE_RE = /^\s*\[sample\s+(\d+)\/(\d+)\]\s+(.+?)\s*$/;

// Rotation events emitted by Invoke-RotationCheck in the engine.
// Examples:
//   [rotate] deleted C:\models\Q\Qwen3.5-9B-Q4_K_M.gguf
//   [rotate] deleted C:\models\Q\mmproj-F16.gguf (mmproj)
//   [rotate] kept C:\models\Q\Qwen3.5-9B-Q4_K_M.gguf (-KeepDownloads)
//   [rotate] kept C:\models\Q\Qwen3.5-9B-Q4_K_M.gguf (1 failed)
//   [rotate] FAILED to delete C:\models\...: <message>
const ROTATE_DELETE_RE = /^\s*\[rotate\]\s+deleted\s+(.+?)\s*$/;
const ROTATE_KEEP_RE   = /^\s*\[rotate\]\s+kept\s+(.+?)\s*$/;
const ROTATE_FAIL_RE   = /^\s*\[rotate\]\s+FAILED\s+(.+?)\s*$/;

interface Progress {
  current: number;
  total: number;
  label: string;
}

interface SampleProgress {
  current: number;
  total: number;
  sampleId: string;
}

interface RotationStats {
  deleted: number;
  kept: number;
  failed: number;
  lastEvent: string | null;
}

export function RunView({ args, label, onExit }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [sampleProgress, setSampleProgress] = useState<SampleProgress | null>(null);
  const [rotation, setRotation] = useState<RotationStats>({ deleted: 0, kept: 0, failed: 0, lastEvent: null });
  const [exitCode, setExitCode] = useState<number | null>(null);
  // Scroll offset measured from the bottom of the buffer in lines. 0 means
  // 'follow the tail'; positive values mean 'show N lines up from the
  // bottom'. When the user scrolls up we stop auto-following so new output
  // doesn't yank them back. End key resumes follow.
  const [scrollOffset, setScrollOffset] = useState(0);
  const procRef = useRef<ReturnType<typeof runEngine> | null>(null);
  const isBench = useMemo(() => args[0] === "bench" || args[0] === "all", [args]);

  useEffect(() => {
    const run = runEngine(args);
    procRef.current = run;

    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const incoming = text.split(/\r?\n/);
      setLines((prev) => {
        const merged = [...prev];
        if (merged.length === 0) merged.push("");
        merged[merged.length - 1] += incoming[0];
        for (let i = 1; i < incoming.length; i++) merged.push(incoming[i]);
        return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
      });
      // Scan all incoming lines for the most recent [X/Y] config marker
      // and the most recent [sample X/N] outer marker. Scanning newest-first
      // lets us pick the latest event from a chunk that bundles many lines.
      let foundConfig = false;
      let foundSample = false;
      for (let i = incoming.length - 1; i >= 0 && (!foundConfig || !foundSample); i--) {
        if (!foundConfig) {
          const m = incoming[i].match(PROGRESS_RE);
          if (m) {
            setProgress({ current: Number(m[1]), total: Number(m[2]), label: m[3] });
            foundConfig = true;
            continue;
          }
        }
        if (!foundSample) {
          const s = incoming[i].match(SAMPLE_RE);
          if (s) {
            setSampleProgress({ current: Number(s[1]), total: Number(s[2]), sampleId: s[3] });
            // When a new sample starts, the inner [X/Y] from a previous
            // sample is stale; clear it so the display doesn't show
            // last-sample's config strip while the new sample is downloading.
            setProgress(null);
            foundSample = true;
          }
        }
      }
      // Accumulate rotation events from every incoming line.
      let dDelta = 0, kDelta = 0, fDelta = 0;
      let last: string | null = null;
      for (const line of incoming) {
        if (ROTATE_DELETE_RE.test(line))     { dDelta++; last = line.trim(); }
        else if (ROTATE_KEEP_RE.test(line))  { kDelta++; last = line.trim(); }
        else if (ROTATE_FAIL_RE.test(line))  { fDelta++; last = line.trim(); }
      }
      if (dDelta || kDelta || fDelta) {
        setRotation(prev => ({
          deleted: prev.deleted + dDelta,
          kept: prev.kept + kDelta,
          failed: prev.failed + fDelta,
          lastEvent: last ?? prev.lastEvent,
        }));
      }
    };

    run.proc.stdout?.on("data", append);
    run.proc.stderr?.on("data", append);
    run.done.then((code) => setExitCode(code));

    return () => {
      try { run.proc.kill(); } catch {}
    };
  }, []);

  useInput((input, key) => {
    // Scroll bindings work whether the run is live or finished.
    if (key.upArrow)   { setScrollOffset(o => Math.min(Math.max(0, lines.length - VIEWPORT), o + 1)); return; }
    if (key.downArrow) { setScrollOffset(o => Math.max(0, o - 1)); return; }
    if (key.pageUp)    { setScrollOffset(o => Math.min(Math.max(0, lines.length - VIEWPORT), o + VIEWPORT)); return; }
    if (key.pageDown)  { setScrollOffset(o => Math.max(0, o - VIEWPORT)); return; }
    if (input === "g") { setScrollOffset(Math.max(0, lines.length - VIEWPORT)); return; }  // top
    if (input === "G") { setScrollOffset(0); return; }                                       // bottom (resume tail)

    if (exitCode !== null && (key.return || input === "q" || key.escape)) {
      onExit();
    }
    if (exitCode === null && (input === "q" || key.escape)) {
      try { procRef.current?.proc.kill(); } catch {}
    }
  });

  // Slice the visible window. When scrollOffset is 0, end == lines.length
  // (live tail). When scrolled up by N, the window slides up by N lines.
  const end = Math.max(VIEWPORT, lines.length - scrollOffset);
  const start = Math.max(0, end - VIEWPORT);
  const tail = lines.slice(start, end);
  const isTailing = scrollOffset === 0;

  const showProgress = isBench && progress !== null;
  const configPct = showProgress ? Math.round((progress!.current / Math.max(1, progress!.total)) * 100) : 0;
  const samplePct = sampleProgress !== null
    ? Math.round((sampleProgress.current / Math.max(1, sampleProgress.total)) * 100)
    : 0;

  return (
    <Box flexDirection="column">
      <Box>
        {exitCode === null ? (
          <Text color="cyan"><Spinner type="dots" /> running calibr {label}…</Text>
        ) : exitCode === 0 ? (
          <Text color="green">[ok] calibr {label} finished (exit 0)</Text>
        ) : (
          <Text color="red">[err] calibr {label} failed (exit {exitCode})</Text>
        )}
      </Box>
      {sampleProgress !== null && (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            sample {sampleProgress.current}/{sampleProgress.total} · {samplePct}% · {sampleProgress.sampleId}
          </Text>
        </Box>
      )}
      {showProgress && (
        <Box {...(sampleProgress === null ? { marginTop: 1 } : {})}>
          <Text color="cyan">
            config [{progress!.current}/{progress!.total}] {configPct}% — {progress!.label}
          </Text>
        </Box>
      )}
      {isBench && (rotation.deleted > 0 || rotation.kept > 0 || rotation.failed > 0) && (
        <Box marginTop={1} flexDirection="column">
          <Text color={rotation.failed > 0 ? "yellow" : "gray"}>
            rotation: {rotation.deleted} deleted · {rotation.kept} kept{rotation.failed > 0 ? ` · ${rotation.failed} failed` : ""}
          </Text>
          {rotation.lastEvent && <Text dimColor>last: {rotation.lastEvent}</Text>}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {tail.length === 0 ? (
          <Text dimColor>(no output yet)</Text>
        ) : (
          tail.map((line, i) => (
            <Text key={start + i}>{line || " "}</Text>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {!isTailing && (
          <Text color="yellow">
            ↑ scrolled up {scrollOffset} line{scrollOffset === 1 ? "" : "s"} · new output paused · press G to resume tail
          </Text>
        )}
        <Text dimColor>
          ↑/↓ scroll · PgUp/PgDn page · g top · G bottom · {exitCode === null ? "q/esc cancel" : "enter/q/esc back"}
        </Text>
      </Box>
    </Box>
  );
}
