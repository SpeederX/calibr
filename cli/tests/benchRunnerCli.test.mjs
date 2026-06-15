import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runFromPayload } from "../dist/benchRunnerCli.js";

async function* streamParts(parts) {
  for (const part of parts) yield part;
}

test("runFromPayload (nostream) reproduces the PowerShell parity contract", async () => {
  const nowValues = [100, 160];
  const calls = [];
  const out = await runFromPayload(
    { baseUrl: "http://127.0.0.1:18080", prompt: "hi", maxTokens: 8, stream: false, reasoningOff: true },
    {
      nowMs: () => nowValues.shift() ?? 160,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            timings: {
              prompt_n: 2,
              prompt_per_second: 10,
              prompt_ms: 5,
              predicted_n: 4,
              predicted_per_second: 25,
              predicted_ms: 160,
            },
          }),
        };
      },
    },
  );

  assert.equal(out.ok, true);
  assert.equal(out.mode, "nostream");
  assert.equal(out.status, 200);
  assert.equal(out.total_request_ms, 60);
  assert.equal(out.ttfr_ms, null);
  assert.equal(out.e2e_ttft_ms, null);
  assert.equal(out.timings.predicted_per_second, 25);
  // The engine relies on this exact request shape.
  assert.equal(JSON.parse(calls[0].init.body).stream, false);
  assert.equal(JSON.parse(calls[0].init.body).enable_thinking, false);
});

test("runFromPayload (stream) maps streamed latency + final timings", async () => {
  const nowValues = [0, 30, 60, 70, 90];
  const out = await runFromPayload(
    { baseUrl: "http://127.0.0.1:18080", prompt: "hi", maxTokens: 8 },
    {
      nowMs: () => nowValues.shift() ?? 90,
      streamFetchImpl: async (url, init) => {
        assert.equal(JSON.parse(init.body).stream, true);
        return {
          ok: true,
          status: 200,
          body: streamParts([
            'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"y"}}],"timings":{"prompt_n":3,"prompt_per_second":30,"prompt_ms":12,"predicted_n":5,"predicted_per_second":20,"predicted_ms":250}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      },
    },
  );

  assert.equal(out.ok, true);
  assert.equal(out.mode, "stream");
  assert.equal(out.ttfr_ms, 30);
  assert.equal(out.e2e_ttft_ms, 30);
  assert.equal(out.total_request_ms, 90);
  assert.deepEqual(out.timings, {
    prompt_n: 3,
    prompt_per_second: 30,
    prompt_ms: 12,
    predicted_n: 5,
    predicted_per_second: 20,
    predicted_ms: 250,
  });
});

test("runFromPayload surfaces transport errors as ok:false", async () => {
  const out = await runFromPayload(
    { baseUrl: "http://127.0.0.1:18080", prompt: "hi", maxTokens: 8 },
    {
      nowMs: () => 0,
      streamFetchImpl: async () => {
        throw new Error("connection refused");
      },
    },
  );

  assert.equal(out.ok, false);
  assert.equal(out.mode, "stream");
  assert.match(out.error ?? "", /connection refused/);
});

test("CLI entrypoint reads payload from --json-file as UTF-8 JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "calibr-runner-json-"));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify({
    baseUrl: "http://127.0.0.1:1",
    prompt: "ciao",
    maxTokens: 1,
    stream: false,
  }), "utf8");

  try {
    const proc = spawnSync(process.execPath, [join(process.cwd(), "dist", "benchRunnerCli.js"), "--json-file", payloadPath], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(proc.status, 0);
    const out = JSON.parse(proc.stdout.trim());
    assert.equal(out.ok, false);
    assert.notEqual(out.error, "invalid payload json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
