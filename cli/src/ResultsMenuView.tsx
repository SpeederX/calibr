import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  onResults: () => void;
  onLogs: () => void;
  onExit: () => void;
}

const ITEMS = [
  {
    label: "benchmark results",
    description: "model leaderboard and per-config drilldown",
  },
  {
    label: "benchmark run logs",
    description: "commands and llama-server output for previous runs",
  },
];

export function ResultsMenuView({ onResults, onLogs, onExit }: Props) {
  const [cursor, setCursor] = useState(0);
  useInput((input, key) => {
    if (key.upArrow || input === "k") setCursor((value) => Math.max(0, value - 1));
    else if (key.downArrow || input === "j") setCursor((value) => Math.min(ITEMS.length - 1, value + 1));
    else if (key.return || input === " ") (cursor === 0 ? onResults : onLogs)();
    else if (key.escape || input === "q" || key.leftArrow || input === "h") onExit();
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">results</Text>
      <Box marginTop={1} flexDirection="column">
        {ITEMS.map((item, index) => {
          const selected = index === cursor;
          return (
            <Box key={item.label}>
              <Text color={selected ? "cyan" : undefined} inverse={selected}>
                {selected ? "> " : "  "}{item.label.padEnd(24)}
              </Text>
              <Text dimColor>  {item.description}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>up/down to move · enter to open · q/esc back</Text>
      </Box>
    </Box>
  );
}
