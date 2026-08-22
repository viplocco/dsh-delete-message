# Sync the workspace checkout of dsh-delete-message into the installed web
# profile copy.
#
# Run this while the DSH web process is STOPPED: Windows locks the loaded
# ESM/module files of the running host, so an in-place copy fails with
# "being used by another process" until the process exits. After this script
# runs, starting `dsh web` boots the fixed plugin (v0.1.1+).
#
# Usage (from anywhere):  powershell -File scripts\sync-to-profile.ps1

$ErrorActionPreference = "Stop"

$src = Join-Path $PSScriptRoot ".."
$dst = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\dsh-delete-message"

if (-not (Test-Path (Join-Path $dst "package.json"))) {
	Write-Error "installed copy not found at $dst — install the plugin first"
}

foreach ($rel in @("src", "package.json")) {
	$from = Join-Path $src $rel
	$to = Join-Path $dst $rel
	Copy-Item $from $to -Recurse -Force
	Write-Host "synced $rel -> $to"
}

$version = (Get-Content (Join-Path $dst "package.json") -Raw | ConvertFrom-Json).version
Write-Host "installed copy is now version $version"
Write-Host "start dsh web to load it (host half needs a full process restart)."
