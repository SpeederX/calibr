export interface OffloadProbeObservation {
  requested_layers: number;
  offloaded_layers: number | null;
  vram_ready_mib: number | null;
  fit_under_safe_cap: boolean;
  ready: boolean;
}

export interface OffloadCliffEstimate {
  predicted_fit_layers: number;
  verified_fit_layers: number | null;
  first_spill_layers: number | null;
  slope_mib_per_layer: number | null;
  intercept_mib: number | null;
  confidence: "none" | "single-probe" | "linear" | "bracketed" | "verified-full";
  next_probe_layers: number | null;
  complete: boolean;
  reason: string;
}

function clampLayer(value: number, blockCount: number): number {
  return Math.max(0, Math.min(Math.max(0, Math.trunc(blockCount)), Math.trunc(value)));
}

function actualLayer(probe: OffloadProbeObservation, blockCount: number): number | null {
  const value = probe.offloaded_layers ?? probe.requested_layers;
  return Number.isFinite(value) && value >= 0 ? clampLayer(value, blockCount) : null;
}

function uniqueValidProbes(probes: OffloadProbeObservation[], blockCount: number): Array<OffloadProbeObservation & { layer: number; vram: number }> {
  const byLayer = new Map<number, OffloadProbeObservation & { layer: number; vram: number }>();
  for (const probe of probes) {
    const layer = actualLayer(probe, blockCount);
    const vram = probe.vram_ready_mib;
    if (!probe.ready || layer === null || typeof vram !== "number" || !Number.isFinite(vram) || vram < 0) continue;
    byLayer.set(layer, { ...probe, layer, vram });
  }
  return [...byLayer.values()].sort((a, b) => a.layer - b.layer);
}

function linearFit(points: Array<{ layer: number; vram: number }>): { slope: number; intercept: number } | null {
  if (points.length < 2) return null;
  const meanX = points.reduce((sum, point) => sum + point.layer, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.vram, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.layer - meanX) ** 2, 0);
  if (denominator <= 0) return null;
  const slope = points.reduce((sum, point) => sum + (point.layer - meanX) * (point.vram - meanY), 0) / denominator;
  if (!Number.isFinite(slope) || slope <= 0) return null;
  return { slope, intercept: meanY - slope * meanX };
}

function firstUntested(candidates: number[], tested: Set<number>): number | null {
  for (const candidate of candidates) if (!tested.has(candidate)) return candidate;
  return null;
}

export function estimateOffloadCliff(options: {
  blockCount: number;
  safeCapMib: number;
  initialEstimate: number;
  probes: OffloadProbeObservation[];
  maxProbeCount?: number;
}): OffloadCliffEstimate {
  const blockCount = Math.max(0, Math.trunc(options.blockCount));
  const initial = clampLayer(options.initialEstimate, blockCount);
  const maxProbeCount = Math.max(1, Math.trunc(options.maxProbeCount ?? 4));
  const valid = uniqueValidProbes(options.probes, blockCount);
  const boundary = options.probes.map((probe) => ({ probe, layer: actualLayer(probe, blockCount) }))
    .filter((entry): entry is { probe: OffloadProbeObservation; layer: number } => entry.layer !== null);
  const tested = new Set(boundary.map((entry) => entry.layer));
  const fitLayers = boundary.filter(({ probe }) => probe.ready && probe.fit_under_safe_cap).map(({ layer }) => layer);
  const spillLayers = boundary.filter(({ probe }) => !probe.ready || !probe.fit_under_safe_cap).map(({ layer }) => layer);
  const verifiedFit = fitLayers.length > 0 ? Math.max(...fitLayers) : null;
  const firstSpill = spillLayers.length > 0 ? Math.min(...spillLayers) : null;
  const regression = linearFit(valid);
  const predicted = regression
    ? clampLayer(Math.floor((options.safeCapMib - regression.intercept) / regression.slope), blockCount)
    : verifiedFit ?? initial;
  const adjacentBracket = verifiedFit !== null && firstSpill !== null && firstSpill - verifiedFit <= 1;
  const verifiedFull = verifiedFit === blockCount;
  const complete = adjacentBracket || verifiedFull || options.probes.length >= maxProbeCount;

  let next: number | null = null;
  let reason = "probe initial structural estimate";
  if (!complete) {
    if (verifiedFit !== null && firstSpill !== null) {
      next = firstUntested([
        clampLayer(Math.floor((verifiedFit + firstSpill) / 2), blockCount),
        clampLayer(verifiedFit + 1, blockCount),
      ], tested);
      reason = "narrow verified fit/spill bracket";
    } else if (boundary.length === 0) {
      next = initial;
    } else if (valid.length === 0) {
      const failedLayer = firstSpill ?? initial;
      next = firstUntested([
        clampLayer(Math.floor(failedLayer / 2), blockCount),
        clampLayer(failedLayer - 1, blockCount),
        0,
      ], tested);
      reason = "probe failed before stable allocation; search downward";
    } else if (valid.length === 1) {
      const point = valid[0];
      if (point.fit_under_safe_cap) {
        next = firstUntested([
          clampLayer(Math.ceil((point.layer + blockCount) / 2), blockCount),
          clampLayer(point.layer + 1, blockCount),
          blockCount,
        ], tested);
        reason = "single fitting probe; search upward";
      } else {
        next = firstUntested([
          clampLayer(Math.floor(point.layer / 2), blockCount),
          clampLayer(point.layer - 1, blockCount),
          0,
        ], tested);
        reason = "single spilling probe; search downward";
      }
    } else {
      const candidates = [
        predicted,
        clampLayer(predicted + 1, blockCount),
        clampLayer(predicted - 1, blockCount),
        verifiedFit !== null ? blockCount : 0,
      ];
      next = firstUntested(candidates, tested);
      reason = regression ? "validate linear cliff prediction" : "expand probe range";
    }
  }
  const confidence = verifiedFull ? "verified-full"
    : adjacentBracket ? "bracketed"
      : regression ? "linear"
        : valid.length === 1 ? "single-probe" : "none";
  return {
    predicted_fit_layers: predicted,
    verified_fit_layers: verifiedFit,
    first_spill_layers: firstSpill,
    slope_mib_per_layer: regression?.slope ?? null,
    intercept_mib: regression?.intercept ?? null,
    confidence,
    next_probe_layers: next,
    complete,
    reason: complete && options.probes.length >= maxProbeCount && !adjacentBracket && !verifiedFull
      ? "probe budget exhausted" : reason,
  };
}

export function buildOffloadBenchmarkCandidates(
  fitLayers: number,
  blockCount: number,
  offsets: number[] = [-6, -3, -1, 0, 1, 3],
): number[] {
  const values = offsets.map((offset) => clampLayer(fitLayers + Math.trunc(offset), blockCount));
  return [...new Set(values)].sort((a, b) => a - b);
}