import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { CALIBR_LOCAL_CFG, loadConfig, traceAction, updateLocalConfigField } from "./engine.js";

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
      <Box marginTop={1} flexDirection="column">
        <Text>
          vram usage warning: <Text color="cyan">{warningPct}%</Text>
        </Text>
        <Text dimColor>
          Warn when baseline VRAM already used by OS/apps is above this share of total VRAM.
        </Text>
        <Text dimColor>
          Guided Run can override this for the current session without saving it.
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
