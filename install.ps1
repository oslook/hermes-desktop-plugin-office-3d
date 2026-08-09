# office-3d installer (Windows PowerShell) — copies the plugin into your
# Hermes home, enables the backend, and prints how to reload.
# Honours $env:HERMES_HOME, falls back to %USERPROFILE%\.hermes.
$ErrorActionPreference = 'Stop'

$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE '.hermes' }
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "office-3d installer"
Write-Host "  Hermes home: $HermesHome"

if (-not (Test-Path $HermesHome)) {
  Write-Error "  x $HermesHome not found. Is Hermes installed? (set HERMES_HOME if using a custom path)"
  exit 1
}

# 1. Frontend (desktop plugin ESM)
$FeDir = Join-Path $HermesHome 'desktop-plugins\office-3d'
New-Item -ItemType Directory -Force -Path $FeDir | Out-Null
Copy-Item (Join-Path $Here 'desktop-plugins\office-3d\plugin.js') (Join-Path $FeDir 'plugin.js') -Force
Write-Host "  + frontend  -> $FeDir\plugin.js"

# 2. Backend (dashboard FastAPI router + manifest)
$BeDir = Join-Path $HermesHome 'plugins\office-3d\dashboard'
New-Item -ItemType Directory -Force -Path $BeDir | Out-Null
Copy-Item (Join-Path $Here 'plugins\office-3d\dashboard\plugin_api.py') (Join-Path $BeDir 'plugin_api.py') -Force
Copy-Item (Join-Path $Here 'plugins\office-3d\dashboard\manifest.json') (Join-Path $BeDir 'manifest.json') -Force
Write-Host "  + backend   -> $BeDir\"

# 3. Enable the backend so the dashboard imports it (security gate).
$hermes = Get-Command hermes -ErrorAction SilentlyContinue
if ($hermes) {
  try {
    hermes plugins enable office-3d | Out-Null
    Write-Host "  + enabled   -> plugins.enabled += office-3d"
  } catch {
    Write-Host "  ! could not run 'hermes plugins enable office-3d' - add 'office-3d' to plugins.enabled in config.yaml manually (must be a YAML list)"
  }
} else {
  Write-Host "  ! 'hermes' not on PATH - add 'office-3d' to plugins.enabled in $HermesHome\config.yaml manually (must be a YAML list)"
}

Write-Host ""
Write-Host "Next steps to make it appear:"
Write-Host "  - Frontend: fully quit and reopen the Hermes Desktop app"
Write-Host "              (or Ctrl+K -> 'Reload desktop plugins'), then open the"
Write-Host "              'Office' page from the sidebar."
Write-Host "  - Backend:  restart the dashboard web server so it mounts"
Write-Host "              /api/plugins/office-3d/ (e.g. stop and start 'hermes dashboard')."
Write-Host ""
Write-Host "Done."