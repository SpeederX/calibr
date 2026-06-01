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

// Live polling marker emitted by Invoke-OneBenchRun every ~500ms during
// the load wait. Format is structured key=value pairs so the parser is
// grep-stable. Example:
//   [poll] gpu_mem=7032 gpu_pow=180.5 gpu_temp=72 gpu_util=87 ram_used=512 disk_r=420.5
// Filtered from the visible log so it doesn't bloat the scroll buffer.
const POLL_RE = /^\s*\[poll\]\s+(.+?)\s*$/;
function parsePollLine(rest: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of rest.split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const val = Number(pair.slice(eq + 1));
    if (!isNaN(val)) out[key] = val;
  }
  return out;
}

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

interface LiveMetrics {
  gpu_mem: number;
  gpu_pow: number;
  gpu_temp: number;
  gpu_util: number;
  ram_used: number;
  disk_r: number;
  updatedAt: number; // ms since epoch; goes stale after a few seconds
}

// Format ms as MM:SS.mmm under 1h, HH:MM:SS.mmm under 24h, Xd HH:MM:SS.mmm
// beyond. Used by the total-elapsed timer + (later) the per-config timer.
function fmtElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMs   = Math.floor(ms);
  const days      = Math.floor(totalMs / 86_400_000);
  const remDay    = totalMs % 86_400_000;
  const hours     = Math.floor(remDay / 3_600_000);
  const remHr     = remDay % 3_600_000;
  const minutes   = Math.floor(remHr / 60_000);
  const remMin    = remHr % 60_000;
  const seconds   = Math.floor(remMin / 1_000);
  const milli     = remMin % 1_000;
  const pad2      = (n: number) => n.toString().padStart(2, "0");
  const pad3      = (n: number) => n.toString().padStart(3, "0");
  if (days > 0) return `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(milli)}`;
  if (hours > 0) return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(milli)}`;
  return `${pad2(minutes)}:${pad2(seconds)}.${pad3(milli)}`;
}

export function RunView({ args, label, onExit }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [sampleProgress, setSampleProgress] = useState<SampleProgress | null>(null);
  const [rotation, setRotation] = useState<RotationStats>({ deleted: 0, kept: 0, failed: 0, lastEvent: null });
  const [live, setLive] = useState<LiveMetrics | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  // Total elapsed time for this RunView mount (≈ the whole run, since
  // RunView is created the moment the user hits 'start' in the form).
  // Tick once per 100 ms so the milliseconds digit changes visibly.
  const startedAtRef = useRef<number>(Date.now());
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  // Scroll offset measured from the bottom of the buffer in lines. 0 means
  // 'follow the tail'; positive values mean 'show N lines up from the
  // bottom'. When the user scrolls up we stop auto-following so new output
  // doesn't yank them back. End key resumes follow.
  const [scrollOffset, setScrollOffset] = useState(0);
  const procRef = useRef<ReturnType<typeof runEngine> | null>(null);
  // Stream re-assembly buffer: chunks of stdout don't necessarily end on a
  // newline, so we keep the trailing partial here and prepend it to the
  // next chunk. Filtering [poll] BEFORE reassembly was the bug: a poll
  // line that straddled two chunks would have its prefix matched + stripped
  // and its suffix leak into the visible log as garbage / blank lines.
  const partialRef = useRef<string>("");
  const isBench = useMemo(() => args[0] === "bench" || args[0] === "all", [args]);

  useEffect(() => {
    const run = runEngine(args);
    procRef.current = run;

    const append = (chunk: Buffer) => {
      const text = partialRef.current + chunk.toString("utf8");
      const allLines = text.split(/\r?\n/);
      // Last element is whatever came after the final \n — possibly empty,
      // possibly a partial line. Save it for next chunk; process only the
      // complete lines (everything before).
      partialRef.current = allLines.pop() ?? "";
      // Now every entry in `complete` is a definitively-terminated line,
      // so we can safely test it against POLL_RE without false negatives
      // from mid-chunk truncation.
      const complete = allLines;
      const visible = complete.filter(l => !POLL_RE.test(l));
      if (visible.length > 0) {
        setLines((prev) => {
          const merged = prev.concat(visible);
          return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
        });
      }
      // Scan complete lines for the most recent [X/Y] config marker and
      // the most recent [sample X/N] outer marker. Newest-first.
      let foundConfig = false;
      let foundSample = false;
      for (let i = complete.length - 1; i >= 0 && (!foundConfig || !foundSample); i--) {
        if (!foundConfig) {
          const m = complete[i].match(PROGRESS_RE);
          if (m) {
            setProgress({ current: Number(m[1]), total: Number(m[2]), label: m[3] });
            foundConfig = true;
            continue;
          }
        }
        if (!foundSample) {
          const s = complete[i].match(SAMPLE_RE);
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
      // Accumulate rotation events from every complete line.
      let dDelta = 0, kDelta = 0, fDelta = 0;
      let lastRot: string | null = null;
      // Most recent [poll] line wins for the live strip.
      let lastPoll: Record<string, number> | null = null;
      for (const line of complete) {
        if (ROTATE_DELETE_RE.test(line))     { dDelta++; lastRot = line.trim(); }
        else if (ROTATE_KEEP_RE.test(line))  { kDelta++; lastRot = line.trim(); }
        else if (ROTATE_FAIL_RE.test(line))  { fDelta++; lastRot = line.trim(); }
        else {
          const pm = line.match(POLL_RE);
          if (pm) lastPoll = parsePollLine(pm[1]);
        }
      }
      if (dDelta || kDelta || fDelta) {
        setRotation(prev => ({
          deleted: prev.deleted + dDelta,
          kept: prev.kept + kDelta,
          failed: prev.failed + fDelta,
          lastEvent: lastRot ?? prev.lastEvent,
        }));
      }
      if (lastPoll) {
        setLive({
          gpu_mem:  lastPoll.gpu_mem  ?? 0,
          gpu_pow:  lastPoll.gpu_pow  ?? 0,
          gpu_temp: lastPoll.gpu_temp ?? 0,
          gpu_util: lastPoll.gpu_util ?? 0,
          ram_used: lastPoll.ram_used ?? 0,
          disk_r:   lastPoll.disk_r   ?? 0,
          updatedAt: Date.now(),
        });
      }
    };

    run.proc.stdout?.on("data", append);
    run.proc.stderr?.on("data", append);
    run.done.then((code) => setExitCode(code));

    // Stop ticking the elapsed timer once the process exits — the value
    // freezes on the final total so the user can read it. While running,
    // tick 10×/sec for milli digit visibility.
    const tick = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 100);

    return () => {
      clearInterval(tick);
      try { run.proc.kill(); } catch {}
    };
  }, []);

  // Freeze the timer at exit. Without this, the interval is cleared by the
  // unmount path only — but exitCode can flip while we're still mounted.
  useEffect(() => {
    if (exitCode !== null) setElapsedMs(Date.now() - startedAtRef.current);
  }, [exitCode]);

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
          <Text color="cyan"><Spinner type="dots" /> running calibr {label}… <Text dimColor>· {fmtElapsed(elapsedMs)}</Text></Text>
        ) : exitCode === 0 ? (
          <Text color="green">[ok] calibr {label} finished in {fmtElapsed(elapsedMs)} (exit 0)</Text>
        ) : (
          <Text color="red">[err] calibr {label} failed after {fmtElapsed(elapsedMs)} (exit {exitCode})</Text>
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
      {live && (
        <Box marginTop={1}>
          <Text color="cyan">
            live · GPU {live.gpu_mem} MiB / {live.gpu_pow.toFixed(0)} W / {live.gpu_temp}°C / {live.gpu_util}%  ·  RAM Δ {live.ram_used} MiB  ·  disk r {live.disk_r.toFixed(0)} MB/s
          </Text>
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
