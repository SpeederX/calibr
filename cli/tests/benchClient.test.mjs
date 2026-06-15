import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeChatCompletionStream,
  buildChatCompletionRequest,
  metricsFromLlamaTimings,
  parseSseDataLines,
  runNonStreamingChatCompletion,
} from "../dist/benchClient.js";

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
