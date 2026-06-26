import { spawnSync } from "node:child_process";

export interface LlamaCapabilities {
  executable: string;
  version: string;
  options: string[];
  cacheTypesK: string[];
  cacheTypesV: string[];
  helpExitCode: number | null;
  ok: boolean;
  error: string | null;
}

function optionBlock(help: string, option: string): string {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(option));
  if (start < 0) return "";
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-{1,2}[a-z0-9]/i.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join(" ");
}

function allowedValues(help: string, option: string): string[] {
  const match = optionBlock(help, option).match(/allowed values:\s*([a-z0-9_,.\s-]+)/i);
  if (!match) return [];
  return match[1].split(",").map((value) => value.trim()).filter((value) => /^[a-z0-9_]+$/i.test(value));
}

export function parseLlamaHelp(help: string, executable = ""): LlamaCapabilities {
  const options = new Set<string>();
  for (const line of help.split(/\r?\n/)) {
    if (!/^\s*-{1,2}[a-z0-9]/i.test(line)) continue;
    for (const match of line.matchAll(/(?:^|[,\s])(-{1,2}[a-z][a-z0-9-]*)/gi)) {
      options.add(match[1]);
    }
  }
  return {
    executable,
    version: "unknown",
    options: [...options].sort(),
    cacheTypesK: allowedValues(help, "--cache-type-k"),
    cacheTypesV: allowedValues(help, "--cache-type-v"),
    helpExitCode: 0,
    ok: options.size > 0,
    error: options.size > 0 ? null : "llama-server help did not expose any CLI options",
  };
}

export function inspectLlamaServer(executable: string): LlamaCapabilities {
  const help = spawnSync(executable, ["--help"], { encoding: "utf8", windowsHide: true });
  const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  const capabilities = parseLlamaHelp(helpText, executable);
  const version = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true });
  const versionText = `${version.stdout ?? ""}\n${version.stderr ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
  capabilities.version = versionText || "unknown";
  capabilities.helpExitCode = help.status;
  if (help.error) {
    capabilities.ok = false;
    capabilities.error = help.error.message;
  }
  return capabilities;
}

export function supportsOption(capabilities: LlamaCapabilities, ...names: string[]): boolean {
  const available = new Set(capabilities.options);
  return names.some((name) => available.has(name));
}

export function compatibleCacheType(
  requested: string,
  allowed: string[],
  fallbacks = ["q8_0", "f16"],
): string | null {
  if (allowed.length === 0) return requested;
  if (allowed.includes(requested)) return requested;
  return fallbacks.find((candidate) => allowed.includes(candidate)) ?? allowed[0] ?? null;
}

export function validateLlamaArgs(args: string[], capabilities: LlamaCapabilities): string[] {
  const issues: string[] = [];
  const available = new Set(capabilities.options);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!/^-{1,2}[a-z]/i.test(token)) continue;
    if (!available.has(token)) issues.push(`unsupported option ${token}`);
    if ((token === "--cache-type-k" || token === "-ctk") && args[i + 1]) {
      const value = args[i + 1];
      if (capabilities.cacheTypesK.length > 0 && !capabilities.cacheTypesK.includes(value)) {
        issues.push(`unsupported K cache type ${value}`);
      }
    }
    if ((token === "--cache-type-v" || token === "-ctv") && args[i + 1]) {
      const value = args[i + 1];
      if (capabilities.cacheTypesV.length > 0 && !capabilities.cacheTypesV.includes(value)) {
        issues.push(`unsupported V cache type ${value}`);
      }
    }
  }
  return [...new Set(issues)];
}
