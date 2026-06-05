import React, { useEffect, useState } from "react";
import { existsSync } from "node:fs";
import { Box, Text, useApp, useInput } from "ink";
import { ENGINE_COMMANDS, readStatus, type EngineCommand, type Status } from "./engine.js";
import { StatusView } from "./StatusView.js";
import { RunView } from "./RunView.js";
import { ResultsView } from "./ResultsView.js";
import { BenchOptionsView } from "./BenchOptionsView.js";
import { AllOptionsView } from "./AllOptionsView.js";
import { InitOptionsView } from "./InitOptionsView.js";
import { ResetOptionsView } from "./ResetOptionsView.js";
import { LlamaPathView } from "./LlamaPathView.js";
import { DoctorView } from "./DoctorView.js";

type Screen =
  | { kind: "menu" }
  | { kind: "advancedTools" }
  | { kind: "help" }
  | { kind: "doctor" }
  | { kind: "initOptions" }
  | { kind: "benchOptions" }
  | { kind: "allOptions" }
  | { kind: "resetOptions" }
  | { kind: "llamaPath" }
  | { kind: "run"; args: string[]; label: string }
  | { kind: "results" };

type Badge = {
  text: string;
  color: "green" | "red";
};

type MenuItem = {
  id: string;
  label: string;
  description: string;
  badge?: Badge;
  run: () => void;
};

function readinessBadge(ready: boolean): Badge {
  return ready ? { text: "✓", color: "green" } : { text: "*", color: "red" };
}

function initIsReady(status: Status): boolean {
  const hw = status.config.hardware ?? {};
  return Boolean(status.hasLocalConfig && (hw.gpu_name || hw.vram_total_mib || hw.vram_safety_budget_mib));
}

function llamaPathIsReady(status: Status): boolean {
  const path = status.config.llama_server_exe;
  return Boolean(path && existsSync(path));
}

function renderRows(items: MenuItem[], cursor: number) {
  return items.map((item, index) => {
    const selected = index === cursor;
    return (
      <Box key={item.id}>
        <Text color={selected ? "cyan" : undefined} inverse={selected}>
          {selected ? "> " : "  "}
          {item.label.padEnd(20)}
        </Text>
        {item.badge && (
          <Text color={item.badge.color} bold>
            {item.badge.text}
          </Text>
        )}
        <Text dimColor>  {item.description}</Text>
      </Box>
    );
  });
}

export function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "menu" });
  const [status, setStatus] = useState<Status>(() => readStatus());
  const [menuCursor, setMenuCursor] = useState(0);
  const [advancedCursor, setAdvancedCursor] = useState(0);
  const [helpCursor, setHelpCursor] = useState(0);

  // Refresh status whenever we return to a menu with readiness indicators.
  useEffect(() => {
    if (screen.kind === "menu" || screen.kind === "advancedTools") setStatus(readStatus());
  }, [screen.kind]);

  const openEngineCommand = (cmd: EngineCommand) => {
    if (cmd.id === "init") {
      setScreen({ kind: "initOptions" });
      return;
    }
    if (cmd.id === "bench") {
      setScreen({ kind: "benchOptions" });
      return;
    }
    if (cmd.id === "reset") {
      setScreen({ kind: "resetOptions" });
      return;
    }
    setScreen({ kind: "run", args: cmd.args, label: cmd.label });
  };

  const mainItems: MenuItem[] = [
    {
      id: "guided-run",
      label: "guided run",
      description: "download, discover, plan, bench, report",
      run: () => setScreen({ kind: "allOptions" }),
    },
    {
      id: "results",
      label: "results",
      description: "browse benchmark winners",
      run: () => setScreen({ kind: "results" }),
    },
    {
      id: "advanced-tools",
      label: "advanced tools",
      description: "status, init, discover, plan, bench, report, reset",
      run: () => setScreen({ kind: "advancedTools" }),
    },
    {
      id: "llama-path",
      label: "configure llama path",
      description: "choose a llama.cpp server binary",
      badge: readinessBadge(llamaPathIsReady(status)),
      run: () => setScreen({ kind: "llamaPath" }),
    },
    {
      id: "help",
      label: "help",
      description: "doctor: check system & dependencies",
      run: () => setScreen({ kind: "help" }),
    },
  ];

  const helpItems: MenuItem[] = [
    {
      id: "doctor",
      label: "doctor",
      description: "sanity-check CPU/GPU/OS + deps, see fixes, export a bundle",
      run: () => setScreen({ kind: "doctor" }),
    },
  ];

  const advancedItems: MenuItem[] = ENGINE_COMMANDS
    .filter((cmd) => cmd.id !== "all")
    .map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      description: cmd.description,
      badge: cmd.id === "init" ? readinessBadge(initIsReady(status)) : undefined,
      run: () => openEngineCommand(cmd),
    }));

  useInput((input, key) => {
    if (screen.kind === "menu") {
      if (input === "q" || key.escape) {
        exit();
        return;
      }
      if (key.upArrow) {
        setMenuCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setMenuCursor((c) => Math.min(mainItems.length - 1, c + 1));
        return;
      }
      if (key.return || input === " ") {
        mainItems[menuCursor]?.run();
        return;
      }
    }

    if (screen.kind === "advancedTools") {
      if (input === "q" || key.escape) {
        setScreen({ kind: "menu" });
        return;
      }
      if (key.upArrow) {
        setAdvancedCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setAdvancedCursor((c) => Math.min(advancedItems.length - 1, c + 1));
        return;
      }
      if (key.return || input === " ") {
        advancedItems[advancedCursor]?.run();
      }
    }

    if (screen.kind === "help") {
      if (input === "q" || key.escape) {
        setScreen({ kind: "menu" });
        return;
      }
      if (key.upArrow) {
        setHelpCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setHelpCursor((c) => Math.min(helpItems.length - 1, c + 1));
        return;
      }
      if (key.return || input === " ") {
        helpItems[helpCursor]?.run();
      }
    }
  });

  if (screen.kind === "run") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <RunView args={screen.args} label={screen.label} onExit={() => setScreen({ kind: "menu" })} />
      </Box>
    );
  }

  if (screen.kind === "results") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <ResultsView onExit={() => setScreen({ kind: "menu" })} />
      </Box>
    );
  }

  if (screen.kind === "benchOptions") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <BenchOptionsView
          onRun={(args, label) => setScreen({ kind: "run", args, label })}
          onCancel={() => setScreen({ kind: "menu" })}
        />
      </Box>
    );
  }

  if (screen.kind === "allOptions") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <AllOptionsView
          onRun={(args, label) => setScreen({ kind: "run", args, label })}
          onCancel={() => setScreen({ kind: "menu" })}
        />
      </Box>
    );
  }

  if (screen.kind === "initOptions") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <InitOptionsView
          onRun={(args, label) => setScreen({ kind: "run", args, label })}
          onCancel={() => setScreen({ kind: "menu" })}
        />
      </Box>
    );
  }

  if (screen.kind === "resetOptions") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <ResetOptionsView
          onRun={(args, label) => setScreen({ kind: "run", args, label })}
          onCancel={() => setScreen({ kind: "menu" })}
        />
      </Box>
    );
  }

  if (screen.kind === "llamaPath") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <LlamaPathView onCancel={() => setScreen({ kind: "menu" })} />
      </Box>
    );
  }

  if (screen.kind === "doctor") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <DoctorView onExit={() => setScreen({ kind: "help" })} />
      </Box>
    );
  }

  if (screen.kind === "help") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold>help</Text>
        <Box marginTop={1} flexDirection="column">
          {renderRows(helpItems, helpCursor)}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>up/down to move | enter to open | q/esc back</Text>
        </Box>
      </Box>
    );
  }

  if (screen.kind === "advancedTools") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <StatusView status={status} />
        <Box marginTop={1} flexDirection="column">
          <Text bold>advanced tools</Text>
          <Box marginTop={1} flexDirection="column">
            {renderRows(advancedItems, advancedCursor)}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>up/down to move | enter to run | q/esc back</Text>
            <Text dimColor>
              <Text color="green">✓</Text> ready | <Text color="red">*</Text> needs attention
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <StatusView status={status} />
      <Box marginTop={1} flexDirection="column">
        <Text bold>what next?</Text>
        <Box marginTop={1} flexDirection="column">
          {renderRows(mainItems, menuCursor)}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>up/down to move | enter to open | q to quit</Text>
          <Text dimColor>
            <Text color="green">✓</Text> ready | <Text color="red">*</Text> needs attention
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
