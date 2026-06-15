export type WinnerProfile = "speed" | "efficiency" | "safety" | "overall";

export interface WinnerPolicyResult {
  id?: string;
  model?: string;
  ok?: boolean;
  eval_tps?: number | null;
  gpu_power_peak_w?: number | null;
  shared_peak_mib?: number | null;
  vram_peak_mib?: number | null;
  ctx_size?: number | null;
  extra_args?: string | null;
  [key: string]: unknown;
}

export interface WinnerPolicyAnchors {
  evalMax: number;
  effMax: number;
}

export interface WinnerPolicyOptions {
  confirmMib?: number;
  anchors?: WinnerPolicyAnchors;
  tieBandPct?: number;
}

export type WinnerWithMeta<T extends WinnerPolicyResult> = T & {
  _score: number;
  _fallback?: boolean;
};

const DEFAULT_CONFIRM_MIB = 500;
const DEFAULT_TIE_BAND_PCT = 0.05;

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function ctxValue(result: WinnerPolicyResult): number {
  if (result.ctx_size !== null && result.ctx_size !== undefined) return finiteNumber(result.ctx_size);
  const match = String(result.extra_args ?? "").match(/--ctx-size\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

export function isSafe(result: WinnerPolicyResult, confirmMib = DEFAULT_CONFIRM_MIB): boolean {
  return finiteNumber(result.shared_peak_mib) <= confirmMib;
}

export function computeAnchors(results: WinnerPolicyResult[]): WinnerPolicyAnchors {
  const ok = results.filter((r) => r.ok);
  const evalMax = Math.max(1, ...ok.map((r) => finiteNumber(r.eval_tps)));
  const effs = ok
    .filter((r) => finiteNumber(r.gpu_power_peak_w) > 0)
    .map((r) => finiteNumber(r.eval_tps) / finiteNumber(r.gpu_power_peak_w));
  const effMax = effs.length > 0 ? Math.max(1, ...effs) : 1;
  return { evalMax, effMax };
}

export function winnerScore(
  result: WinnerPolicyResult,
  profile: WinnerProfile,
  options: WinnerPolicyOptions = {},
): number {
  const evalTps = finiteNumber(result.eval_tps);
  const power = finiteNumber(result.gpu_power_peak_w);
  const anchors = options.anchors ?? { evalMax: 1, effMax: 1 };

  switch (profile) {
    case "speed":
      return evalTps;
    case "efficiency":
      return power > 0 ? evalTps / power : -Infinity;
    case "safety":
      return evalTps;
    case "overall": {
      const speedPart = evalTps / Math.max(1, anchors.evalMax);
      const safetyPart = isSafe(result, options.confirmMib ?? DEFAULT_CONFIRM_MIB) ? 1 : 0;
      const efficiencyPart = power > 0
        ? (evalTps / power) / Math.max(1, anchors.effMax)
        : 0;
      return 0.5 * speedPart + 0.3 * safetyPart + 0.2 * efficiencyPart;
    }
  }
}

function lowerMemoryTieBreak(candidate: WinnerPolicyResult, current: WinnerPolicyResult): boolean {
  const candidateShared = finiteNumber(candidate.shared_peak_mib);
  const currentShared = finiteNumber(current.shared_peak_mib);
  if (candidateShared !== currentShared) return candidateShared < currentShared;

  const candidateVram = finiteNumber(candidate.vram_peak_mib, Number.MAX_SAFE_INTEGER);
  const currentVram = finiteNumber(current.vram_peak_mib, Number.MAX_SAFE_INTEGER);
  if (candidateVram !== currentVram) return candidateVram < currentVram;

  return finiteNumber(candidate.eval_tps, -1) > finiteNumber(current.eval_tps, -1);
}

export function isBetterWinner(
  candidate: WinnerPolicyResult,
  current: WinnerPolicyResult | null | undefined,
  profile: WinnerProfile,
  options: WinnerPolicyOptions = {},
): boolean {
  if (!current) return true;

  if (profile !== "safety") {
    return winnerScore(candidate, profile, options) > winnerScore(current, profile, options);
  }

  const confirmMib = options.confirmMib ?? DEFAULT_CONFIRM_MIB;
  const candidateSafe = isSafe(candidate, confirmMib);
  const currentSafe = isSafe(current, confirmMib);
  if (candidateSafe !== currentSafe) return candidateSafe;

  const candidateEval = finiteNumber(candidate.eval_tps, -1);
  const currentEval = finiteNumber(current.eval_tps, -1);
  const bestEval = Math.max(candidateEval, currentEval);
  const tieBandPct = options.tieBandPct ?? DEFAULT_TIE_BAND_PCT;
  if (bestEval > 0 && Math.abs(candidateEval - currentEval) / bestEval > tieBandPct) {
    return candidateEval > currentEval;
  }

  const candidateCtx = ctxValue(candidate);
  const currentCtx = ctxValue(current);
  if (candidateCtx !== currentCtx) return candidateCtx > currentCtx;

  return lowerMemoryTieBreak(candidate, current);
}

export function groupWinners<T extends WinnerPolicyResult>(
  results: T[],
  profile: WinnerProfile,
  options: WinnerPolicyOptions = {},
): Record<string, WinnerWithMeta<T>> {
  const byModel: Record<string, WinnerWithMeta<T>> = {};
  const fallbacks: Record<string, WinnerWithMeta<T>> = {};

  for (const result of results) {
    if (!result.ok) continue;
    const model = String(result.model ?? result.id ?? "");
    if (!model) continue;

    const score = winnerScore(result, profile, options);
    if (score > -Infinity && isBetterWinner(result, byModel[model], profile, options)) {
      byModel[model] = { ...result, _score: score };
    }

    const speedScore = winnerScore(result, "speed", options);
    if (isBetterWinner(result, fallbacks[model], "speed", options)) {
      fallbacks[model] = { ...result, _score: speedScore };
    }
  }

  for (const [model, fallback] of Object.entries(fallbacks)) {
    if (!byModel[model]) byModel[model] = { ...fallback, _fallback: true };
  }
  return byModel;
}

export function createReportWinnerPolicySource(): string {
  const functions = [
    finiteNumber,
    ctxValue,
    isSafe,
    computeAnchors,
    winnerScore,
    lowerMemoryTieBreak,
    isBetterWinner,
    groupWinners,
  ].map((fn) => fn.toString()).join("\n\n");

  return `// BEGIN GENERATED WINNER POLICY - source: cli/src/winnerPolicy.ts
const DEFAULT_CONFIRM_MIB = ${DEFAULT_CONFIRM_MIB};
const DEFAULT_TIE_BAND_PCT = ${DEFAULT_TIE_BAND_PCT};
const CONFIRM_MIB = (CFG.wddm_detection && CFG.wddm_detection.shared_delta_confirm_mib)
  ? +CFG.wddm_detection.shared_delta_confirm_mib : DEFAULT_CONFIRM_MIB;

${functions}

const SCORERS = {
  speed: {
    label: 'Speed',
    desc: 'Raw highest eval tokens/s. Ignores power, WDDM paging, and near-tie context preference.',
    score: d => winnerScore(d, 'speed', { confirmMib: CONFIRM_MIB, anchors: ANCHORS }),
  },
  efficiency: {
    label: 'Efficiency',
    desc: 'Tokens per watt. Best perf/W (requires GPU power data).',
    score: d => winnerScore(d, 'efficiency', { confirmMib: CONFIRM_MIB, anchors: ANCHORS }),
  },
  safety: {
    label: 'Safety-balanced',
    desc: 'Safe configs first; within 5% eval speed, prefer larger context, then lower shared/VRAM use.',
    score: d => winnerScore(d, 'safety', { confirmMib: CONFIRM_MIB, anchors: ANCHORS }),
  },
  overall: {
    label: 'Overall',
    desc: 'Weighted: 50% speed + 30% safety (no paging) + 20% efficiency. Normalized against the run\\'s best of each.',
    score: d => winnerScore(d, 'overall', { confirmMib: CONFIRM_MIB, anchors: ANCHORS }),
  },
};

function computeWinners(filter) {
  return groupWinners(VIEW, filter, { confirmMib: CONFIRM_MIB, anchors: ANCHORS });
}
// END GENERATED WINNER POLICY`;
}
