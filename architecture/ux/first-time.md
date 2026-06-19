# UX flow: first run

## Goal

Reach a useful guided benchmark without learning the PowerShell engine.

## Flow

1. Install the package and run `calibr`.
2. Let hardware detection populate the initial defaults.
3. Select or download a compatible `llama-server` build when none is
   configured.
4. Choose local models or a curated catalog level.
5. Review the policy summary and start guided run.

The CLI owns prompts, choices, progress, and recovery guidance. The PowerShell
adapter owns platform/config discovery and raw engine work. Personal absolute
paths are persisted locally and redacted or normalized in shared reports.

## Recovery

If setup is incomplete, guided run repairs it before benchmarking. Preferences
cover normal changes; raw `calibr.ps1` commands remain an advanced maintenance
surface for diagnosis and automation.
