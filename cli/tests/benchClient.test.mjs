import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeChatCompletionStream,
  buildChatCompletionRequest,
  metricsFromLlamaTimings,
  parseSseDataLines,
  runNonStreamingChatCompletion,
  runStreamingChatCompletion,
} from "../dist/benchClient.js";

async function* streamParts(parts) {
  for (const part of parts) yield part;
}

test("buildChatCompletionRequest mirrors the llama.cpp chat endpoint shape", () => {
  assert.deepEqual(buildChatCompletionRequest({
    prompt: "hello",
    maxTokens: 32,
    stream: true,
    cachePrompt: false,
    reasoningMode: "off",
  }), {
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32,
    temperature: 0,
    stream: true,
    cache_prompt: false,
    enable_thinking: false,
  });
});

test("metricsFromLlamaTimings rounds prompt/eval metrics and guards sentinel eval speeds", () => {
  assert.deepEqual(metricsFromLlamaTimings({
    prompt_n: 128,
    prompt_per_second: 1234.567,
    prompt_ms: 98.765,
    predicted_n: 64,
    predicted_per_second: 42.4242,
    predicted_ms: 1508,
  }), {
    prompt_n: 128,
    prompt_tps: 1234.57,
    prompt_ms: 98.77,
    eval_n: 64,
    eval_tps: 42.42,
  });

  assert.equal(metricsFromLlamaTimings({
    predicted_n: 1,
    predicted_per_second: 1000000,
    predicted_ms: 0,
  }).eval_tps, null);
});

test("parseSseDataLines extracts JSON data events and DONE markers", () => {
  const events = parseSseDataLines([
    "event: ignored",
    "data: {\"a\":1}",
    "",
    "data: [DONE]",
  ].join("\n"));

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { kind: "json", value: { a: 1 } });
  assert.deepEqual(events[1], { kind: "done" });
});

test("analyzeChatCompletionStream measures first response and first content separately", () => {
  const chunks = [
    { atMs: 110, text: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' },
    { atMs: 145, text: 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' },
    {
      atMs: 210,
      text: 'data: {"choices":[{"delta":{"content":" world"}}],"timings":{"prompt_ms":33,"predicted_n":12,"predicted_ms":500,"predicted_per_second":24}}\n\n',
    },
    { atMs: 215, text: "data: [DONE]\n\n" },
  ];

  const metrics = analyzeChatCompletionStream(chunks, 100);
  assert.equal(metrics.ttfr_ms, 10);
  assert.equal(metrics.e2e_ttft_ms, 45);
  assert.equal(metrics.response_chunk_count, 3);
  assert.equal(metrics.content_chunk_count, 2);
  assert.deepEqual(metrics.timings, {
    prompt_ms: 33,
    predicted_n: 12,
    predicted_ms: 500,
    predicted_per_second: 24,
  });
});

test("analyzeChatCompletionStream treats reasoning_content as generated output", () => {
  const chunks = [
    { atMs: 110, text: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' },
    { atMs: 160, text: 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n' },
    { atMs: 180, text: 'data: [DONE]\n\n' },
  ];

  const metrics = analyzeChatCompletionStream(chunks, 100);
  assert.equal(metrics.ttfr_ms, 10);
  assert.equal(metrics.e2e_ttft_ms, 60);
  assert.equal(metrics.content_chunk_count, 1);
});

test("runNonStreamingChatCompletion posts a non-streaming request and extracts llama timings", async () => {
  const calls = [];
  const nowValues = [100, 175];
  const result = await runNonStreamingChatCompletion({
    baseUrl: "http://127.0.0.1:18080/",
    request: buildChatCompletionRequest({
      prompt: "hello",
      maxTokens: 16,
      stream: true,
      cachePrompt: true,
    }),
    nowMs: () => nowValues.shift() ?? 175,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          timings: {
            prompt_n: 4,
            prompt_per_second: 10.111,
            prompt_ms: 20,
            predicted_n: 3,
            predicted_per_second: 30,
            predicted_ms: 100,
          },
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.total_request_ms, 75);
  assert.equal(result.metrics.prompt_tps, 10.11);
  assert.equal(result.metrics.eval_tps, 30);
  assert.equal(calls[0].url, "http://127.0.0.1:18080/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(JSON.parse(calls[0].init.body).stream, false);
});

test("runNonStreamingChatCompletion reports HTTP errors without parsing metrics", async () => {
  const result = await runNonStreamingChatCompletion({
    baseUrl: "http://127.0.0.1:18080",
    request: buildChatCompletionRequest({ prompt: "hello", maxTokens: 16 }),
    nowMs: () => 100,
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "boom",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, "boom");
  assert.equal(result.metrics.eval_tps, null);
});

test("runNonStreamingChatCompletion reports transport errors", async () => {
  const result = await runNonStreamingChatCompletion({
    baseUrl: "http://127.0.0.1:18080",
    request: buildChatCompletionRequest({ prompt: "hello", maxTokens: 16 }),
    nowMs: () => 100,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.error ?? "", /network down/);
  assert.equal(result.metrics.prompt_tps, null);
});

test("runStreamingChatCompletion times first response/content and assembles streamed text", async () => {
  const calls = [];
  const contentEvents = [];
  // now() order: start, one per emitted chunk (4: role, content, content+timings, DONE), total.
  const nowValues = [1000, 1110, 1145, 1210, 1212, 1215];
  const result = await runStreamingChatCompletion({
    baseUrl: "http://127.0.0.1:18080/",
    request: buildChatCompletionRequest({ prompt: "hello", maxTokens: 16, stream: false }),
    nowMs: () => nowValues.shift() ?? 1215,
    onContentEvent: event => contentEvents.push(event),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        body: streamParts([
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" there"}}],"timings":{"prompt_n":5,"prompt_per_second":50,"prompt_ms":40,"predicted_n":8,"predicted_per_second":24.5,"predicted_ms":320}}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.total_request_ms, 215);
  assert.equal(result.latency.ttfr_ms, 110);
  assert.equal(result.latency.e2e_ttft_ms, 145);
  assert.equal(result.latency.response_chunk_count, 3);
  assert.equal(result.latency.content_chunk_count, 2);
  assert.equal(result.content, "hi there");
  assert.equal(result.metrics.prompt_tps, 50);
  assert.equal(result.metrics.eval_tps, 24.5);
  assert.equal(calls[0].url, "http://127.0.0.1:18080/v1/chat/completions");
  assert.equal(JSON.parse(calls[0].init.body).stream, true);
  assert.deepEqual(contentEvents, [
    { at_ms: 145, index: 1 },
    { at_ms: 210, index: 2 },
  ]);
});

test("runStreamingChatCompletion buffers SSE events split across stream parts", async () => {
  const nowValues = [0, 50, 90, 120];
  const result = await runStreamingChatCompletion({
    baseUrl: "http://127.0.0.1:18080",
    request: buildChatCompletionRequest({ prompt: "hi", maxTokens: 8 }),
    nowMs: () => nowValues.shift() ?? 120,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: streamParts([
        'data: {"choices":[{"delta":{"content":"par',
        'tial"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, "partial");
  assert.equal(result.latency.content_chunk_count, 1);
});

test("runStreamingChatCompletion reports HTTP errors", async () => {
  const result = await runStreamingChatCompletion({
    baseUrl: "http://127.0.0.1:18080",
    request: buildChatCompletionRequest({ prompt: "hello", maxTokens: 16 }),
    nowMs: () => 100,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: null,
      text: async () => "unavailable",
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.error, "unavailable");
  assert.equal(result.latency.ttfr_ms, null);
  assert.equal(result.content, "");
});

test("runStreamingChatCompletion reports transport errors", async () => {
  const result = await runStreamingChatCompletion({
    baseUrl: "http://127.0.0.1:18080",
    request: buildChatCompletionRequest({ prompt: "hello", maxTokens: 16 }),
    nowMs: () => 100,
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.error ?? "", /connection refused/);
});
