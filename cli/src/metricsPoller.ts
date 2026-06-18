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
  disk_read_mb_s: number;
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

async function sampleProcessVram(pid: number, command = "nvidia-smi"): Promise<number> {
  const query = await runNvidiaSmi(
    ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
    command,
  );
  const fromQuery = parseComputeAppsQuery(query, pid);
  if (fromQuery >= 0) return fromQuery;
  return parseStandardNvidiaSmi(await runNvidiaSmi([], command), pid);
}

async function sampleWindowsSystemMetrics(): Promise<{ shared_mib: number; disk_read_mb_s: number }> {
  if (process.platform !== "win32") return { shared_mib: -1, disk_read_mb_s: 0 };
  const script = [
    "$s=-1; $d=0",
    "try { $c=Get-Counter '\\GPU Adapter Memory(*)\\Shared Usage' -MaxSamples 1 -ErrorAction Stop; $s=[int](($c.CounterSamples | Measure-Object CookedValue -Sum).Sum/1MB) } catch {}",
    "try { $c=Get-Counter '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec' -MaxSamples 1 -ErrorAction Stop; $d=[double](($c.CounterSamples | Select-Object -First 1).CookedValue/1MB) } catch {}",
    "Write-Output (('{0},{1}' -f $s,$d))",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const [shared, disk] = stdout.trim().split(",");
    return {
      shared_mib: Math.trunc(num(shared, -1)),
      disk_read_mb_s: num(disk, 0),
    };
  } catch {
    return { shared_mib: -1, disk_read_mb_s: 0 };
  }
}

let systemMetricsCache = { atMs: 0, value: { shared_mib: -1, disk_read_mb_s: 0 } };
let systemMetricsPending: Promise<{ shared_mib: number; disk_read_mb_s: number }> | null = null;

async function sampleWindowsSystemMetricsCached(nowMs: number): Promise<{ shared_mib: number; disk_read_mb_s: number }> {
  if (nowMs - systemMetricsCache.atMs < 1000) return systemMetricsCache.value;
  if (!systemMetricsPending) {
    systemMetricsPending = sampleWindowsSystemMetrics().then((value) => {
      systemMetricsCache = { atMs: Date.now(), value };
      systemMetricsPending = null;
      return value;
    });
  }
  return systemMetricsPending;
}

export async function collectMetricSample(
  pid: number,
  command = "nvidia-smi",
  now = () => new Date(),
  includeSystemMetrics = false,
): Promise<MetricSample> {
  const gpu = parseGpuQuery(await runNvidiaSmi(
    ["--query-gpu=memory.used,power.draw,temperature.gpu,utilization.gpu", "--format=csv,noheader,nounits"],
    command,
  ));
  const at = now();
  const system = includeSystemMetrics
    ? await sampleWindowsSystemMetricsCached(at.getTime())
    : { shared_mib: -1, disk_read_mb_s: 0 };
  return {
    at: at.toISOString(),
    ...gpu,
    process_vram_mib: await sampleProcessVram(pid, command),
    shared_mib: system.shared_mib,
    ram_avail_mib: Math.trunc(os.freemem() / 1024 / 1024),
    disk_read_mb_s: system.disk_read_mb_s,
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
