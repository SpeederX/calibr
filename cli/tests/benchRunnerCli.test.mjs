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

test("runFromPayload owns warmup, KV reset, and one measured streaming request", async () => {
  const calls = [];
  const resets = [];
  let now = 0;
  const out = await runFromPayload(
    {
      baseUrl: "http://127.0.0.1:18080",
      prompt: "hi",
      maxTokens: 64,
      warmup: true,
      reasoningOff: true,
    },
    {
      nowMs: () => {
        now += 10;
        return now;
      },
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
      eraseSlot: async (baseUrl, slotId) => {
        resets.push([baseUrl, slotId]);
        return null;
      },
      streamFetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          body: streamParts([
            'data: {"choices":[{"delta":{"content":"x"}}],"timings":{"prompt_n":2,"prompt_per_second":10,"prompt_ms":5,"predicted_n":1,"predicted_per_second":25,"predicted_ms":40,"cache_n":0}}\n\n',
            'data: {"choices":[{"delta":{"content":"y"}}],"timings":{"prompt_n":2,"prompt_per_second":10,"prompt_ms":5,"predicted_n":64,"predicted_per_second":25,"predicted_ms":2560,"cache_n":0}}\n\n',
            "data: [DONE]\n\n",
          ]),
        };
      },
    },
  );

  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.equal(out.timings.predicted_n, 64);
  assert.equal(out.timings.cache_n, 0);
  assert.ok(out.ttfr_ms > 0);
  assert.ok(out.e2e_ttft_ms > 0);
  assert.ok(out.latency_total_request_ms > 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(resets, [["http://127.0.0.1:18080", 0]]);

  const bodies = calls.map((call) => JSON.parse(call.init.body));
  assert.equal(bodies[0].max_tokens, 8);
  assert.equal(bodies[0].stream, false);
  assert.equal(bodies[0].cache_prompt, true);
  assert.equal(bodies[1].max_tokens, 64);
  assert.equal(bodies[1].stream, true);
  assert.equal(bodies[1].cache_prompt, false);
  assert.equal(bodies[1].timings_per_token, true);
  assert.equal(bodies[1].return_progress, true);
  assert.equal(bodies[1].ignore_eos, true);
  assert.equal(bodies[1].seed, 42);
  assert.equal(bodies[1].id_slot, 0);
  assert.ok(bodies.every((body) => body.enable_thinking === false));
  assert.equal(out.total_request_ms, out.latency_total_request_ms);
});

test("runFromPayload keeps a failed warmup non-fatal", async () => {
  const out = await runFromPayload(
    { baseUrl: "http://127.0.0.1:18080", prompt: "hi", maxTokens: 8, warmup: true },
    {
      nowMs: () => 0,
      fetchImpl: async () => { throw new Error("warmup failed"); },
      streamFetchImpl: async () => ({
        ok: true,
        status: 200,
        body: streamParts([
          'data: {"choices":[{"delta":{"content":"ok"}}],"timings":{"predicted_n":8,"predicted_ms":400,"predicted_per_second":20}}\n\n',
          "data: [DONE]\n\n",
        ]),
      }),
    },
  );

  assert.equal(out.ok, true);
  assert.match(out.warmup_error ?? "", /warmup failed/);
  assert.equal(out.timings.predicted_per_second, 20);
});

test("diagnostic workloads keep the optional warmup on the short base prompt", async () => {
  const requests = [];
  const workloadFetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/apply-template")) {
      return { ok: true, status: 200, json: async () => ({ prompt: body.messages[0].content }) };
    }
    const count = String(body.content).trim().split(/\s+/).filter(Boolean).length;
    return { ok: true, status: 200, json: async () => ({ tokens: Array.from({ length: count }, (_, i) => i) }) };
  };
  const out = await runFromPayload({
    baseUrl: "http://127.0.0.1:18080",
    prompt: "short warmup",
    maxTokens: 8,
    warmup: true,
    workloadKind: "prefill",
    prefillTargetTokens: 128,
  }, {
    workloadFetchImpl,
    eraseSlot: async () => null,
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ timings: { prompt_n: 2, predicted_n: 1, predicted_ms: 10 } }),
      };
    },
    streamFetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        body: streamParts([
          'data: {"choices":[{"delta":{"content":"ok"}}],"timings":{"prompt_n":128,"predicted_n":8,"predicted_ms":400,"predicted_per_second":20,"cache_n":0}}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(requests[0].messages[0].content, "short warmup");
  assert.notEqual(requests[1].messages[0].content, "short warmup");
});

test("runFromPayload rejects a measured run when KV reset fails after warmup", async () => {
  let streamed = false;
  const out = await runFromPayload(
    { baseUrl: "http://127.0.0.1:18080", prompt: "hi", maxTokens: 8, warmup: true },
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ timings: { predicted_n: 8, predicted_ms: 400 } }),
      }),
      eraseSlot: async () => "HTTP 501",
      streamFetchImpl: async () => {
        streamed = true;
        throw new Error("should not run");
      },
    },
  );
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /cache reset failed.*501/);
  assert.equal(streamed, false);
});

test("runFromPayload treats measured streaming failure as benchmark failure", async () => {
  const out = await runFromPayload(
    { baseUrl: "http://127.0.0.1:18080", prompt: "hi", maxTokens: 8 },
    {
      nowMs: () => 0,
      streamFetchImpl: async () => { throw new Error("connection refused"); },
    },
  );

  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /connection refused/);
  assert.equal(out.timings, null);
});

test("runFromPayload fills KV then measures a cached-prefix stream", async () => {
  const requests = [];
  const workloadFetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/apply-template")) {
      return { ok: true, status: 200, json: async () => ({ prompt: body.messages[0].content }) };
    }
    const count = String(body.content).trim().split(/\s+/).filter(Boolean).length;
    return { ok: true, status: 200, json: async () => ({ tokens: Array.from({ length: count }, (_, i) => i) }) };
  };
  const out = await runFromPayload({
    baseUrl: "http://127.0.0.1:18080",
    prompt: "baseline",
    maxTokens: 8,
    workloadKind: "kv-fill",
    kvFillTargetTokens: 128,
  }, {
    workloadFetchImpl,
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ timings: { prompt_n: 128, predicted_n: 1, predicted_ms: 10 } }),
      };
    },
    streamFetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        body: streamParts([
          'data: {"choices":[{"delta":{"content":"ok"}}],"timings":{"prompt_n":8,"predicted_n":8,"predicted_ms":400,"predicted_per_second":20,"cache_n":126}}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].stream, false);
  assert.equal(requests[0].cache_prompt, true);
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].cache_prompt, true);
  assert.ok(requests[1].messages[0].content.startsWith(requests[0].messages[0].content));
  assert.equal(out.kv_fill_cached_tokens, 126);
  assert.ok(out.kv_fill_ms >= 0);
});

test("CLI entrypoint reads payload from --json-file as UTF-8 JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "calibr-runner-json-"));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify({
    baseUrl: "http://127.0.0.1:1",
    prompt: "ciao",
    maxTokens: 1,
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
