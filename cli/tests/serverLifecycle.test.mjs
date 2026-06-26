import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  validateLifecyclePayload,
  waitForServerReady,
} from "../dist/engine/bench/serverLifecycle.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForStatus(path, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(readFileSync(path, "utf8"));
      if (expected.includes(status.state)) return status;
    } catch { }
    await sleep(25);
  }
  throw new Error(`status did not reach ${expected.join("/")}`);
}

test("validateLifecyclePayload rejects incomplete payloads", () => {
  assert.equal(validateLifecyclePayload({
    executable: "",
    args: [],
    baseUrl: "",
    timeoutMs: 0,
    statusFile: "",
    stopFile: "",
    stdoutFile: "",
    stderrFile: "",
  }), "missing executable");
});

test("waitForServerReady distinguishes ready, timeout and process exit", async () => {
  let now = 0;
  let calls = 0;
  const ready = await waitForServerReady("http://127.0.0.1:1", 1000, 100, {
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async () => {
      calls++;
      return new Response(calls > 1 ? "{\"data\":[1]}" : "", { status: calls > 1 ? 200 : 503 });
    },
  });
  assert.equal(ready.reason, "ready");

  now = 0;
  const timeout = await waitForServerReady("http://127.0.0.1:1", 200, 100, {
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(timeout.reason, "timeout");

  const exited = await waitForServerReady("http://127.0.0.1:1", 200, 100, {
    isExited: () => true,
  });
  assert.equal(exited.reason, "exited");
});

test("serverLifecycleCli owns start, readiness and explicit stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "calibr-lifecycle-"));
  const port = await freePort();
  const fakeServer = join(root, "fake-server.mjs");
  const payloadPath = join(root, "payload.json");
  const statusFile = join(root, "status.json");
  const stopFile = join(root, "stop");
  const stdoutFile = join(root, "stdout.log");
  const stderrFile = join(root, "stderr.log");
  writeFileSync(fakeServer, `
    import http from "node:http";
    const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, {"content-type":"application/json"});
        res.end('{"data":[{"id":"stub"}]}');
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(port, "127.0.0.1");
    const stop = () => server.close(() => process.exit(0));
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
  `, "utf8");
  writeFileSync(payloadPath, JSON.stringify({
    executable: process.execPath,
    args: [fakeServer, "--port", String(port)],
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 3000,
    pollIntervalMs: 50,
    statusFile,
    stopFile,
    stdoutFile,
    stderrFile,
  }), "utf8");

  const supervisor = spawn(process.execPath, ["dist/engine/bench/serverLifecycleCli.js", "--json-file", payloadPath], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  try {
    const ready = await waitForStatus(statusFile, ["ready"]);
    assert.equal(ready.state, "ready");
    assert.ok(ready.serverPid > 0);
    writeFileSync(stopFile, "stop", "utf8");
    const final = await waitForStatus(statusFile, ["stopped"]);
    assert.equal(final.state, "stopped");
    const exitCode = supervisor.exitCode !== null
      ? supervisor.exitCode
      : await new Promise((resolve) => supervisor.once("close", resolve));
    assert.equal(exitCode, 0);
  } finally {
    if (supervisor.exitCode === null) supervisor.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
