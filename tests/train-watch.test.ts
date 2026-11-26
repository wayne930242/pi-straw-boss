import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs, run } from "../src/server/cli.ts";
import { WATCH_EVERY, WATCH_MAX } from "../src/server/traincmds.ts";
import { type Board, writeBoard } from "../src/train/board.ts";
import { SHA_A } from "./train-fixtures.ts";

// `cli.mjs train status --watch` (troubleshoot kit §5 item 5): a monitor on a slow poller died of inactivity because nothing was printed while nothing changed. The watch prints one JSONL `progress` line
// for every look, changed or not (pi-loop-monitor renews its inactivity timeout on one), and the status itself only when the trains changed.

const dir = mkdtempSync(join(process.env.SB_TEST_ROOT!, "tw-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.parse("2026-11-07T08:00:00Z");
const board = (code: string, pid: number, updated: string): Board => ({
	v: 1, project: "acme", app: "web", code, writer: { session: `sess-${code}`, pid, started: "2026-11-07T06:00:00.000Z" }, updated, round: 1,
	cars: [{ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "none" }],
	steps: [{ id: 1, kind: "merge", name: "merge", status: "in_progress", round: 1, holds: { lane: "web" } }, { id: 2, kind: "land", name: "land", status: "pending", round: 1, holds: { lane: "web" } }],
});

test("cli: --watch and --every are train status's", () => {
	assert.deepEqual(parseArgs(["train", "status", "--watch", "--every", "30"]).flags, { sub: "status", watch: true, every: "30" });
});

test("train status --watch prints a progress line at every look, the status only when it changed, and waits --every between looks", async () => {
	const stateDir = join(dir, "state");
	writeBoard(stateDir, board("2026-11-07-a", 4242, "2026-11-07T07:00:00.000Z")); // its session is gone and it has not moved for an hour: stale
	const ended = new AbortController(), waits: number[] = [], out: string[] = [];
	let load = 1;
	// The second look sees only a new load; before the third a live train starts; after it the watch is stopped.
	const sleep = async (ms: number) => {
		waits.push(ms);
		load += 1;
		if (waits.length === 2) writeBoard(stateDir, board("2026-11-07-b", process.pid, "2026-11-07T07:59:00.000Z"));
		if (waits.length === 3) ended.abort();
	};
	const code = await run(["train", "status", "--watch", "--every", "30"], { stateDir, out: (t) => out.push(t), err: (t) => assert.fail(t), train: { now: () => NOW, alive: (w) => w.pid === process.pid, load: () => ({ now: load, cores: 8 }), sleep, signal: ended.signal } });
	assert.equal(code, 0);
	assert.deepEqual(waits, [30_000, 30_000, 30_000]);
	const lines = out.join("").trimEnd().split("\n").map((l) => JSON.parse(l) as { progress: { message: string }; status?: { trains: { code: string }[]; load: { now: number } } });
	assert.equal(lines.length, 3, "one line per look");
	for (const line of lines) assert.equal(typeof line.progress.message, "string", "pi-loop-monitor takes a progress line with a message");
	assert.deepEqual(lines.map((l) => l.status?.trains.map((t) => t.code)), [["2026-11-07-a"], undefined, ["2026-11-07-a", "2026-11-07-b"]]);
	assert.deepEqual(lines.map((l) => l.progress.message), ["changed: 1 stale; 2026-11-07-a #1 merge", "unchanged: 1 stale; 2026-11-07-a #1 merge", "changed: 1 live, 1 stale; 2026-11-07-a #1 merge, 2026-11-07-b #1 merge (waits)"]);
	assert.equal(lines[2]!.status!.load.now, 3, "the load is shown but is no change by itself");
});

test("a look that fails is a progress line that says so, and the watch goes on", async () => {
	const ended = new AbortController(), out: string[] = [];
	let looks = 0;
	const load = () => { looks++; if (looks === 1) throw new Error("loadavg failed"); return { now: 1, cores: 8 }; };
	const sleep = async () => void (looks === 2 && ended.abort());
	assert.equal(await run(["train", "status", "--watch"], { stateDir: join(dir, "empty"), out: (t) => out.push(t), err: (t) => assert.fail(t), train: { now: () => NOW, load, sleep, signal: ended.signal } }), 0);
	assert.deepEqual(out.join("").trimEnd().split("\n").map((l) => (JSON.parse(l) as { progress: { message: string } }).progress.message), ["the look failed: loadavg failed", "changed: no trains"]);
});

test("--every goes with --watch and is 10 seconds or more; the default is a minute", async () => {
	assert.equal(WATCH_EVERY, 60);
	for (const argv of [["--every", "30"], ["--watch", "--every", "5"], ["--watch", "--every", "soon"]]) {
		const err: string[] = [];
		assert.equal(await run(["train", "status", ...argv], { stateDir: join(dir, "none"), out: () => assert.fail("no output"), err: (t) => err.push(t) }), 2, argv.join(" "));
		assert.match(err.join(""), /--every goes with --watch: the seconds between looks, 10 or more/);
	}
});

test("kit2-F005: --every that is not finite, or longer than a timer can wait, is a usage error, never a 1 ms poll", async () => {
	// An aborted signal: a watch that started anyway ends at once (exit 0) instead of polling.
	for (const argv of [["--watch", "--every", "Infinity"], ["--watch", "--every", "1e400"], ["--watch", "--every", "2147484"]]) {
		const err: string[] = [];
		assert.equal(await run(["train", "status", ...argv], { stateDir: join(dir, "none"), out: () => assert.fail("no output"), err: (t) => err.push(t), train: { signal: AbortSignal.abort() } }), 2, argv.join(" "));
		assert.match(err.join(""), /--every goes with --watch: the seconds between looks, 10 or more and 2147483 at most/);
	}
	assert.equal(WATCH_MAX, 2_147_483, "the longest wait a Node timer takes, in whole seconds");
});

/** A stdout whose reader is slow: every `write` answers false, the test emits `drain`, and the pipe can close or fail. */
class Pipe extends EventEmitter {
	lines: string[] = [];
	write(text: string) {
		this.lines.push(text);
		return false;
	}
}

test("kit2-F006: the watch waits for stdout to drain before the next look, and ends when the pipe closes or fails", async () => {
	for (const end of ["close", "error"] as const) {
		const pipe = new Pipe(), waits: number[] = [], out: string[] = [], cap = new AbortController();
		// The cap only ends a watch that ignores the pipe (a hundred looks), so such a watch fails here instead of spinning.
		const sleep = async (ms: number) => void (waits.push(ms) >= 100 && cap.abort());
		const watching = run(["train", "status", "--watch"], { stateDir: join(dir, "drain"), out: (t) => out.push(t), err: () => undefined, train: { now: () => NOW, load: () => ({ now: 1, cores: 8 }), sleep, signal: cap.signal, stream: pipe } });
		await new Promise((done) => setImmediate(done));
		assert.equal(pipe.lines.length, 1, `${end}: the first look is written`);
		assert.deepEqual(waits, [], `${end}: no wait and no next look while the write waits for 'drain'`);
		pipe.emit("drain");
		await new Promise((done) => setImmediate(done));
		assert.equal(pipe.lines.length, 2, `${end}: one drain lets one more look through`);
		assert.deepEqual(waits, [WATCH_EVERY * 1000], `${end}: and the wait before it`);
		const written = pipe.lines.length;
		if (end === "close") pipe.emit("close");
		else pipe.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
		assert.equal(await watching, 1, `${end}: the reader is gone, the watch ends`);
		assert.equal(pipe.lines.length, written, `${end}: nothing is written after the pipe went`);
		assert.deepEqual(out, [], `${end}: the lines go to the stream`);
	}
});
