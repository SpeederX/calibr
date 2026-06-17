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
  process_gpu_active: boolean;
  process_sm_pct: number;
  process_mem_pct: number;
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

export function parsePmonQuery(stdout: string, pid: number): Pick<MetricSample, "process_gpu_active" | "process_sm_pct" | "process_mem_pct"> {
  let smPct = -1;
  let memPct = -1;
  let seen = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 10) continue;
    if (Number(parts[1]) !== pid) continue;
    seen = true;
    const sm = num(parts[3], -1);
    const mem = num(parts[4], -1);
    if (sm > smPct) smPct = sm;
    if (mem > memPct) memPct = mem;
  }
  return {
    process_gpu_active: seen,
    process_sm_pct: Math.trunc(smPct),
    process_mem_pct: Math.trunc(memPct),
  };
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
  return -1;
}

export async function collectMetricSample(pid: number, command = "nvidia-smi", now = () => new Date()): Promise<MetricSample> {
  const gpu = parseGpuQuery(await runNvidiaSmi(
    ["--query-gpu=memory.used,power.draw,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"],
    command,
  ));
  const processActivity = parsePmonQuery(await runNvidiaSmi(["pmon", "-c", "1"], command), pid);
  return {
    at: now().toISOString(),
    ...gpu,
    ...processActivity,
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
