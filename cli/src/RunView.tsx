import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { spawnSync } from "node:child_process";
import { runEngine, openReport } from "./engine.js";

// Kill the whole process tree rooted at pid. Node's child.kill() doesn't
// propagate to grandchildren — the shell (powershell/pwsh) spawns
// llama-server via System.Diagnostics.Process, and it keeps running after the
// shell dies. On Windows, taskkill /T /F walks the tree. On POSIX, runEngine
// spawns the child with detached:true so it leads its own process group;
// kill(-pid) signals the whole group (shell + llama-server).
function killTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
    } catch {}
    return;
  }
  // POSIX: negative pid targets the process group led by pid.
  try { process.kill(-pid, "SIGKILL"); }
  catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

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

// Phase + download markers (added v0.1.5). All grep-stable, all filtered
// from the visible log.
//   [phase] downloading | loading_model | server_ready | sending_prompt | run_complete
//   [dlprog] bytes=12345 total=67890 speed_mibps=23.4 elapsed_ms=540
//   [dldone] bytes=N elapsed_ms=E avg_mibps=S
const PHASE_RE  = /^\s*\[phase\]\s+(\w+)\s*$/;
const DLPROG_RE = /^\s*\[dlprog\]\s+(.+?)\s*$/;
const DLDONE_RE = /^\s*\[dldone\]\s+(.+?)\s*$/;
// Per-run header from Invoke-OneBench: "  run 2/3" emitted before each
// run inside a multi-run config. Lets the flow widget show "run 2/3:".
const RUN_RE = /^\s*run\s+(\d+)\/(\d+)\s*$/;
// Per-config status line from Write-BenchStatusLine: "[OK]  ..." or "[FAIL] ..."
// Detected for coloring (the engine has its own console colors but they
// don't survive the spawn pipeline; CLI re-colors here).
const OK_RE   = /^\s*\[OK\]/;
const FAIL_RE = /^\s*\[FAIL\]/;
// End-of-bench summary line, e.g.
//   "   2 ok . 0 fail . 0 skipped (out of 2 configs (3 runs each))"
//   "   2 ok . 0 fail . 0 skipped (out of 2)"  (legacy / runs_per_config=1)
// Lenient on the "(out of T...)" tail so engine wording changes don't break
// the color rule. Colored based on whether M (fail count) is non-zero.
const SUMMARY_RE = /^\s*(\d+)\s+ok\s+\.\s+(\d+)\s+fail\s+\.\s+\d+\s+skipped\s+\(out of \d+.*\)\s*$/;
// "Report: C:\...\report.html" emitted by Invoke-Report on completion.
// Presence of this line is a guarantee that a FRESH report was just
// written by this run (not a stale leftover); the CLI uses it to gate
// the "open report?" prompt so the user isn't offered an old report
// after a bench-only run that didn't touch report.html.
const REPORT_RE = /^Report:\s+(.+\.html)\s*$/;

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

interface DownloadState {
  bytes: number;
  total: number;
  speedMibps: number;
  elapsedMs: number;
  done: boolean;        // [dldone] arrived
  updatedAt: number;
}

type Phase =
  | 'idle'
  | 'downloading'
  | 'loading_model'
  | 'server_ready'
  | 'sending_prompt'
  | 'run_complete';

interface RunCount {
  current: number;  // 1-based index of current run within config
  total: number;
}

// Bench-phase progress widget. Engine emits a subset of phases; we map them
// onto a 4-step visual flow so the user feels continuous progression even
// during the synchronous POST (where the engine can't tell "prompt sent"
// from "responding"). PHASES_VIEW is the displayed sequence; the mapping
// table below decides which steps are pending / active / done.
const PHASES_VIEW = [
  { id: 'load',     label: 'loading model'    },
  { id: 'sent',     label: 'prompt sent'      },
  { id: 'resp',     label: 'model responding' },
  { id: 'done',     label: 'completed'        },
] as const;
type PhaseState = 'pending' | 'active' | 'done';

function phaseStates(p: Phase): PhaseState[] {
  switch (p) {
    case 'loading_model':  return ['active',  'pending', 'pending', 'pending'];
    case 'server_ready':   return ['done',    'pending', 'pending', 'pending'];
    case 'sending_prompt': return ['done',    'done',    'active',  'pending'];
    case 'run_complete':   return ['done',    'done',    'done',    'done'];
    case 'downloading':
    case 'idle':
    default:               return ['pending', 'pending', 'pending', 'pending'];
  }
}

function parseKvLine(rest: string): Record<string, number> {
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

// Compact human-readable byte size for the download bar.
function fmtBytes(n: number): string {
  if (n < 0 || !isFinite(n)) return "?";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024)       return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// Short eta string: "12s" / "4m 32s" / "1h 12m". For the runtime estimator
// we don't bother going below seconds.
function fmtEtaShort(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return "?";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hr = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hr > 0) return `${hr}h ${min}m`;
  return `${min}m ${sec}s`;
}

// Render a fixed-width bar with `pct`% filled. Block chars give the
// purple/violet feel without escapes; the parent <Text color="..."> picks
// the actual color.
function progressBar(pct: number, width = 30): string {
  const safe = Math.max(0, Math.min(100, pct));
  const filled = Math.round((safe / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
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
  const [download, setDownload] = useState<DownloadState | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [runCount, setRunCount] = useState<RunCount | null>(null);
  // Path to the report.html the engine just wrote (matched against
  // REPORT_RE). Null until the engine reaches Invoke-Report; presence
  // gates the "open report? [y/n]" prompt shown after a successful run.
  const [reportPath, setReportPath] = useState<string | null>(null);
  // Per-config completion times in ms. Pushed on each PROGRESS_RE transition
  // (config N → N+1). Running mean drives the bench-side of the ETA. Kept
  // bounded to avoid drift from a degenerate first config.
  const configTimesRef = useRef<number[]>([]);
  const configStartedAtRef = useRef<number | null>(null);
  const lastProgressKeyRef = useRef<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  // Total elapsed time for this RunView mount (≈ the whole run, since
  // RunView is created the moment the user hits 'start' in the form).
  // Tick once per 100 ms so the milliseconds digit changes visibly, but
  // stop the moment the process exits so the displayed value freezes on
  // the final total instead of running past it.
  const startedAtRef = useRef<number>(Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
      // from mid-chunk truncation. Also filter out the structured download
      // and phase markers — they're high-frequency telemetry, not user-
      // facing log content; we parse them below to drive the live widgets.
      const complete = allLines;
      const visible = complete.filter(l =>
        !POLL_RE.test(l) && !DLPROG_RE.test(l) && !DLDONE_RE.test(l) && !PHASE_RE.test(l)
      );
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
            const key = `${m[1]}/${m[2]}|${m[3]}`;
            setProgress({ current: Number(m[1]), total: Number(m[2]), label: m[3] });
            // Per-config ETA tracking: when this is a NEW config (different
            // key than the last one we saw), close out the previous one's
            // duration into the history and start the clock for this one.
            // Runs-per-config repeats don't trigger this because they share
            // the same [X/Y] label.
            if (lastProgressKeyRef.current !== key) {
              if (lastProgressKeyRef.current !== null && configStartedAtRef.current !== null) {
                const dur = Date.now() - configStartedAtRef.current;
                configTimesRef.current.push(dur);
                if (configTimesRef.current.length > 8) configTimesRef.current.shift();
              }
              lastProgressKeyRef.current = key;
              configStartedAtRef.current = Date.now();
              // New config also resets the run counter; it'll repopulate when
              // the next "  run X/Y" line arrives.
              setRunCount(null);
            }
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
      // Most recent [dlprog] / [dldone] / [phase] / run X/Y wins for the
      // corresponding widget. Each handled per-line below.
      let lastDl: Record<string, number> | null = null;
      let lastDlDone = false;
      let lastPhase: Phase | null = null;
      let lastRun: RunCount | null = null;
      let lastReport: string | null = null;
      for (const line of complete) {
        if (ROTATE_DELETE_RE.test(line))     { dDelta++; lastRot = line.trim(); continue; }
        if (ROTATE_KEEP_RE.test(line))       { kDelta++; lastRot = line.trim(); continue; }
        if (ROTATE_FAIL_RE.test(line))       { fDelta++; lastRot = line.trim(); continue; }
        const pm = POLL_RE.exec(line);     if (pm) { lastPoll = parseKvLine(pm[1]); continue; }
        const dm = DLPROG_RE.exec(line);   if (dm) { lastDl = parseKvLine(dm[1]); continue; }
        if (DLDONE_RE.test(line))             { lastDlDone = true; continue; }
        const phm = PHASE_RE.exec(line);   if (phm) { lastPhase = phm[1] as Phase; continue; }
        const rm = RUN_RE.exec(line);      if (rm) { lastRun = { current: Number(rm[1]), total: Number(rm[2]) }; continue; }
        const rpm = REPORT_RE.exec(line);  if (rpm) { lastReport = rpm[1]; continue; }
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
      if (lastDl) {
        setDownload({
          bytes: lastDl.bytes ?? 0,
          total: lastDl.total ?? 0,
          speedMibps: lastDl.speed_mibps ?? 0,
          elapsedMs: lastDl.elapsed_ms ?? 0,
          done: lastDlDone,
          updatedAt: Date.now(),
        });
      } else if (lastDlDone) {
        // dldone arrived without an interior dlprog in this chunk (small
        // file finished in one tick). Mark whatever we had as done.
        setDownload(prev => prev ? { ...prev, done: true } : prev);
      }
      if (lastPhase) {
        setPhase(lastPhase);
        // When the bench-side phases start, the download bar from the
        // previous sample's fetch is stale; clear it.
        if (lastPhase === 'loading_model') setDownload(null);
      }
      if (lastRun) setRunCount(lastRun);
      if (lastReport) setReportPath(lastReport);
    };

    run.proc.stdout?.on("data", append);
    run.proc.stderr?.on("data", append);
    run.done.then((code) => setExitCode(code));

    // Tick 10×/sec for milli digit visibility while the process is alive.
    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 100);

    return () => {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      killTree(run.proc.pid);
    };
  }, []);

  // Freeze the timer at exit: clear the interval (without this the timer
  // keeps incrementing past the exit moment) AND set the final value once.
  useEffect(() => {
    if (exitCode !== null) {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      setElapsedMs(Date.now() - startedAtRef.current);
    }
  }, [exitCode]);

  useInput((input, key) => {
    // Scroll bindings work whether the run is live or finished.
    if (key.upArrow)   { setScrollOffset(o => Math.min(Math.max(0, lines.length - VIEWPORT), o + 1)); return; }
    if (key.downArrow) { setScrollOffset(o => Math.max(0, o - 1)); return; }
    if (key.pageUp)    { setScrollOffset(o => Math.min(Math.max(0, lines.length - VIEWPORT), o + VIEWPORT)); return; }
    if (key.pageDown)  { setScrollOffset(o => Math.max(0, o - VIEWPORT)); return; }
    // Lowercase mnemonics for top/bottom (uppercase G felt awkward in a
    // PowerShell terminal where Shift+letter is muscle-memory for caps).
    // Home/End are kept as the universal escape hatch.
    if (input === "g" || key.meta && key.upArrow)   { setScrollOffset(Math.max(0, lines.length - VIEWPORT)); return; }  // top
    if (input === "h" || key.meta && key.downArrow) { setScrollOffset(0); return; }                                       // bottom (resume tail)

    // q / esc: cancel a live run, exit the screen after the run is done.
    // We kill the WHOLE PowerShell process tree because the engine
    // spawns llama-server as a grandchild — Node's child.kill() only
    // hits the immediate child, leaving llama-server orphaned and still
    // emitting stdout. taskkill /T /F walks the tree.
    if (input === "q" || key.escape) {
      if (exitCode === null) {
        killTree(procRef.current?.proc.pid);
        // Don't onExit() yet — let the natural process close handler
        // set exitCode so the user sees the final '[err] ... (exit -1)'
        // banner with the elapsed time. They press q/esc again to leave.
      } else {
        onExit();
      }
      return;
    }
    // After a successful run that produced a fresh report, the prompt
    // defaults to 'open' on enter (the user just sat through the bench;
    // opening the report is the natural next step). Explicit 'n' / esc
    // skips. Holding to 'y/enter = open, n/esc = skip' so the keys
    // mirror the natural reading order of the prompt label.
    if (exitCode === 0 && reportPath) {
      if (input === "y" || input === "Y" || input === "o" || input === "O" || key.return) {
        openReport();
        onExit();
        return;
      }
      if (input === "n" || input === "N") {
        onExit();
        return;
      }
      return;  // ignore other keys while the prompt is up
    }
    if (exitCode !== null && key.return) {
      onExit();
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

  // ETA: configs_remaining * mean(configTimesRef) + download remainder.
  // Rough estimate, deliberately not surfaced to the user as authoritative.
  const etaMs = (() => {
    if (exitCode !== null) return 0;
    let total = 0;
    const remaining = showProgress ? Math.max(0, progress!.total - progress!.current) : 0;
    const hist = configTimesRef.current;
    if (remaining > 0 && hist.length > 0) {
      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
      total += mean * remaining;
      // If this is part of `all -FetchCatalog`, extrapolate across remaining
      // samples too. Approximation: each upcoming sample takes about the
      // same time as the average so far (which is ALL completed configs
      // across all completed samples / configs_per_sample-ish). Good enough.
      if (sampleProgress && sampleProgress.total > sampleProgress.current && progress!.total > 0) {
        const sampleRemaining = sampleProgress.total - sampleProgress.current;
        total += sampleRemaining * progress!.total * mean;
      }
    }
    if (download && !download.done && download.total > 0) {
      const remainingBytes = Math.max(0, download.total - download.bytes);
      const speedBps = download.speedMibps * 1024 * 1024;
      if (speedBps > 0) total += (remainingBytes / speedBps) * 1000;
    }
    return total;
  })();

  // Color a log line if it matches one of the engine's status patterns.
  // Keeps the existing "engine wrote it once, CLI shows it once" rule —
  // the colors don't survive ANSI stripping through the Node spawn.
  const lineColor = (line: string): string | undefined => {
    if (OK_RE.test(line))      return 'green';
    if (FAIL_RE.test(line))    return 'red';
    const sm = SUMMARY_RE.exec(line);
    if (sm) return Number(sm[2]) > 0 ? 'yellow' : 'green';
    return undefined;
  };

  // Engine phase → array of states for the 4 displayed flow chips.
  const flow = phaseStates(phase);
  const showFlow = isBench && phase !== 'idle' && phase !== 'downloading';
  // Download bar: visible whenever we have download state and either it
  // isn't done yet OR we're still in the downloading phase (covers the
  // brief gap between the engine's last [dlprog] and the first [phase]
  // loading_model from the bench that follows).
  const showDownload = download !== null && (!download.done || phase === 'downloading');
  const dlPct = showDownload && download!.total > 0
    ? (download!.bytes / download!.total) * 100
    : 0;

  return (
    <Box flexDirection="column">
      <Box>
        {exitCode === null ? (
          <Text color="cyan">
            <Spinner type="dots" /> running calibr {label}… <Text dimColor>· {fmtElapsed(elapsedMs)}{etaMs > 0 ? ` · eta ~${fmtEtaShort(etaMs)}` : ""}</Text>
          </Text>
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
      {showDownload && (
        <Box {...(sampleProgress === null ? { marginTop: 1 } : {})}>
          <Text color="magenta">
            downloading [<Text bold>{progressBar(dlPct, 30)}</Text>] {dlPct.toFixed(1)}%
            <Text dimColor>   {fmtBytes(download!.bytes)} / {fmtBytes(download!.total)}   </Text>
            <Text>↓ {download!.speedMibps.toFixed(1)} MB/s</Text>
          </Text>
        </Box>
      )}
      {showProgress && (
        <Box {...(sampleProgress === null && !showDownload ? { marginTop: 1 } : {})}>
          <Text color="cyan">
            config [{progress!.current}/{progress!.total}] {configPct}% — {progress!.label}
          </Text>
        </Box>
      )}
      {showFlow && (
        <Box marginTop={(sampleProgress === null && !showProgress) ? 1 : 0}>
          <Text>
            {runCount ? (
              <Text color="cyan" bold>run {runCount.current}/{runCount.total}: </Text>
            ) : null}
            {PHASES_VIEW.map((p, i) => {
              const state = flow[i];
              const sep = i < PHASES_VIEW.length - 1 ? <Text dimColor> → </Text> : null;
              if (state === 'done') {
                return (
                  <Text key={p.id}>
                    <Text color="green">✓ </Text><Text color="green">{p.label}</Text>{sep}
                  </Text>
                );
              }
              if (state === 'active') {
                return (
                  <Text key={p.id}>
                    <Text color="cyan"><Spinner type="dots" /> </Text><Text color="cyan" bold>{p.label}</Text>{sep}
                  </Text>
                );
              }
              return (
                <Text key={p.id}>
                  <Text dimColor>○ {p.label}</Text>{sep}
                </Text>
              );
            })}
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
          tail.map((line, i) => {
            const c = lineColor(line);
            return <Text key={start + i} color={c}>{line || " "}</Text>;
          })
        )}
      </Box>
      {exitCode === 0 && reportPath && (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>
            open report in browser? <Text color="green">[y / enter]</Text> yes <Text dimColor>·</Text> <Text>[n / esc]</Text> back to menu
          </Text>
          <Text dimColor>{reportPath}</Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {!isTailing && (
          <Text color="yellow">
            ↑ scrolled up {scrollOffset} line{scrollOffset === 1 ? "" : "s"} · new output paused · press G to resume tail
          </Text>
        )}
        <Text dimColor>
          ↑/↓ scroll · PgUp/PgDn page · g top · h bottom · {
            exitCode === null
              ? "q/esc cancel run"
              : (exitCode === 0 && reportPath ? "y/enter open report · n/esc back" : "enter/q/esc back")
          }
        </Text>
      </Box>
    </Box>
  );
}
