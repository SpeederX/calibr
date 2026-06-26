import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { CALIBR_LOCAL_CFG, loadConfig, traceAction, updateLocalConfigField } from "../engine.js";

interface Props {
  onExit: () => void;
}

const DEFAULT_VRAM_WARNING_PCT = 10;
const STEP = 5;

function readInitialWarningPct(): number {
  const cfg = loadConfig();
  const raw = cfg.preferences?.vram_usage_warning_pct;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_VRAM_WARNING_PCT;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value / STEP) * STEP));
}

export function PreferencesView({ onExit }: Props) {
  const initial = useMemo(readInitialWarningPct, []);
  const [warningPct, setWarningPct] = useState<number>(clampPct(initial));
  const [saved, setSaved] = useState(false);
  const cfg = useMemo(loadConfig, []);
  const moeOffsets = Array.isArray(cfg.planning?.moe_planning?.benchmark_offsets)
    ? cfg.planning.moe_planning.benchmark_offsets.map((value: number) => value >= 0 ? `+${value}` : value).join(", ")
    : "adaptive defaults";
  const moeRatios = Array.isArray(cfg.planning?.moe_planning?.benchmark_ratios)
    ? cfg.planning.moe_planning.benchmark_ratios.map((value: number) => `${Math.round(value * 100)}%`).join(", ")
    : "50%, 75%";
  const offloadOffsets = Array.isArray(cfg.planning?.offload_planning?.benchmark_offsets)
    ? cfg.planning.offload_planning.benchmark_offsets.map((value: number) => value >= 0 ? `+${value}` : value).join(", ")
    : "adaptive defaults";

  const save = (nextPct: number) => {
    const cfg = loadConfig();
    const preferences = {
      ...(cfg.preferences && typeof cfg.preferences === "object" ? cfg.preferences : {}),
      vram_usage_warning_pct: nextPct,
    };
    updateLocalConfigField("preferences", preferences);
    traceAction({
      flow: "preferences",
      action: "update vram usage warning",
      status: "completed",
      message: `preferences > vram usage warning set to ${nextPct}%`,
      details: { vramUsageWarningPct: nextPct },
    });
    setWarningPct(nextPct);
    setSaved(true);
  };

  useInput((input, key) => {
    if (input === "q" || key.escape) { onExit(); return; }
    if (key.leftArrow || input === "-" || input === "h") {
      save(clampPct(warningPct - STEP));
      return;
    }
    if (key.rightArrow || input === "+" || input === "=" || input === "l") {
      save(clampPct(warningPct + STEP));
      return;
    }
    if (input === "r") {
      save(DEFAULT_VRAM_WARNING_PCT);
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">preferences</Text>
      <Text dimColor>Saved user defaults. Guided Run can override advanced values for one session.</Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>saved defaults</Text>
        <Text>
          vram usage warning: <Text color="cyan">{warningPct}%</Text> <Text dimColor>(editable)</Text>
        </Text>
        <Text dimColor>
          Warn when baseline VRAM already used by OS/apps is above this share of total VRAM.
        </Text>
        <Text dimColor>
          Baseline % = VRAM used before the run / total VRAM x 100.
        </Text>
        <Text dimColor>
          Example: 1500 / 8192 = 18.3%; a 5%, 10%, or 15% threshold would warn.
        </Text>
        <Text dimColor>
          Baseline is measured before the benchmark and each config. It is system-level,
          not reliable per-process attribution on Windows WDDM.
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>planned advanced defaults</Text>
        <Text>
          gpu offload planning: <Text color="gray">adaptive around N_fit ({offloadOffsets})</Text>
        </Text>
        <Text dimColor>
          Short load-only probes find the local VRAM cliff before benchmark configs are expanded.
        </Text>
        <Text>
          cpu moe planning: <Text color="gray">load anchor ({moeOffsets}) + performance range ({moeRatios}, CPU-heavy tail)</Text>
        </Text>
        <Text dimColor>
          Load probes place the first anchor; measured throughput, power, and shared memory determine the useful config.
        </Text>
        <Text>
          polling interval: <Text color="gray">150 ms</Text> <Text dimColor>(planned)</Text>
        </Text>
        <Text dimColor>
          Controls live metric sampling cadence during benchmark runs.
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>left/right or -/+ changes by {STEP}% · r resets to {DEFAULT_VRAM_WARNING_PCT}% · q/esc back</Text>
        <Text dimColor>config: {CALIBR_LOCAL_CFG}</Text>
        {saved && <Text color="green">saved</Text>}
      </Box>
    </Box>
  );
}
