import React from "react";
import { Box, Text } from "ink";
import type { Status } from "./engine.js";

export function StatusView({ status }: { status: Status }) {
  const c = status.config;
  const hw = c.hardware ?? {};
  const vramBudget = hw.vram_safety_budget_mib ?? "?";
  const vramTotal = hw.vram_total_mib ?? "?";
  const gpu = hw.gpu_name ?? "?";
  const llama = c.llama_server_exe || "(unset)";
  const paths = (c.scan_paths ?? []).join(", ") || "(unset)";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>calibr — status</Text>
      <Box marginTop={1} flexDirection="column">
        <Text><Text dimColor>gpu:        </Text>{gpu}</Text>
        <Text><Text dimColor>vram:       </Text>{vramBudget} / {vramTotal} MiB (safety budget / total)</Text>
        <Text><Text dimColor>llama:      </Text>{llama}</Text>
        <Text><Text dimColor>scan paths: </Text>{paths}</Text>
        <Text><Text dimColor>config:     </Text>{status.hasLocalConfig ? "local override present" : "defaults only"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text><Text dimColor>catalog:    </Text>{status.catalogCount} models</Text>
        <Text><Text dimColor>plan:       </Text>{status.planCount} configs</Text>
        <Text><Text dimColor>results:    </Text>{status.resultsCount} completed</Text>
        <Text><Text dimColor>report:     </Text>{status.hasReport ? "yes (data/report.html)" : "no"}</Text>
      </Box>
    </Box>
  );
}
