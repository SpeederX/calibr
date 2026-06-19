import React, { useEffect, useState } from "react";
import { existsSync } from "node:fs";
import { Box, Text, useApp, useInput } from "ink";
import { readStatus, traceAction, traceSessionEnd, traceSessionStart, type Status, type TraceContext } from "./engine.js";
import { StatusView } from "./StatusView.js";
import { RunView } from "./RunView.js";
import { ResultsView } from "./ResultsView.js";
import { AllOptionsView, type GuidedRunSession } from "./AllOptionsView.js";
import { LlamaPathView } from "./LlamaPathView.js";
import { DoctorView } from "./DoctorView.js";
import { PreferencesView } from "./PreferencesView.js";

type Screen =
  | { kind: "menu" }
  | { kind: "help" }
  | { kind: "doctor" }
  | { kind: "allOptions" }
  | { kind: "llamaPath" }
  | { kind: "preferences" }
  | { kind: "run"; args: string[]; label: string; trace?: TraceContext }
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
  const [guidedSession, setGuidedSession] = useState<GuidedRunSession>({});
  const [menuCursor, setMenuCursor] = useState(0);
  const [helpCursor, setHelpCursor] = useState(0);

  useEffect(() => {
    traceSessionStart();
  }, []);

  // Refresh status whenever we return to the main menu readiness indicators.
  useEffect(() => {
    if (screen.kind === "menu") setStatus(readStatus());
  }, [screen.kind]);

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
      id: "llama-path",
      label: "configure llama path",
      description: "choose a llama.cpp server binary",
      badge: readinessBadge(llamaPathIsReady(status)),
      run: () => setScreen({ kind: "llamaPath" }),
    },
    {
      id: "preferences",
      label: "preferences",
      description: "user defaults and warnings",
      run: () => setScreen({ kind: "preferences" }),
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

  useInput((input, key) => {
    if (screen.kind === "menu") {
      if (input === "q" || key.escape) {
        traceAction({
          flow: "app",
          action: "quit",
          status: "completed",
          message: "app > quit",
        });
        traceSessionEnd("user quit from main menu");
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
        <RunView args={screen.args} label={screen.label} trace={screen.trace} onExit={() => setScreen({ kind: "menu" })} />
      </Box>
    );
  }

  if (screen.kind === "results") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <ResultsView
          onExit={() => setScreen({ kind: "menu" })}
          onRun={(args, label) => setScreen({
            kind: "run",
            args,
            label,
            trace: {
              flow: "results",
              action: "re-run selected config",
              message: "results > re-run selected config",
              details: { label },
            },
          })}
        />
      </Box>
    );
  }

  if (screen.kind === "allOptions") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <AllOptionsView
          session={guidedSession}
          onSessionChange={(patch) => setGuidedSession((current) => ({ ...current, ...patch }))}
          onRun={(args, label, trace) => setScreen({ kind: "run", args, label, trace })}
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

  if (screen.kind === "preferences") {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <PreferencesView onExit={() => setScreen({ kind: "menu" })} />
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
