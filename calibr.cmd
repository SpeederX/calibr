@echo off
REM Thin wrapper so `calibr <cmd>` works from cmd.exe and PowerShell once
REM this directory is on PATH. %~dp0 resolves to the folder containing this
REM .cmd file (trailing backslash). -NoProfile skips the user's PS profile so
REM startup is fast and predictable. -ExecutionPolicy Bypass avoids the
REM "running scripts is disabled" error on locked-down machines.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0calibr.ps1" %*
exit /b %ERRORLEVEL%
