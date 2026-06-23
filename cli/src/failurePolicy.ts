export type FailurePhase =
  | "preflight"
  | "compatibility"
  | "spawn"
  | "load"
  | "readiness"
  | "warmup"
  | "workload_prepare"
  | "kv_fill"
  | "completion"
  | "persistence"
  | "unknown";

export type FailureCause =
  | "model_missing"
  | "unsupported_architecture"
  | "unsupported_argument"
  | "incompatible_cache_profile"
  | "load_oom"
  | "load_process_exit"
  | "readiness_timeout"
  | "request_timeout"
  | "transport_error"
  | "invalid_completion"
  | "user_cancelled"
  | "engine_unavailable"
  | "persistence_error"
  | "unknown";

export type FailureAction =
  | "retry_same_config"
  | "skip_config_continue"
  | "skip_larger_targets"
  | "abandon_profile"
  | "abandon_heavier"
  | "abandon_model"
  | "abort_benchmark";

export interface RuntimeFailure {
  phase: FailurePhase;
  cause: FailureCause;
  evidence: string;
  action: FailureAction;
  retryable: boolean;
  attempts: number;
  retry_exhausted: boolean;
}

export interface FailureClassificationInput {
  ok?: boolean | null;
  ready?: boolean | null;
  readinessReason?: "ready" | "timeout" | "exited" | null;
  error?: string | null;
  stderr?: string | null;
  fitStatus?: string | null;
  unsupportedArchitecture?: string | null;
  workloadKind?: string | null;
  attempt?: number;
  maxAttempts?: number;
}

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function evidence(error: string, stderr: string, fallback: string): string {
  const source = error.trim() || stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || fallback;
  return source.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 500);
}

function actionFor(
  cause: FailureCause,
  workloadKind: string,
): {
  action: FailureAction;
  exhaustedAction: FailureAction;
  retryable: boolean;
} {
  const skipTarget: FailureAction =
    workloadKind === "prefill" || workloadKind === "kv-fill"
      ? "skip_larger_targets"
      : "skip_config_continue";
  switch (cause) {
    case "unsupported_architecture":
      return { action: "abandon_model", exhaustedAction: "abandon_model", retryable: false };
    case "unsupported_argument":
    case "incompatible_cache_profile":
      return { action: "abandon_profile", exhaustedAction: "abandon_profile", retryable: false };
    case "load_oom":
      return { action: "abandon_heavier", exhaustedAction: "abandon_heavier", retryable: false };
    case "request_timeout":
      return { action: "retry_same_config", exhaustedAction: skipTarget, retryable: true };
    case "model_missing":
      return { action: "skip_config_continue", exhaustedAction: "skip_config_continue", retryable: false };
    case "user_cancelled":
    case "engine_unavailable":
    case "persistence_error":
      return { action: "abort_benchmark", exhaustedAction: "abort_benchmark", retryable: false };
    case "load_process_exit":
    case "readiness_timeout":
    case "transport_error":
    case "invalid_completion":
    case "unknown":
      return {
        action: "retry_same_config",
        exhaustedAction: "skip_config_continue",
        retryable: true,
      };
  }
}

export function classifyRuntimeFailure(input: FailureClassificationInput): RuntimeFailure | null {
  if (input.ok === true) return null;
  const error = String(input.error ?? "");
  const stderr = String(input.stderr ?? "");
  const combined = `${error}\n${stderr}`;
  const attempt = Math.max(1, Math.trunc(input.attempt ?? 1));
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? 3));
  const workloadKind = String(input.workloadKind ?? "baseline");

  let cause: FailureCause = "unknown";
  let phase: FailurePhase = "unknown";

  if (/model file\(s\) not found|no such file or directory|failed to open.*gguf/i.test(combined)) {
    cause = "model_missing";
    phase = "preflight";
  } else if (input.unsupportedArchitecture || /unknown model architecture/i.test(combined)) {
    cause = "unsupported_architecture";
    phase = "compatibility";
  } else if (/compatibility check failed|unknown argument|unrecognized option|invalid argument.*--/i.test(combined)) {
    cause = "unsupported_argument";
    phase = "compatibility";
  } else if (includesAny(combined, [
    /quantized V cache.*requires Flash Attention/i,
    /cache type.*not supported/i,
    /cannot use.*cache.*Flash Attention/i,
  ])) {
    cause = "incompatible_cache_profile";
    phase = "load";
  } else if (input.fitStatus === "failed_but_running" || includesAny(combined, [
    /out of memory/i,
    /cuda.*alloc.*fail/i,
    /failed to allocate/i,
    /not enough memory/i,
  ])) {
    cause = "load_oom";
    phase = input.ready === false ? "load" : "completion";
  } else if (/user cancel|cancelled by user|canceled by user|SIGINT|SIGTERM/i.test(combined)) {
    cause = "user_cancelled";
    phase = "unknown";
  } else if (/ENOSPC|disk full|no space left|results? (?:file )?.*not writable|EACCES.*(?:result|log)/i.test(combined)) {
    cause = "persistence_error";
    phase = "persistence";
  } else if (/spawn .*ENOENT|llama_server_exe missing|backend unavailable|could not inspect llama-server/i.test(combined)) {
    cause = "engine_unavailable";
    phase = "spawn";
  } else if (input.readinessReason === "timeout" || /readiness timeout|server did not become ready \(timeout\)/i.test(combined)) {
    cause = "readiness_timeout";
    phase = "readiness";
  } else if (input.readinessReason === "exited" || (input.ready === false && /server did not become ready \(exited\)/i.test(combined))) {
    cause = "load_process_exit";
    phase = "load";
  } else if (/timed? ?out|operation was aborted|AbortError|headers timeout|body timeout/i.test(combined)) {
    cause = "request_timeout";
    phase = workloadKind === "kv-fill" ? "kv_fill" : "completion";
  } else if (/fetch failed|ECONNRESET|ECONNREFUSED|socket|network|HTTP 5\d\d/i.test(combined)) {
    cause = "transport_error";
    phase = workloadKind === "kv-fill" ? "kv_fill" : "completion";
  } else if (/too few tokens|invalid completion|no readable stream|invalid JSON|response.*missing/i.test(combined)) {
    cause = "invalid_completion";
    phase = "completion";
  } else if (input.ready === false) {
    cause = "load_process_exit";
    phase = "load";
  } else {
    cause = "unknown";
    phase = "completion";
  }

  const policy = actionFor(cause, workloadKind);
  const exhausted = policy.retryable && attempt >= maxAttempts;
  return {
    phase,
    cause,
    evidence: evidence(error, stderr, cause),
    action: exhausted ? policy.exhaustedAction : policy.action,
    retryable: policy.retryable,
    attempts: attempt,
    retry_exhausted: exhausted,
  };
}

export function failureSummaryLabel(failure: RuntimeFailure): string {
  return `${failure.cause} during ${failure.phase}: ${failure.evidence}`;
}
