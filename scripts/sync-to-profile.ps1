# Sync the workspace checkout of dsh-delete-message into the installed web
# profile copy.
#
# Run this while the DSH web process is STOPPED for HOST-half changes: Windows
# locks the loaded ESM/module files of the running host, so an in-place copy
# fails with "being used by another process" until the process exits.
# Client-half changes need no restart at all — the host serves client.js from
# disk per request; a browser hard refresh picks it up.
#
# ## Why FILE-BY-FILE copies (v0.1.3)
#
# `Copy-Item -Recurse src <existing dst>\src` does NOT mirror — when the
# destination exists PowerShell copies the source folder INTO it, producing
# dst\src\src. One 2026-08-22 run under a spawned powershell.exe turned that
# into a self-nesting runaway (src copied into its own subtree until MAX_PATH).
# Copying flat FILES to explicit destinations cannot nest, so this script
# never passes a directory as the first Copy-Item argument.
#
# Usage (from anywhere):  powershell -File scripts\sync-to-profile.ps1

$ErrorActionPreference = "Stop"

$srcRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dstRoot = Join-Path $env:USERPROFILE ".dsh\profiles\web\node_modules\dsh-delete-message"

if (-not (Test-Path (Join-Path $dstRoot "package.json"))) {
	Write-Error "installed copy not found at $dstRoot — install the plugin first"
}

# Root files (explicit destinations — never a directory argument). The host
# may hold package.json open, so every copy lands as <name>.new first and
# atomically replaces via Move-Item with a short retry loop.
function Copy-FileAtomic([string] $from, [string] $to) {
	$tmp = "$to.new"
	Copy-Item -LiteralPath $from -Destination $tmp -Force
	foreach ($i in 1..5) {
		try {
			Move-Item -LiteralPath $tmp -Destination $to -Force -ErrorAction Stop
			return
		} catch {
			Start-Sleep -Milliseconds 400
		}
	}
	throw "could not replace $to after retries (file held open?)"
}

foreach ($name in @("package.json", "cordis.patch.yml", "LICENSE", "README.md")) {
	$from = Join-Path $srcRoot $name
	if (Test-Path $from -PathType Leaf) {
		Copy-FileAtomic $from (Join-Path $dstRoot $name)
		Write-Host "synced $name"
	}
}

# src\ is flat — copy each FILE to an explicit destination path.
$srcDir = Join-Path $srcRoot "src"
$dstDir = Join-Path $dstRoot "src"
New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
foreach ($file in Get-ChildItem -LiteralPath $srcDir -File) {
	Copy-FileAtomic $file.FullName (Join-Path $dstDir $file.Name)
	Write-Host "synced src/$($file.Name)"
}

# Defensive sweep: a legacy nested copy (dst\src\src) must never survive.
$legacy = Join-Path $dstDir "src"
if (Test-Path -LiteralPath $legacy) {
	Remove-Item -LiteralPath $legacy -Recurse -Force
	Write-Warning "removed legacy nested copy $legacy"
}

$version = (Get-Content (Join-Path $dstRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host "installed copy is now version $version"
Write-Host "client half: hard-refresh the browser (no restart needed). Host half: restart dsh web."
