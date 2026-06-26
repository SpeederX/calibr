import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { RESULTS_MENU_ITEMS, reduceResultsMenu } from "./resultsMenu.js";

interface Props {
  onResults: () => void;
  onLogs: () => void;
  onExit: () => void;
}

export function ResultsMenuView({ onResults, onLogs, onExit }: Props) {
  const [cursor, setCursor] = useState(0);
  useInput((input, key) => {
    const action = reduceResultsMenu(cursor, {
      input,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      return: key.return,
      escape: key.escape,
    });
    switch (action.type) {
      case "move":
        setCursor(action.cursor);
        break;
      case "select":
        (action.target === "results" ? onResults : onLogs)();
        break;
      case "exit":
        onExit();
        break;
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">results</Text>
      <Box marginTop={1} flexDirection="column">
        {RESULTS_MENU_ITEMS.map((item, index) => {
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
