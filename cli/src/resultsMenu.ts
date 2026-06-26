// Pure navigation/selection logic for the results submenu, kept free of React
// and Ink so it can be unit-tested deterministically — no rendering, no input
// timing. ResultsMenuView wires these decisions to component state/callbacks.

export interface ResultsMenuItem {
  label: string;
  description: string;
}

export const RESULTS_MENU_ITEMS: ResultsMenuItem[] = [
  {
    label: "benchmark results",
    description: "model leaderboard and per-config drilldown",
  },
  {
    label: "benchmark run logs",
    description: "commands and llama-server output for previous runs",
  },
];

// Minimal view of an Ink key event: only the fields this menu reacts to.
export interface ResultsMenuKey {
  input: string;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  return?: boolean;
  escape?: boolean;
}

export type ResultsMenuAction =
  | { type: "move"; cursor: number }
  | { type: "select"; target: "results" | "logs" }
  | { type: "exit" }
  | { type: "none" };

// Decide what a keypress does given the current cursor. Index 0 opens results,
// any other index opens logs; navigation clamps to the item range.
export function reduceResultsMenu(
  cursor: number,
  key: ResultsMenuKey,
  itemCount: number = RESULTS_MENU_ITEMS.length,
): ResultsMenuAction {
  if (key.upArrow || key.input === "k") {
    return { type: "move", cursor: Math.max(0, cursor - 1) };
  }
  if (key.downArrow || key.input === "j") {
    return { type: "move", cursor: Math.min(itemCount - 1, cursor + 1) };
  }
  if (key.return || key.input === " ") {
    return { type: "select", target: cursor === 0 ? "results" : "logs" };
  }
  if (key.escape || key.input === "q" || key.leftArrow || key.input === "h") {
    return { type: "exit" };
  }
  return { type: "none" };
}
