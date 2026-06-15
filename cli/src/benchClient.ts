export interface ChatCompletionRequestOptions {
  prompt: string;
  maxTokens: number;
  stream?: boolean;
  cachePrompt?: boolean;
  reasoningMode?: "off" | "default";
}

export interface ChatCompletionRequest {
  messages: Array<{ role: "user"; content: string }>;
  max_tokens: number;
  temperature: number;
  stream: boolean;
  cache_prompt: boolean;
  enable_thinking?: boolean;
}

export interface LlamaTimings {
  prompt_n?: number | null;
  prompt_per_second?: number | null;
  prompt_ms?: number | null;
  predicted_n?: number | null;
  predicted_per_second?: number | null;
  predicted_ms?: number | null;
}

export interface BenchTimingMetrics {
  prompt_n: number | null;
  prompt_tps: number | null;
  prompt_ms: number | null;
  eval_n: number | null;
  eval_tps: number | null;
}

export interface TimedStreamChunk {
  atMs: number;
  text: string;
}

export interface StreamLatencyMetrics {
  ttfr_ms: number | null;
  e2e_ttft_ms: number | null;
  response_chunk_count: number;
  content_chunk_count: number;
  timings: LlamaTimings | null;
}

type ParsedSseData =
  | { kind: "done" }
  | { kind: "json"; value: unknown }
  | { kind: "text"; value: string };

export function buildChatCompletionRequest(opts: ChatCompletionRequestOptions): ChatCompletionRequest {
  const request: ChatCompletionRequest = {
    messages: [{ role: "user", content: opts.prompt }],
    max_tokens: opts.maxTokens,
    temperature: 0.0,
    stream: opts.stream ?? false,
    cache_prompt: opts.cachePrompt ?? false,
  };
  if (opts.reasoningMode === "off") request.enable_thinking = false;
  return request;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function metricsFromLlamaTimings(timings: LlamaTimings | null | undefined): BenchTimingMetrics {
  const promptN = finiteNumber(timings?.prompt_n);
  const promptPerSecond = finiteNumber(timings?.prompt_per_second);
  const promptMs = finiteNumber(timings?.prompt_ms);
  const predictedN = finiteNumber(timings?.predicted_n);
  const predictedPerSecond = finiteNumber(timings?.predicted_per_second);
  const predictedMs = finiteNumber(timings?.predicted_ms);

  return {
    prompt_n: promptN,
    prompt_tps: promptPerSecond === null ? null : round(promptPerSecond, 2),
    prompt_ms: promptMs === null ? null : round(promptMs, 2),
    eval_n: predictedN,
    // llama.cpp can report sentinel-level throughput when a response emits
    // too few tokens to time. Mirror the PowerShell guard before reporting it.
    eval_tps: predictedN !== null && predictedN >= 2 && predictedMs !== null && predictedMs > 0 && predictedPerSecond !== null
      ? round(predictedPerSecond, 2)
      : null,
  };
}

export function parseSseDataLines(text: string): ParsedSseData[] {
  const events: ParsedSseData[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      events.push({ kind: "done" });
      continue;
    }
    try {
      events.push({ kind: "json", value: JSON.parse(data) });
    } catch {
      events.push({ kind: "text", value: data });
    }
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractContentDelta(value: unknown): string {
  if (!isRecord(value)) return "";
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  let out = "";
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = choice.delta;
    const message = choice.message;
    const directText = choice.text;
    if (isRecord(delta) && typeof delta.content === "string") out += delta.content;
    else if (isRecord(message) && typeof message.content === "string") out += message.content;
    else if (typeof directText === "string") out += directText;
  }
  return out;
}

function extractTimings(value: unknown): LlamaTimings | null {
  if (!isRecord(value)) return null;
  return isRecord(value.timings) ? value.timings as LlamaTimings : null;
}

export function analyzeChatCompletionStream(chunks: TimedStreamChunk[], startMs = 0): StreamLatencyMetrics {
  let firstResponseAt: number | null = null;
  let firstContentAt: number | null = null;
  let responseChunkCount = 0;
  let contentChunkCount = 0;
  let timings: LlamaTimings | null = null;

  for (const chunk of chunks) {
    const events = parseSseDataLines(chunk.text);
    for (const event of events) {
      if (event.kind === "done") continue;
      responseChunkCount++;
      if (firstResponseAt === null) firstResponseAt = chunk.atMs;

      if (event.kind === "json") {
        const content = extractContentDelta(event.value);
        if (content.length > 0) {
          contentChunkCount++;
          if (firstContentAt === null) firstContentAt = chunk.atMs;
        }
        timings = extractTimings(event.value) ?? timings;
      }
    }
  }

  return {
    ttfr_ms: firstResponseAt === null ? null : round(firstResponseAt - startMs, 2),
    e2e_ttft_ms: firstContentAt === null ? null : round(firstContentAt - startMs, 2),
    response_chunk_count: responseChunkCount,
    content_chunk_count: contentChunkCount,
    timings,
  };
}
