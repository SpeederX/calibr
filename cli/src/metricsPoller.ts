import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MetricSample {
  at: string;
  gpu_mem_mib: number;
  gpu_power_w: number;
  gpu_temp_c: number;
  gpu_util_pct: number;
  process_vram_mib: number;
  shared_mib: number;
  ram_avail_mib: number;
}

export interface MetricPollerOptions {
  pid: number;
  outFile: string;
  intervalMs?: number;
  command?: string;
  append?: (line: string) => Promise<void>;
  now?: () => Date;
}

function num(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const match = value.trim().match(/^-?[\d.]+/);
  return match ? Number(match[0]) : fallback;
}

async function runNvidiaSmi(args: string[], command = "nvidia-smi"): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function runTypeperf(counter: string): Promise<string> {
  if (process.platform !== "win32") return "";
  try {
    const { stdout } = await execFileAsync("typeperf", [counter, "-sc", "1"], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current);
  return values;
}

export function parseGpuQuery(stdout: string): Pick<MetricSample, "gpu_mem_mib" | "gpu_power_w" | "gpu_temp_c" | "gpu_util_pct"> {
  const line = stdout.split(/\r?\n/).find((row) => row.trim().length > 0) ?? "";
  const parts = line.split(",").map((part) => part.trim());
  return {
    gpu_mem_mib: Math.trunc(num(parts[0], 0)),
    gpu_power_w: num(parts[1], 0),
    gpu_temp_c: Math.trunc(num(parts[2], 0)),
    gpu_util_pct: Math.trunc(num(parts[3], -1)),
  };
}

export function parseComputeAppsQuery(stdout: string, pid: number): number {
  let total = 0;
  let seen = false;
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 3) continue;
    if (Number(parts[0]) !== pid) continue;
    const mib = parts[2].match(/(\d+)/);
    if (!mib) continue;
    total += Number(mib[1]);
    seen = true;
  }
  return seen ? total : -1;
}

export function parseStandardNvidiaSmi(stdout: string, pid: number): number {
  let total = 0;
  let seen = false;
  const pidPattern = new RegExp(`(?<!\\d)${pid}(?!\\d)`);
  for (const line of stdout.split(/\r?\n/)) {
    if (!pidPattern.test(line)) continue;
    if (!/llama-server/i.test(line)) continue;
    const mib = line.match(/(\d+)\s*MiB/i);
    if (!mib) continue;
    total += Number(mib[1]);
    seen = true;
  }
  return seen ? total : -1;
}

export function parseTypeperfGpuProcessMemory(stdout: string, pid: number): number {
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'));
  if (rows.length < 2) return -1;

  const headers = parseCsvLine(rows[0]);
  const values = parseCsvLine(rows[1]);
  const pidNeedle = `pid_${pid}_`;
  let totalBytes = 0;
  let seen = false;

  for (let i = 1; i < headers.length; i += 1) {
    const header = headers[i] ?? "";
    if (!header.toLowerCase().includes(pidNeedle)) continue;
    const bytes = Number(values[i]);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    totalBytes += bytes;
    seen = true;
  }

  return seen ? Math.trunc(totalBytes / 1024 / 1024) : -1;
}

async function sampleWindowsProcessVram(pid: number): Promise<number> {
  const dedicated = parseTypeperfGpuProcessMemory(
    await runTypeperf("\\GPU Process Memory(*)\\Dedicated Usage"),
    pid,
  );
  if (dedicated >= 0) return dedicated;

  return parseTypeperfGpuProcessMemory(
    await runTypeperf("\\GPU Process Memory(*)\\Local Usage"),
    pid,
  );
}

async function sampleProcessVram(pid: number, command = "nvidia-smi"): Promise<number> {
  const query = await runNvidiaSmi(
    ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
    command,
  );
  const fromQuery = parseComputeAppsQuery(query, pid);
  if (fromQuery >= 0) return fromQuery;
  const fromTable = parseStandardNvidiaSmi(await runNvidiaSmi([], command), pid);
  if (fromTable >= 0) return fromTable;
  return sampleWindowsProcessVram(pid);
}

export async function collectMetricSample(pid: number, command = "nvidia-smi", now = () => new Date()): Promise<MetricSample> {
  const gpu = parseGpuQuery(await runNvidiaSmi(
    ["--query-gpu=memory.used,power.draw,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"],
    command,
  ));
  return {
    at: now().toISOString(),
    ...gpu,
    process_vram_mib: await sampleProcessVram(pid, command),
    shared_mib: -1,
    ram_avail_mib: Math.trunc(os.freemem() / 1024 / 1024),
  };
}

export function startMetricPoller(options: MetricPollerOptions): () => void {
  const intervalMs = Math.max(50, options.intervalMs ?? 150);
  const append = options.append ?? ((line: string) => appendFile(options.outFile, line, "utf8"));
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const sample = await collectMetricSample(options.pid, options.command, options.now);
      await append(`${JSON.stringify(sample)}\n`);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
