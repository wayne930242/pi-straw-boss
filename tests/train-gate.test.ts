import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/server/cli.ts";
import { slotOf } from "../src/server/record.ts";
import { trainStatus } from "../src/server/traincmds.ts";
import { cleanTail, fit, gateDeps, GRACE_MS, KILL_WAIT_MS, lastBytes, lastLine, type GateDeps, readGate, readSpec, runGate, startMs, writerAlive } from "../src/server/traingate.ts";
import { heldLocks, holderAlive, holderOf, lockDirOf, takeLock } from "../src/server/trainlock.ts";
import { startOf } from "../src/startof.ts";
import { type Board, boardPath, readBoard, readTrainboards, writeBoard } from "../src/train/board.ts";
import { holders } from "../src/train/waits.ts";
import { factsOf } from "../src/train/board.ts";
import { CODE, evidence, SHA_A, sb, slip } from "./train-fixtures.ts";
import { stallWatch } from "./server-world.ts";
import { TickClock, turn, until } from "./tick-clock.ts";

// docs/specs/2026-11-07-train-workers.md §8, §9: the gate wrapper, the named lock and the `train` commands. The wrapper runs on a clock the test moves and a load it sets; its children are real, and work only inside the test root.

const ROOT = process.env.SB_TEST_ROOT!;
const CLI = fileURLToPath(new URL("../src/server/cli.ts", import.meta.url));
const WORKER = fileURLToPath(new URL("./train-lock-worker.ts", import.meta.url));
const PROJECT = "acme";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) try { fn(); } catch { /* best effort */ } });

interface World { base: string; stateDir: string; work: string; lockDir: string; clock: TickClock; load: { now: number; cores: number } | undefined; flag: string }
function world(): World {
	const base = mkdtempSync(join(ROOT, "tg-")), stateDir = join(base, "state"), work = join(base, "work");
	mkdirSync(work, { recursive: true });
	const flag = join(work, "flag");
	cleanup.push(() => rmSync(base, { recursive: true, force: true }));
	// A test that fails before it ends its command must not leave the command waiting for ever (it would keep the test process alive): the flag ends every waitFor.
	cleanup.push(() => writeFileSync(flag, ""));
	return { base, stateDir, work, lockDir: join(base, "locks"), clock: new TickClock(), load: { now: 10, cores: 8 }, flag };
}
const waitFor = (flag: string) => `while [ ! -e '${flag}' ]; do sleep 0.02; done`;
const codeDir = (w: World, code = CODE, project = PROJECT) => join(w.stateDir, "trainboard", project, code);

/** Writes a step's frozen spec where the guard freezes it; `check` and `spec` replace keys of the run check and of the spec. */
function step(w: World, id: number, check: Record<string, unknown> = {}, spec: Record<string, unknown> = {}, over: Record<string, unknown> = {}, code = CODE): string {
	const dir = codeDir(w, code);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `step-${id}.json`);
	writeFileSync(file, JSON.stringify(sb({ train: code, name: "unit", ...over }, { check: { type: "run", cwd: w.work, run: "true", log: join(w.work, `step-${id}.log`), ...check }, ...spec })));
	return file;
}

interface Gate { done: Promise<number>; lines: Record<string, any>[]; raw: string[]; leave: (signal: string) => void }
function start(w: World, file: string, over: Partial<GateDeps> = {}): Gate {
	const g: Gate = { done: undefined as never, lines: [], raw: [], leave: () => {} };
	const deps: GateDeps = {
		env: process.env, out: (line) => (g.raw.push(line), g.lines.push(JSON.parse(line))), clock: w.clock, load: () => w.load, startOf, alive: () => true,
		signals: (leave) => (g.leave = leave), platform: process.platform, home: w.base, pid: process.pid, lockDir: () => w.lockDir, ...over,
	};
	g.done = runGate(file, deps);
	g.done.catch(() => {}); // a test that has gone on to clean up does not leave an unhandled rejection
	cleanup.push(() => g.leave("SIGTERM"));
	return g;
}
const last = (g: Gate) => g.lines.at(-1)!;
const kinds = (g: Gate) => g.lines.map((l) => l.sb.state);
const touch = (file: string) => writeFileSync(file, "");
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

// ---- the line format

test("a gate waits on load, prints a waiting line each 30 s, runs when the load falls, and ends with one outcome line", async () => {
	const w = world();
	w.load = { now: 42, cores: 8 };
	const file = step(w, 4, { run: `echo hello; ${waitFor(w.flag)}; echo done` }, { load: { max: 30, weight: 4 } }, { kind: "full-check" });
	const g = start(w, file);
	await until(() => g.lines.length === 1, "the first waiting line");
	assert.equal(g.lines[0]!.progress.message, "waiting: load <=30 (now 42)");
	assert.deepEqual(g.lines[0]!.progress.load, { max: 30, now: 42 });
	const { spec, run, ...first } = g.lines[0]!.sb as Record<string, unknown>;
	assert.deepEqual(first, { v: 1, train: CODE, step: 4, kind: "full-check", state: "waiting", since: "2026-11-07T08:00:00.000Z", waits: [{ load: { max: 30, now: 42 } }] });
	assert.match(String(spec), /^[0-9a-f]{64}$/, "every line names the step file it read");
	assert.match(String(run), /^[0-9a-f]{32}$/, "and the run it belongs to");
	assert.equal(readGate(join(codeDir(w), "gate-4.json"))?.state, "waiting");
	await w.clock.advance(30_000);
	await until(() => g.lines.length === 2, "the second waiting line");
	assert.equal(last(g).progress.message, "waiting: load <=30 (now 42)");
	w.load = { now: 18, cores: 8 };
	await w.clock.advance(30_000);
	await until(() => kinds(g).includes("running"), "the running line");
	assert.equal(last(g).progress.message, "running 0s: unit (load 18)");
	assert.equal(last(g).sb.since, "2026-11-07T08:01:00.000Z");
	await until(() => /hello/.test(readFileSync(join(w.work, "step-4.log"), "utf8")), "the command's output");
	await w.clock.advance(30_000);
	await until(() => last(g).progress.message.startsWith("running 30s"), "the next beat");
	assert.equal(last(g).progress.message, "running 30s: unit (load 18)");
	assert.equal(last(g).sb.tail, "hello");
	touch(w.flag);
	assert.equal(await g.done, 0);
	const end = last(g);
	assert.deepEqual(end.monitorOutcome, { status: "passed", message: "exit 0 in 30s" });
	const { spec: endSpec, run: endRun, ...endRest } = end.sb as Record<string, unknown>;
	assert.deepEqual(endRest, { v: 1, train: CODE, step: 4, kind: "full-check", state: "passed", exit: 0 });
	assert.deepEqual([endSpec, endRun], [(g.lines[0]!.sb as Record<string, unknown>).spec, (g.lines[0]!.sb as Record<string, unknown>).run], "the end names the same file and run as the first line");
	assert.ok(g.lines.every((l) => (l.sb as Record<string, unknown> | undefined)?.run === endRun), "every line of a run carries its nonce");
	assert.equal(g.lines.filter((l) => l.monitorOutcome).length, 1, "one outcome line");
	assert.equal(readFileSync(join(w.work, "step-4.log"), "utf8"), "hello\ndone\n");
});

test("a line comes at least every 30 s while the command runs, each with progress.message, none over 1000 characters", async () => {
	const w = world();
	const file = step(w, 1, { run: `printf '\\033[31m'; head -c 5000 /dev/zero | tr '\\0' x; printf '\\033[0m\\n'; ${waitFor(w.flag)}` }, { load: { perCore: 2, weight: 1 } }, { name: "n".repeat(64) });
	const g = start(w, file);
	await until(() => kinds(g).includes("running"), "running");
	await until(() => { try { return readFileSync(join(w.work, "step-1.log"), "utf8").endsWith("\u001b[0m\n"); } catch { return false; } }, "the command's long line");
	const before = g.lines.length;
	for (let beat = 1; beat <= 4; beat++) {
		await w.clock.advance(30_000);
		await until(() => g.lines.length === before + beat, `beat ${beat}`);
		assert.equal(last(g).sb.state, "running");
		assert.equal(last(g).sb.tail, "x".repeat(200), "the tail is cut to 200 characters with the escapes gone");
	}
	touch(w.flag);
	await g.done;
	assert.equal(g.lines.length, 6, "running, four beats, the outcome");
	for (const [i, line] of g.lines.entries()) {
		assert.equal(typeof line.progress?.message, "string", `line ${i} carries progress.message`);
		assert.ok(line.progress.message.length > 0);
		assert.ok(g.raw[i]!.length <= 1000, `line ${i} is ${g.raw[i]!.length} characters`);
		assert.ok(!g.raw[i]!.includes("\n"), "one object per line");
	}
});

test("fit keeps a line within 1000 characters by giving up the tail, then the waits, then the message", () => {
	const line = (tail: string, waits: unknown[], message = "waiting") => ({ progress: { message }, sb: { v: 1, state: "running", tail, ...(waits.length ? { waits } : {}) } });
	assert.equal(fit(line("a", [])).length < 1000, true);
	const long = fit(line("\"".repeat(900), []));
	assert.ok(long.length <= 1000, `${long.length}`);
	assert.ok(JSON.parse(long).progress.message);
	const waits = Array.from({ length: 30 }, (_, i) => ({ lane: { app: `app-${i}`, holder: "2026-11-07-a" } }));
	const noWaits = fit(line("t".repeat(10), waits));
	assert.ok(noWaits.length <= 1000);
	assert.ok(JSON.parse(noWaits).progress.message);
	const huge = fit({ monitorOutcome: { status: "failed", message: "m".repeat(5000) }, progress: { message: "m".repeat(5000) }, sb: { v: 1, state: "failed" } });
	assert.ok(huge.length <= 1000);
	assert.equal(JSON.parse(huge).monitorOutcome.status, "failed");
});

test("cleanTail reads the last line of a log as a person would", () => {
	assert.equal(cleanTail("first\nsecond\n\n"), "second");
	assert.equal(cleanTail("\u001b[32m✓ 1204 tests\u001b[0m\n"), "✓ 1204 tests");
	assert.equal(cleanTail("progress 10%\rprogress 55%\rprogress 100%\n"), "progress 100%");
	assert.equal(cleanTail("a\u0007\u0000b\t\tc"), "a b c");
	assert.equal(cleanTail("\u001b]0;title\u0007done"), "done");
	assert.equal(cleanTail("z".repeat(500)).length, 200);
	assert.equal(cleanTail(""), "");
});

// ---- exit codes

test("exit codes: 0 passed, 1 failed (a command's own exit, a signal, a command that cannot start), and the outcome line says which", async () => {
	const w = world();
	const ok = start(w, step(w, 1, { run: "exit 0" }));
	assert.equal(await ok.done, 0);
	assert.equal(last(ok).monitorOutcome.status, "passed");
	const bad = start(w, step(w, 2, { run: "echo oops >&2; exit 7" }));
	assert.equal(await bad.done, 1);
	assert.deepEqual(last(bad).monitorOutcome, { status: "failed", message: "exit 7 in 0s" });
	assert.equal(last(bad).sb.exit, 7);
	assert.equal(readFileSync(join(w.work, "step-2.log"), "utf8"), "oops\n", "stderr goes to the log too");
	const killed = start(w, step(w, 3, { run: "kill -9 $$" }));
	assert.equal(await killed.done, 1);
	assert.match(last(killed).monitorOutcome.message, /^killed by SIGKILL after 0s$/);
	const nowhere = start(w, step(w, 4, { cwd: join(w.work, "missing"), run: "true" }));
	assert.equal(await nowhere.done, 1);
	assert.match(last(nowhere).monitorOutcome.message, /^could not start the command: .*ENOENT/);
	assert.equal(readGate(join(codeDir(w), "gate-2.json"))?.state, "failed");
});

test("a spec that does not validate is refused with exit 3, and nothing runs", async () => {
	const w = world();
	const cases: [string, () => string, RegExp][] = [
		["a file that is not under a trainboard", () => { const f = join(w.base, "step-1.json"); writeFileSync(f, JSON.stringify(sb())); return f; }, /not in a trainboard folder/],
		["a file that is not a step file", () => { const f = join(codeDir(w), "x.json"); mkdirSync(codeDir(w), { recursive: true }); writeFileSync(f, "{}"); return f; }, /not a step file/],
		["a file that is not there", () => join(codeDir(w), "step-9.json"), /cannot read the step file/],
		["a file that is not JSON", () => { mkdirSync(codeDir(w), { recursive: true }); const f = join(codeDir(w), "step-5.json"); writeFileSync(f, "{nope"); return f; }, /cannot read the step file/],
		["a kind that is not one", () => step(w, 6, {}, {}, { kind: "e2e" }), /e2e/],
		["a check that is not a run", () => { const f = step(w, 7); const v = JSON.parse(readFileSync(f, "utf8")); v.spec.check = { type: "git", cwd: w.work, contains: [SHA_A] }; writeFileSync(f, JSON.stringify(v)); return f; }, /run check/],
		["a spec of another train", () => { const f = step(w, 8); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), train: "2026-11-06-z" })); return f; }, /train 2026-11-06-z is not the folder's/],
		["a spec of another project", () => { const f = step(w, 9); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), project: "other" })); return f; }, /project other is not the folder's/],
		["a spec over 16 KB", () => { const f = step(w, 10); writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), pad: "p".repeat(20_000) })); return f; }, /more than 16 KB/],
	];
	for (const [what, make, why] of cases) {
		const marker = join(w.work, "ran");
		rmSync(marker, { force: true });
		const g = start(w, make());
		assert.equal(await g.done, 3, what);
		assert.equal(g.lines.length, 1, what);
		assert.equal(last(g).monitorOutcome.status, "refused", what);
		assert.match(last(g).monitorOutcome.message, why, what);
		assert.match(last(g).progress.message, /^refused: /);
		assert.equal(last(g).sb.state, "refused");
		assert.equal(existsSync(marker), false);
	}
	// A load spec where there is no load average is a refusal, not a gate that never waits.
	const noLoad = start(w, step(w, 11, {}, { load: { max: 30 } }), { load: () => undefined });
	assert.equal(await noLoad.done, 3);
	assert.match(last(noLoad).monitorOutcome.message, /no load average/);
	const win = start(w, step(w, 12), { platform: "win32" });
	assert.equal(await win.done, 3);
	assert.match(last(win).monitorOutcome.message, /process groups/);
});

test("readSpec takes the state folder, project and code from the path and the step id from the file name", () => {
	const w = world();
	const file = step(w, 3);
	const read = readSpec(file);
	assert.ok(read.ok);
	if (!read.ok) return;
	assert.equal(read.frozen.stateDir, w.stateDir);
	assert.deepEqual([read.frozen.project, read.frozen.code, read.frozen.id], [PROJECT, CODE, 3]);
	assert.equal(read.frozen.hash, createHash("sha256").update(readFileSync(file)).digest("hex"));
});

// ---- verify, expect, poll

const counting = (w: World, outputs: string) => {
	const count = join(w.work, "count");
	return `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${count}'; case $n in ${outputs}; esac`;
};
const tries = (w: World) => { try { return Number(readFileSync(join(w.work, "count"), "utf8")); } catch { return 0; } };
/** The n-th try of a step's verify has ended and the wrapper has read its output (it removes `verify-<id>.out` and goes straight to its next sleep), so the clock can be moved without racing it. */
const tried = (w: World, n: number, id = 1) => tries(w) === n && !existsSync(join(codeDir(w), `verify-${id}.out`));

test("verify and expect: the last stdout line of verify must equal expect once run exited 0", async () => {
	const w = world();
	const same = start(w, step(w, 1, { run: "true", verify: "echo noise; echo ' v1.2.3 '", expect: "v1.2.3" }));
	assert.equal(await same.done, 0);
	assert.match(last(same).monitorOutcome.message, /verified "v1\.2\.3"/);
	const other = start(w, step(w, 2, { run: "true", verify: "echo v1.2.2", expect: "v1.2.3" }));
	assert.equal(await other.done, 1);
	assert.equal(last(other).monitorOutcome.message, 'verify printed "v1.2.2", expected "v1.2.3"');
	const code = start(w, step(w, 3, { run: "true", verify: "echo v1.2.3; exit 4", expect: "v1.2.3" }));
	assert.equal(await code.done, 1);
	assert.equal(last(code).monitorOutcome.message, "verify exited 4");
	const bare = start(w, step(w, 4, { run: "true", verify: "true" }));
	assert.equal(await bare.done, 0, "verify without expect passes on exit 0");
	const skipped = start(w, step(w, 5, { run: "exit 2", verify: "touch verify-ran", expect: "x" }));
	assert.equal(await skipped.done, 1);
	assert.equal(existsSync(join(w.work, "verify-ran")), false, "verify runs only after run exited 0");
});

test("poll: verify runs again every everySec until expect is printed, and the poll beats every 30 s", async () => {
	const w = world();
	const file = step(w, 1, { run: "true", verify: counting(w, "1|2) echo running;; *) echo success"), expect: "success", poll: { everySec: 60, forMin: 10 } }, {}, { kind: "ci", name: "pipeline" });
	const g = start(w, file);
	await until(() => tried(w, 1), "the first try");
	const before = g.lines.length;
	await w.clock.advance(30_000);
	await until(() => g.lines.length === before + 1, "a beat between tries");
	assert.equal(last(g).sb.state, "verifying");
	assert.equal(tries(w), 1, "not yet");
	await w.clock.advance(30_000);
	await until(() => tried(w, 2), "the second try");
	await w.clock.advance(60_000);
	assert.equal(await g.done, 0);
	assert.equal(tries(w), 3);
	assert.match(last(g).monitorOutcome.message, /verified "success"/);
});

test("poll: a pipeline that concludes failed fails the step at once, a line that merely mentions the word does not", async () => {
	const w = world();
	const g = start(w, step(w, 1, { run: "true", verify: counting(w, "1) echo running;; *) echo Failed"), expect: "success", poll: { everySec: 60, forMin: 600 } }));
	await until(() => tried(w, 1), "the first try");
	await w.clock.advance(60_000);
	assert.equal(await g.done, 1);
	assert.equal(tries(w), 2);
	assert.match(last(g).monitorOutcome.message, /the pipeline concluded "Failed"/);
	const w2 = world();
	const talky = start(w2, step(w2, 1, { run: "true", verify: counting(w2, "1) echo 'the failed job was retried';; *) echo success"), expect: "success", poll: { everySec: 60, forMin: 600 } }));
	await until(() => tried(w2, 1), "the first try");
	await w2.clock.advance(60_000);
	assert.equal(await talky.done, 0, "free text is not read for the words");
	for (const word of ["failure", "error", "cancelled", "canceled", "timed_out", "aborted", "skipped"]) {
		const w3 = world();
		const g3 = start(w3, step(w3, 1, { run: "true", verify: `echo ${word}`, expect: "success", poll: { everySec: 60, forMin: 600 } }));
		assert.equal(await g3.done, 1, word);
	}
});

test("poll: a verify that never prints expect fails when the minutes run out, and without poll it is tried once", async () => {
	const w = world();
	const g = start(w, step(w, 1, { run: "true", verify: counting(w, "*) echo running"), expect: "success", poll: { everySec: 60, forMin: 2 } }));
	await until(() => tried(w, 1), "try 1");
	await w.clock.advance(60_000);
	await until(() => tried(w, 2), "try 2");
	await w.clock.advance(60_000);
	assert.equal(await g.done, 1);
	assert.equal(tries(w), 3, "tries at 0, 60 and 120 s");
	assert.match(last(g).monitorOutcome.message, /^verify printed "running", expected "success"; still not after 2m of polling$/);
	const once = world();
	const g2 = start(once, step(once, 1, { run: "true", verify: counting(once, "*) echo running"), expect: "success" }));
	assert.equal(await g2.done, 1);
	assert.equal(tries(once), 1);
	// A verify that fails to run is tried again inside a poll, not at once.
	const flaky = world();
	const g3 = start(flaky, step(flaky, 1, { run: "true", verify: counting(flaky, "1) exit 1;; *) echo success"), expect: "success", poll: { everySec: 60, forMin: 5 } }));
	await until(() => tried(flaky, 1), "flaky try 1");
	await flaky.clock.advance(60_000);
	assert.equal(await g3.done, 0);
});

// ---- the lock

const dead = () => { const p = spawnSync("true"); return p.pid!; };

test("a lock is taken by one holder; another sees who holds it; only the holder's own release frees it", () => {
	const w = world();
	const a = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 });
	assert.ok(a.ok);
	assert.equal(statSync(join(w.lockDir, "heavy.lock")).mode & 0o777, 0o600);
	const b = takeLock(w.lockDir, "heavy", { train: "2026-11-07-a", step: 2 });
	assert.equal(b.ok, false);
	if (b.ok || !a.ok) return;
	assert.equal(b.why, "held");
	assert.deepEqual([b.holder?.train, b.holder?.step, b.holder?.pid], [CODE, 1, process.pid]);
	assert.equal(holderOf(w.lockDir, "heavy")?.step, 1);
	assert.deepEqual(heldLocks(w.lockDir).map((l) => l.name), ["heavy"]);
	// A release by a holder whose body is not on disk any more removes nothing (the lock is another's now).
	writeFileSync(join(w.lockDir, "heavy.lock"), JSON.stringify({ train: "x", step: 9, pid: process.pid, since: new Date().toISOString() }));
	a.release();
	assert.equal(holderOf(w.lockDir, "heavy")?.step, 9);
	rmSync(join(w.lockDir, "heavy.lock"));
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
	assert.equal(readdirSync(w.lockDir).length, 0, "no temp files are left");
});

test("lock names are 1 to 32 of a-z, 0-9, -", () => {
	const w = world();
	for (const name of ["../x", "Heavy", "a b", "", "x".repeat(33), "a/b", "a.b"]) assert.throws(() => takeLock(w.lockDir, name, { train: CODE, step: 1 }), /lock name/, JSON.stringify(name));
	assert.ok(takeLock(w.lockDir, "x".repeat(32), { train: CODE, step: 1 }).ok);
	assert.throws(() => holderOf(w.lockDir, "../x"), /lock name/);
});

test("a dead holder loses the lock at the next look: its pid is gone, or the pid answers to another start time", () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const body = (pid: number, started?: string) => JSON.stringify({ train: "2026-11-05-a", step: 3, pid, ...(started ? { started } : {}), since: "2026-11-05T00:00:00.000Z" });
	// pid gone
	writeFileSync(join(w.lockDir, "heavy.lock"), body(dead(), "Sat Nov  7 08:00:00 2026"));
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
	const taken = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 });
	assert.ok(taken.ok);
	assert.equal(JSON.parse(readFileSync(join(w.lockDir, "heavy.lock"), "utf8")).train, CODE);
	taken.ok && taken.release();
	// pid reused: it answers, to a start time that is not the holder's
	writeFileSync(join(w.lockDir, "heavy.lock"), body(process.pid, "Thu Jan  1 00:00:00 1970"));
	assert.equal(holderAlive({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970" }), false);
	assert.ok(takeLock(w.lockDir, "heavy", { train: CODE, step: 2 }).ok);
	// the same process with its own start time keeps it
	const mine = startOf(process.pid);
	assert.ok(mine);
	writeFileSync(join(w.lockDir, "other.lock"), body(process.pid, mine));
	const held = takeLock(w.lockDir, "other", { train: CODE, step: 4 });
	assert.equal(held.ok, false);
	// a start time that cannot be read for a live pid is not a reason to take its lock
	assert.equal(holderAlive({ pid: process.pid, started: "x" }, { startOf: () => undefined }), true);
	// injected liveness
	assert.equal(holderAlive({ pid: 1234 }, { alive: () => false }), false);
});

test("a takeover reads the lock back and is not the holder when the body is not its own", () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock"), rival = JSON.stringify({ train: "2026-11-07-a", step: 7, pid: process.pid, since: new Date().toISOString() });
	writeFileSync(file, JSON.stringify({ train: "dead", step: 1, pid: dead(), since: "2026-11-05T00:00:00.000Z" }));
	const lost = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 }, { afterReplace: () => writeFileSync(file, rival) });
	assert.equal(lost.ok, false);
	assert.equal(!lost.ok && lost.why, "held");
	assert.equal(!lost.ok && lost.holder?.step, 7);
	assert.equal(readFileSync(file, "utf8"), rival, "the rival's lock is not removed");
});

test("a lock body that cannot be read is waited for while fresh and taken once it is old; a looker's marker is respected until it is old", () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock");
	writeFileSync(file, "{half");
	const fresh = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 });
	assert.deepEqual([fresh.ok, !fresh.ok && fresh.why], [false, "unreadable"]);
	const old = new Date(Date.now() - 60_000);
	utimesSync(file, old, old);
	// a marker of a looker that is at work: back off
	writeFileSync(`${file}.looking.1`, "");
	const busy = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 });
	assert.deepEqual([busy.ok, !busy.ok && busy.why], [false, "looking"]);
	assert.equal(readFileSync(file, "utf8"), "{half", "the lock was not touched under another's marker");
	// a marker a crashed looker left
	utimesSync(`${file}.looking.1`, old, old);
	const taken = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 });
	assert.ok(taken.ok);
	assert.deepEqual(markersOf(w.lockDir), [], "the marker is gone");
	assert.equal(readdirSync(w.lockDir).filter((n) => n.endsWith(".tmp") || n.endsWith(".old")).length, 0);
});

const markersOf = (dir: string) => readdirSync(dir).filter((n) => /\.lock\.looking\.\d+$/.test(n)).sort();
function worker(base: Record<string, unknown>): { proc: ChildProcess; exit: Promise<number> } {
	const proc = spawn(process.execPath, [WORKER, JSON.stringify(base)], { stdio: ["ignore", "inherit", "pipe"] });
	cleanup.push(() => proc.kill("SIGKILL"));
	const exit = new Promise<number>((done) => {
		let stderr = "";
		proc.stderr!.on("data", (d) => (stderr += d));
		proc.once("exit", (code) => done((code !== 0 && console.error(stderr), code ?? -1)));
	});
	return { proc, exit };
}
function workers(w: World, count: number, base: Record<string, unknown>): { procs: ChildProcess[]; exits: Promise<number>[] } {
	const all = Array.from({ length: count }, (_, i) => worker({ ...base, id: i + 1 }));
	return { procs: all.map((x) => x.proc), exits: all.map((x) => x.exit) };
}

test("two lookers of the same dead holder do not both win: overlapping real processes, dead pids and reused pids, round after round", async () => {
	const w = world();
	const sync = join(w.base, "sync"), rounds = 8, count = 3;
	mkdirSync(sync, { recursive: true });
	mkdirSync(w.lockDir, { recursive: true });
	const { exits } = workers(w, count, { mode: "rounds", dir: w.lockDir, name: "heavy", sync, rounds });
	const lockFile = join(w.lockDir, "heavy.lock");
	for (let r = 1; r <= rounds; r++) {
		// odd rounds: the holder's pid is gone; even rounds: the pid is the test's own (alive), with another start time
		writeFileSync(lockFile, JSON.stringify(r % 2 ? { train: "dead", step: 1, pid: dead(), started: "Sat Nov  7 08:00:00 2026", since: "2026-11-07T08:00:00.000Z" } : { train: "reused", step: 1, pid: process.pid, started: "Thu Jan  1 00:00:00 1970", since: "2026-11-07T08:00:00.000Z" }));
		writeFileSync(`${lockFile}.looking.${r}`, JSON.stringify({ pid: dead(), started: "Sat Nov  7 08:00:01 2026" })); // a looker killed inside its takeover
		writeFileSync(join(sync, `go-${r}`), "");
		await until(() => readdirSync(sync).filter((n) => n.startsWith(`res-${r}-`)).length === count, `round ${r}'s answers`);
		const answers = Array.from({ length: count }, (_, i) => JSON.parse(readFileSync(join(sync, `res-${r}-${i + 1}`), "utf8")) as { ok: boolean; why?: string });
		const winners = answers.flatMap((a, i) => (a.ok ? [i + 1] : []));
		assert.equal(winners.length, 1, `round ${r}: exactly one winner, got ${JSON.stringify(answers)}`);
		const body = JSON.parse(readFileSync(lockFile, "utf8"));
		assert.equal(body.step, winners[0], "the lock is the winner's");
		for (const [i, a] of answers.entries()) if (!a.ok) assert.ok(["held", "looking"].includes(a.why!), `round ${r}, worker ${i + 1}: ${a.why}`);
		writeFileSync(join(sync, `rel-${r}`), "");
		await until(() => readdirSync(sync).filter((n) => n.startsWith(`fin-${r}-`)).length === count, `round ${r}'s end`);
		assert.equal(existsSync(lockFile), false, "the winner released it");
		assert.deepEqual(markersOf(w.lockDir), [], `round ${r}: no marker is left, the crashed looker's included`);
	}
	assert.deepEqual(await Promise.all(exits), [0, 0, 0]);
});

test("a lock keeps three real processes out of each other's critical region", async () => {
	const w = world();
	const sync = join(w.base, "sync2");
	mkdirSync(sync, { recursive: true });
	const { exits } = workers(w, 3, { mode: "contend", dir: w.lockDir, name: "heavy", sync, times: 25 });
	assert.deepEqual(await Promise.all(exits), [0, 0, 0]);
	assert.equal(existsSync(join(sync, "violations")), false, existsSync(join(sync, "violations")) ? readFileSync(join(sync, "violations"), "utf8") : "");
	assert.equal(readFileSync(join(sync, "entries"), "utf8").trim().split("\n").length, 75);
});

test("writerAlive: the pid answers and the process is not one that started after the writer did", () => {
	const mine = startMs(startOf(process.pid)!);
	const iso = (ms: number) => new Date(ms).toISOString();
	assert.equal(writerAlive({ session: "s", pid: process.pid, started: iso(mine) }), true);
	assert.equal(writerAlive({ session: "s", pid: process.pid, started: iso(mine + 60_000) }), true, "a session that said it started later is the same process");
	assert.equal(writerAlive({ session: "s", pid: process.pid, started: iso(mine - 3_600_000) }), false, "a process that started after the writer is a reused pid");
	assert.equal(writerAlive({ session: "s", pid: dead(), started: iso(mine) }), false);
	assert.equal(writerAlive({ session: "s", pid: process.pid, started: iso(mine - 3_600_000) }, () => undefined), true, "a start time that cannot be told is not held against the writer");
});

// ---- the lock across the command, and a signal

test("the lock is held in the wrapper from before the command until after it, and a second step with the same lock waits and then runs", async () => {
	const w = world();
	const first = start(w, step(w, 1, { run: `echo one > '${join(w.work, "one")}'; ${waitFor(w.flag)}` }, { lock: "heavy" }));
	await until(() => existsSync(join(w.work, "one")), "the first command");
	const holder = holderOf(w.lockDir, "heavy");
	assert.deepEqual([holder?.train, holder?.step, holder?.pid], [CODE, 1, process.pid]);
	assert.ok(holder?.started, "the start time is recorded");
	const ran = join(w.work, "two-ran");
	const second = start(w, step(w, 2, { run: `touch '${ran}'` }, { lock: "heavy" }), { signals: () => {} });
	await until(() => second.lines.length === 1, "the second step's waiting line");
	assert.equal(last(second).progress.message, `waiting: lock heavy (held by ${CODE} #1)`);
	assert.deepEqual(last(second).sb.waits, [{ lock: { name: "heavy", holder: { train: CODE, step: 1 } } }]);
	assert.equal(readGate(join(codeDir(w), "gate-2.json"))?.holder, CODE);
	await w.clock.advance(30_000);
	await until(() => second.lines.length === 2, "another waiting line");
	assert.equal(existsSync(ran), false, "the second command does not run while the first holds the lock");
	touch(w.flag);
	assert.equal(await first.done, 0);
	assert.equal(holderOf(w.lockDir, "heavy"), undefined, "free when the outcome line is out");
	await w.clock.advance(30_000);
	assert.equal(await second.done, 0);
	assert.equal(existsSync(ran), true);
	assert.equal(heldLocks(w.lockDir).length, 0);
});

test("the lock is free when the outcome line is out, whether the command passed, failed or was stopped", async () => {
	const w = world();
	const seen: unknown[] = [];
	const out = (line: string) => { if (JSON.parse(line).monitorOutcome) seen.push(holderOf(w.lockDir, "heavy")); };
	assert.equal(await start(w, step(w, 1, { run: "true" }, { lock: "heavy" }), { out }).done, 0);
	assert.equal(await start(w, step(w, 2, { run: "exit 3" }, { lock: "heavy" }), { out }).done, 1);
	const stopped = start(w, step(w, 3, { run: waitFor(w.flag) }, { lock: "heavy" }), { out });
	await until(() => holderOf(w.lockDir, "heavy")?.step === 3, "the third step's lock");
	stopped.leave("SIGTERM");
	assert.equal(await stopped.done, 143);
	assert.deepEqual(seen, [undefined, undefined, undefined]);
});

test("a step waits on load and on a lock together, in that order", async () => {
	const w = world();
	const first = start(w, step(w, 1, { run: waitFor(w.flag) }, { lock: "heavy" }));
	await until(() => holderOf(w.lockDir, "heavy")?.step === 1, "the first step's lock");
	const second = start(w, step(w, 2, { run: "true" }, { lock: "heavy", load: { max: 5 } }));
	await until(() => second.lines.length === 1, "the second step's waiting line");
	assert.equal(last(second).progress.message, `waiting: load <=5 (now 10); lock heavy (held by ${CODE} #1)`);
	assert.deepEqual(last(second).sb.waits, [{ load: { max: 5, now: 10 } }, { lock: { name: "heavy", holder: { train: CODE, step: 1 } } }]);
	touch(w.flag);
	await first.done;
	second.leave("SIGTERM");
	assert.equal(await second.done, 143);
});

test("a dead holder's lock does not stop a gate", async () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	writeFileSync(join(w.lockDir, "heavy.lock"), JSON.stringify({ train: "2026-11-05-a", step: 1, pid: dead(), started: "Sat Nov  7 08:00:00 2026", since: "2026-11-05T00:00:00.000Z" }));
	const g = start(w, step(w, 1, { run: "true" }, { lock: "heavy" }));
	assert.equal(await g.done, 0);
	assert.equal(kinds(g).includes("waiting"), false);
});

test("SIGTERM ends the command's process group, releases the lock, and says stopped with exit 143", async () => {
	const w = world();
	const pids = join(w.work, "pids");
	const g = start(w, step(w, 1, { run: `sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }));
	cleanup.push(() => { try { for (const p of readFileSync(pids, "utf8").trim().split(" ")) process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } });
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" "), "the command's pids");
	const [shell, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
	assert.equal(holderOf(w.lockDir, "heavy")?.step, 1);
	g.leave("SIGTERM");
	assert.equal(await g.done, 143);
	assert.equal(last(g).monitorOutcome.status, "stopped");
	assert.match(last(g).monitorOutcome.message, /stopped by SIGTERM/);
	assert.equal(last(g).sb.state, "stopped");
	await until(() => gone(shell) && gone(sleeper), "the group to be gone");
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
	assert.equal(readGate(join(codeDir(w), "gate-1.json"))?.state, "stopped");
});

test("a command that ignores SIGTERM gets SIGKILL after the 4 s grace, and the lock is held until then", async () => {
	const w = world();
	const pids = join(w.work, "pids");
	const g = start(w, step(w, 1, { run: `trap '' TERM; sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }));
	cleanup.push(() => { try { for (const p of readFileSync(pids, "utf8").trim().split(" ")) process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } });
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" "), "the command's pids");
	const [shell, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
	g.leave("SIGTERM");
	await turn();
	await w.clock.advance(3_000);
	await new Promise((done) => setTimeout(done, 100));
	assert.equal(gone(shell) || gone(sleeper), false, "both still run after 3 s");
	assert.equal(holderOf(w.lockDir, "heavy")?.step, 1, "the lock is held while the group lives");
	assert.equal(last(g).sb.state, "running");
	await w.clock.advance(1_500);
	await until(() => last(g).monitorOutcome, "the stopped line");
	assert.equal(await g.done, 143);
	assert.ok(GRACE_MS + KILL_WAIT_MS < 5000, "the whole stop fits inside MonitorStop's SIGTERM-to-SIGKILL 5 s");
	await until(() => gone(shell) && gone(sleeper), "the group to be killed");
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
});

test("SIGTERM while waiting stops the gate without running anything", async () => {
	const w = world();
	w.load = { now: 99, cores: 8 };
	const ran = join(w.work, "ran");
	const g = start(w, step(w, 1, { run: `touch '${ran}'` }, { load: { max: 30 } }));
	await until(() => g.lines.length === 1, "waiting");
	g.leave("SIGTERM");
	assert.equal(await g.done, 143);
	assert.match(last(g).monitorOutcome.message, /stopped by SIGTERM while waiting/);
	assert.equal(existsSync(ran), false);
});

test("SIGTERM during a poll ends the gate without another try", async () => {
	const w = world();
	const g = start(w, step(w, 1, { run: "echo built", verify: counting(w, "*) echo running"), expect: "success", poll: { everySec: 120, forMin: 60 } }));
	await until(() => tried(w, 1), "the first try");
	await w.clock.advance(30_000);
	await until(() => last(g).sb.state === "verifying" && last(g).sb.tail === "built", "a verifying beat with the tail of the log");
	g.leave("SIGTERM");
	assert.equal(await g.done, 143, JSON.stringify(last(g)));
	assert.match(last(g).monitorOutcome.message, /stopped by SIGTERM while polling/);
	assert.equal(tries(w), 1);
});

// ---- lane, target and the gate file

const board = (code: string, over: Partial<Board> = {}): Board => ({
	v: 1, project: PROJECT, app: "web", code, writer: { session: "sess-train-0", pid: process.pid, started: new Date(startMs(startOf(process.pid)!)).toISOString() }, updated: "2026-11-07T07:59:00.000Z", round: 1,
	cars: [{ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "none" }],
	steps: [{ id: 1, kind: "merge", name: "merge", status: "in_progress", round: 1, holds: { lane: "web" } }, { id: 2, kind: "deploy", name: "deploy", status: "pending", round: 1, holds: { target: "target-a" } }],
	...over,
});

test("a step that declares a lane waits for an earlier train that holds it, and runs when that train has completed its steps", async () => {
	const w = world();
	writeBoard(w.stateDir, board("2026-11-05-a"));
	const g = start(w, step(w, 1, { run: "true" }, { holds: { lane: "web" } }), { alive: () => true });
	await until(() => g.lines.length === 1, "the lane wait");
	assert.equal(last(g).progress.message, "waiting: lane web (held by 2026-11-05-a)");
	assert.deepEqual(last(g).sb.waits, [{ lane: { app: "web", holder: "2026-11-05-a" } }]);
	assert.equal(readGate(join(codeDir(w), "gate-1.json"))?.holder, "2026-11-05-a");
	await w.clock.advance(30_000);
	await until(() => g.lines.length === 2, "still waiting");
	const earlier = board("2026-11-05-a");
	writeBoard(w.stateDir, { ...earlier, steps: earlier.steps.map((s) => (s.holds?.lane ? { ...s, status: "completed" as const, outcome: "passed" as const } : s)) });
	await w.clock.advance(30_000);
	assert.equal(await g.done, 0);
});

test("a step that declares a target waits for an earlier train's target, and a train that departed later never blocks", async () => {
	const w = world();
	writeBoard(w.stateDir, board("2026-11-05-a", { steps: [{ id: 1, kind: "deploy", name: "deploy", status: "in_progress", round: 1, holds: { target: "target-a" } }] }));
	writeBoard(w.stateDir, board("2026-11-09-a", { steps: [{ id: 1, kind: "deploy", name: "deploy", status: "in_progress", round: 1, holds: { target: "target-b" } }] }));
	const wait = start(w, step(w, 1, { run: "true" }, { holds: { target: "target-a" } }), { alive: () => true });
	await until(() => wait.lines.length === 1, "the target wait");
	assert.equal(last(wait).progress.message, "waiting: target target-a (held by 2026-11-05-a)");
	wait.leave("SIGTERM");
	await wait.done;
	const free = start(w, step(w, 2, { run: "true" }, { holds: { target: "target-b" } }), { alive: () => true });
	assert.equal(await free.done, 0, "the later train's hold is not waited for");
});

test("a stale train keeps its lane and an unreadable board holds the project: the wait says why", async () => {
	const w = world();
	writeBoard(w.stateDir, board("2026-11-05-a", { updated: "2026-11-07T07:00:00.000Z" }));
	const stale = start(w, step(w, 1, { run: "true" }, { holds: { lane: "web" } }), { alive: () => false });
	await until(() => stale.lines.length === 1, "stale wait");
	assert.equal(last(stale).progress.message, "waiting: lane web (held by 2026-11-05-a, stale)");
	stale.leave("SIGTERM");
	await stale.done;
	const w2 = world();
	mkdirSync(codeDir(w2, "2026-11-04-a"), { recursive: true });
	writeFileSync(join(codeDir(w2, "2026-11-04-a"), "board.json"), "{not json");
	const bad = start(w2, step(w2, 1, { run: "true" }, { holds: { lane: "web" } }));
	await until(() => bad.lines.length === 1, "unreadable wait");
	assert.equal(last(bad).progress.message, "waiting: lane web (held by 2026-11-04-a, unreadable)");
	bad.leave("SIGTERM");
	await bad.done;
});

test("the gate file records state, since, load, the holder it waits on, pid, start time and the spec's hash, privately, on every line", async () => {
	const w = world();
	w.load = { now: 42.34, cores: 8 };
	writeBoard(w.stateDir, board("2026-11-05-a"));
	const file = step(w, 1, { run: `${waitFor(w.flag)}` }, { load: { perCore: 2 }, holds: { lane: "web" } });
	const g = start(w, file, { alive: () => true });
	await until(() => g.lines.length === 1, "waiting");
	const gate = join(codeDir(w), "gate-1.json");
	assert.equal(statSync(gate).mode & 0o777, 0o600);
	const waiting = readGate(gate)!;
	assert.deepEqual(waiting.load, { max: 16, now: 42.3, cores: 8 });
	assert.equal(waiting.holder, "2026-11-05-a");
	assert.equal(waiting.state, "waiting");
	assert.equal(waiting.since, "2026-11-07T08:00:00.000Z");
	assert.equal(waiting.pid, process.pid);
	assert.equal(waiting.started, startOf(process.pid));
	assert.equal(waiting.spec, createHash("sha256").update(readFileSync(file)).digest("hex"));
	assert.equal(waiting.train, CODE);
	assert.equal(waiting.step, 1);
	assert.deepEqual(waiting.waits, [{ load: { max: 16, now: 42.3 } }, { lane: { app: "web", holder: "2026-11-05-a" } }]);
	g.leave("SIGTERM");
	await g.done;
	assert.equal(readGate(gate)!.state, "stopped");
	assert.equal(readGate(join(codeDir(w), "missing.json")), undefined);
	writeFileSync(gate, "{}");
	assert.equal(readGate(gate), undefined);
	assert.equal(readdirSync(codeDir(w)).filter((n) => n.endsWith(".tmp")).length, 0);
});

// ---- real processes: two overlapping gates, a signal, a kill

function cliGate(env: NodeJS.ProcessEnv, file: string) {
	const proc = spawn(process.execPath, [CLI, "train", "gate", "--spec", file], { env, stdio: ["ignore", "pipe", "pipe"] });
	cleanup.push(() => proc.kill("SIGTERM"));
	const lines: Record<string, any>[] = [];
	let buffer = "", stderr = "";
	proc.stdout.on("data", (d) => {
		buffer += d;
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) (lines.push(JSON.parse(buffer.slice(0, i))), (buffer = buffer.slice(i + 1)));
	});
	proc.stderr.on("data", (d) => (stderr += d));
	const exit = new Promise<number>((done) => proc.once("exit", (code, signal) => done(code ?? 128 + (signal === "SIGKILL" ? 9 : 15))));
	return { proc, lines, exit, stderr: () => stderr };
}

test("two overlapping gate processes: the second waits on the lock the first holds, never runs meanwhile, and both end by signal or exit code", async () => {
	const w = world();
	const lockFile = join(lockDirOf(w.stateDir), "heavy.lock");
	const ran = join(w.work, "second-ran");
	const a = cliGate(process.env, step(w, 1, { run: `echo $$ > '${join(w.work, "a.pid")}'; ${waitFor(w.flag)}` }, { lock: "heavy" }));
	await until(() => a.lines.some((l) => l.sb.state === "running") && existsSync(lockFile), "the first gate's lock");
	assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).pid, a.proc.pid, "the lock is held by the wrapper process itself");
	const b = cliGate(process.env, step(w, 2, { run: `touch '${ran}'` }, { lock: "heavy" }));
	await until(() => b.lines.length >= 1, `the second gate's first line (${b.stderr()})`);
	assert.equal(b.lines[0]!.progress.message, `waiting: lock heavy (held by ${CODE} #1)`);
	assert.equal(existsSync(ran), false);
	touch(w.flag);
	assert.equal(await a.exit, 0);
	assert.equal(a.lines.at(-1)!.monitorOutcome.status, "passed");
	assert.equal(existsSync(lockFile), false, "released at the end");
	assert.equal(existsSync(ran), false, "the second still waits for its next look");
	b.proc.kill("SIGTERM");
	assert.equal(await b.exit, 143);
	assert.equal(b.lines.at(-1)!.monitorOutcome.status, "stopped");
	assert.equal(existsSync(ran), false);
});

test("SIGTERM to a gate process kills the command's group, frees the lock and exits 143; a gate that is killed outright loses its lock to the next one", async () => {
	const w = world();
	const lockFile = join(lockDirOf(w.stateDir), "heavy.lock");
	const pids = join(w.work, "pids");
	const a = cliGate(process.env, step(w, 1, { run: `sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }));
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" ") && existsSync(lockFile), `the command (${a.stderr()})`);
	const [shell, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
	a.proc.kill("SIGTERM");
	assert.equal(await a.exit, 143, a.stderr());
	assert.equal(a.lines.at(-1)!.monitorOutcome.status, "stopped");
	await until(() => gone(shell) && gone(sleeper), "the group to be gone");
	assert.equal(existsSync(lockFile), false);
	// killed outright: nothing releases the lock, and the next look finds its holder dead
	const killedPids = join(w.work, "pids2");
	const b = cliGate(process.env, step(w, 2, { run: `sleep 300 & echo "$$ $!" > '${killedPids}'; wait` }, { lock: "heavy" }));
	cleanup.push(() => { try { for (const p of readFileSync(killedPids, "utf8").trim().split(" ")) process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } });
	await until(() => existsSync(killedPids) && readFileSync(killedPids, "utf8").includes(" ") && existsSync(lockFile), `the second command (${b.stderr()})`);
	b.proc.kill("SIGKILL");
	await b.exit;
	assert.equal(existsSync(lockFile), true, "a killed wrapper leaves its lock file");
	assert.equal(holderOf(lockDirOf(w.stateDir), "heavy"), undefined, "but it has no live holder");
	const c = start(w, step(w, 3, { run: "true" }, { lock: "heavy" }), { lockDir: () => lockDirOf(w.stateDir) });
	assert.equal(await c.done, 0);
	assert.equal(kinds(c).includes("waiting"), false);
});

// ---- the cli

test("cli: train needs a command and its flags; unknown ones are usage errors (exit 2)", async () => {
	const out: string[] = [], err: string[] = [];
	const go = (...argv: string[]) => run(argv, { out: (t) => out.push(t), err: (t) => err.push(t), stateDir: join(ROOT, "cli-state") });
	assert.equal(await go("train"), 2);
	assert.equal(await go("train", "fly"), 2);
	assert.equal(await go("train", "fly", "--spec", "x"), 2);
	assert.equal(await go("train", "gate"), 2);
	assert.equal(await go("train", "status", "--wat"), 2);
	assert.equal(await go("train", "notices", "--wat"), 2);
	assert.equal(await go("train", "check"), 2);
	assert.equal(await go("train", "check", "--step", "a", "--accept", "b"), 2);
	assert.equal(await go("train", "check", "--step", "a", "--slip", "b"), 2);
	assert.equal(await go("train", "clear", "--project", "p"), 2);
	assert.equal(await go("train", "clear", "--project", "p", "--train", CODE, "--lane", "a", "--target", "b", "--reason", "r"), 2);
	assert.match(err.join(""), /train gate --spec/);
	assert.match(err.join(""), /train needs gate, check, status, clear or notices/);
});

test("cli: train gate runs the wrapper and returns its exit code", async () => {
	const w = world();
	const lines: string[] = [];
	const code = await run(["train", "gate", "--spec", step(w, 1, { run: "exit 5" })], { out: (t) => lines.push(t), err: () => {}, train: { gate: { clock: w.clock, lockDir: () => w.lockDir, alive: () => true, signals: () => {} } } });
	assert.equal(code, 1);
	assert.equal(JSON.parse(lines.at(-1)!).monitorOutcome.status, "failed");
	assert.ok(lines.every((l) => l.endsWith("\n") && l.length <= 1001));
});

// ---- check

/** `train check` in `w.base`, which holds an apps.json naming app `web` with an integration that requires no acceptance (0.77.3: a named app is checked against the project's file, and with none found it is refused as unchecked), unless `apps` is false. */
function checkIo(w: World, apps = true) {
	if (apps) (mkdirSync(join(w.base, ".straw-boss"), { recursive: true }), writeFileSync(join(w.base, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: ".", integration: { base: "develop" } }] })));
	const out: string[] = [], err: string[] = [];
	const go = async (...argv: string[]) => {
		out.length = 0;
		const code = await run(["train", "check", ...argv], { out: (t) => out.push(t), err: (t) => err.push(t), stateDir: w.stateDir, train: { cwd: w.base, exists: () => true, isAncestor: () => true } });
		return { code, result: out.length ? (JSON.parse(out.join("")) as { ok: boolean; refusals: string[] }) : undefined, err: err.join("") };
	};
	return go;
}

test("train check --step validates a step's metadata.sb with the guard's validator and exits 2 on a refusal", async () => {
	const w = world();
	const go = checkIo(w);
	const good = join(w.base, "good.json"), wrapped = join(w.base, "wrapped.json"), uat = join(w.base, "uat.json");
	writeFileSync(good, JSON.stringify(sb()));
	writeFileSync(wrapped, JSON.stringify({ sb: sb() }));
	writeFileSync(uat, JSON.stringify(sb({ kind: "uat" })));
	assert.deepEqual((await go("--step", good)), { code: 0, result: { ok: true, refusals: [] }, err: "" });
	assert.equal((await go("--step", wrapped)).code, 0, "a todo's metadata is read too");
	const refused = await go("--step", uat);
	assert.equal(refused.code, 2);
	assert.equal(refused.result?.ok, false);
	assert.match(refused.result!.refusals.join(" "), /uat/i);
	assert.match(refused.result!.refusals.join(" "), /acceptance/);
	const missing = await go("--step", join(w.base, "nope.json"));
	assert.equal(missing.code, 2);
	assert.match(missing.result!.refusals[0]!, /cannot read --step/);
	writeFileSync(join(w.base, "bad.json"), "{");
	assert.match((await go("--step", join(w.base, "bad.json"))).result!.refusals[0]!, /not JSON/);
});

test("train check --accept validates acceptance evidence, with --app-accept and --slip", async () => {
	const w = world();
	const go = checkIo(w);
	const file = join(w.base, "accept.json");
	writeFileSync(file, JSON.stringify(evidence()));
	assert.deepEqual((await go("--accept", file, "--app-accept", "e2e")).result, { ok: true, refusals: [] });
	const lacking = await go("--accept", file, "--app-accept", "e2e,uat");
	assert.equal(lacking.code, 2);
	assert.match(lacking.result!.refusals.join(" "), /lacks a uat entry/);
	assert.match((await go("--accept", file, "--app-accept", "Bad Kind")).result!.refusals[0]!, /integration\.accept/);
	writeFileSync(join(w.base, "slip.txt"), slip({ accept: file }));
	assert.equal((await go("--accept", file, "--app-accept", "e2e", "--slip", join(w.base, "slip.txt"))).code, 0);
	writeFileSync(join(w.base, "uatslip.txt"), slip({ accept: file, uat: "pending" }));
	const asked = await go("--accept", file, "--slip", join(w.base, "uatslip.txt"));
	assert.equal(asked.code, 2);
	assert.match(asked.result!.refusals.join(" "), /acceptance/);
	writeFileSync(file, JSON.stringify(evidence({}, { result: "pending" })));
	assert.equal((await go("--accept", file)).code, 2);
	// the default checks run against the real folder and git: a path that is not there is refused
	const out: string[] = [];
	writeFileSync(file, JSON.stringify(evidence({}, { evidence: join(w.base, "no-such-log") })));
	assert.equal(await run(["train", "check", "--accept", file], { out: (t) => out.push(t), err: () => {}, stateDir: w.stateDir, train: { cwd: w.base } }), 2);
	assert.match(out.join(""), /does not exist/);
});

test("TP-F003: train check --accept none means no evidence: the slip is checked against the app's integration.accept, with or without --slip", async () => {
	const w = world();
	const go = checkIo(w);
	writeFileSync(join(w.base, "none-slip.txt"), slip({ accept: "none" }));
	writeFileSync(join(w.base, "file-slip.txt"), slip({ accept: join(w.base, "accept.json") }));
	assert.deepEqual((await go("--accept", "none", "--slip", join(w.base, "none-slip.txt"))).result, { ok: true, refusals: [] }, "no evidence and the app asks for none");
	assert.deepEqual((await go("--accept", "none", "--app", "web")).result, { ok: true, refusals: [] }, "no slip: only what the app requires is checked");
	const required = await go("--accept", "none", "--app-accept", "e2e", "--slip", join(w.base, "none-slip.txt"));
	assert.equal(required.code, 2);
	assert.match(required.result!.refusals.join(" "), /accept: none is allowed only for an app whose integration\.accept is empty \(this app requires e2e\)/);
	const bare = await go("--accept", "none", "--app", "web", "--app-accept", "e2e,uat");
	assert.equal(bare.code, 2);
	assert.match(bare.result!.refusals.join(" "), /requires e2e, uat/, "without a slip the refusal is the same");
	const named = await go("--accept", "none", "--slip", join(w.base, "file-slip.txt"));
	assert.equal(named.code, 2);
	assert.match(named.result!.refusals.join(" "), /names an evidence file, but it was not read/, "the slip names a file the check was not given");
	assert.ok(!named.result!.refusals.join(" ").includes("ENOENT"), "none is not a path");
});

test("TB-F001: train check reads what the app requires from apps.json, so --app-accept cannot weaken it; a folder without the file checks the flag alone, and an app it names is refused as unchecked", async () => {
	const w = world();
	const go = checkIo(w, false);
	const file = join(w.base, "accept.json");
	writeFileSync(file, JSON.stringify(evidence()));
	writeFileSync(join(w.base, "web-slip.txt"), slip({ accept: file }));
	writeFileSync(join(w.base, "none-slip.txt"), slip({ accept: "none" }));
	assert.match((await go("--accept", file)).result!.refusals.join(" "), /app web could not be checked: no apps\.json at/, "no apps.json here: the evidence's car.app cannot be checked, which is no ok (0.77.3)");
	assert.equal((await go("--accept", "none")).code, 0, "no apps.json and no app named: the flag alone, and it asks for nothing");
	const apps = (integration: object) => (mkdirSync(join(w.base, ".straw-boss"), { recursive: true }), writeFileSync(join(w.base, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: ".", integration }] })));
	apps({ base: "develop", accept: ["e2e", "uat"] });
	const weak = await go("--accept", file, "--app-accept", "e2e", "--slip", join(w.base, "web-slip.txt"));
	assert.equal(weak.code, 2);
	assert.match(weak.result!.refusals.join(" "), /lacks a uat entry \(the app requires e2e, uat\)/, "the flag names less than the file, and the file wins");
	assert.match((await go("--accept", "none", "--slip", join(w.base, "none-slip.txt"))).result!.refusals.join(" "), /this app requires e2e, uat/);
	assert.match((await go("--accept", file, "--app", "web")).result!.refusals.join(" "), /lacks a uat entry/, "--app names the app without a slip; the evidence's own car.app does too");
	assert.match((await go("--accept", file)).result!.refusals.join(" "), /lacks a uat entry/);
	assert.match((await go("--accept", file, "--app", "api")).result!.refusals.join(" "), /has no app named api/);
	apps({ base: "develop", accept: ["e2e"] });
	assert.equal((await go("--accept", file, "--slip", join(w.base, "web-slip.txt"))).code, 0, "with every kind the file asks for");
	apps({ base: "develop", stages: ["merge", "uat"] });
	const old = await go("--accept", file, "--app", "web");
	assert.equal(old.code, 2);
	assert.match(old.result!.refusals.join(" "), /stages lists "uat".*Moving a project to 0\.65\.0/);
	writeFileSync(join(w.base, ".straw-boss", "apps.json"), "{");
	assert.match((await go("--accept", file)).result!.refusals.join(" "), /cannot be parsed/, "a file that exists and cannot be read refuses");
});

test("0.77.3 A1: train check in a linked worktree with no apps.json reads the main checkout's; with none anywhere a named app is refused as unchecked, never ok", async () => {
	const w = world();
	const main = join(w.base, "main"), wt = join(w.base, "wt"), gitdir = join(main, ".git", "worktrees", "wt");
	mkdirSync(gitdir, { recursive: true });
	mkdirSync(wt, { recursive: true });
	writeFileSync(join(gitdir, "commondir"), "../..\n");
	writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
	const file = join(w.base, "accept.json"), slipFile = join(w.base, "slip.txt");
	writeFileSync(file, JSON.stringify(evidence()));
	writeFileSync(slipFile, slip({ car: "no-such-app", accept: file }));
	const go = async (...argv: string[]) => {
		const out: string[] = [];
		const code = await run(["train", "check", ...argv], { out: (t) => out.push(t), err: () => {}, stateDir: w.stateDir, train: { cwd: wt, exists: () => true, isAncestor: () => true } });
		return { code, result: JSON.parse(out.join("")) as { ok: boolean; refusals: string[] } };
	};
	const none = await go("--accept", file, "--app-accept", "e2e", "--slip", slipFile);
	assert.equal(none.code, 2, "no apps.json in the worktree nor the main checkout: the app could not be checked, so not ok");
	assert.match(none.result.refusals.join(" "), /no-such-app could not be checked/);
	mkdirSync(join(main, ".claude", "straw-boss"), { recursive: true });
	writeFileSync(join(main, ".claude", "straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: ".", integration: { base: "develop", accept: ["e2e"] } }] }));
	const missing = await go("--accept", file, "--app-accept", "e2e", "--slip", slipFile);
	assert.equal(missing.code, 2);
	assert.match(missing.result.refusals.join(" "), /has no app named no-such-app/, "the main checkout's apps.json is read, as the tower reads it");
	writeFileSync(slipFile, slip({ car: "web", accept: file }));
	assert.deepEqual((await go("--accept", file, "--slip", slipFile)).result, { ok: true, refusals: [] });
});

// ---- status and clear

test("train status lists every train with its steps, waits and holders, the locks held and the load", async () => {
	const w = world();
	writeBoard(w.stateDir, board("2026-11-05-a"));
	writeBoard(w.stateDir, board(CODE, { writer: { session: "sess-train-1", pid: dead(), started: "2026-11-07T07:00:00.000Z" }, updated: "2026-11-07T07:00:00.000Z", steps: [{ id: 1, kind: "merge", name: "merge", status: "in_progress", round: 1, holds: { lane: "web" }, load: { max: 30 }, lock: "heavy" }] }));
	mkdirSync(codeDir(w, "2026-11-06-b"), { recursive: true });
	writeFileSync(join(codeDir(w, "2026-11-06-b"), "board.json"), "garbage");
	const taken = takeLock(lockDirOf(w.stateDir), "heavy", { train: "2026-11-05-a", step: 1 });
	assert.ok(taken.ok);
	const g = start(w, step(w, 1, { run: waitFor(w.flag) }, { lock: "heavy", load: { max: 30 }, holds: { lane: "web" } }), { alive: () => true });
	await until(() => g.lines.length === 1, "a gate file");
	g.leave("SIGTERM");
	await g.done;
	const now = () => Date.parse("2026-11-07T08:00:00Z");
	const status = trainStatus({ stateDir: w.stateDir, now, load: () => ({ now: 42, cores: 8 }) });
	assert.deepEqual(status.load, { now: 42, cores: 8 });
	assert.deepEqual(status.locks.map((l) => [l.name, l.train, l.step]), [["heavy", "2026-11-05-a", 1]]);
	assert.deepEqual(status.trains.map((t) => [t.code, t.state]), [["2026-11-05-a", "live"], ["2026-11-06-b", "unreadable"], [CODE, "stale"]]);
	const mine = status.trains.find((t) => t.code === CODE)!;
	assert.equal(mine.session?.live, false);
	assert.deepEqual(mine.holds, { lanes: ["web"], targets: [] });
	assert.deepEqual(mine.steps[0]!.waits.map((x) => Object.keys(x)[0]), ["load", "lock", "lane"]);
	assert.equal(mine.steps[0]!.gate?.state, "stopped");
	assert.match(status.trains.find((t) => t.code === "2026-11-06-b")!.reason!, /not JSON/);
	const out: string[] = [];
	assert.equal(await run(["train", "status", "--json", "--project", PROJECT], { out: (t) => out.push(t), err: () => {}, stateDir: w.stateDir, train: { now, load: () => ({ now: 42, cores: 8 }), alive: () => false } }), 0);
	assert.equal(JSON.parse(out.join("")).trains.length, 3);
	out.length = 0;
	assert.equal(await run(["train", "status", "--project", "nobody"], { out: (t) => out.push(t), err: () => {}, stateDir: w.stateDir, train: { now, load: () => undefined } }), 0);
	assert.match(out.join(""), /load unknown/);
	out.length = 0;
	await run(["train", "status"], { out: (t) => out.push(t), err: () => {}, stateDir: w.stateDir, train: { now, load: () => ({ now: 42, cores: 8 }), alive: () => false } });
	assert.match(out.join(""), new RegExp(`acme web ${CODE} stale session sess-train-1 gone round 1`));
	assert.match(out.join(""), /locks: heavy \(2026-11-05-a #1, pid \d+\)/);
	assert.match(out.join(""), /#1 merge merge: in_progress \[stopped: .*\] waits load/);
	taken.ok && taken.release();
});

test("train clear releases a stale train's lane in its board, refuses a live, recent, ended, unreadable or non-holding one, and does not touch `updated`", async () => {
	const w = world();
	const now = () => Date.parse("2026-11-07T08:00:00Z");
	const out: string[] = [], err: string[] = [];
	const go = (code: string, alive: boolean, ...rest: string[]) => run(["train", "clear", "--project", PROJECT, "--train", code, "--reason", "session crashed; target-a reads 1.2.3", ...rest], { out: (t) => out.push(t), err: (t) => err.push(t), stateDir: w.stateDir, train: { now, alive: () => alive, user: "tester" } });
	const stale = board(CODE, { writer: { session: "sess-train-1", pid: 4242, started: "2026-11-07T06:00:00.000Z" }, updated: "2026-11-07T07:00:00.000Z" });
	writeBoard(w.stateDir, stale);
	const holdsNow = (code: string) => {
		const read = readBoard(boardPath(w.stateDir, PROJECT, code));
		const facts = [factsOf({ project: PROJECT, code, file: "", ...read }, { now: now(), alive: () => false })];
		return holders(facts, { project: PROJECT, lane: "web", before: "2026-12-01-a" }).length > 0;
	};
	assert.equal(holdsNow(CODE), true);
	assert.equal(await go(CODE, true, "--lane", "web"), 1, "live");
	assert.match(err.join(""), /session is live/);
	assert.equal(await go(CODE, false, "--lane", "mobile"), 1);
	assert.match(err.join(""), /does not hold lane mobile/);
	assert.equal(await go(CODE, false, "--target", "target-a"), 1, "a target it does not hold yet");
	assert.equal(await go(CODE, false, "--lane", "web"), 0, err.join(""));
	const cleared = JSON.parse(out.join(""));
	assert.deepEqual([cleared.ok, cleared.train, cleared.lane], [true, CODE, "web"]);
	const after = readBoard(boardPath(w.stateDir, PROJECT, CODE));
	assert.ok(after.ok);
	if (after.ok) {
		assert.equal(after.board.updated, stale.updated, "updated stays, or the train would be live again");
		assert.deepEqual(after.board.clears, [{ lane: "web", reason: "session crashed; target-a reads 1.2.3", by: "cli train clear (tester)", at: "2026-11-07T08:00:00.000Z" }]);
	}
	assert.equal(holdsNow(CODE), false);
	assert.equal(await go(CODE, false, "--lane", "web"), 1, "twice");
	assert.match(err.join(""), /already cleared/);
	// recent: gone, but updated 5 minutes ago
	writeBoard(w.stateDir, board("2026-11-06-b", { updated: "2026-11-07T07:55:00.000Z" }));
	assert.equal(await go("2026-11-06-b", false, "--lane", "web"), 1);
	assert.match(err.join(""), /less than 10 minutes ago/);
	// ended: its land step completed
	writeBoard(w.stateDir, board("2026-11-06-c", { updated: "2026-11-07T01:00:00.000Z", steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] }));
	assert.equal(await go("2026-11-06-c", false, "--lane", "web"), 1);
	assert.match(err.join(""), /has ended/);
	// unreadable
	mkdirSync(codeDir(w, "2026-11-06-d"), { recursive: true });
	writeFileSync(join(codeDir(w, "2026-11-06-d"), "board.json"), "garbage");
	assert.equal(await go("2026-11-06-d", false, "--lane", "web"), 1);
	assert.match(err.join(""), /cannot be read/);
	// usage: a code that is no code, a missing reason
	assert.equal(await go("../x", false, "--lane", "web"), 2);
	assert.equal(await run(["train", "clear", "--project", PROJECT, "--train", CODE, "--lane", "web", "--reason", "  "], { out: () => {}, err: () => {}, stateDir: w.stateDir }), 2);
});

// ---- review fixes (todo #125 task 2, review G-F001 to G-F013)

test("G-F001: writerAlive reads the start time `ps` prints as UTC, whatever zone the process runs in", () => {
	const was = process.env.TZ;
	cleanup.push(() => (was === undefined ? delete process.env.TZ : (process.env.TZ = was)));
	const lstart = "Sat Nov  7 12:19:53 2026", at = "2026-11-07T12:19:53.000Z", threeHoursEarlier = "2026-11-07T09:19:53.000Z";
	for (const tz of ["America/New_York", "Asia/Taipei", "UTC"]) {
		process.env.TZ = tz;
		assert.equal(startMs(lstart), Date.parse(at), tz);
		assert.equal(startMs(at), Date.parse(at), `${tz}: the ISO text of Windows is its own instant`);
		assert.equal(writerAlive({ session: "s", pid: process.pid, started: at }, () => lstart), true, `${tz}: the live writer`);
		assert.equal(writerAlive({ session: "s", pid: process.pid, started: threeHoursEarlier }, () => lstart), false, `${tz}: a pid reused 3 h after the writer started`);
		assert.equal(writerAlive({ session: "s", pid: process.pid, started: at }, () => at), true, `${tz}: Windows text`);
	}
});

test("G-F002: a gate reads every board of its project, so a lane held by a train past the 64th board still holds", async () => {
	const w = world();
	for (let day = 1; day <= 7; day++) for (const letter of "abcdefghij") writeBoard(w.stateDir, board(`2026-10-0${day}-${letter}`, { steps: [{ id: 1, kind: "merge", name: "merge", status: "completed", round: 1, outcome: "passed", holds: { lane: "web" } }, { id: 2, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] }));
	writeBoard(w.stateDir, board("2026-11-05-a"));
	const g = start(w, step(w, 1, { run: "true" }, { holds: { lane: "web" } }), { alive: () => true });
	await until(() => g.lines.length === 1, "the first line");
	assert.equal(last(g).progress.message, "waiting: lane web (held by 2026-11-05-a)");
	g.leave("SIGTERM");
	await g.done;
});

test("G-F002: a read of the project's boards that was cut holds everything: the gate refuses and says why", async () => {
	const w = world();
	for (const letter of "abcdef") writeBoard(w.stateDir, board(`2026-11-01-${letter}`, { steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] }));
	const g = start(w, step(w, 1, { run: "true" }), { alive: () => true, maxBoards: 5 });
	assert.equal(await g.done, 3);
	assert.match(last(g).monitorOutcome.message, /^refused: .*more than 5 trainboards/);
});

test("G-F002: train status shows the newest 64 trains, not the oldest, and says it cut", () => {
	const w = world();
	for (let day = 1; day <= 6; day++) for (const letter of "abcdefghijk") writeBoard(w.stateDir, board(`2026-10-${String(day).padStart(2, "0")}-${letter}`));
	const status = trainStatus({ stateDir: w.stateDir, now: () => Date.parse("2026-11-07T08:00:00Z"), alive: () => true, load: () => undefined });
	assert.equal(status.trains.length, 64);
	assert.equal(status.truncated, true);
	assert.equal(status.trains.at(-1)!.code, "2026-10-06-k");
	assert.equal(status.trains[0]!.code, "2026-10-01-c", "66 trains: the two oldest are cut");
});

const deadHolder = (pid = dead()) => JSON.stringify({ train: "2026-11-05-a", step: 3, pid, started: "Sat Nov  7 08:00:00 2026", since: "2026-11-05T00:00:00.000Z" });
const liveBody = () => JSON.stringify({ pid: process.pid, started: startOf(process.pid) });
const longAgo = () => new Date(Date.now() - 60_000);

test("G-F003: a live looker's marker is never robbed by age, a dead looker's marker goes at once", () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock"), marker = `${file}.looking.1`;
	writeFileSync(file, deadHolder());
	writeFileSync(marker, liveBody());
	utimesSync(marker, longAgo(), longAgo());
	let made = false;
	const stalled = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 }, { beforeMarker: () => (made = true) });
	assert.deepEqual([stalled.ok, !stalled.ok && stalled.why], [false, "looking"], "a looker that is alive keeps its marker however long it takes");
	assert.equal(made, false, "a marker that is visibly busy makes a looker back off before it makes one of its own");
	assert.equal(readFileSync(marker, "utf8"), liveBody());
	assert.equal(JSON.parse(readFileSync(file, "utf8")).train, "2026-11-05-a", "the lock was not touched");
	writeFileSync(marker, JSON.stringify({ pid: dead(), started: "Sat Nov  7 08:00:00 2026" }));
	const taken = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 });
	assert.ok(taken.ok, "the marker of a dead looker does not wait for its age");
	assert.deepEqual(markersOf(w.lockDir), []);
	// a pid reused by another process is not the looker either
	taken.ok && taken.release();
	writeFileSync(file, deadHolder());
	writeFileSync(marker, JSON.stringify({ pid: process.pid, started: "Thu Jan  1 00:00:00 1970" }));
	assert.ok(takeLock(w.lockDir, "heavy", { train: CODE, step: 2 }).ok);
});

test("G-F003: a looker that stalls in a takeover is not robbed, however long: two real processes never both hold", async () => {
	const w = world();
	const sync = join(w.base, "sync-stall");
	mkdirSync(sync, { recursive: true });
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock");
	writeFileSync(file, deadHolder());
	const { exit } = worker({ mode: "stall", at: "replace", dir: w.lockDir, name: "heavy", sync, id: 1 });
	await until(() => existsSync(join(sync, "in-1")), "the looker to stand inside its takeover");
	const [marker] = markersOf(w.lockDir);
	assert.ok(marker, "it holds a marker");
	utimesSync(join(w.lockDir, marker), longAgo(), longAgo()); // it has stood there for a minute
	const rival = takeLock(w.lockDir, "heavy", { train: CODE, step: 9 });
	assert.deepEqual([rival.ok, !rival.ok && rival.why], [false, "looking"], "the second looker backs off");
	rival.ok && rival.release();
	writeFileSync(join(sync, "go-1"), "");
	await until(() => existsSync(join(sync, "res-1")), "the stalled looker's answer");
	assert.equal(JSON.parse(readFileSync(join(sync, "res-1"), "utf8")).ok, true);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).step, 1, "the lock is the stalled looker's, taken once");
	assert.deepEqual(markersOf(w.lockDir), [], "its marker went when it left the takeover");
	writeFileSync(join(sync, "rel-1"), "");
	assert.equal(await exit, 0);
});

test("RR-F002: a looker that judged a dead marker and stands still while another takes over never makes a second holder, and no marker is put back or left", () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock");
	writeFileSync(file, deadHolder());
	writeFileSync(`${file}.looking.1`, JSON.stringify({ pid: dead(), started: "Sat Nov  7 08:00:00 2026" })); // a looker killed inside its takeover
	const got: Record<string, ReturnType<typeof takeLock>> = {};
	got.B = takeLock(w.lockDir, "heavy", { train: CODE, step: 2 }, {
		// B has read the markers and found the only one dead; while it stands still, A takes the lock, and C looks while A is inside.
		beforeMarker: () => {
			got.A = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 }, { beforeReplace: () => { got.C = takeLock(w.lockDir, "heavy", { train: CODE, step: 3 }); } });
		},
	});
	assert.equal(got.A!.ok, true);
	assert.deepEqual([got.C!.ok, !got.C!.ok && got.C!.why], [false, "looking"], "C finds A's marker, alive");
	assert.equal(got.B!.ok, false, "B's view was stale: the lock it judged dead is A's now");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).step, 1);
	assert.deepEqual(readdirSync(w.lockDir).sort(), ["heavy.lock"], "no marker is left: A's went with A, the crashed looker's with A's takeover");
});

test("RR-F002: a looker whose view of the markers went stale backs off when it finds a live marker after making its own, and takes its own away", () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock"), crashed = `${file}.looking.1`;
	writeFileSync(file, deadHolder());
	writeFileSync(crashed, JSON.stringify({ pid: dead(), started: "Sat Nov  7 08:00:00 2026" }));
	// Y has read one dead marker and stands still. Meanwhile a looker (here the test, as this process) stands in a takeover of the same, unchanged lock, under a marker with another number than the one Y will make.
	const y = takeLock(w.lockDir, "heavy", { train: CODE, step: 2 }, {
		beforeMarker: () => {
			unlinkSync(crashed);
			writeFileSync(crashed, liveBody());
		},
	});
	assert.deepEqual([y.ok, !y.ok && y.why], [false, "looking"]);
	assert.equal(readFileSync(crashed, "utf8"), liveBody(), "the live looker's marker is untouched");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).step, 3, "the lock is untouched");
	assert.deepEqual(readdirSync(w.lockDir).sort(), ["heavy.lock", "heavy.lock.looking.1"], "Y's own marker is gone");
});

test("RR-F002: three real lookers, a crashed looker's marker and a dead holder: one holder; the stale looker and the late one back off; no marker is left", async () => {
	const w = world();
	const sync = join(w.base, "sync-three");
	mkdirSync(sync, { recursive: true });
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock");
	writeFileSync(file, deadHolder());
	writeFileSync(`${file}.looking.1`, JSON.stringify({ pid: dead(), started: "Sat Nov  7 08:00:01 2026" }));
	const base = { mode: "stall", dir: w.lockDir, name: "heavy", sync };
	const b = worker({ ...base, id: 2, at: "marker" }); // judges the crashed marker dead, then stands still
	await until(() => existsSync(join(sync, "in-2")), "B to stand still");
	const a = worker({ ...base, id: 1, at: "replace" }); // takes over and stands still inside it
	await until(() => existsSync(join(sync, "in-1")), "A to stand inside its takeover");
	const c = worker({ ...base, id: 3, at: "none" });
	await until(() => existsSync(join(sync, "res-3")), "C's answer");
	assert.deepEqual(JSON.parse(readFileSync(join(sync, "res-3"), "utf8")), { ok: false, why: "looking" });
	writeFileSync(join(sync, "go-2"), ""); // B goes on with its old view
	await until(() => existsSync(join(sync, "res-2")), "B's answer");
	assert.deepEqual(JSON.parse(readFileSync(join(sync, "res-2"), "utf8")), { ok: false, why: "looking" });
	writeFileSync(join(sync, "go-1"), "");
	await until(() => existsSync(join(sync, "res-1")), "A's answer");
	assert.deepEqual(JSON.parse(readFileSync(join(sync, "res-1"), "utf8")), { ok: true });
	assert.equal(JSON.parse(readFileSync(file, "utf8")).step, 1, "the lock is A's, and only A's");
	assert.deepEqual(markersOf(w.lockDir), [], "nothing is left of the takeover");
	writeFileSync(join(sync, "rel-1"), "");
	assert.deepEqual(await Promise.all([a.exit, b.exit, c.exit]), [0, 0, 0]);
});

test("RR-F002: a marker is never written without the looker's start time: a looker that cannot tell its own waits", () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const file = join(w.lockDir, "heavy.lock");
	writeFileSync(file, deadHolder());
	const blind = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 }, { startOf: () => undefined });
	assert.deepEqual([blind.ok, !blind.ok && blind.why], [false, "looking"]);
	assert.deepEqual(readdirSync(w.lockDir), ["heavy.lock"], "no marker was written");
	assert.equal(JSON.parse(readFileSync(file, "utf8")).step, 3, "the lock was not touched");
	// A looker that was told its start time by the caller writes it into the marker.
	let body = "";
	const told = takeLock(w.lockDir, "heavy", { train: CODE, step: 1, started: "Sat Nov  7 09:00:00 2026" }, { startOf: () => undefined, beforeReplace: () => { body = readFileSync(join(w.lockDir, markersOf(w.lockDir)[0]!), "utf8"); } });
	assert.ok(told.ok);
	assert.deepEqual(JSON.parse(body), { pid: process.pid, started: "Sat Nov  7 09:00:00 2026" });
});

test("G-F004: a gate-file write error while the command runs ends the command's group, frees the lock after it, and still prints the outcome line", async () => {
	const w = world();
	const pids = join(w.work, "pids");
	const g = start(w, step(w, 1, { run: `sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }));
	cleanup.push(() => { try { for (const p of readFileSync(pids, "utf8").trim().split(" ")) process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } });
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" ") && holderOf(w.lockDir, "heavy"), "the command under its lock");
	const [shell, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
	chmodSync(codeDir(w), 0o500);
	cleanup.push(() => chmodSync(codeDir(w), 0o700));
	await w.clock.advance(30_000); // the beat's gate file cannot be written
	await until(() => last(g).monitorOutcome, "the outcome line");
	assert.equal(await g.done, 1);
	assert.equal(last(g).monitorOutcome.status, "failed");
	assert.match(last(g).monitorOutcome.message, /^the wrapper failed: .*gate-1\.json/);
	await until(() => gone(shell) && gone(sleeper), "the command's group to be gone");
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
});

test("G-F005: a verify try that hangs is ended when the poll's time is up: its group is killed, the step fails, the lock is free", async () => {
	const w = world();
	const pids = join(w.work, "vpids");
	const g = start(w, step(w, 1, { run: "true", verify: `sleep 300 & echo "$$ $!" > '${pids}'; wait`, expect: "success", poll: { everySec: 10, forMin: 1 } }, { lock: "heavy" }));
	cleanup.push(() => { try { for (const p of readFileSync(pids, "utf8").trim().split(" ")) process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } });
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" "), "the hung verify");
	const [shell, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
	await w.clock.advance(60_000);
	assert.equal(last(g).sb.state, "verifying", "inside the minute it is still tried");
	await w.clock.advance(10_000); // the try's own 10 s of grace
	await until(() => last(g).monitorOutcome, "the outcome line");
	assert.equal(await g.done, 1);
	assert.match(last(g).monitorOutcome.message, /^verify was still running after .+ of polling; its group was ended$/);
	await until(() => gone(shell) && gone(sleeper), "the hung verify's group to be gone");
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
});

test("G-F007: a gate does not take a lock before it can tell its own start time", async () => {
	const w = world();
	let blind = true;
	const g = start(w, step(w, 1, { run: waitFor(w.flag) }, { lock: "heavy" }), { startOf: (pid) => (blind && pid === process.pid ? undefined : startOf(pid)) });
	await until(() => g.lines.length === 1, "the first line");
	assert.match(last(g).progress.message, /^waiting: .*start time/);
	assert.equal(existsSync(join(w.lockDir, "heavy.lock")), false, "no lock without a start time");
	blind = false;
	await w.clock.advance(30_000);
	await until(() => holderOf(w.lockDir, "heavy"), "the lock");
	assert.equal(holderOf(w.lockDir, "heavy")!.started, startOf(process.pid));
	assert.equal(readGate(join(codeDir(w), "gate-1.json"))?.started, startOf(process.pid));
	touch(w.flag);
	assert.equal(await g.done, 0);
});

test("G-F008: temp names do not collide with what a killed process of the same pid left behind", async () => {
	const w = world();
	mkdirSync(w.lockDir, { recursive: true });
	const lockFile = join(w.lockDir, "heavy.lock");
	for (let n = 0; n < 3000; n++) writeFileSync(`${lockFile}.${process.pid}.${n}.tmp`, "");
	const taken = takeLock(w.lockDir, "heavy", { train: CODE, step: 1 });
	assert.ok(taken.ok);
	taken.ok && taken.release();
	// the marker of a takeover too
	for (let n = 0; n < 3000; n++) writeFileSync(`${lockFile}.looking.${process.pid}.${n}.tmp`, "");
	writeFileSync(lockFile, deadHolder());
	const over = takeLock(w.lockDir, "heavy", { train: CODE, step: 2 });
	assert.ok(over.ok, "a takeover");
	over.ok && over.release();
	const file = step(w, 1, { run: "true" });
	for (let n = 0; n < 3000; n++) writeFileSync(join(codeDir(w), `gate-1.json.${process.pid}.${n}.tmp`), "");
	const g = start(w, file);
	assert.equal(await g.done, 0, JSON.stringify(last(g)));
});

test("G-F009: fit ends on a tail of characters outside the BMP", () => {
	const url = new URL("../src/server/traingate.ts", import.meta.url).href;
	const code = `import(${JSON.stringify(url)}).then(({ fit }) => { const t = fit({ progress: { message: "running 1m: unit" }, sb: { v: 1, state: "running", tail: "\\u{1F600}".repeat(600) } }); process.exit(t.length <= 1000 ? 0 : 2); });`;
	const r = spawnSync(process.execPath, ["-e", code], { timeout: 20_000, env: process.env });
	assert.equal(r.status, 0, `${r.status} ${r.signal} ${String(r.stderr)}`);
});

test("G-F010: lastBytes reads the end of a file only", () => {
	const w = world();
	const big = join(w.work, "big"), small = join(w.work, "small");
	writeFileSync(big, `${"x\n".repeat(50_000)}one\nsuccess\n`);
	writeFileSync(small, "ok\n");
	const end = lastBytes(big, 16384);
	assert.ok(end.length <= 16384 && end.length > 10_000);
	assert.equal(lastLine(end), "success");
	assert.equal(lastBytes(small, 16384), "ok\n");
	assert.equal(lastBytes(big, 4), "ess\n");
});

test("G-F011: a name that is an Object.prototype member is a usage error, not a crash", async () => {
	const go = (...argv: string[]) => run(argv, { out: () => {}, err: () => {}, stateDir: join(ROOT, "cli-state") });
	assert.equal(await go("train", "constructor", "--spec", "x"), 2);
	assert.equal(await go("train", "toString"), 2);
	assert.equal(await go("constructor", "--x"), 2);
	assert.equal(await go("hasOwnProperty"), 2);
});

test("G-F012: a step file that is a symlink is refused", () => {
	const w = world();
	const real = step(w, 9), dir = codeDir(w);
	renameSync(real, join(dir, "real.json"));
	symlinkSync(join(dir, "real.json"), join(dir, "step-9.json"));
	const read = readSpec(join(dir, "step-9.json"));
	assert.equal(read.ok, false);
	assert.match(!read.ok ? read.refusals.join(" ") : "", /not a regular file|cannot read/);
});

// ---- re-review fixes (todo #125 task 2, round 2: RR-F001 to RR-F006, G-F013)

const eperm = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });
const killAtCleanup = (pids: string) => cleanup.push(() => { try { for (const p of readFileSync(pids, "utf8").trim().split(" ")) process.kill(Number(p), "SIGKILL"); } catch { /* gone */ } });
const pidsOf = (pids: string) => readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];

test("RR-F001: a stop while the group holds only a dead leader nobody has reaped (macOS answers EPERM to every signal) ends stopped, exit 143, lock free", async () => {
	const w = world();
	const pids = join(w.work, "pids");
	let zombie = false;
	// The real SIGTERM ends the group; from then on the kernel answers EPERM, as it does for a group whose leader is dead and not yet waited for.
	const kill = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => {
		if (zombie) throw eperm();
		process.kill(pid, signal);
		if (signal === "SIGTERM") zombie = true;
	};
	const g = start(w, step(w, 1, { run: `sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }), { kill });
	killAtCleanup(pids);
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" ") && holderOf(w.lockDir, "heavy"), "the command under its lock");
	g.leave("SIGTERM");
	// The fake clock is not moved: a group that answers EPERM is gone, so the stop does not wait for the grace.
	await until(() => last(g).monitorOutcome, "the stopped line", 5000);
	assert.equal(await g.done, 143, JSON.stringify(last(g)));
	assert.equal(last(g).monitorOutcome.status, "stopped");
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
});

test("RR-F001: a verify that hangs past its poll, with the group answering EPERM after SIGTERM, still ends `verify was still running`", async () => {
	const w = world();
	const pids = join(w.work, "vpids");
	let zombie = false;
	const kill = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => {
		if (zombie) throw eperm();
		process.kill(pid, signal);
		if (signal === "SIGTERM") zombie = true;
	};
	const g = start(w, step(w, 1, { run: "true", verify: `sleep 300 & echo "$$ $!" > '${pids}'; wait`, expect: "success", poll: { everySec: 10, forMin: 1 } }, { lock: "heavy" }), { kill });
	killAtCleanup(pids);
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" "), "the hung verify");
	await w.clock.advance(70_000);
	await until(() => last(g).monitorOutcome, "the outcome line", 5000);
	assert.equal(await g.done, 1, JSON.stringify(last(g)));
	assert.match(last(g).monitorOutcome.message, /^verify was still running after .+ of polling; its group was ended$/);
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
});

test("RR-F001: an EPERM that answers the signal itself is not a failure either", async () => {
	const w = world();
	const pids = join(w.work, "pids");
	const kill = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => {
		process.kill(pid, signal);
		if (signal === "SIGTERM") throw eperm();
	};
	const g = start(w, step(w, 1, { run: `sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }), { kill });
	killAtCleanup(pids);
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" ") && holderOf(w.lockDir, "heavy"), "the command under its lock");
	g.leave("SIGTERM");
	// The group is gone after the signal, whose answer was an error: the stop does not wait for the grace either.
	await until(() => last(g).monitorOutcome, "the stopped line", 5000);
	assert.equal(await g.done, 143, JSON.stringify(last(g)));
	assert.equal(last(g).monitorOutcome.status, "stopped");
});

test("RR-F003: train status without --project keeps the newest 64 of every project, not those of the last projects by name", () => {
	const w = world();
	const ended = [{ id: 1, kind: "land" as const, name: "land", status: "completed" as const, round: 1, outcome: "passed" as const }];
	for (let day = 1; day <= 8; day++) for (const letter of "abcdefgh") writeBoard(w.stateDir, board(`2026-10-0${day}-${letter}`, { project: "zzz", steps: ended }));
	writeBoard(w.stateDir, board("2026-11-07-a", { project: "aaa" }));
	const status = trainStatus({ stateDir: w.stateDir, now: () => Date.parse("2026-11-07T08:00:00Z"), alive: () => true, load: () => undefined });
	assert.equal(status.trains.length, 64);
	assert.equal(status.truncated, true);
	assert.deepEqual([status.trains[0]!.project, status.trains[0]!.code], ["aaa", "2026-11-07-a"], "the live train of an earlier-named project is shown");
	assert.equal(status.trains.some((t) => t.project === "zzz" && t.code === "2026-10-01-a"), false, "the oldest of the 65 is the one cut");
	const keys = status.trains.map((t) => [t.project, t.code]);
	assert.deepEqual(keys, [...keys].sort((x, y) => (x[0]! === y[0]! ? x[1]!.localeCompare(y[1]!) : x[0]!.localeCompare(y[0]!))), "listed by project, then code");
});

test("RR-F004: a project folder that cannot be listed is reported, and the gate refuses instead of running beside a train it did not see", async () => {
	const w = world();
	writeBoard(w.stateDir, board("2026-11-05-a"));
	const ran = join(w.work, "ran");
	const file = step(w, 1, { run: `touch '${ran}'` }, { holds: { lane: "web" } });
	const projectDir = join(w.stateDir, "trainboard", PROJECT);
	chmodSync(projectDir, 0o300); // it can be passed through, not listed
	cleanup.push(() => chmodSync(projectDir, 0o700));
	const read = readTrainboards(w.stateDir, { project: PROJECT });
	assert.equal(read.unlisted.length, 1);
	assert.match(read.unlisted[0]!, /EACCES/);
	assert.match(read.unlisted[0]!, new RegExp(PROJECT));
	assert.deepEqual(readTrainboards(w.stateDir, { project: "nobody" }).unlisted, [], "a project with no folder has no boards, which is not a failure");
	const g = start(w, file, { alive: () => true });
	assert.equal(await g.done, 3, JSON.stringify(last(g)));
	assert.match(last(g).monitorOutcome.message, /^refused: .*cannot list.*EACCES/);
	assert.equal(existsSync(ran), false, "the command did not run");
});

test("RR-F005: the refusal for too many trainboards names a remedy that lowers the count", async () => {
	const w = world();
	for (const letter of "abcdef") writeBoard(w.stateDir, board(`2026-11-01-${letter}`, { steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] }));
	const g = start(w, step(w, 1, { run: "true" }), { alive: () => true, maxBoards: 5 });
	assert.equal(await g.done, 3);
	const message: string = last(g).monitorOutcome.message;
	assert.match(message, /more than 5 trainboards/);
	assert.ok(message.includes(`remove the folders of ended trains under ${join(w.stateDir, "trainboard", PROJECT)}`), message);
	assert.doesNotMatch(message, /clear old trains/, "`train clear` only appends to a board; it removes nothing");
});

test("RR-F006: a stop of a command that ignores SIGTERM, on a real clock, ends inside MonitorStop's 5 s: SIGKILL at the grace, the line out, the lock free", async () => {
	const w = world();
	const pids = join(w.work, "pids");
	const real = { now: Date.now, sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)) };
	const g = start(w, step(w, 1, { run: `trap '' TERM; sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }), { clock: real });
	killAtCleanup(pids);
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" ") && holderOf(w.lockDir, "heavy"), "the command under its lock");
	const [shell, sleeper] = pidsOf(pids), stalls = stallWatch(), began = Date.now();
	g.leave("SIGTERM");
	assert.equal(await g.done, 143);
	const took = Date.now() - began;
	stalls.stop();
	assert.equal(last(g).monitorOutcome.status, "stopped");
	assert.ok(took >= 3900, `the command had its grace: ${took} ms`);
	assert.ok(took < 5000 - 500 + stalls.worst(), `from SIGTERM to the outcome line: ${took} ms (this process stood still for ${stalls.worst()} ms)`);
	assert.ok(gone(shell) && gone(sleeper), "the group is gone when the line is out");
	assert.equal(holderOf(w.lockDir, "heavy"), undefined);
});

test("RR-F006: when SIGKILL does not end the group, the stop waits 0.5 s more and no longer", async () => {
	const w = world();
	const pids = join(w.work, "pids");
	// No signal reaches the group; probes do.
	const kill = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => { if (signal === 0) process.kill(pid, 0); };
	const g = start(w, step(w, 1, { run: `sleep 300 & echo "$$ $!" > '${pids}'; wait` }, { lock: "heavy" }), { kill });
	killAtCleanup(pids);
	await until(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" ") && holderOf(w.lockDir, "heavy"), "the command under its lock");
	g.leave("SIGTERM");
	await turn();
	const stalls = stallWatch(), began = Date.now();
	await w.clock.advance(GRACE_MS);
	assert.equal(await g.done, 143);
	const took = Date.now() - began;
	stalls.stop();
	assert.ok(took >= KILL_WAIT_MS - 50, `it waited for the group: ${took} ms`);
	assert.ok(took < KILL_WAIT_MS + 250 + stalls.worst(), `and then no longer: ${took} ms (this process stood still for ${stalls.worst()} ms)`);
});

test("RR-F006: a step file that is a FIFO is refused without blocking", () => {
	const w = world();
	const dir = codeDir(w);
	mkdirSync(dir, { recursive: true });
	const fifo = join(dir, "step-3.json");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	// A read that opened it would block for ever: it runs in a process of its own, with a bound.
	const url = new URL("../src/server/traingate.ts", import.meta.url).href;
	const code = `import(${JSON.stringify(url)}).then(({ readSpec }) => { const r = readSpec(${JSON.stringify(fifo)}); console.log(JSON.stringify(r)); process.exit(0); });`;
	const r = spawnSync(process.execPath, ["-e", code], { timeout: 20_000, encoding: "utf8", env: process.env });
	assert.equal(r.status, 0, `${r.status} ${r.signal} ${r.stderr}`);
	const read = JSON.parse(r.stdout);
	assert.equal(read.ok, false);
	assert.match(read.refusals.join(" "), /not a regular file/);
});

test("G-F013 (D5): every slot of the computer uses one lock folder, the primary slot's: two slots contend for one name", () => {
	const w = world();
	const envA = { ...process.env, HERDR_SOCKET_PATH: join(w.base, "a.sock") }, envB = { ...process.env, HERDR_SOCKET_PATH: join(w.base, "b.sock") };
	const primary = { ...process.env, HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined };
	const slots = [envA, envB, primary].map((env) => slotOf(w.stateDir, env));
	assert.equal(new Set(slots.map((s) => s.dir)).size, 3, "three slot folders");
	const dirs = [envA, envB, primary].map((env) => gateDeps(env).lockDir(w.stateDir));
	assert.deepEqual(new Set(dirs).size, 1);
	assert.equal(dirs[0], lockDirOf(w.stateDir));
	assert.equal(dirs[0], join(slots[2]!.dir, "locks"), "the primary slot's folder");
	const a = takeLock(dirs[0]!, "heavy", { train: CODE, step: 1 });
	assert.ok(a.ok);
	const b = takeLock(dirs[1]!, "heavy", { train: "2026-11-07-a", step: 2 });
	assert.deepEqual([b.ok, !b.ok && b.why], [false, "held"]);
	const status = trainStatus({ stateDir: w.stateDir, now: () => Date.parse("2026-11-07T08:00:00Z"), alive: () => true, load: () => undefined });
	assert.deepEqual(status.locks.map((l) => l.name), ["heavy"], "status reads the same folder whichever slot asks");
	a.ok && a.release();
});
