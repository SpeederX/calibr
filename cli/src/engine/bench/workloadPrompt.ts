export type WorkloadKind = "baseline" | "prefill" | "kv-fill";

interface JsonResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type WorkloadFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<JsonResponseLike>;

export interface PreparedWorkloadPrompt {
  kind: WorkloadKind;
  measuredPrompt: string;
  fillPrompt: string | null;
  targetTokens: number;
  actualTokens: number;
  targetErrorTokens: number;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

async function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: WorkloadFetch,
): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = response.text ? await response.text().catch(() => "") : "";
    throw new Error(`${path} HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

export async function countChatPromptTokens(
  baseUrl: string,
  content: string,
  fetchImpl: WorkloadFetch = fetch as unknown as WorkloadFetch,
): Promise<number> {
  const templated = asRecord(await postJson(baseUrl, "/apply-template", {
    messages: [{ role: "user", content }],
  }, fetchImpl));
  const prompt = typeof templated?.prompt === "string" ? templated.prompt : null;
  if (prompt === null) throw new Error("/apply-template response has no prompt");

  const tokenized = asRecord(await postJson(baseUrl, "/tokenize", {
    content: prompt,
    add_special: true,
    parse_special: true,
  }, fetchImpl));
  if (!Array.isArray(tokenized?.tokens)) throw new Error("/tokenize response has no tokens array");
  return tokenized.tokens.length;
}

const SYNTHETIC_HEADER =
  "calibr deterministic workload. Read the records below and retain their order for the final instruction.";
const SYNTHETIC_UNIT =
  "\nrecord 0123456789 alpha beta gamma delta epsilon: local inference prefill and cache calibration.";
const KV_PROBE_SUFFIX =
  "\n\ncalibr probe: summarize the final record in one short sentence.";

export async function buildTokenTargetPrompt(
  baseUrl: string,
  targetTokens: number,
  fetchImpl: WorkloadFetch = fetch as unknown as WorkloadFetch,
): Promise<{ content: string; actualTokens: number }> {
  const target = Math.max(1, Math.trunc(targetTokens));
  const contentFor = (repeatCount: number) => SYNTHETIC_HEADER + SYNTHETIC_UNIT.repeat(Math.max(0, repeatCount));
  const cache = new Map<number, number>();
  const countFor = async (repeatCount: number) => {
    const normalized = Math.max(0, Math.trunc(repeatCount));
    const cached = cache.get(normalized);
    if (cached !== undefined) return cached;
    const count = await countChatPromptTokens(baseUrl, contentFor(normalized), fetchImpl);
    cache.set(normalized, count);
    return count;
  };

  const zeroCount = await countFor(0);
  if (zeroCount >= target) return { content: contentFor(0), actualTokens: zeroCount };

  const oneCount = await countFor(1);
  const tokensPerUnit = Math.max(1, oneCount - zeroCount);
  let high = Math.max(1, Math.ceil((target - zeroCount) / tokensPerUnit));
  while (await countFor(high) < target) high *= 2;
  let low = 0;
  let bestRepeats = 0;
  let bestCount = zeroCount;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const count = await countFor(mid);
    if (Math.abs(count - target) < Math.abs(bestCount - target)) {
      bestRepeats = mid;
      bestCount = count;
    }
    if (count < target) low = mid + 1;
    else if (count > target) high = mid - 1;
    else break;
  }

  for (const candidate of [low, high]) {
    if (candidate < 0) continue;
    const count = await countFor(candidate);
    if (Math.abs(count - target) < Math.abs(bestCount - target)) {
      bestRepeats = candidate;
      bestCount = count;
    }
  }
  return { content: contentFor(bestRepeats), actualTokens: bestCount };
}

export async function prepareWorkloadPrompt(options: {
  baseUrl: string;
  basePrompt: string;
  kind?: WorkloadKind;
  prefillTargetTokens?: number;
  kvFillTargetTokens?: number;
  fetchImpl?: WorkloadFetch;
}): Promise<PreparedWorkloadPrompt> {
  const kind = options.kind ?? "baseline";
  if (kind === "baseline") {
    return {
      kind,
      measuredPrompt: options.basePrompt,
      fillPrompt: null,
      targetTokens: 0,
      actualTokens: 0,
      targetErrorTokens: 0,
    };
  }

  const targetTokens = kind === "prefill"
    ? Math.trunc(options.prefillTargetTokens ?? 0)
    : Math.trunc(options.kvFillTargetTokens ?? 0);
  if (targetTokens <= 0) throw new Error(`${kind} workload requires a positive token target`);

  try {
    const built = await buildTokenTargetPrompt(options.baseUrl, targetTokens, options.fetchImpl);
    return {
      kind,
      measuredPrompt: kind === "kv-fill" ? `${built.content}${KV_PROBE_SUFFIX}` : built.content,
      fillPrompt: kind === "kv-fill" ? built.content : null,
      targetTokens,
      actualTokens: built.actualTokens,
      targetErrorTokens: built.actualTokens - targetTokens,
    };
  } catch (error) {
    throw new Error(`could not prepare ${kind} workload: ${errorMessage(error)}`);
  }
}
