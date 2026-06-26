import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ServerLifecyclePayload {
  executable: string;
  args: string[];
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  statusFile: string;
  stopFile: string;
  stdoutFile: string;
  stderrFile: string;
  parentPid?: number;
}

export type ServerLifecycleState =
  | "started"
  | "ready"
  | "timeout"
  | "exited"
  | "stopped"
  | "error";

export interface ServerLifecycleStatus {
  state: ServerLifecycleState;
  supervisorPid: number;
  serverPid: number | null;
  startedAt: string;
  loadMs: number | null;
  exitCode: number | null;
  error?: string;
}

export interface ReadinessDeps {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isExited?: () => boolean;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function validateLifecyclePayload(payload: ServerLifecyclePayload): string | null {
  if (!payload.executable) return "missing executable";
  if (!Array.isArray(payload.args)) return "args must be an array";
  if (!payload.baseUrl) return "missing baseUrl";
  if (!Number.isFinite(payload.timeoutMs) || payload.timeoutMs <= 0) return "timeoutMs must be positive";
  if (!payload.statusFile || !payload.stopFile || !payload.stdoutFile || !payload.stderrFile) {
    return "missing lifecycle file path";
  }
  return null;
}

export async function waitForServerReady(
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs = 250,
  deps: ReadinessDeps = {},
): Promise<{ ready: boolean; loadMs: number; reason: "ready" | "timeout" | "exited" }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? delay;
  const started = nowMs();

  while (nowMs() - started < timeoutMs) {
    if (deps.isExited?.()) return { ready: false, loadMs: nowMs() - started, reason: "exited" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(1000, pollIntervalMs * 2));
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
          signal: controller.signal,
        });
        const body = response.ok ? await response.text() : "";
        if (response.ok && body.length > 10) {
          return { ready: true, loadMs: nowMs() - started, reason: "ready" };
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Server is still starting.
    }
    await sleep(pollIntervalMs);
  }
  return { ready: false, loadMs: nowMs() - started, reason: "timeout" };
}

function writeStatus(path: string, status: ServerLifecycleStatus): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(status), "utf8");
  renameSync(temp, path);
}

export function stopProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { }
  }
}

function processExists(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function superviseServer(payload: ServerLifecyclePayload): Promise<ServerLifecycleStatus> {
  const error = validateLifecyclePayload(payload);
  const startedAt = new Date().toISOString();
  const baseStatus = (): ServerLifecycleStatus => ({
    state: "error",
    supervisorPid: process.pid,
    serverPid: null,
    startedAt,
    loadMs: null,
    exitCode: null,
  });
  if (error) {
    const status = { ...baseStatus(), error };
    writeStatus(payload.statusFile, status);
    return status;
  }

  mkdirSync(dirname(payload.stdoutFile), { recursive: true });
  mkdirSync(dirname(payload.stderrFile), { recursive: true });
  const stdoutFd = openSync(payload.stdoutFile, "a");
  const stderrFd = openSync(payload.stderrFile, "a");
  let child: ChildProcess;
  try {
    child = spawn(payload.executable, payload.args, {
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (spawnError) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    const status = {
      ...baseStatus(),
      error: spawnError instanceof Error ? spawnError.message : String(spawnError),
    };
    writeStatus(payload.statusFile, status);
    return status;
  }

  let exited = false;
  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  let current: ServerLifecycleStatus = {
    state: "started",
    supervisorPid: process.pid,
    serverPid: child.pid ?? null,
    startedAt,
    loadMs: null,
    exitCode: null,
  };
  writeStatus(payload.statusFile, current);

  const readiness = await waitForServerReady(
    payload.baseUrl,
    payload.timeoutMs,
    payload.pollIntervalMs ?? 250,
    { isExited: () => exited || !processExists(payload.parentPid) },
  );
  current = {
    ...current,
    state: readiness.reason === "ready" ? "ready" : readiness.reason,
    loadMs: readiness.loadMs,
    exitCode,
  };
  writeStatus(payload.statusFile, current);

  if (readiness.ready) {
    while (!exited && !existsSync(payload.stopFile) && processExists(payload.parentPid)) await delay(100);
  }

  if (!exited) {
    stopProcessTree(child);
    const deadline = Date.now() + 3000;
    while (!exited && Date.now() < deadline) await delay(50);
    if (!exited) {
      try { child.kill("SIGKILL"); } catch { }
    }
  }

  closeSync(stdoutFd);
  closeSync(stderrFd);
  current = {
    ...current,
    state: existsSync(payload.stopFile) ? "stopped" : (readiness.ready ? "exited" : current.state),
    exitCode,
  };
  writeStatus(payload.statusFile, current);
  return current;
}
