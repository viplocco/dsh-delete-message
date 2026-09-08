/**
 * run-upgrade-check.mjs — one-click DSH-core-upgrade regression gate.
 *
 * WHAT IT DOES
 *   Launches a throwaway headless Edge per probe (fresh profile + distinct CDP
 *   port), runs each verification probe against the RUNNING dsh web GUI
 *   (http://127.0.0.1:3080 by default), kills the Edge, aggregates PASS/FAIL,
 *   and exits non-zero if anything fails.
 *
 *   Run this AFTER upgrading the DeepSeek Harness core (npm i -g
 *   @deepseek-ai/dsh@<ver> + restart web). It is the automated version of the
 *   manual "did the plugin still mount on the new host" check and gates the
 *   three P1-fragile couplings (React fiber introspection, CSS-modules hashed
 *   class tokens, data-* DOM hooks) plus the deep behavioral contracts.
 *
 * PROBES
 *   tmp-probe/verify-upgrade.mjs   P1-fragility healthcheck (mounts, fiber,
 *                                  hashed-class, data-* anchors). Non-destructive.
 *   scripts/smoke-render.mjs       Node-only smoke (no browser): bundle loads,
 *                                  slot registers, seq-resolution + verdict-cache
 *                                  + transition contracts.
 *   tmp-probe/verify-preflight.mjs Live: refusal/allow verdict gating, icon
 *                                  graying, zero real POSTs (fetch-shimmed).
 *   tmp-probe/verify-transition.mjs Live: pending spinner, graceful close, row
 *                                  leave animation, inline-failure retry.
 *   tmp-probe/verify-dedup.mjs     Live: ledger sweep once-per-snapshot gate.
 *
 * USAGE
 *   node scripts/run-upgrade-check.mjs [--probe <name>] [--only-smoke]
 *   Environment overrides:
 *     DSH_EDGE=path/to/msedge.exe      DSH_PROBE_GUI=http://127.0.0.1:3080/
 *     DSH_PROBE_PROJECT=Delete-message DSH_PROBE_SESSION="现在删除助手消息时"
 *     DSH_KEEP_EDGE=1  (do not kill Edge after the run, for debugging)
 *     DSH_EDGE_PORT=9xxx  (base CDP port; each probe gets base+index)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const GUI = process.env.DSH_PROBE_GUI || "http://127.0.0.1:3080/";
const KEEP_EDGE = process.env.DSH_KEEP_EDGE === "1";
const BASE_PORT = Number(process.env.DSH_EDGE_PORT || 9335);

/** Locate a usable Microsoft Edge binary. */
function findEdge() {
	const candidates = [
		process.env.DSH_EDGE,
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe"
	].filter(Boolean);
	for (const p of candidates) if (existsSync(p)) return p;
	throw new Error(
		"Edge not found. Set DSH_EDGE=C:\\path\\to\\msedge.exe (this script needs a REAL " +
		"Chromium to run the live CDP probes against the dsh web GUI)."
	);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until a CDP endpoint answers /json/list, up to timeoutMs. */
async function waitForCdp(port, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (res.ok) return true;
		} catch {}
		await sleep(500);
	}
	return false;
}

/** True when the dsh web GUI is reachable. The SPA may not answer HEAD with a
 * 2xx, so any HTTP response (even 404/405) means the server is up — only a
 * network refusal counts as "down". */
async function guiIsUp() {
	try {
		await fetch(GUI, { method: "HEAD" });
		return true;
	} catch { return false; }
}

const PROBES = [
	{ name: "upgrade-healthcheck", file: "tmp-probe/verify-upgrade.mjs", needsBrowser: true },
	{ name: "smoke-render",         file: "scripts/smoke-render.mjs",     needsBrowser: false },
	{ name: "preflight",            file: "tmp-probe/verify-preflight.mjs", needsBrowser: true },
	{ name: "transition",           file: "tmp-probe/verify-transition.mjs", needsBrowser: true },
	{ name: "ledger-dedup",         file: "tmp-probe/verify-dedup.mjs",    needsBrowser: true }
];

const runProbe = (probe, port) => new Promise((resolve) => {
	const env = {
		...process.env,
		DSH_PROBE_PORT: String(port),
		DSH_PROBE_GUI: GUI
	};
	const child = spawn(process.execPath, [join(ROOT, probe.file)], { env, cwd: ROOT });
	let out = "";
	child.stdout.on("data", (d) => { out += d; });
	child.stderr.on("data", (d) => { out += d; });
	child.on("error", (err) => resolve({ probe: probe.name, status: "SPAWN-ERROR", output: String(err), pass: false }));
	child.on("close", (code) => {
		const verdict = /OVERALL:\s*(PASS|FAIL)/.exec(out);
		const pass = verdict ? verdict[1] === "PASS" : code === 0;
		resolve({ probe: probe.name, status: pass ? "PASS" : "FAIL", output: out, pass });
	});
});

async function main() {
	const args = process.argv.slice(2);
	const onlyName = args.includes("--only-smoke") ? "smoke-render"
		: (() => { const i = args.indexOf("--probe"); return i >= 0 ? args[i + 1] : null; })();

	// Only require a running dsh web when at least one selected probe needs a
	// browser (smoke-render is pure Node and must not be gated on the GUI).
	const selected = PROBES.filter((p) => !onlyName || p.name === onlyName);
	if (selected.some((p) => p.needsBrowser) && !(await guiIsUp())) {
		console.error(`dsh web GUI not reachable at ${GUI}. Start dsh web first (e.g. run .dsh-restart-web.ps1 in a normal shell), then re-run.`);
		process.exit(1);
	}

	const edge = findEdge();
	const started = [];
	const results = [];
	let port = BASE_PORT;

	try {
		for (const probe of selected) {
			console.log(`\n=== probe: ${probe.name} ===`);
			let pass = false;
			let output = "";
			let attempt;
			for (attempt = 1; attempt <= 2; attempt += 1) {
				let portForRun = port;
				if (probe.needsBrowser) {
					const profile = mkdtempSync(join(tmpdir(), "dsh-upgrade-"));
					const child = spawn(edge, [
						"--headless=new",
						`--remote-debugging-port=${portForRun}`,
						`--user-data-dir=${profile}`,
						"--no-first-run",
						"--disable-gpu",
						"--disable-background-networking",
						"--window-size=1400,1000",
						GUI
					], { stdio: "ignore" });
					started.push({ child, profile });
					const up = await waitForCdp(portForRun);
					if (!up) { console.error(`  [attempt ${attempt}] CDP not up on :${portForRun} (Edge likely crashed at launch)`); if (attempt === 1) { portForRun += 1; port = portForRun; } continue; }
					const r = await runProbe(probe, portForRun);
					pass = r.pass; output = r.output;
					if (!pass && attempt === 1) {
						// The known headless-Edge navigation crash can kill the page
						// mid-probe; relaunch on a fresh port and retry once.
						console.error(`  [attempt ${attempt}] FAIL — relaunching Edge on :${portForRun + 1} and retrying once.`);
						portForRun += 1; port = portForRun;
						continue;
					}
					port = portForRun + 1;
					break;
				}
				const r = await runProbe(probe, portForRun);
				pass = r.pass; output = r.output;
				break;
			}
			// Show the probe's OWN verdict lines (kept short) not the full dump.
			const lines = output.split("\n").filter((l) => /VERDICT:|OVERALL:|SMOKE OK|MEASURE:|BASELINE:|RESULT:/.test(l));
			if (lines.length) console.log(lines.join("\n"));
			results.push({ probe: probe.name, pass, attempt, output });
		}
	} finally {
		if (!KEEP_EDGE) for (const s of started) { try { s.child.kill(); } catch {} }
		// Best-effort cleanup of the throwaway Edge profiles. Edge may hold a
		// lock for a beat after kill(), so this is fire-and-forget.
		await sleep(300);
		for (const s of started) { try { rmSync(s.profile, { recursive: true, force: true }); } catch {} }
	}

	// Summary
	console.log("\n================ UPGRADE-CHECK SUMMARY ================");
	let anyFail = false;
	for (const r of results) {
		console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.probe}`);
		if (!r.pass) { anyFail = true; console.log(r.output.split("\n").filter((l) => /OVERALL:|VERDICT:|EVAL ERROR|Error|error/.test(l)).slice(0, 8).map((l) => "       " + l).join("\n")); }
	}
	console.log("=======================================================");
	console.log(anyFail ? "RESULT: FAIL — upgrade BROKE the plugin. Inspect the failing probe above." : "RESULT: ALL PASS — the plugin still mounts on the new host.");
	process.exit(anyFail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });