import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

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
export const CALIBR_REPORT = join(CALIBR_DATA_DIR, "report.html");
export const CALIBR_DEFAULT_CFG = join(ENGINE_ROOT, "config.default.json");
export const CALIBR_LOCAL_CFG = defaultConfigPath();
export const CALIBR_PS1 = join(ENGINE_ROOT, "calibr.ps1");

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
  };
  [k: string]: any;
}

export function loadConfig(): Config {
  const def = readJsonSafe<Config>(CALIBR_DEFAULT_CFG, {});
  const loc = readJsonSafe<Config>(CALIBR_LOCAL_CFG, {});
  return deepMerge(def, loc);
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
  let resultsCount = 0;
  if (existsSync(CALIBR_RESULTS_DIR) && statSync(CALIBR_RESULTS_DIR).isDirectory()) {
    resultsCount = readdirSync(CALIBR_RESULTS_DIR).filter(f => f.endsWith(".json")).length;
  }
  return {
    config,
    catalogCount: Array.isArray(catalog) ? catalog.length : 0,
    planCount: Array.isArray(plan) ? plan.length : 0,
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
  tier: "A" | "B" | "C" | string;
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
  failure_reason?: "vram_overflow" | "server_timeout" | "unsupported_arch" | "other" | null;
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
  return (r.shared_peak_mib ?? 0) <= threshold;
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

function beats(a: Result, b: Result, threshold: number): boolean {
  const sa = isSafe(a, threshold), sb = isSafe(b, threshold);
  if (sa !== sb) return sa;
  return (a.eval_tps ?? -1) > (b.eval_tps ?? -1);
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
    let winner = oks[0];
    for (const c of oks.slice(1)) if (beats(c, winner, threshold)) winner = c;
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
function buildEngineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    CALIBR_DATA_DIR: CALIBR_DATA_DIR,
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
// that pre-set the flag (e.g. ENGINE_COMMANDS init) don't double it.
function injectNonInteractive(args: string[]): string[] {
  if (args.includes("-NonInteractive")) return args;
  return [...args, "-NonInteractive"];
}

/**
 * Shell out to calibr.ps1 with the given engine arguments.
 * stdout/stderr are streamed to the caller via the child process.
 */
export function runEngine(args: string[]): EngineRun {
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
  const proc = spawn(shell, psArgs, {
    cwd: ENGINE_ROOT,
    windowsHide: true,
    // On POSIX, give the engine its own process group so killTree can reap
    // the whole tree (pwsh + the llama-server it spawns) with kill(-pgid).
    detached: !isWin,
    env: buildEngineEnv(),
  });
  const done = new Promise<number>((res) => {
    proc.on("close", (code) => res(code ?? -1));
    proc.on("error", () => res(-1));
  });
  return { proc, done };
}

/**
 * Open the generated HTML report with the OS default browser.
 * Returns true if the report exists and the open command was launched,
 * false if the report has not been generated yet.
 */
export function openReport(): boolean {
  if (!existsSync(CALIBR_REPORT)) return false;
  // Platform default-browser opener: cmd start (Windows), open (macOS),
  // xdg-open (Linux).
  const [cmd, cmdArgs] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", CALIBR_REPORT]]
    : process.platform === "darwin" ? ["open", [CALIBR_REPORT]]
    : ["xdg-open", [CALIBR_REPORT]];
  const child = spawn(cmd as string, cmdArgs as string[], {
    cwd: ENGINE_ROOT,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

export interface EngineCommand {
  id: string;
  label: string;
  description: string;
  args: string[];
}

export const ENGINE_COMMANDS: EngineCommand[] = [
  { id: "status",   label: "status",   description: "show current state",                   args: ["status"] },
  { id: "init",     label: "init",     description: "detect hardware, write config.json",   args: ["init", "-NonInteractive"] },
  { id: "discover", label: "discover", description: "scan scan_paths for .gguf files",      args: ["discover"] },
  { id: "plan",     label: "plan",     description: "expand catalog into a test plan",      args: ["plan"] },
  { id: "bench",    label: "bench",    description: "run pending bench configs",            args: ["bench"] },
  { id: "report",   label: "report",   description: "build HTML report + .bat launchers",   args: ["report"] },
  { id: "all",      label: "all",      description: "discover -> plan -> bench -> report",  args: ["all"] },
  { id: "reset",    label: "reset",    description: "wipe runtime state (results, downloads, ...) with confirm", args: ["reset"] },
];

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
  tier_hint?: "A" | "B" | "C" | string;
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
