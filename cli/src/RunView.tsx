import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { runEngine } from "./engine.js";

interface Props {
  args: string[];
  label: string;
  onExit: () => void;
}

const MAX_LINES = 200;

// Match the engine's `Write-Host "[X/Y] <label>"` progress lines.
// Source: calibr.ps1 Invoke-Bench inner loop.
const PROGRESS_RE = /^\s*\[(\d+)\/(\d+)\]\s+(.+?)\s*$/;

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

interface RotationStats {
  deleted: number;
  kept: number;
  failed: number;
  lastEvent: string | null;
}

export function RunView({ args, label, onExit }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [rotation, setRotation] = useState<RotationStats>({ deleted: 0, kept: 0, failed: 0, lastEvent: null });
  const [exitCode, setExitCode] = useState<number | null>(null);
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
      // Scan all incoming lines for the most recent [X/Y] marker.
      for (let i = incoming.length - 1; i >= 0; i--) {
        const m = incoming[i].match(PROGRESS_RE);
        if (m) {
          setProgress({ current: Number(m[1]), total: Number(m[2]), label: m[3] });
          break;
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
    if (exitCode !== null && (key.return || input === "q" || key.escape)) {
      onExit();
    }
    if (exitCode === null && (input === "q" || key.escape)) {
      try { procRef.current?.proc.kill(); } catch {}
    }
  });

  const tail = lines.slice(-30);
  const showProgress = isBench && progress !== null;
  const pct = showProgress ? Math.round((progress!.current / Math.max(1, progress!.total)) * 100) : 0;

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
      {showProgress && (
        <Box marginTop={1}>
          <Text color="cyan">
            [{progress!.current}/{progress!.total}] {pct}% — {progress!.label}
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
            <Text key={i}>{line || " "}</Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {exitCode === null ? "press q or esc to cancel" : "press enter, q, or esc to go back"}
        </Text>
      </Box>
    </Box>
  );
}
