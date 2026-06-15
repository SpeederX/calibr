import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { groupWinners, isSafe as winnerIsSafe, type WinnerWithMeta } from "./winnerPolicy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Locate the PowerShell engine. Two modes:
//   bundled: running from an npm install — calibr.ps1 sits next to dist/
//            inside our own package (cli/engine/calibr.ps1).
//   dev:     running from the repo — walk up until we find calibr.ps1 at
//            the project root.
// Dev mode takes priority so a developer with a checkout sees their own
// engine + data even if an older bundled copy exists.
function findEngineLocation(): { root: string; bundled: boolean } {
  const envRoot = process.env.CALIBR_ROOT;
  if (envRoot && existsSync(join(envRoot, "calibr.ps1"))) {
    return { root: envRoot, bundled: false };
  }

  // Walk up first so a repo checkout always wins over the bundled copy.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "calibr.ps1"))) return { root: dir, bundled: false };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const bundled = resolve(__dirname, "..", "engine");
  if (existsSync(join(bundled, "calibr.ps1"))) return { root: bundled, bundled: true };

  if (existsSync(join(process.cwd(), "calibr.ps1"))) {
    return { root: process.cwd(), bundled: false };
  }

  throw new Error(
    "Could not locate calibr.ps1. Set CALIBR_ROOT, run from the project directory, or reinstall calibr."
  );
}

const { root: ENGINE_ROOT, bundled: IS_BUNDLED } = findEngineLocation();

function defaultDataDir(): string {
  if (process.env.CALIBR_DATA_DIR) return process.env.CALIBR_DATA_DIR;
  if (IS_BUNDLED) {
    if (process.platform === "win32") {
      const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.USERPROFILE;
      if (!base) {
        throw new Error("Cannot determine data directory: LOCALAPPDATA, APPDATA, and USERPROFILE are all unset.");
      }
      return join(base, "calibr");
    }
    // POSIX: XDG Base Directory spec, defaulting to ~/.local/share.
    const xdg = process.env.XDG_DATA_HOME;
    const home = process.env.HOME;
    if (xdg) return join(xdg, "calibr");
    if (home) return join(home, ".local", "share", "calibr");
    throw new Error("Cannot determine data directory: XDG_DATA_HOME and HOME are both unset.");
  }
  return join(ENGINE_ROOT, "data");
}

export const CALIBR_ROOT = ENGINE_ROOT;
export const CALIBR_BUNDLED = IS_BUNDLED;
export const CALIBR_DATA_DIR = defaultDataDir();
mkdirSync(CALIBR_DATA_DIR, { recursive: true });

function defaultConfigPath(): string {
  if (process.env.CALIBR_CONFIG) return process.env.CALIBR_CONFIG;
  if (IS_BUNDLED) return join(CALIBR_DATA_DIR, "config.json");
  return join(ENGINE_ROOT, "config.json");
}

export const CALIBR_CATALOG = join(CALIBR_DATA_DIR, "catalog.json");
export const CALIBR_PLAN = join(CALIBR_DATA_DIR, "plan.json");
export const CALIBR_RESULTS_DIR = join(CALIBR_DATA_DIR, "results");
export const CALIBR_LOGS_DIR = join(CALIBR_DATA_DIR, "logs");
export const CALIBR_ACTION_TRACE = join(CALIBR_LOGS_DIR, "action-trace.jsonl");
export const CALIBR_ACTION_TRACE_LOG = join(CALIBR_LOGS_DIR, "action-trace.log");
export const CALIBR_REPORT = join(CALIBR_DATA_DIR, "report.html");
export const CALIBR_DEFAULT_CFG = join(ENGINE_ROOT, "config.default.json");
export const CALIBR_LOCAL_CFG = defaultConfigPath();
export const CALIBR_PS1 = join(ENGINE_ROOT, "calibr.ps1");
export const CALIBR_TRACE_SESSION_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;

export type TraceStatus = "started" | "selected" | "completed" | "failed" | "cancelled" | "skipped";

export interface TraceContext {
  flow: string;
  action: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface TraceEvent extends TraceContext {
  status: TraceStatus;
  source?: "cli" | "engine";
  details?: Record<string, unknown>;
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  if (!search) return value;
  return value.split(search).join(replacement);
}

function redactTraceString(value: string): string {
  let out = value;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const appData = process.env.APPDATA || "";
  const replacements: Array<[string, string]> = [
    [CALIBR_DATA_DIR, "<CALIBR_DATA_DIR>"],
    [CALIBR_ROOT, "<CALIBR_ROOT>"],
    [home, process.platform === "win32" ? "%USERPROFILE%" : "$HOME"],
    [localAppData, "%LOCALAPPDATA%"],
    [appData, "%APPDATA%"],
  ];
  for (const [needle, label] of replacements.sort((a, b) => b[0].length - a[0].length)) {
    if (!needle) continue;
    out = replaceAllLiteral(out, needle, label);
    if (process.platform === "win32") out = replaceAllLiteral(out, needle.replace(/\\/g, "/"), label);
  }
  return out;
}

function sanitizeTraceValue(value: unknown): unknown {
  if (typeof value === "string") return redactTraceString(value);
  if (Array.isArray(value)) return value.map(sanitizeTraceValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeTraceValue(item);
    }
    return out;
  }
  return value;
}

function detailsToText(details: Record<string, unknown>): string {
  const parts = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${key}=${rendered}`;
    });
  return parts.join(", ");
}

function appendHumanTraceLine(event: {
  ts: string;
  source: string;
  sessionId: string;
  flow: string;
  action: string;
  status: string;
  message: string;
  details: Record<string, unknown>;
}): void {
  const time = event.ts.slice(11, 19);
  const row = [
    time.padEnd(10),
    event.source.padEnd(8).slice(0, 8),
    event.flow.padEnd(22).slice(0, 22),
    event.action.padEnd(30).slice(0, 30),
    event.status.padEnd(10).slice(0, 10),
    (detailsToText(event.details) || event.message),
  ].join(" | ");
  appendFileSync(CALIBR_ACTION_TRACE_LOG, row + "\n", "utf8");
}

export function traceSessionStart(): void {
  try {
    mkdirSync(CALIBR_LOGS_DIR, { recursive: true });
    const now = new Date().toISOString();
    const line = "=".repeat(110);
    const header = [
      "",
      line,
      `SESSION ${CALIBR_TRACE_SESSION_ID} | ${now} | ${process.platform} | data=<CALIBR_DATA_DIR>`,
      line,
      "TIME       | SOURCE   | FLOW                   | ACTION                         | STATUS     | DETAILS",
      "-".repeat(110),
    ].join("\n");
    appendFileSync(CALIBR_ACTION_TRACE_LOG, header + "\n", "utf8");
    traceAction({
      flow: "session",
      action: "start",
      status: "started",
      message: "session > start",
      details: { sessionId: CALIBR_TRACE_SESSION_ID, platform: process.platform, dataDir: CALIBR_DATA_DIR },
    });
  } catch {
    // Trace logging must never break app startup.
  }
}

export function traceSessionEnd(reason = "user exit"): void {
  traceAction({
    flow: "session",
    action: "end",
    status: "completed",
    message: "session > end",
    details: { sessionId: CALIBR_TRACE_SESSION_ID, reason },
  });
}

export function traceAction(event: TraceEvent): void {
  try {
    mkdirSync(CALIBR_LOGS_DIR, { recursive: true });
    const details = sanitizeTraceValue(event.details ?? {}) as Record<string, unknown>;
    const line = {
      ts: new Date().toISOString(),
      source: event.source ?? "cli",
      sessionId: CALIBR_TRACE_SESSION_ID,
      flow: event.flow,
      action: event.action,
      status: event.status,
      message: redactTraceString(event.message ?? `${event.flow} > ${event.action} ${event.status}`),
      details,
    };
    appendFileSync(CALIBR_ACTION_TRACE, JSON.stringify(line) + "\n", "utf8");
    appendHumanTraceLine(line);
  } catch {
    // Trace logging must never break the app path it is trying to observe.
  }
}

function readJsonSafe<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    let raw = readFileSync(path, "utf8");
    // PowerShell writes JSON with a UTF-8 BOM; JSON.parse rejects it.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function deepMerge<T extends Record<string, any>>(base: T, over: any): T {
  if (!over || typeof over !== "object") return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const k of Object.keys(over)) {
    const bv = (base as any)[k];
    const ov = over[k];
    if (
      bv && ov &&
      typeof bv === "object" && typeof ov === "object" &&
      !Array.isArray(bv) && !Array.isArray(ov)
    ) {
      out[k] = deepMerge(bv, ov);
    } else {
      out[k] = ov;
    }
  }
  return out;
}

export interface Config {
  llama_server_exe?: string;
  scan_paths?: string[];
  hardware?: {
    vram_total_mib?: number;
    vram_safety_budget_mib?: number;
    vram_safety_budget_pct?: number;
    gpu_name?: string;
    gpu_backend_hint?: string;
    memory_unified?: boolean;
    unified_memory_total_mib?: number;
  };
  [k: string]: any;
}

export function loadConfig(): Config {
  const def = readJsonSafe<Config>(CALIBR_DEFAULT_CFG, {});
  const loc = readJsonSafe<Config>(CALIBR_LOCAL_CFG, {});
  return deepMerge(def, loc);
}

export interface LlamaServerCandidate {
  path: string;
  label: string;
  version?: string;
}

export function normalizeLlamaBuildInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^\d{1,4}$/.test(trimmed)) return `b${trimmed}`;
  if (/^b\d{1,4}$/i.test(trimmed)) return `b${trimmed.slice(1)}`;
  return null;
}

function findFileUnder(root: string, filename: string, maxDepth: number): string[] {
  if (!root || maxDepth < 0 || !existsSync(root)) return [];
  const out: string[] = [];
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      out.push(full);
    } else if (entry.isDirectory() && maxDepth > 0) {
      out.push(...findFileUnder(full, filename, maxDepth - 1));
    }
  }
  return out;
}

function candidateLabel(path: string): { label: string; version?: string } {
  const version = path.match(/\b(b\d{1,5})\b/i)?.[1];
  const dir = basename(dirname(path));
  return {
    version,
    label: `${version ?? dir} - ${path}`,
  };
}

export function findLlamaServerCandidates(): LlamaServerCandidate[] {
  const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const paths: string[] = [];
  const rootsOnly = process.env.CALIBR_LLAMA_SCAN_ROOTS_ONLY === "1";

  if (!rootsOnly) {
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(dir, binName);
      if (existsSync(candidate)) paths.push(candidate);
    }

    paths.push(...findFileUnder(join(CALIBR_DATA_DIR, "llama-bin"), binName, 5));
  }

  const extraRoots = (process.env.CALIBR_LLAMA_SCAN_ROOTS ?? "")
    .split(delimiter)
    .map(s => s.trim())
    .filter(Boolean);
  for (const root of extraRoots) paths.push(...findFileUnder(root, binName, 5));

  if (!rootsOnly) {
    let parent = CALIBR_ROOT;
    for (let i = 0; i < 3; i++) {
      parent = dirname(parent);
      if (!parent) break;
      paths.push(...findFileUnder(parent, binName, 2));
    }
  }

  const seen = new Set<string>();
  return paths
    .filter(path => {
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(path => ({ path, ...candidateLabel(path) }));
}

export interface CachedLlamaBuild {
  tag: string;
  flavor: string;
  path: string;
  label: string;
}

export function listCachedLlamaBuilds(): CachedLlamaBuild[] {
  const root = join(CALIBR_DATA_DIR, "llama-bin");
  if (!existsSync(root)) return [];
  const out: CachedLlamaBuild[] = [];
  const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  for (const tagEntry of readdirSync(root, { withFileTypes: true })) {
    if (!tagEntry.isDirectory() || tagEntry.name === "archives") continue;
    const tagDir = join(root, tagEntry.name);
    for (const flavorEntry of readdirSync(tagDir, { withFileTypes: true })) {
      if (!flavorEntry.isDirectory()) continue;
      const flavorDir = join(tagDir, flavorEntry.name);
      const servers = findFileUnder(flavorDir, binName, 4);
      for (const server of servers) {
        const label = `${tagEntry.name} ${flavorEntry.name} - ${server}`;
        out.push({ tag: tagEntry.name, flavor: flavorEntry.name, path: server, label });
      }
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function deleteCachedLlamaBuild(build: CachedLlamaBuild): void {
  const root = join(CALIBR_DATA_DIR, "llama-bin");
  const dir = join(root, build.tag, build.flavor);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Set a single top-level field on the LOCAL config.json without touching
 * any other key. Used by the config-edit screens (e.g. LlamaPathView).
 * Creates config.json with just this field if it doesn't exist yet —
 * the engine's deepMerge with config.default.json fills the rest at
 * read time, so the file stays minimal.
 *
 * Two-space indent matches PowerShell's ConvertTo-Json default so a hand
 * edit of the file doesn't look out of place next to an engine-init write.
 */
export function updateLocalConfigField(key: string, value: unknown): void {
  let parsed: Record<string, unknown> = {};
  if (existsSync(CALIBR_LOCAL_CFG)) {
    try {
      let raw = readFileSync(CALIBR_LOCAL_CFG, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        parsed = data as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  parsed[key] = value;
  writeFileSync(CALIBR_LOCAL_CFG, JSON.stringify(parsed, null, 2), "utf8");
}

/**
 * Open a native Windows file picker (System.Windows.Forms.OpenFileDialog)
 * and return the selected absolute path, or null on cancel / error.
 *
 * Shells out to PowerShell because Node has no built-in file dialog and
 * Ink runs in the terminal. PS -STA is required: OpenFileDialog needs
 * a single-threaded apartment and PS defaults to MTA. The dialog pops
 * over the terminal; the TUI is frozen while it's up because spawnSync
 * blocks the event loop, which is the behavior we want (user picks,
 * dialog closes, render resumes).
 *
 * filter syntax: "Label|*.ext|Other|*.foo" — same as the native one.
 */
export function pickFileSync(opts: {
  title?: string;
  filter?: string;
  initialDir?: string;
} = {}): string | null {
  // Single-quote PS string escaping: ' → ''.
  const esc = (s: string) => s.replace(/'/g, "''");
  const lines = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$dlg = New-Object System.Windows.Forms.OpenFileDialog",
    "$dlg.CheckFileExists = $true",
    "$dlg.Multiselect = $false",
  ];
  if (opts.title)  lines.push(`$dlg.Title = '${esc(opts.title)}'`);
  if (opts.filter) lines.push(`$dlg.Filter = '${esc(opts.filter)}'`);
  if (opts.initialDir) {
    lines.push(`if (Test-Path -LiteralPath '${esc(opts.initialDir)}') { $dlg.InitialDirectory = '${esc(opts.initialDir)}' }`);
  }
  lines.push("if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }");

  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", lines.join("; ")],
    { encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0) return null;
  const out = (res.stdout || "").trim();
  return out.length > 0 ? out : null;
}

export function pickFolderSync(opts: {
  description?: string;
  initialDir?: string;
} = {}): string | null {
  const esc = (s: string) => s.replace(/'/g, "''");
  const lines = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dlg.ShowNewFolderButton = $true",
  ];
  if (opts.description) lines.push(`$dlg.Description = '${esc(opts.description)}'`);
  if (opts.initialDir) {
    lines.push(`if (Test-Path -LiteralPath '${esc(opts.initialDir)}') { $dlg.SelectedPath = '${esc(opts.initialDir)}' }`);
  }
  lines.push("if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }");

  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", lines.join("; ")],
    { encoding: "utf8", windowsHide: true },
  );
  if (res.status !== 0) return null;
  const out = (res.stdout || "").trim();
  return out.length > 0 ? out : null;
}

export interface Status {
  config: Config;
  catalogCount: number;
  planCount: number;
  resultsCount: number;
  hasReport: boolean;
  hasLocalConfig: boolean;
  bundled: boolean;
  dataDir: string;
}

export function readStatus(): Status {
  const config = loadConfig();
  const catalog = readJsonSafe<any[]>(CALIBR_CATALOG, []);
  const plan = readJsonSafe<any[]>(CALIBR_PLAN, []);
  // Count only entries whose model file is still on disk, so the menu card
  // never advertises a model that was rotated/deleted (the engine prunes the
  // JSON on its next run; this keeps the UI honest before that happens).
  // Coerce to array: a single-model catalog is serialized as a bare object.
  const catArr = Array.isArray(catalog) ? catalog : (catalog ? [catalog] : []);
  const planArr = Array.isArray(plan) ? plan : (plan ? [plan] : []);
  const liveCatalog = catArr.filter(m => m?.path && existsSync(m.path));
  const livePlan = planArr.filter(p => p?.model_path && existsSync(p.model_path));
  let resultsCount = 0;
  if (existsSync(CALIBR_RESULTS_DIR) && statSync(CALIBR_RESULTS_DIR).isDirectory()) {
    resultsCount = readdirSync(CALIBR_RESULTS_DIR).filter(f => f.endsWith(".json")).length;
  }
  return {
    config,
    catalogCount: liveCatalog.length,
    planCount: livePlan.length,
    resultsCount,
    hasReport: existsSync(CALIBR_REPORT),
    hasLocalConfig: existsSync(CALIBR_LOCAL_CFG),
    bundled: IS_BUNDLED,
    dataDir: CALIBR_DATA_DIR,
  };
}

export interface Result {
  id: string;
  label: string;
  level?: "low" | "middle" | "high" | "ultra" | string | null;
  sweep?: "context" | "moe-cpu" | "offload" | string | null;
  model: string;
  variant: string;
  series?: string;
  ok: boolean;
  ready?: boolean;
  error?: string | null;
  prompt_tps?: number;
  eval_tps?: number;
  vram_peak_mib?: number;
  shared_peak_mib?: number;
  wddm_vram_saturation?: number;
  fit_status?: string;
  failure_reason?: "vram_overflow" | "server_timeout" | "unsupported_arch" | "model_missing" | "other" | null;
  unsupported_architecture?: string | null;
  extra_args?: string;
  timestamp?: string;
  // Extended metrics (v0.1.3+). Null when not collected (failure before
  // bench POST, or pre-extended-metrics legacy result JSONs).
  ttft_sec?: number | null;
  gpu_power_peak_w?: number;
  gpu_temp_peak_c?: number;
  gpu_util_avg_pct?: number;
  ram_baseline_mib?: number;
  ram_used_peak_mib?: number;
  disk_read_peak_mb_s?: number;
  [k: string]: any;
}

export function cachedResultsCount(): number {
  // Number of result JSON files currently in data/results/. Used by the
  // form footers to warn the user that some configs will be skipped unless
  // -Force is set. We intentionally don't try to match each file against a
  // would-be plan — for the user this rough count answers the actually
  // useful question 'is there any cache state on disk?'.
  if (!existsSync(CALIBR_RESULTS_DIR)) return 0;
  try {
    return readdirSync(CALIBR_RESULTS_DIR).filter(f => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function readResults(): Result[] {
  if (!existsSync(CALIBR_RESULTS_DIR)) return [];
  const out: Result[] = [];
  for (const f of readdirSync(CALIBR_RESULTS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const r = readJsonSafe<Result | null>(join(CALIBR_RESULTS_DIR, f), null);
    if (r && typeof r === "object") out.push(r);
  }
  return out;
}

// Same rule the engine uses: safety beats speed; among equally-safe, higher eval_tps wins.
// Threshold matches calibr.ps1 winner picker: shared_peak_mib <= shared_delta_confirm_mib.
function sharedConfirmMib(cfg: Config): number {
  const v = cfg?.wddm_detection?.shared_delta_confirm_mib;
  return typeof v === "number" ? v : 500;
}

export function isSafe(r: Result, threshold: number): boolean {
  return winnerIsSafe(r, threshold);
}

export type ResultStatus = "safe" | "wddm" | "high" | "fail" | "noload" | "na";

export function classifyResult(r: Result, threshold: number): ResultStatus {
  if (r.ok) {
    if ((r.shared_peak_mib ?? 0) > threshold) return "wddm";
    if ((r.wddm_vram_saturation ?? 0) > 0.92) return "high";
    return "safe";
  }
  if (r.unsupported_architecture) return "na";
  if (r.ready === false) return "noload";
  return "fail";
}

export interface ModelGroup {
  model: string;
  series?: string;
  winner: Result;
  configs: Result[];
  successCount: number;
  totalCount: number;
}

export function groupByModel(results: Result[], cfg?: Config): ModelGroup[] {
  const threshold = sharedConfirmMib(cfg ?? loadConfig());
  const groups = new Map<string, Result[]>();
  for (const r of results) {
    const key = r.model ?? r.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const out: ModelGroup[] = [];
  for (const [model, configs] of groups) {
    const oks = configs.filter(c => c.ok);
    if (oks.length === 0) continue;
    const winnerMap = groupWinners(oks, "safety", { confirmMib: threshold });
    const winner = winnerMap[model] as WinnerWithMeta<Result>;
    out.push({
      model,
      series: winner.series,
      winner,
      configs: configs.sort((a, b) => (b.eval_tps ?? -1) - (a.eval_tps ?? -1)),
      successCount: oks.length,
      totalCount: configs.length,
    });
  }
  return out.sort((a, b) => (b.winner.eval_tps ?? 0) - (a.winner.eval_tps ?? 0));
}

export function getSharedThreshold(cfg?: Config): number {
  return sharedConfirmMib(cfg ?? loadConfig());
}

export interface EngineRun {
  proc: ChildProcess;
  // Resolves to exit code.
  done: Promise<number>;
}

// Inject data dir + local config path so the engine writes to the same
// place the CLI reads from. Without these, a bundled install would read
// from %LOCALAPPDATA%\calibr but the PowerShell engine would still write
// next to its own script (inside node_modules).
function buildEngineEnv(trace?: TraceContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    CALIBR_DATA_DIR: CALIBR_DATA_DIR,
    CALIBR_TRACE_SESSION_ID,
    // Default-on from the CLI: wire the compiled TS bench runner so
    // engine/bench.ps1 can delegate chat/completions to it. Opt out with
    // CALIBR_TS_BENCH=0. Standalone calibr.ps1 keeps using PowerShell unless
    // these adapter-owned vars are provided.
    ...(process.env.CALIBR_TS_BENCH !== "0"
      ? {
          CALIBR_TS_BENCH: "1",
          CALIBR_TS_BENCH_SCRIPT: join(__dirname, "benchRunnerCli.js"),
          CALIBR_NODE: process.execPath,
        }
      : {}),
    ...(trace ? { CALIBR_TRACE_PARENT: JSON.stringify(trace) } : {}),
  };
}

function injectConfigArg(args: string[]): string[] {
  if (args.includes("-Config")) return args;
  // First arg is the verb (status / bench / etc.) — keep it leading.
  const [verb, ...rest] = args;
  return [verb, "-Config", CALIBR_LOCAL_CFG, ...rest];
}

// All engine invocations from the CLI are non-interactive: the CLI has no
// way to forward keystrokes to a Read-Host prompt in the child PowerShell
// (stdin isn't wired through Ink), so a prompt would hang forever. Any
// confirmation the engine would have asked for is collected by the CLI
// up front (see AllOptionsView's pre-flight gate). Idempotent so callers
// that pre-set the flag don't double it.
function injectNonInteractive(args: string[]): string[] {
  if (args.includes("-NonInteractive")) return args;
  return [...args, "-NonInteractive"];
}

function redactEngineArgsForTrace(args: string[]): string[] {
  const redacted = [...args];
  for (let i = 0; i < redacted.length - 1; i++) {
    if (redacted[i] === "-ScanPath" || redacted[i] === "-Destination") {
      redacted[i + 1] = "<model_folder_dir>";
      i++;
    }
  }
  return redacted;
}

/**
 * Shell out to calibr.ps1 with the given engine arguments.
 * stdout/stderr are streamed to the caller via the child process.
 */
function inferTraceContext(args: string[]): TraceContext {
  const verb = args[0] ?? "unknown";
  return {
    flow: "engine command",
    action: verb,
    message: `engine command > ${verb}`,
    details: { args },
  };
}

export function runEngine(args: string[], trace?: TraceContext): EngineRun {
  const isWin = process.platform === "win32";
  // Windows PowerShell needs -ExecutionPolicy Bypass to run an unsigned .ps1;
  // pwsh on Linux has no execution policy, so we omit it there.
  const shell = isWin ? "powershell" : "pwsh";
  const psArgs = [
    "-NoProfile",
    ...(isWin ? ["-ExecutionPolicy", "Bypass"] : []),
    "-File", CALIBR_PS1,
    ...injectNonInteractive(injectConfigArg(args)),
  ];
  const traceContext = trace ?? inferTraceContext(args);
  const traceArgs = redactEngineArgsForTrace(args);
  traceAction({
    ...traceContext,
    status: "started",
    details: { ...(traceContext.details ?? {}), args: traceArgs },
  });
  const proc = spawn(shell, psArgs, {
    cwd: ENGINE_ROOT,
    windowsHide: true,
    // On POSIX, give the engine its own process group so killTree can reap
    // the whole tree (pwsh + the llama-server it spawns) with kill(-pgid).
    detached: !isWin,
    env: buildEngineEnv(traceContext),
  });
  const done = new Promise<number>((res) => {
    proc.on("close", (code) => {
      const exitCode = code ?? -1;
      traceAction({
        ...traceContext,
        status: exitCode === 0 ? "completed" : "failed",
        details: { ...(traceContext.details ?? {}), args: traceArgs, exitCode },
      });
      res(exitCode);
    });
    proc.on("error", (error) => {
      traceAction({
        ...traceContext,
        status: "failed",
        message: `${traceContext.flow} > ${traceContext.action} failed to launch engine`,
        details: { ...(traceContext.details ?? {}), args: traceArgs, error: error.message },
      });
      res(-1);
    });
  });
  return { proc, done };
}

/**
 * Run an engine verb and capture its full stdout/stderr (vs runEngine, which
 * streams). Used for verbs whose stdout is structured data the CLI parses
 * (today: `doctor -Json`). Resolves, never rejects.
 */
export function captureEngine(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell" : "pwsh";
  const psArgs = [
    "-NoProfile",
    ...(isWin ? ["-ExecutionPolicy", "Bypass"] : []),
    "-File", CALIBR_PS1,
    ...injectNonInteractive(injectConfigArg(args)),
  ];
  return new Promise((res) => {
    const proc = spawn(shell, psArgs, { cwd: ENGINE_ROOT, windowsHide: true, env: buildEngineEnv() });
    let stdout = "", stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
    proc.on("error", (e) => res({ code: -1, stdout, stderr: stderr + String(e) }));
  });
}

// ---------------------------------------------------------------------------
// Doctor (sanity check). Mirrors the engine's JSON contract (schemaVersion 1).
// ---------------------------------------------------------------------------
export type DoctorCheck = "ok" | "warning" | "fail" | "missing" | "skipped";

export interface DoctorDep {
  name: string;
  kind: string;
  required: boolean;
  present: boolean;
  version?: string | null;
  command?: string | null;
  log?: string;
  check: DoctorCheck;
  detail?: string | null;
  remediation?: string | null;
}

export interface DoctorReport {
  schemaVersion: number;
  calibrVersion?: string | null;
  generatedAt: string;
  extended: boolean;
  overallStatus: "ok" | "degraded" | "unable-to-start";
  inference: { gpuOffloadPossible: boolean; recommendedBackend: string; reason: string };
  systemInfo: {
    os: { platform: string; name: string; kernel?: string | null };
    cpu: { model?: string | null; arch?: string | null; coresPhysical?: number | null; threadsLogical?: number | null; flags?: Record<string, boolean> | null };
    ram: { totalMib?: number | null; availableMib?: number | null };
    gpus: Array<{
      name: string;
      vendor?: string | null;
      vramTotalMib?: number | null;
      memoryUnified?: boolean | null;
      unifiedMemoryTotalMib?: number | null;
      backendHint?: string | null;
      kernelDriver?: string | null;
      powerW?: number | null;
      metalSupported?: boolean | null;
      vulkanDevice?: string | null;
    }>;
  };
  deps: DoctorDep[];
}

export const DOCTOR_ISSUE_URL = "https://github.com/SpeederX/calibr/issues/new";

function hasCommand(cmd: string): boolean {
  try {
    return spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Pick a command that opens `target` (a local file path or a URL) in a web
 * browser. On Linux we deliberately prefer real browser launchers
 * (`$BROWSER`, x-www-browser, sensible-browser) over `xdg-open`: xdg-open
 * dispatches a local .html by its text/html MIME association, which a
 * non-browser app can hijack (seen in the wild: a password manager grabbing
 * text/html, so the report opened there instead of Firefox). Browser
 * launchers and Windows `start` / macOS `open` use the browser association.
 */
function browserOpener(target: string): [string, string[]] {
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", target]];
  if (process.platform === "darwin") return ["open", [target]];
  const envBrowser = process.env.BROWSER?.trim();
  if (envBrowser) return [envBrowser, [target]];
  for (const c of ["x-www-browser", "sensible-browser"]) {
    if (hasCommand(c)) return [c, [target]];
  }
  return ["xdg-open", [target]];
}

function launchDetached(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Open a URL in the OS default browser. */
export function openUrl(url: string): void {
  const [cmd, args] = browserOpener(url);
  const ok = launchDetached(cmd, args);
  traceAction({
    flow: "help",
    action: "open url",
    status: ok ? "completed" : "failed",
    message: `help > open url ${ok ? "launched" : "failed"}`,
    details: { url, command: cmd },
  });
}

/** Run `doctor -Json` and parse the contract. Resolves with an error string on failure. */
export async function runDoctor(extended: boolean): Promise<{ report?: DoctorReport; error?: string }> {
  const args = ["doctor", "-Json"];
  if (extended) args.push("-Extended");
  const { code, stdout, stderr } = await captureEngine(args);
  const text = stdout.trim();
  if (!text) return { error: stderr.trim() || `doctor exited with code ${code} and no output` };
  try {
    return { report: JSON.parse(text) as DoctorReport };
  } catch {
    // The JSON is the last contiguous {...} block; salvage it if a stray
    // line slipped onto stdout ahead of it.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return { report: JSON.parse(text.slice(start, end + 1)) as DoctorReport }; } catch { /* fall through */ }
    }
    return { error: `could not parse doctor output: ${text.slice(0, 200)}` };
  }
}

/** Run `doctor -Export` (always extended) to a known path and return it. */
export async function exportDoctor(extended: boolean): Promise<{ path?: string; error?: string }> {
  const path = join(CALIBR_DATA_DIR, "doctor-report.json");
  const args = ["doctor", "-Export", "-ExportPath", path];
  if (extended) args.push("-Extended");
  const { code, stderr } = await captureEngine(args);
  if (existsSync(path)) return { path };
  return { error: stderr.trim() || `export failed (exit ${code})` };
}

/**
 * Open the generated HTML report with the OS default browser.
 * Returns true if the report exists and the open command was launched,
 * false if the report has not been generated yet.
 */
export function openReport(): boolean {
  if (!existsSync(CALIBR_REPORT)) {
    traceAction({
      flow: "results",
      action: "open report",
      status: "failed",
      message: "results > open report failed: report.html is missing",
      details: { report: CALIBR_REPORT },
    });
    return false;
  }
  const [cmd, args] = browserOpener(CALIBR_REPORT);
  const ok = launchDetached(cmd, args);
  traceAction({
    flow: "results",
    action: "open report",
    status: ok ? "completed" : "failed",
    message: `results > open report ${ok ? "launched" : "failed"}`,
    details: { report: CALIBR_REPORT, command: cmd, args },
  });
  return ok;
}

// ---------------------------------------------------------------------------
// Model catalog (curated GGUF download list shipped with the engine).
// The 'Sample' / 'samples' naming was retired in v0.1.3 because it
// overloaded 'sample' (which has a separate meaning in ML — token sampling
// from a distribution). CatalogEntry / readModelCatalog / filterCatalog
// make the intent explicit.
// ---------------------------------------------------------------------------
export interface CatalogEntry {
  id: string;
  model: string;
  series?: string;
  variant?: string;
  sweep_hint?: "context" | "moe-cpu" | "offload" | string;
  hf_repo: string;
  hf_file: string;
  target_dir: string;
  mmproj_file?: string;
  size_bytes: number;
  max_context?: number;
  notes?: string;
}

export function readModelCatalog(): CatalogEntry[] {
  const path = join(ENGINE_ROOT, "models_catalog.json");
  const parsed = readJsonSafe<{ models?: CatalogEntry[] }>(path, {});
  return Array.isArray(parsed.models) ? parsed.models : [];
}

function catalogIdGlobs(catalogId: string): RegExp[] {
  return catalogId
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(glob => {
      const pattern = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
      return new RegExp(pattern, "i");
    });
}

export function filterCatalog(entries: CatalogEntry[], opts: { catalogId?: string; model?: string }): CatalogEntry[] {
  return entries.filter(e => {
    if (opts.catalogId) {
      // Mirror PowerShell -like (case-insensitive glob), including the
      // engine's comma-separated -CatalogId list.
      const patterns = catalogIdGlobs(opts.catalogId);
      if (patterns.length > 0 && !patterns.some(pattern => pattern.test(e.id))) return false;
    }
    if (opts.model) {
      // Mirror PowerShell -match (case-insensitive regex).
      try { if (!new RegExp(opts.model, "i").test(e.model)) return false; }
      catch { return false; }
    }
    return true;
  });
}

export function downloadFootprintBytes(entries: CatalogEntry[]): { totalBytes: number; maxFileBytes: number } {
  let total = 0;
  let max = 0;
  for (const e of entries) {
    const b = Number(e.size_bytes) || 0;
    total += b;
    if (b > max) max = b;
  }
  return { totalBytes: total, maxFileBytes: max };
}

// ---------------------------------------------------------------------------
// Bench presets (default + user-saved)
// ---------------------------------------------------------------------------
export interface Preset {
  label: string;
  hardware_target?: string;
  models: "*" | string[];
  max_ctx?: number | null;
  context_sizes?: number[];
}

export const CALIBR_USER_PRESETS = join(CALIBR_DATA_DIR, "user_bench_presets.json");

/**
 * Save (or replace) a named preset in data/user_bench_presets.json. Used by
 * CustomBenchView v2 to persist a model selection (+ optional ctx-size set) for
 * reuse via `all -Preset <name>`. Returns the destination path.
 */
export function saveUserPreset(name: string, ids: string[], contextSizes?: number[]): string {
  let doc: { $schema_version?: number; presets?: Record<string, Preset> } = {};
  if (existsSync(CALIBR_USER_PRESETS)) {
    try {
      let raw = readFileSync(CALIBR_USER_PRESETS, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") doc = parsed;
    } catch { /* corrupt file: overwrite with a fresh doc */ }
  }
  if (!doc.presets || typeof doc.presets !== "object") doc.presets = {};
  if (doc.$schema_version == null) doc.$schema_version = 1;
  const preset: Preset = {
    label: `${name} — user-saved (${ids.length} model${ids.length === 1 ? "" : "s"})`,
    models: ids,
  };
  if (contextSizes && contextSizes.length > 0) {
    preset.context_sizes = [...contextSizes].sort((a, b) => a - b);
    preset.max_ctx = Math.max(...contextSizes);
  }
  doc.presets[name] = preset;
  mkdirSync(CALIBR_DATA_DIR, { recursive: true });
  writeFileSync(CALIBR_USER_PRESETS, JSON.stringify(doc, null, 2), "utf8");
  return CALIBR_USER_PRESETS;
}

export function readPresetCatalog(): Record<string, Preset> {
  // Merge default_bench_presets.json (shipped, at ENGINE_ROOT) with
  // data/user_bench_presets.json (user-saved). Same-name user presets
  // override defaults (replace, not merge).
  const merged: Record<string, Preset> = {};
  const paths = [
    join(ENGINE_ROOT, "default_bench_presets.json"),
    join(CALIBR_DATA_DIR, "user_bench_presets.json"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      let raw = readFileSync(p, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      if (parsed?.presets && typeof parsed.presets === "object") {
        for (const [name, preset] of Object.entries(parsed.presets)) {
          merged[name] = preset as Preset;
        }
      }
    } catch {
      // skip unreadable preset file; the engine will warn at runtime
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Disk-space probing for the download destination
// ---------------------------------------------------------------------------
export function downloadDestination(cfg?: Config): string {
  const c = cfg ?? loadConfig();
  if (Array.isArray(c.scan_paths) && c.scan_paths.length > 0) return c.scan_paths[0]!;
  return join(CALIBR_DATA_DIR, "downloaded-models");
}

// Walks up the path until it finds a directory that exists, then statfs's
// that. statfsSync errors out on a non-existent path, but the destination
// folder may legitimately not exist yet (e.g. first-time download into a
// scan_paths[0] that the user just configured).
export function freeBytesOn(path: string): number {
  let probe = path;
  while (probe && !existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!probe || !existsSync(probe)) {
    // Fall back to the filesystem root so we at least report something.
    probe = parsePath(path).root || (process.platform === "win32" ? "C:\\" : "/");
    if (!existsSync(probe)) return -1;
  }
  try {
    const stat = statfsSync(probe);
    // bavail = blocks free for non-superuser. Multiply by block size for bytes.
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return -1;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 0) return "?";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024)       return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
