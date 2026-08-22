/**
 * Session log probe — pins the integration assumptions against a REAL log.
 *
 * Reads one session.jsonl.zstd, decompresses it, and prints STRUCTURE only:
 * the event-type sequence, envelope keys, and surfaceOp distribution. Message
 * text is never printed — this probe answers shape questions, not content.
 *
 * Usage: node scripts/probe-session.mjs <sessionId>
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

/**
 * Decompress the jsonl backend's chunk-packed log into one UTF-8 string.
 *
 * The file is a CONCATENATION of independent zstd frames (a real session:
 * 3,500+), each frame carrying one multi-line block of JSONL records. The
 * one-shot and stream decoders both stop after the FIRST frame — which is
 * just the session header line — so frames are split on the zstd magic
 * (0x28 B5 2F FD) and decompressed individually.
 */
function decompressAllFrames(raw) {
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const parts = [];
	let start = 0;
	while (true) {
		const next = raw.indexOf(MAGIC, start + 1);
		const end = next === -1 ? raw.length : next;
		parts.push(zstdDecompressSync(raw.subarray(start, end)).toString("utf8"));
		if (next === -1) break;
		start = next;
	}
	return parts.join("");
}

const sessionId = process.argv[2];
if (!sessionId) {
	console.error("usage: node scripts/probe-session.mjs <sessionId>");
	process.exit(1);
}

// The current project's session dir; extend when probing other workspaces.
const dir = join(
	homedir(),
	".dsh",
	"sessions",
	"--E-project-DSH-Delete-message--",
	sessionId
);
const raw = readFileSync(join(dir, "session.jsonl.zstd"));
const text = decompressAllFrames(raw);
const events = text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));

console.log(`events: ${events.length}`);
console.log(`types : ${events.map((e) => e.type.replace("/message", "")).join(" ")}`);

const firstUser = events.find((e) => e.type === "user/message");
if (firstUser) {
	const { seq, type, time, data, ...rest } = firstUser;
	console.log("\nfirst user/message envelope keys:", Object.keys({ seq, type, time, ...rest }).join(", "));
	console.log("data keys:", Object.keys(data ?? {}).join(", "));
	console.log("content block types:", (data?.content ?? []).map((b) => b?.type).join(", "));
	console.log("surfaceOp:", JSON.stringify(firstUser.surfaceOp));
}

const ops = {};
for (const e of events) {
	if (e.surfaceOp === undefined) continue;
	const key = typeof e.surfaceOp === "string" ? "append" : `replace(${e.surfaceOp.start}-${e.surfaceOp.end})`;
	ops[key] = (ops[key] ?? 0) + 1;
}
console.log("\nsurfaceOp distribution:", JSON.stringify(ops));

// What the deletion rules would say about every deletable-looking node.
const userMsgs = events.filter((e) => e.type === "user/message" && e.surfaceOp === "append");
console.log(`\nappend-state user/message nodes: ${userMsgs.map((e) => e.seq).join(", ")}`);
