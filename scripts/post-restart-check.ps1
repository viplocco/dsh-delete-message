# dsh-delete-message — post-restart verification probe.
#
# Run this AFTER restarting the DSH web host. It answers the only three
# questions that matter after a restart, in order, and stops at the first
# failure so the fix target is unambiguous:
#
#   1. Is the web host back?           (GET / -> 200)
#   2. Is the browser half served?     (GET /plugins/dsh-delete-message/client.js)
#   3. Is the host half routed?        (GET /api/delete-message/status)
#
# The status probe uses deliberately bogus parameters: any JSON answer
# ({ok:false,...}) proves the ROUTE is alive; 404 means the plugin layer did
# not compose and the restart did not pick it up.

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:3080"

Write-Host "== [1/3] waiting for the web host on $base ..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
	try {
		$code = curl.exe -s -o NUL -w "%{http_code}" --max-time 4 "$base/"
		if ($code -eq "200") { $ready = $true; break }
	} catch {}
	Start-Sleep -Seconds 2
}
if (-not $ready) { Write-Host "FAIL: host not reachable after 60s"; exit 1 }
Write-Host "OK: host is up"

Write-Host "== [2/3] browser half (client bundle) ..."
$out = Join-Path $env:TEMP "dmc-client.js"
$code = curl.exe -s -o $out -w "%{http_code}" --max-time 10 "$base/plugins/dsh-delete-message/client.js"
if ($code -ne "200") { Write-Host "FAIL: client.js -> $code (plugin layer not composed? check dump-config)"; exit 1 }
$marker = Select-String -Path $out -Pattern "__ModuleLoader__" -SimpleMatch -Quiet
if (-not $marker) { Write-Host "FAIL: client.js served but missing __ModuleLoader__ marker"; exit 1 }
Write-Host ("OK: client.js served ({0} bytes)" -f (Get-Item $out).Length)

Write-Host "== [3/3] host half (delete route) ..."
$json = curl.exe -s --max-time 10 "$base/api/delete-message/status?sessionId=probe&seq=0"
Write-Host "status => $json"
if ($json -match '"ok"') {
	Write-Host "OK: delete route is live"
	Write-Host ""
	Write-Host "ALL GREEN — open the GUI, enter a session, hover a message row:"
	Write-Host "the trash icon should sit right of the copy button."
	exit 0
}
Write-Host "FAIL: route answered '$json' (expected JSON with an ok field)"
exit 1
