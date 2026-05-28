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

interface Progress {
  current: number;
  total: number;
  label: string;
}

export function RunView({ args, label, onExit }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
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
