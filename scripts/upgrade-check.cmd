@echo off
rem one-click DSH-core-upgrade regression check for dsh-delete-message.
rem Run this AFTER upgrading the DeepSeek Harness core and restarting dsh web.
rem It launches a throwaway headless Edge per probe and gates the plugin's
rem three fragile couplings (React fiber introspection, CSS-modules hashed
rem class tokens, data-* DOM hooks) plus the deep behavioral contracts.
rem
rem Optional:  upgrade-check.cmd --only-smoke      (skip the live CDP probes)
rem             upgrade-check.cmd --probe preflight (run a single live probe)
cd /d "%~dp0"
node "%~dp0run-upgrade-check.mjs" %*
set EXITCODE=%ERRORLEVEL%
echo.
echo exit code: %EXITCODE%
exit /b %EXITCODE%
