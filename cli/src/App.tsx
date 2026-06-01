import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import { ENGINE_COMMANDS, readStatus, type Status } from "./engine.js";
import { StatusView } from "./StatusView.js";
import { RunView } from "./RunView.js";
import { ResultsView } from "./ResultsView.js";
import { BenchOptionsView } from "./BenchOptionsView.js";
import { AllOptionsView } from "./AllOptionsView.js";
import { InitOptionsView } from "./InitOptionsView.js";
import { ResetOptionsView } from "./ResetOptionsView.js";
import { LlamaPathView } from "./LlamaPathView.js";

type Screen =
  | { kind: "menu" }
  | { kind: "initOptions" }
  | { kind: "benchOptions" }
  | { kind: "allOptions" }
  | { kind: "resetOptions" }
  | { kind: "llamaPath" }
  | { kind: "run"; args: string[]; label: string }
  | { kind: "results" };

export function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "menu" });
  const [status, setStatus] = useState<Status>(() => readStatus());

  // Refresh status whenever we return to the menu.
  useEffect(() => {
    if (screen.kind === "menu") setStatus(readStatus());
  }, [screen.kind]);

  useInput((input, key) => {
    if (screen.kind === "menu" && (input === "q" || key.escape)) {
      exit();
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

  const items: { label: string; value: string }[] = [
    { label: `${"results".padEnd(10)} — browse benchmark winners`, value: "__results" },
    ...ENGINE_COMMANDS.map((c) => ({
      label: `${c.label.padEnd(10)} — ${c.description}`,
      value: c.id,
    })),
    { label: `${"llama".padEnd(10)} — change llama-server.exe path`, value: "__llamaPath" },
  ];

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <StatusView status={status} />
      <Box marginTop={1} flexDirection="column">
        <Text bold>what next?</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__results") {
              setScreen({ kind: "results" });
              return;
            }
            if (item.value === "__llamaPath") {
              setScreen({ kind: "llamaPath" });
              return;
            }
            if (item.value === "init") {
              setScreen({ kind: "initOptions" });
              return;
            }
            if (item.value === "bench") {
              setScreen({ kind: "benchOptions" });
              return;
            }
            if (item.value === "all") {
              setScreen({ kind: "allOptions" });
              return;
            }
            if (item.value === "reset") {
              setScreen({ kind: "resetOptions" });
              return;
            }
            const cmd = ENGINE_COMMANDS.find((c) => c.id === item.value);
            if (cmd) setScreen({ kind: "run", args: cmd.args, label: cmd.label });
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>↑/↓ to move · enter to run · q to quit</Text>
        </Box>
      </Box>
    </Box>
  );
}
