export type MemoryState =
  | "dedicated" | "saturated" | "shared_allocated" | "spill_risk"
  | "spill_correlated_degradation" | "moe_shared_ambiguous";

export interface MemoryPolicyFields {
  memory_state: MemoryState;
  memory_state_reason: string;
  estimated_cliff_tokens: number | null;
  cliff_degradation_pct: number | null;
}

const n = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const ctx = (row: Record<string, unknown>): number | null => {
  const match = String(row.extra_args ?? "").match(/--ctx-size\s+(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
};
const key = (row: Record<string, unknown>) => `${String(row.model ?? "")}|${String(row.variant ?? "")}`;

export function deriveMemoryPolicies(
  rows: Array<Record<string, unknown>>,
  vramTotalMib: number,
  sharedThresholdMib = 500,
  degradationThreshold = 0.20,
): Map<string, MemoryPolicyFields> {
  const out = new Map<string, MemoryPolicyFields>();
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);

  for (const group of groups.values()) {
    const isMoe = group.some((row) => row.sweep === "moe-cpu");
    const cleanLoads = group
      .filter((row) => row.ok === true && (row.workload_kind ?? "baseline") === "baseline"
        && row.sweep === "context" && (n(row.shared_peak_mib) ?? 0) <= sharedThresholdMib)
      .map((row) => ({ tokens: ctx(row), memory: n(row.vram_peak_mib) }))
      .filter((p): p is { tokens: number; memory: number } => p.tokens !== null && p.memory !== null)
      .sort((a, b) => a.tokens - b.tokens);

    let estimatedCliff: number | null = null;
    if (cleanLoads.length >= 2 && vramTotalMib > 0) {
      const a = cleanLoads.at(-2)!;
      const b = cleanLoads.at(-1)!;
      const slope = (b.memory - a.memory) / (b.tokens - a.tokens);
      if (slope > 0) estimatedCliff = Math.round(b.tokens + Math.max(0, vramTotalMib - b.memory) / slope);
    }

    const fills = group
      .filter((row) => row.ok === true && row.workload_kind === "kv-fill")
      .map((row) => ({
        tokens: n(row.kv_fill_cached_tokens) ?? n(row.kv_fill_target_tokens),
        eval: n(row.eval_tps),
        shared: n(row.shared_peak_mib) ?? 0,
      }))
      .filter((p): p is { tokens: number; eval: number; shared: number } => p.tokens !== null && p.eval !== null)
      .sort((a, b) => a.tokens - b.tokens);

    let degradation: number | null = null;
    let correlated = false;
    if (estimatedCliff !== null) {
      const before = fills.filter((point) => point.tokens < estimatedCliff);
      const after = fills.find((point) => point.tokens >= estimatedCliff);
      if (before.length >= 2 && after) {
        const a = before.at(-2)!;
        const b = before.at(-1)!;
        const cleanSlope = (b.eval - a.eval) / Math.max(1, b.tokens - a.tokens);
        const expected = Math.max(0.001, b.eval + cleanSlope * (after.tokens - b.tokens));
        degradation = Math.max(0, (expected - after.eval) / expected);
        correlated = after.shared > sharedThresholdMib && degradation > degradationThreshold;
      }
    }

    for (const row of group) {
      const shared = n(row.shared_peak_mib) ?? 0;
      const saturation = vramTotalMib > 0 ? (n(row.vram_peak_mib) ?? 0) / vramTotalMib : 0;
      let state: MemoryState = saturation >= 0.92 ? "saturated" : "dedicated";
      let reason = state === "saturated"
        ? "Dedicated VRAM is near capacity; no significant shared allocation was observed."
        : "The measured allocation remained in dedicated VRAM.";
      if (shared > 0 && shared <= sharedThresholdMib) {
        state = "shared_allocated";
        reason = "Shared allocation increased, but stayed below the configured significance threshold.";
      } else if (shared > sharedThresholdMib && isMoe) {
        state = "moe_shared_ambiguous";
        reason = "MoE CPU expert mapping and GPU spill cannot yet be separated reliably.";
      } else if (shared > sharedThresholdMib && correlated) {
        state = "spill_correlated_degradation";
        reason = "KV-fill crossed the estimated memory boundary and throughput degraded beyond the clean trend.";
      } else if (shared > sharedThresholdMib) {
        state = "spill_risk";
        reason = fills.length
          ? "Shared allocation increased, but KV-fill did not confirm correlated degradation."
          : "Might spill with high context usage; KV-fill validation was not collected.";
      }
      out.set(String(row.id ?? ""), {
        memory_state: state,
        memory_state_reason: reason,
        estimated_cliff_tokens: estimatedCliff,
        cliff_degradation_pct: degradation === null ? null : Math.round(degradation * 1000) / 10,
      });
    }
  }
  return out;
}
