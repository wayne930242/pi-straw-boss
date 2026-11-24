import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type CarView, coordinatorWord } from "../src/train/cars.ts";
import { serverCli } from "../src/server/version.ts";
import { acceptanceWord } from "../src/train/spec.ts";
import { boardPath, boardState, readBoard, validateBoard, writeBoard } from "../src/train/board.ts";
import { frozenText, gateCommand, specHash } from "../src/trainguard.ts";
import { cleanup, forwardEntry, git, MANIFEST_HEADER, type Reply, rig, type Rig, run, SESSION_ID, sha, slipBlock } from "./train-guard-rig.ts";
import { CODE, evidence, type Json, result, runCheck, SHA_A, SHA_B, SHA_C, sb } from "./train-fixtures.ts";

// The train's guard (docs/specs/2026-11-07-train-workers.md §7, §21; todo #125 task 4): what sb checks on a train's own tools. It reads `event.input` for policy and the session branch for state, blocks with the spec's words, rewrites
// a run step's MonitorCreate to the gate wrapper in place, and passes a step only on evidence that the model cannot write: the monitor's own stream, git, the disk, and the branch.

afterEach(cleanup);
const word = (car: string | undefined, what: string, where: string) => acceptanceWord({ ...(car === undefined ? {} : { car }), what, where });
const asRefusal = (reply: Reply) => (assert.equal(reply.ok, false, "the call was blocked"), reply.reason!);
const refused = async (promise: Promise<Reply>, pattern: RegExp | string) => {
	const reason = asRefusal(await promise);
	if (typeof pattern === "string") assert.ok(reason.startsWith(pattern) || reason.includes(pattern), `${reason}\n(wanted ${pattern})`);
	else assert.match(reason, pattern);
};
const check = (r: Rig, over: Json = {}) => ({ type: "git", cwd: r.cwd, contains: [SHA_A], ...over });

// ---- §7.1: every todo of a train is a step

test("a train's todo with no metadata.sb is refused with §7.1's word; a batch create names the item that has none; a read passes", async () => {
	const r = rig();
	await refused(r.todo({ action: "create", subject: "write the report" }), "sb: every todo of a train is a step: add metadata.sb (kinds: assemble, review, full-check, merge, ci, deploy, deploy-verify, rollback, land)");
	await refused(r.todo({ action: "create", subject: "x", metadata: { note: "no sb" } }), /every todo of a train is a step/);
	const batch = await r.todo({ action: "create", tasks: [{ subject: "ok", metadata: { sb: run(r) } }, { subject: "no sb" }] });
	assert.match(asRefusal(batch), /^sb: tasks\[1\]: every todo of a train is a step/);
	assert.equal(r.list.tasks.length, 0, "a blocked batch leaves the list as it was");
	assert.equal((await r.todo({ action: "list" })).ok, true);
	assert.equal((await r.todo({ action: "get", id: 1 })).ok, true);
	assert.equal((await r.create(run(r))).ok, true);
	await refused(r.todo({ action: "update", id: 1, status: "in_progress", metadata: { sb: null } }), /every todo of a train is a step/);
	assert.equal((await r.todo({ action: "update", id: 1, subject: "renamed" })).ok, true, "an update that leaves metadata alone passes");
});

test("a todo of kind `uat` or `e2e`, or a `run` named `accept`, is blocked with §5.4's word, and nothing is created", async () => {
	const r = rig();
	for (const kind of ["uat", "e2e", "UAT", "end-to-end"]) {
		const reason = asRefusal(await r.create(run(r, { kind })));
		assert.equal(reason, word(undefined, kind, "step kind"), kind);
	}
	assert.equal(asRefusal(await r.create(run(r, { name: "accept" }))), word(undefined, "accept", "step name"));
	assert.equal(asRefusal(await r.create(run(r, { name: "runE2E" }))), word(undefined, "runE2E", "step name"));
	const check = runCheck({ cwd: r.cwd, log: "/l" });
	assert.equal(asRefusal(await r.create(sb({}, { check: { ...check, type: "uat" } }))), word(undefined, "uat", "check type"));
	assert.equal(asRefusal(await r.create(sb({ kind: "uat", name: "accept" }, { check: { ...check, type: "page" } }))), word(undefined, "uat", "step kind"), "the kind is read first");
	assert.equal(r.list.tasks.length, 0, "no step, no wait, no page");
	const batch = await r.todo({ action: "create", tasks: [{ subject: "a", metadata: { sb: run(r) } }, { subject: "b", metadata: { sb: run(r, { kind: "e2e" }) } }] });
	assert.equal(asRefusal(batch), word(undefined, "e2e", "step kind").replace(/^sb: /, "sb: tasks[1]: "));
	// An update that turns a step into one is refused as well.
	assert.equal((await r.create(run(r))).ok, true);
	assert.equal(asRefusal(await r.update(1, "pending", { sb: run(r, { name: "acceptance" }) })), word(undefined, "acceptance", "step name"));
});

test("an unknown kind, a check type a train does not run, and a malformed common field are refused in §7.1's words", async () => {
	const r = rig();
	await refused(r.create(run(r, { kind: "answer" })), /^sb: kind "answer" is not a step kind \(assemble, review, full-check, merge, ci, deploy, deploy-verify, rollback, land\)$/);
	await refused(r.create(sb({}, { check: { type: "page", url: "x" } })), /^sb: check type "page" is not one a train runs \(run, git, report, notice\)$/);
	await refused(r.create(sb({}, { check: { type: "git", cwd: "/w" } })), "sb: a git check needs contains");
	await refused(r.create(sb({ v: 2 }, { check: runCheck() })), "sb: metadata.sb.v must be 1");
	await refused(r.create(run(r, { round: 0 })), /metadata\.sb\.round must be a whole number from 1|names train/);
	await refused(r.create(run(r, { name: "" })), /metadata\.sb\.name must be 1 to 64/);
	await refused(r.create({ ...run(r), extra: 1 }), "sb: metadata.sb.extra is not a field");
	assert.equal(r.list.tasks.length, 0);
});

test("a step names this train and its current round: another train, project, app or round is refused", async () => {
	const r = rig();
	await refused(r.create(run(r, { train: "2026-11-06-n" })), "sb: step #1 names train 2026-11-06-n, round 1; this train is 2026-11-06-m, round 1");
	await refused(r.create(run(r, { project: "other" })), "sb: step #1 names project other; this train's is acme");
	assert.equal((await r.create(run(r))).ok, true);
	await refused(r.create(run(r, { app: "api" })), "sb: step #2 names app api; this train's is web");
	await refused(r.create(run(r, { round: 3 })), /names train 2026-11-06-m, round 3; this train is 2026-11-06-m, round 1/);
	await refused(r.create(run(r, { round: 2 })), /^sb: a new round starts with an assemble step/);
});

test("the app is the manifest's when there is one: a first step for another app is refused", async () => {
	const r = rig({ manifest: MANIFEST_HEADER });
	await refused(r.create(run(r, { app: "api" })), "sb: step #1 names app api; this train's is web");
	assert.equal((await r.create(run(r))).ok, true);
});

test("a new round's assemble comes after every step of the old round has completed; its steps follow it", async () => {
	const r = rig();
	const assemble = (round: number, head = SHA_A) => sb({ kind: "assemble", name: `round ${round}`, round }, { check: check(r, { contains: [head] }), on: { head } });
	assert.equal((await r.create(assemble(1))).ok, true);
	assert.equal((await r.create(run(r))).ok, true);
	await refused(r.create(assemble(2, SHA_B)), "sb: round 1 still has step #1 pending; complete it (void) first");
	assert.equal((await r.update(1, "in_progress")).ok, true);
	await refused(r.create(assemble(2, SHA_B)), "sb: round 1 still has step #1 in_progress; complete it (void) first");
	assert.equal((await r.complete(1, result({ outcome: "void", why: "superseded", evidence: "T-12 dropped" }))).ok, true);
	await refused(r.create(assemble(2, SHA_B)), "sb: round 1 still has step #2 pending; complete it (void) first");
	assert.equal((await r.complete(2, result({ outcome: "void", why: "superseded", evidence: "T-12 dropped" }))).ok, true, "an old round's step completes void under its own round");
	await refused(r.create(run(r, { round: 2 })), /^sb: a new round starts with an assemble step/);
	assert.equal((await r.create(assemble(2, SHA_B))).ok, true);
	assert.equal((await r.create(run(r, { round: 2 }))).ok, true, "the new round's steps follow its assemble");
	await refused(r.create(run(r, { round: 1 })), /names train 2026-11-06-m, round 1; this train is 2026-11-06-m, round 2/);
	await refused(r.create(assemble(4, SHA_B)), /round 4; this train is 2026-11-06-m, round 2/);
});

test("a batch that opens a new round carries its steps: the call sees the assemble it creates first", async () => {
	const r = rig();
	await r.create(run(r));
	await r.complete(1, result({ outcome: "void", why: "superseded", evidence: "T-12 dropped" }));
	const second = sb({ kind: "assemble", name: "round 2", round: 2 }, { check: check(r), on: { head: SHA_A } });
	const batch = await r.todo({ action: "create", tasks: [{ subject: "r2", metadata: { sb: second } }, { subject: "unit", metadata: { sb: run(r, { round: 2 }) } }] });
	assert.equal(batch.ok, true, batch.reason ?? "");
	assert.deepEqual(r.list.tasks.map((t) => (t.metadata as { sb: Json }).sb.round), [1, 2, 2]);
	const wrong = await r.todo({ action: "create", tasks: [{ subject: "a", metadata: { sb: run(r, { round: 3, kind: "full-check" }) } }, { subject: "b", metadata: { sb: run(r, { round: 2 }) } }] });
	assert.match(asRefusal(wrong), /^sb: tasks\[0\]: a new round starts with an assemble step/);
});

test("a re-assembly that leaves a step open is refused in a batch as well: the steps of the new round cannot come in the call that closes the old one", async () => {
	const r = rig();
	assert.equal((await r.create(run(r))).ok, true);
	const second = sb({ kind: "assemble", name: "round 2", round: 2 }, { check: check(r), on: { head: SHA_A } });
	const batch = await r.todo({ action: "create", tasks: [{ subject: "r2", metadata: { sb: second } }] });
	assert.match(asRefusal(batch), /^sb: tasks\[0\]: round 1 still has step #1 pending; complete it \(void\) first/);
	assert.equal(r.list.tasks.length, 1);
});

test("a step's metadata.sb nested over 32 levels, not JSON, or over 8 KB is refused before anything walks it", async () => {
	const r = rig();
	let deep: Json = { leaf: 1 };
	for (let i = 0; i < 40; i++) deep = { n: deep };
	await refused(r.create({ ...run(r), spec: deep }), "sb: metadata.sb is nested more than 32 levels");
	const cyclic: Json = { ...run(r) };
	cyclic.self = cyclic;
	await refused(r.create(cyclic), "sb: metadata.sb is nested more than 32 levels");
	await refused(r.create({ ...run(r), n: 10n as unknown as number }), /^sb: metadata\.sb is not JSON/);
	await refused(r.create(sb({}, { check: runCheck({ run: "x".repeat(9000) }) })), /^sb: metadata\.sb is \d+\.\d KB, more than 8$/);
	assert.equal(r.list.tasks.length, 0);
});

test("a delete or a clear never reaches a step that started: it is completed void, not erased", async () => {
	const r = rig();
	await r.create(run(r));
	await r.create(run(r, { name: "lint" }));
	await r.update(2, "in_progress");
	assert.equal((await r.todo({ action: "delete", id: 1 })).ok, true, "a step that never started may be deleted");
	await refused(r.todo({ action: "delete", id: 2 }), "sb: step #2 is in_progress; a started step is never deleted: complete it as void (why: skipped or superseded)");
	await refused(r.update(2, "deleted"), /^sb: step #2 is in_progress; a started step is never deleted/);
	await refused(r.todo({ action: "clear" }), /^sb: step #2 is in_progress; a started step is never deleted/);
	await r.complete(2, result({ outcome: "void", why: "skipped", evidence: "the app declares no such stage" }));
	await refused(r.todo({ action: "clear" }), /step #2 is completed/);
});

// ---- §7.1: completion

test("a completed step carries a result that meets its check; the validator's words come with the step's number", async () => {
	const r = rig();
	const report = await r.begin(sb({ kind: "review", name: "review" }, { check: { type: "report", path: join(r.cwd, "rev.md"), expect: "P0=0 P1=0" }, on: { head: SHA_A } }));
	await refused(r.complete(report, result()), "sb: step #1: a report check passes with result.verdict, the report's verdict line");
	await refused(r.complete(report, result({ verdict: "P0=1" })), "sb: step #1: result.verdict must equal the check's expect (P0=0 P1=0)");
	const id = await r.begin(sb({ kind: "assemble", name: "round 1" }, { check: check(r), on: { head: SHA_A } }));
	await refused(r.update(id, "completed"), "sb: step #2: completed needs a result in metadata.sb.result");
	await refused(r.complete(id, result({ outcome: "passed" })), "sb: step #2: a git check passes with result.head, the commit HEAD showed");
	await refused(r.update(id, "pending", { sb: { ...r.sbOf(id), result: result() } }), /^sb: step #2: metadata\.sb\.result is set only on completed/);
});

test("a `run` step completes passed only after its monitor ended passed for this spec", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	await refused(r.complete(id, result()), "sb: step #1 has no passed run of its spec (last: none)");
	const input = await r.runStep(id, "failed");
	await refused(r.complete(id, result()), "sb: step #1 has no passed run of its spec (last: failed)");
	await refused(r.complete(id, result()), /\(last: failed\)/);
	assert.equal((await r.complete(id, result({ outcome: "failed", evidence: "exit 1" }))).ok, true, "a failed step needs no pass");
	assert.ok(input.command);
});

test("the pass is for this spec: the monitor passed, then the step's command, head or cwd was edited, and the pass no longer stands", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	await r.runStep(id);
	const spec = r.sbOf(id).spec as Json;
	for (const edited of [
		{ ...spec, check: { ...(spec.check as Json), run: "true && echo cheap" } },
		{ ...spec, on: { head: SHA_B } },
		{ ...spec, load: { max: 99 } },
		{ ...spec, holds: { lane: "web" } },
		{ ...spec, check: { ...(spec.check as Json), log: "/elsewhere.log" } },
	]) await refused(r.complete(id, result(), { spec: edited }), /^sb: step #1 has no passed run of its spec \(last: passed for another spec\)/);
	await refused(r.complete(id, result(), { name: "renamed" }), /no passed run of its spec/);
	assert.equal((await r.complete(id, result())).ok, true, "the spec as it ran passes");
});

test("a pass reads the same with the keys of the step in another order", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	await r.runStep(id);
	const reorder = (value: unknown): unknown => (Array.isArray(value) ? value.map(reorder) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value);
	assert.equal((await r.update(id, "completed", { sb: { ...(reorder(r.sbOf(id)) as Json), result: result() } })).ok, true);
});

test("the outcome is the monitor's own: `gate-<id>.json` saying passed, a step file nobody ran, and a passed run of another step count for nothing", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	const input = { description: r.describe(id), command: "true", timeout: 1000 };
	assert.equal((await r.monitor(input)).ok, true);
	// The train's shell writes what the wrapper would: a gate file that says passed, with the right hash.
	const gate = join(r.stateDir, "trainboard", "acme", CODE, `gate-${id}.json`);
	writeFileSync(gate, JSON.stringify({ v: 1, project: "acme", app: "web", train: CODE, step: id, kind: "full-check", name: "unit", state: "passed", since: r.iso(), updated: r.iso(), message: "exit 0", waits: [], pid: 1, spec: r.hashOf(id), exit: 0 }));
	await refused(r.complete(id, result()), "sb: step #1 has no passed run of its spec (last: starting)");
	// And the board it could write, with the step passed.
	const monitor = r.started(input);
	await refused(r.complete(id, result()), "sb: step #1 has no passed run of its spec (last: running)");
	r.finished(monitor, { status: "completed", exitCode: 0 });
	await refused(r.complete(id, result()), "sb: step #1 has no passed run of its spec (last: unverified)"); // it printed no line of the wrapper: nothing says the frozen spec is what ran
	assert.equal(existsSync(gate), true);
});

test("the hash of what the wrapper ran is the one the guard froze, kept in the guard: a step file rewritten before the wrapper read it is not a pass", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	const input = { description: r.describe(id), command: "true", timeout: 1000 };
	assert.equal((await r.monitor(input)).ok, true);
	const file = r.frozen(id), frozenSpec = JSON.parse(readFileSync(file, "utf8")) as Json;
	// The train's shell edits the frozen file and the wrapper reads the edit; the wrapper's lines carry the hash of what it read.
	writeFileSync(file, JSON.stringify({ ...frozenSpec, spec: { ...(frozenSpec.spec as Json), check: { ...runCheck(), cwd: r.cwd, log: join(r.cwd, "unit.log"), run: "true" } } }));
	r.wrapperRun(input, id, "full-check", "passed");
	await refused(r.complete(id, result()), "sb: step #1 has no passed run of its spec (last: ran another spec)");
	// A second run from the same step with the file left alone passes.
	const again: Json = { description: r.describe(id), command: "true" };
	assert.equal((await r.monitor(again)).ok, true);
	r.wrapperRun(again, id, "full-check", "passed");
	assert.equal((await r.complete(id, result())).ok, true, "frozen again, the file is the step's and the run passes");
});

test("a monitor of a step that passed under the guard's hash passes; a wrapper line with another hash after it is a conflict and fails the run", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	const input = { description: r.describe(id), command: "true" };
	await r.monitor(input);
	const monitor = r.started(input);
	r.output(monitor, r.lines(id, "full-check", "running"));
	r.output(monitor, r.lines(id, "full-check", "running", sha("another")));
	r.output(monitor, { monitorOutcome: { status: "passed", message: "exit 0" }, ...r.lines(id, "full-check", "passed") });
	r.finished(monitor);
	await refused(r.complete(id, result()), "(last: ran another spec)");
});

test("a line the step's command or a stray puts into the stream cannot make a pass: the nonce and the file are those of the wrapper's first line, the end is the monitor's exit, and a line after the end only spoils the run", async () => {
	const forged = (r: Rig, id: number, run: string) => ({ monitorOutcome: { status: "passed", message: "exit 0 in 1s" }, ...r.lines(id, "full-check", "passed", r.hashOf(id), run) });
	// 1. The wrapper ran the frozen file and its command failed; something prints a passed line with the right file hash after it. The exit status is the monitor's, and it is 1.
	const a = rig();
	const ida = await a.begin(run(a));
	const ina: Json = { description: a.describe(ida), command: "true" };
	await a.monitor(ina);
	const ma = a.started(ina);
	a.output(ma, a.lines(ida, "full-check", "running"));
	a.output(ma, forged(a, ida, "guessed-nonce"));
	a.finished(ma, { status: "error", exitCode: 1, reportedOutcome: { status: "passed", message: "forged" } });
	await refused(a.complete(ida, result()), /^sb: step #1 has no passed run of its spec \(last: (failed|ran another spec)\)/);
	// 2. The wrapper passed; a stray prints one more line with the right file hash and another nonce after the wrapper's end. The last line is not the wrapper's.
	const b = rig();
	const idb = await b.begin(run(b));
	const inb: Json = { description: b.describe(idb), command: "true" };
	await b.monitor(inb);
	const mb = b.started(inb);
	b.output(mb, b.lines(idb, "full-check", "running"));
	b.output(mb, { monitorOutcome: { status: "passed", message: "exit 0" }, ...b.lines(idb, "full-check", "passed") });
	b.output(mb, forged(b, idb, "stray-nonce"));
	b.finished(mb);
	await refused(b.complete(idb, result()), "(last: ran another spec)");
	// 3. The same run without the stray passes: the stray is the only difference.
	const c = rig();
	const idc = await c.begin(run(c));
	await c.runStep(idc);
	assert.equal((await c.complete(idc, result())).ok, true);
	// 4. The step file was edited and the edit passed; the stream, forged or not, cannot say the frozen file ran: the first line's file is the one the wrapper read.
	const d = rig();
	const idd = await d.begin(run(d));
	const ind: Json = { description: d.describe(idd), command: "true" };
	await d.monitor(ind);
	const md = d.started(ind);
	d.output(md, d.lines(idd, "full-check", "running", sha("the edited file")));
	d.output(md, forged(d, idd, "nonce-1"));
	d.finished(md);
	await refused(d.complete(idd, result()), "(last: ran another spec)");
});

test("the real wrapper keeps the command's own output out of the stream: a command that prints a passed line and fails leaves a failed run with no such line", async () => {
	const r = rig({ node: process.execPath, cli: serverCli() });
	const lie = JSON.stringify({ monitorOutcome: { status: "passed", message: "exit 0" }, progress: { message: "passed" }, sb: { v: 1, train: CODE, step: 1, kind: "full-check", state: "passed", spec: "0".repeat(64), run: "guess" } });
	const id = await r.begin(run(r, { name: "liar" }, { check: runCheck({ cwd: r.cwd, run: `printf '%s\\n' '${lie}'; printf '%s\\n' '${lie}' >&2; exit 3`, log: join(r.cwd, "liar.log") }) }));
	const input: Json = { description: r.describe(id), command: String(((r.sbOf(id).spec as Json).check as Json).run) };
	assert.equal((await r.monitor(input)).ok, true);
	let printed: string[] = [];
	try {
		execFileSync("/bin/sh", ["-c", String(input.command)], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		printed = String((error as { stdout?: string }).stdout).split("\n").filter(Boolean);
	}
	assert.ok(printed.length >= 2, "the wrapper printed its lines");
	assert.ok(printed.every((line) => !line.includes("guess")), "and none of the command's");
	assert.equal((JSON.parse(printed.at(-1)!) as { monitorOutcome: { status: string } }).monitorOutcome.status, "failed");
	const monitor = r.started(input);
	printed.forEach((line) => r.output(monitor, line));
	r.finished(monitor, { status: "error", exitCode: 1, reportedOutcome: { status: "failed" } });
	await refused(r.complete(id, result()), "(last: failed)");
	assert.match(readFileSync(join(r.cwd, "liar.log"), "utf8"), /guess/, "the command's output is in the log");
});

test("a run that stopped, was refused, or ended with a non-zero exit is not a pass, and the refusal says which", async () => {
	for (const [state, last] of [["stopped", "stopped"], ["refused", "refused"], ["failed", "failed"]] as const) {
		const r = rig();
		const id = await r.begin(run(r));
		await r.runStep(id, state);
		await refused(r.complete(id, result()), `(last: ${last})`);
	}
	const r = rig();
	const id = await r.begin(run(r));
	const input = { description: r.describe(id), command: "true" };
	await r.monitor(input);
	r.wrapperRun(input, id, "full-check", "passed", { monitor: { status: "completed", exitCode: 2, reportedOutcome: { status: "passed" } } });
	await refused(r.complete(id, result()), /\(last: failed\)/);
	const again = await r.runStep(id, "passed");
	assert.ok(again.command);
	assert.equal((await r.complete(id, result())).ok, true, "a later passed run passes");
});

test("a run passes only on the monitor's whole record: every part of its last line, its end, and its start is checked on its own", async () => {
	type Make = (r: Rig, id: number) => { first?: Json; last?: Json | string; tail?: Array<Json | string>; end?: Json };
	const pass = (r: Rig, id: number) => ({ first: r.lines(id, "full-check", "running"), last: { monitorOutcome: { status: "passed", message: "exit 0" }, ...r.lines(id, "full-check", "passed") } });
	const cases: Array<[string, Make, string]> = [
		["the baseline", pass, "passed"],
		["a last line of another step", (r, id) => ({ ...pass(r, id), last: { monitorOutcome: { status: "passed" }, ...r.lines(id + 7, "full-check", "passed", r.hashOf(id), `nonce-${id}`) } }), "ran another spec"],
		["a last line of another train", (r, id) => ({ ...pass(r, id), last: { monitorOutcome: { status: "passed" }, sb: { ...(r.lines(id, "full-check", "passed").sb as Json), train: "2026-11-05-x" } } }), "ran another spec"],
		["a last line that is not an end", (r, id) => ({ ...pass(r, id), last: r.lines(id, "full-check", "passed") }), "unverified"],
		["a last line that says failed", (r, id) => ({ ...pass(r, id), last: { monitorOutcome: { status: "failed" }, ...r.lines(id, "full-check", "failed") } }), "ran another spec"],
		["a last line with another nonce", (r, id) => ({ ...pass(r, id), last: { monitorOutcome: { status: "passed" }, ...r.lines(id, "full-check", "passed", r.hashOf(id), "other") } }), "ran another spec"],
		["a last line of another file", (r, id) => ({ ...pass(r, id), last: { monitorOutcome: { status: "passed" }, ...r.lines(id, "full-check", "passed", sha("x")) } }), "ran another spec"],
		["a plain line after the end", (r, id) => ({ ...pass(r, id), tail: ["done"] }), "ran another spec"],
		["a line over 4000 characters after the end", (r, id) => ({ ...pass(r, id), tail: [JSON.stringify({ ...pass(r, id).last, pad: "x".repeat(4100) })] }), "ran another spec"],
		["no line at all", () => ({}), "unverified"],
		["an end the monitor reports as failed with exit 0", (r, id) => ({ ...pass(r, id), end: { reportedOutcome: { status: "failed" } } }), "ran another spec"],
		["an end that is an error with exit 0", (r, id) => ({ ...pass(r, id), end: { status: "error", reportedOutcome: { status: "failed" } } }), "failed"],
		["an end that is stopped", (r, id) => ({ ...pass(r, id), end: { status: "stopped", exitCode: undefined, reportedOutcome: undefined } }), "stopped"],
	];
	for (const [name, make, state] of cases) {
		const r = rig();
		const id = await r.begin(run(r));
		const input: Json = { description: r.describe(id), command: "true" };
		await r.monitor(input);
		const monitor = r.started(input), parts = make(r, id);
		if (parts.first) r.output(monitor, parts.first);
		if (parts.last) r.output(monitor, parts.last);
		for (const line of parts.tail ?? []) r.output(monitor, line);
		r.finished(monitor, parts.end ?? {});
		if (state === "passed") assert.equal((await r.complete(id, result())).ok, true, name);
		else await refused(r.complete(id, result()), `(last: ${state})`).catch((error: Error) => { throw new Error(`${name}: ${error.message}`); });
	}
});

test("a monitor the guard did not start for a step is none of its runs: another command, another description, a second end, or another train's code", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	const input: Json = { description: r.describe(id), command: "true" };
	await r.monitor(input);
	// A start event of another command or description does not take the run, so its lines and end are nobody's.
	for (const odd of [{ ...input, command: "false" }, { ...input, description: "something else" }]) {
		const stray = r.started(odd);
		r.output(stray, r.lines(id, "full-check", "running"));
		r.output(stray, { monitorOutcome: { status: "passed" }, ...r.lines(id, "full-check", "passed") });
		r.finished(stray);
		await refused(r.complete(id, result()), "(last: starting)");
	}
	// The run, then a second end for the same monitor: the first end stands.
	const monitor = r.started(input);
	r.output(monitor, r.lines(id, "full-check", "running"));
	r.output(monitor, { monitorOutcome: { status: "passed" }, ...r.lines(id, "full-check", "passed") });
	r.finished(monitor);
	r.finished(monitor, { status: "error", exitCode: 1, reportedOutcome: { status: "failed" } });
	assert.equal((await r.complete(id, result())).ok, true);
	// A description with another train's code is refused, whatever the step.
	const other = await r.monitor({ description: `train 9999z #${id} full-check`, command: "true" });
	assert.equal(other.ok, false);
	assert.match(other.reason ?? "", /^sb: a train's monitor runs one step: describe it "train 1106m #<id> <kind>"/);
});

test("a guard that fails on a call blocks it, a session that is neither a train nor a main is not checked, and a todo call that failed writes no board", async () => {
	const r = rig();
	const ctx = { cwd: r.cwd, sessionManager: { getBranch: () => { throw new Error("branch unreadable"); }, getSessionId: () => SESSION_ID } };
	const blocked = await r.todo({ action: "create", subject: "s" }, ctx);
	assert.equal(blocked.ok, false);
	assert.match(blocked.reason ?? "", /^sb: the train guard could not check this call \(branch unreadable\); try again/);
	assert.equal(r.list.tasks.length, 0);
	const member = rig({ train: false, main: false });
	assert.equal((await member.todo({ action: "create", subject: "train", metadata: { sb: { v: 1, kind: "merge" } } })).ok, true);
	assert.equal(existsSync(member.yardFile), false);
	const failing = rig();
	await failing.create(sb({ kind: "assemble", name: "a" }, { check: check(failing), on: { head: SHA_A } }));
	rmSync(failing.boardFile);
	await failing.fire("tool_result", { toolName: "todo", toolCallId: "c1", input: {}, content: [], isError: true, details: failing.snapshot() });
	assert.equal(existsSync(failing.boardFile), false, "an error result writes nothing");
	await failing.fire("tool_result", { toolName: "todo", toolCallId: "c1", input: {}, content: [], isError: false, details: failing.snapshot() });
	assert.equal(existsSync(failing.boardFile), true);
});

test("a run that was stopped by the inactivity timeout reads as stale, a monitor that errored on start as error", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	const input = { description: r.describe(id), command: "true" };
	await r.monitor(input);
	const monitor = r.started(input);
	r.finished(monitor, { status: "stopped", reason: "timeout", exitCode: undefined, reportedOutcome: undefined });
	await refused(r.complete(id, result()), "(last: stale)");
});

test("a /reload forgets the runs: they are in the guard's memory only, so a pass written into the session file is no evidence and the step runs again", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	await r.runStep(id);
	assert.deepEqual(r.entries.filter((e) => e.customType !== "rpiv-todo-state" && e.customType !== "todo/v1"), [], "the guard wrote nothing to the session file: the train's shell can edit it");
	r.entries.push({ type: "custom", customType: "straw-boss-train-run", data: { step: id, hash: specHash(r.sbOf(id)), state: "passed", monitor: "m1", at: r.iso() }, timestamp: r.iso() });
	const again = rig({ reuse: r });
	await refused(again.complete(id, result()), "sb: step #1 has no passed run of its spec (last: none)");
	await again.runStep(id);
	assert.equal((await again.complete(id, result())).ok, true, "frozen again and run again, it passes");
});

test("a passed run is for the step it ran: the same hash under another step number does not pass that step", async () => {
	const r = rig();
	const a = await r.begin(run(r)), b = await r.begin(run(r));
	await r.runStep(a);
	await refused(r.complete(b, result()), "sb: step #2 has no passed run of its spec (last: none)");
	assert.equal((await r.complete(a, result())).ok, true);
});

// ---- §7.1: git, report, notice

test("a `git` pass is read from the repository: HEAD is result.head and every `contains` commit is its ancestor", async () => {
	const r = rig();
	const repo = join(r.cwd, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-q", "-m", "a");
	const first = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "b.txt"), "b");
	git(repo, "add", "b.txt");
	git(repo, "commit", "-q", "-m", "b");
	const head = git(repo, "rev-parse", "HEAD");
	git(repo, "branch", "side", first);
	const meta = (over: Json = {}, on = head) => sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: repo, contains: [first], ...over }, on: { head: on } });
	const id = await r.begin(meta());
	await refused(r.complete(id, result({ head: SHA_A }), { spec: { ...(r.sbOf(id).spec as Json), on: { head: SHA_A } } }), /^sb: step #1: git check: HEAD of .* is [0-9a-f]{40}, not result\.head aaaaaaaaaaaa/);
	await refused(r.complete(id, result({ head: first })), /^sb: step #1: on\.head must equal result\.head for a git check to pass/);
	assert.equal((await r.complete(id, result({ head }))).ok, true);
	// A commit that is not an ancestor, a ref other than HEAD, a folder that is no repository.
	const orphan = await r.begin(meta({ contains: [SHA_C] }));
	await refused(r.complete(orphan, result({ head })), `sb: step #2: git check: ${SHA_C.slice(0, 12)} is not an ancestor of HEAD`);
	const ref = await r.begin(meta({ ref: "side", contains: [first] }, first));
	assert.equal((await r.complete(ref, result({ head: first }))).ok, true, "ref side is first");
	const wrongRef = await r.begin(meta({ ref: "side", contains: [head] }, first));
	await refused(r.complete(wrongRef, result({ head: first })), /git check: [0-9a-f]{12} is not an ancestor of side/);
	const dash = await r.begin(meta({ ref: "--output=x" }));
	await refused(r.complete(dash, result({ head })), "sb: step #5: git check: a ref does not begin with -");
	const gone = await r.begin(sb({ kind: "assemble", name: "gone" }, { check: { type: "git", cwd: join(r.cwd, "nope"), contains: [first] }, on: { head } }));
	await refused(r.complete(gone, result({ head })), /^sb: step #6: git check: git failed in .*nope/);
	const plain = join(r.cwd, "plain");
	mkdirSync(plain);
	const notRepo = await r.begin(sb({ kind: "assemble", name: "plain" }, { check: { type: "git", cwd: plain, contains: [first] }, on: { head } }));
	await refused(r.complete(notRepo, result({ head })), /^sb: step #7: git check: git failed in .*plain/);
});

test("a `git` check reads the repository the cwd names; a `~` is the home folder and a relative cwd is the session's", async () => {
	const r = rig();
	const repo = join(r.root, "home-repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a"), "a");
	git(repo, "add", "a");
	git(repo, "commit", "-q", "-m", "a");
	const head = git(repo, "rev-parse", "HEAD");
	for (const cwd of ["~/home-repo", "../home-repo"]) {
		const id = await r.begin(sb({ kind: "assemble", name: cwd }, { check: { type: "git", cwd, contains: [head] }, on: { head } }));
		assert.equal((await r.complete(id, result({ head }))).ok, true, cwd);
	}
});

test("a `report` pass is refused for a file that is missing, empty, or older than the step; it passes for a file written after the step went in_progress", async () => {
	const r = rig();
	const path = join(r.cwd, "review.md");
	const meta = () => sb({ kind: "review", name: "review" }, { check: { type: "report", path, expect: "P0=0 P1=0" }, on: { head: SHA_A } });
	const seconds = (ms: number) => new Date(ms);
	writeFileSync(path, "old report\nP0=0 P1=0\n");
	utimesSync(path, seconds(r.now() - 600_000), seconds(r.now() - 600_000)); // written before the step started
	r.tick(1000);
	const id = await r.begin(meta());
	const started = r.iso();
	await refused(r.complete(id, result({ verdict: "P0=0 P1=0" })), `sb: step #1: report ${path} was not changed since the step went in_progress (${started})`);
	utimesSync(path, seconds(r.now() + 60_000), seconds(r.now() + 60_000));
	assert.equal((await r.complete(id, result({ verdict: "P0=0 P1=0" }))).ok, true);
	const empty = join(r.cwd, "empty.md"), missing = join(r.cwd, "missing.md");
	writeFileSync(empty, "");
	utimesSync(empty, seconds(r.now() + 60_000), seconds(r.now() + 60_000));
	const other = (p: string, name: string) => sb({ kind: "review", name }, { check: { type: "report", path: p, expect: "P0=0 P1=0" }, on: { head: SHA_A } });
	const e = await r.begin(other(empty, "empty")), m = await r.begin(other(missing, "missing"));
	await refused(r.complete(e, result({ verdict: "P0=0 P1=0" })), `sb: step #2: report ${empty} is empty`);
	await refused(r.complete(m, result({ verdict: "P0=0 P1=0" })), `sb: step #3: report ${missing} does not exist`);
});

test("a `report` step that was never seen in_progress cannot pass: the time it started is the guard's, in its memory", async () => {
	const r = rig();
	const path = join(r.cwd, "review.md");
	writeFileSync(path, "x\nP0=0 P1=0\n");
	utimesSync(path, new Date(r.now() + 60_000), new Date(r.now() + 60_000));
	assert.equal((await r.create(sb({ kind: "review", name: "review" }, { check: { type: "report", path, expect: "P0=0 P1=0" }, on: { head: SHA_A } }))).ok, true);
	const never = "sb: step #1: report check: the step was never seen in_progress by this session; set it in_progress before it completes";
	await refused(r.complete(1, result({ verdict: "P0=0 P1=0" })), never);
	assert.equal((await r.update(1, "in_progress")).ok, true);
	// A /reload forgets when it started, and a branch entry cannot say it again.
	const again = rig({ reuse: r });
	await refused(again.complete(1, result({ verdict: "P0=0 P1=0" })), never);
	assert.equal((await again.update(1, "in_progress")).ok, true, "set in_progress again, it starts from now");
	utimesSync(path, new Date(again.now() - 1000), new Date(again.now() - 1000));
	await refused(again.complete(1, result({ verdict: "P0=0 P1=0" })), /was not changed since the step went in_progress/);
	again.tick(5000);
	utimesSync(path, new Date(again.now() + 60_000), new Date(again.now() + 60_000));
	assert.equal((await again.complete(1, result({ verdict: "P0=0 P1=0" }))).ok, true);
});

/** The server's answer about T-15: landed, with this notice record (the guard reads this, never a file). */
const landedView = (notice?: Json): CarView => ({
	file: { v: 1, project: "acme", app: "web", car: { tickets: ["T-15"], branch: "fix/t-15", head: SHA_A }, coordinator: "sess-coord-1", states: [{ state: "landed", at: "2026-11-07T08:30:00Z", by: { role: "train", name: "train 1106m", session: "sess-train-1" }, version: "1.2.0", commit: SHA_B }] },
	...(notice ? { notice: { v: 1, states: { landed: notice as never } } } : {}),
});

test("a `notice` pass waits for sb: refused until the coordinator's notice is delivered or escalated, passed after", async () => {
	const land = () => sb({ kind: "land", name: "land" }, { check: { type: "notice", cars: ["T-15"], state: "landed" } });
	const views = { views: [] as CarView[] };
	const r = rig({ cars: views });
	const id = await r.begin(land());
	await refused(r.complete(id, result()), "sb: step #1: car T-15 has no car file");
	views.views = [landedView()];
	await refused(r.complete(id, result()), "sb: step #1: waits for sb to tell sess-coord-1 that car T-15 is landed (0 attempts)");
	views.views = [landedView({ attempts: [{ at: "2026-11-07T08:31:00Z", outcome: "queued", answer: "queued" }] })];
	await refused(r.complete(id, result()), "sb: step #1: waits for sb to tell sess-coord-1 that car T-15 is landed (1 attempt, last: queued)");
	views.views = [landedView({ attempts: [{ at: "2026-11-07T08:31:00Z", outcome: "delivered" }], deliveredAt: "2026-11-07T08:31:00Z" })];
	assert.equal((await r.complete(id, result())).ok, true);
	const escalated = rig({ cars: { views: [landedView({ attempts: [{ at: "2026-11-07T08:31:00Z", outcome: "not-live" }], escalatedAt: "2026-11-07T08:40:00Z" })] } });
	const e = await escalated.begin(land());
	assert.equal((await escalated.complete(e, result())).ok, true, "escalated counts");
});

test("a car file or notice file the train wrote itself passes nothing (SB4-F003): the guard asks the server and reads no file", async () => {
	const land = () => sb({ kind: "land", name: "land" }, { check: { type: "notice", cars: ["T-15"], state: "landed" } });
	const r = rig({ cars: { views: [] } });
	const id = await r.begin(land());
	// What a shell could write: a landed car file and a delivered notice, exactly as the server writes them.
	const dir = join(r.stateDir, "trainboard", "acme", "cars"), head = SHA_A.slice(0, 12);
	mkdirSync(dir, { recursive: true });
	const view = landedView({ attempts: [{ at: "2026-11-07T08:31:00Z", outcome: "delivered" }], deliveredAt: "2026-11-07T08:31:00Z" });
	writeFileSync(join(dir, `web-${head}.json`), JSON.stringify(view.file));
	writeFileSync(join(dir, `web-${head}.notice.json`), JSON.stringify(view.notice));
	await refused(r.complete(id, result()), "sb: step #1: car T-15 has no car file");
	const blind = rig();
	const b = await blind.begin(land());
	await refused(blind.complete(b, result()), "sb: this guard has no link to the sb server, so it cannot read the car notices a step waits for");
	const down = rig({ cars: { views: [], error: "connect ECONNREFUSED" } });
	const d = await down.begin(land());
	await refused(down.complete(d, result()), /^sb: the sb server did not answer for the cars of project acme \(connect ECONNREFUSED\); try again$/);
});

// ---- SB4-F003: what a step that depends on a notice waits for

/** The server's view of one car in a terminal state, with its notice record. */
function carView(ticket: string, state: "dropped" | "returned" | "landed", notice?: Json, head = SHA_B): CarView {
	const fields: Record<string, Json> = { dropped: { round: 1, reason: "unit red", evidence: "/r/unit.log" }, returned: { reason: ASKED_WORD }, landed: { version: "1.2.0", commit: SHA_B } };
	return {
		file: { v: 1, project: "acme", app: "web", car: { tickets: [ticket], branch: `fix/${ticket.toLowerCase()}`, head }, coordinator: "sess-coord-2", states: [{ state, at: "2026-11-07T08:30:00Z", by: { role: "train", name: "train 1106m", session: "sess-train-1" }, ...fields[state] }] },
		...(notice ? { notice: { v: 1, states: { [state]: notice as never } } } : {}),
	};
}
const ASKED_WORD = "sb: the train runs no acceptance: car T-16 asks for UAT (/r/checkpoints.md) (slip line uat:); rewrite its acceptance criteria and run them before loading, then send the evidence in accept:";
const TOLD = { attempts: [{ at: "2026-11-07T08:31:00Z", outcome: "delivered" }], deliveredAt: "2026-11-07T08:31:00Z" };

function repoWithHead(r: Rig) {
	const repo = join(r.cwd, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-q", "-m", "a");
	const head = git(repo, "rev-parse", "HEAD");
	return { repo, head, step: (spec: Json = {}) => sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: repo, contains: [head] }, on: { head }, ...spec }) };
}

test("an assemble that removes cars is not passed on its git check alone: it waits for sb to tell each removed car's coordinator that it is dropped or returned", async () => {
	const views = { views: [] as CarView[] };
	const r = rig({ cars: views });
	const { head, step } = repoWithHead(r);
	const id = await r.begin(step({ cars: ["T-15"], removed: [{ ticket: "T-16", why: "unit red", evidence: "/r/unit.log" }] }));
	await refused(r.complete(id, result({ head })), "sb: step #1: car T-16 has no car file");
	views.views = [carView("T-16", "dropped")];
	await refused(r.complete(id, result({ head })), "sb: step #1: waits for sb to tell sess-coord-2 that car T-16 is dropped (0 attempts)");
	views.views = [carView("T-16", "dropped", { attempts: [{ at: "2026-11-07T08:31:00Z", outcome: "failed", answer: "session gone" }] })];
	await refused(r.complete(id, result({ head })), "sb: step #1: waits for sb to tell sess-coord-2 that car T-16 is dropped (1 attempt, last: session gone)");
	views.views = [carView("T-16", "landed", TOLD)];
	await refused(r.complete(id, result({ head })), "sb: step #1: car T-16 is landed, not dropped or returned");
	views.views = [carView("T-16", "dropped", TOLD)];
	assert.equal((await r.complete(id, result({ head }))).ok, true);
	// A returned car counts, and so does one the tower was told about; an assemble that removes nothing needs no server.
	for (const view of [carView("T-16", "returned", TOLD), carView("T-16", "dropped", { attempts: [{ at: "2026-11-07T08:31:00Z", outcome: "not-live" }], escalatedAt: "2026-11-07T08:40:00Z" })]) {
		const o = rig({ cars: { views: [view] } });
		const h = repoWithHead(o);
		const i = await o.begin(h.step({ removed: [{ ticket: "T-16", why: "x" }] }));
		assert.equal((await o.complete(i, result({ head: h.head }))).ok, true);
	}
	const none = rig();
	const plain = repoWithHead(none);
	assert.equal((await none.complete(await none.begin(plain.step()), result({ head: plain.head }))).ok, true, "no removed car, no notice to wait for");
});

test("an assemble whose removed cars the server cannot be asked about is refused, and a notice file the train wrote itself does not stand in (SB4-F003)", async () => {
	const down = rig({ cars: { views: [], error: "connect ECONNREFUSED" } });
	const h = repoWithHead(down);
	const id = await down.begin(h.step({ removed: [{ ticket: "T-16", why: "x" }] }));
	await refused(down.complete(id, result({ head: h.head })), /^sb: the sb server did not answer for the cars of project acme/);
	const blind = rig();
	const b = repoWithHead(blind);
	const bid = await blind.begin(b.step({ removed: [{ ticket: "T-16", why: "x" }] }));
	const dir = join(blind.stateDir, "trainboard", "acme", "cars");
	mkdirSync(dir, { recursive: true });
	const view = carView("T-16", "dropped", TOLD);
	writeFileSync(join(dir, `web-${SHA_B.slice(0, 12)}.json`), JSON.stringify(view.file));
	writeFileSync(join(dir, `web-${SHA_B.slice(0, 12)}.notice.json`), JSON.stringify(view.notice));
	await refused(blind.complete(bid, result({ head: b.head })), "sb: this guard has no link to the sb server, so it cannot read the car notices a step waits for");
});

test("round 1's assemble cannot pass until the notice for a car returned from the manifest is delivered (D13 + D14)", async () => {
	const views = { views: [] as CarView[] };
	const r = rig({ manifest: MANIFEST, cars: views });
	const { repo, head } = repoWithHead(r);
	const spec = { check: { type: "git", cwd: repo, contains: [head] }, on: { head }, cars: ["T-15"], removed: [{ ticket: "T-16", why: ASKED, evidence: "/r/checkpoints.md" }] };
	const id = await r.begin(sb({ kind: "assemble", name: "round 1" }, spec));
	views.views = [carView("T-16", "returned")];
	await refused(r.complete(id, result({ head })), "sb: step #1: waits for sb to tell sess-coord-2 that car T-16 is returned (0 attempts)");
	views.views = [carView("T-16", "returned", TOLD)];
	assert.equal((await r.complete(id, result({ head }))).ok, true);
});

test("the round opens once its assemble exists, and its other steps wait until the assemble has passed (SB4-F003): started or passed or failed is refused; void is not", async () => {
	const views = { views: [carView("T-16", "dropped")] };
	const r = rig({ cars: views });
	const { head, step } = repoWithHead(r);
	assert.equal((await r.create(step({ removed: [{ ticket: "T-16", why: "unit red", evidence: "/r/unit.log" }] }))).ok, true);
	assert.equal((await r.create(run(r, { name: "unit" }))).ok, true, "creating a step of the round is fine");
	await refused(r.update(2, "in_progress"), "sb: step #2 waits for round 1's assemble #1 to pass");
	assert.equal((await r.update(1, "in_progress")).ok, true);
	await refused(r.update(2, "in_progress"), "sb: step #2 waits for round 1's assemble #1 to pass");
	await refused(r.complete(1, result({ outcome: "passed", head })), /waits for sb to tell sess-coord-2 that car T-16 is dropped/);
	await refused(r.update(2, "in_progress"), /waits for round 1's assemble #1 to pass/);
	assert.equal((await r.complete(1, result({ outcome: "failed", head }))).ok, true, "a failed assemble is completed");
	await refused(r.update(2, "in_progress"), /waits for round 1's assemble #1 to pass/);
	assert.equal((await r.complete(2, result({ outcome: "void", why: "skipped", evidence: "round 1 failed" }))).ok, true, "a void completion is always allowed");
	views.views = [carView("T-16", "dropped", TOLD)];
	const second = rig({ cars: views });
	const h = repoWithHead(second);
	await second.create(h.step({ removed: [{ ticket: "T-16", why: "x" }] }));
	await second.create(run(second, { name: "unit" }));
	await second.update(1, "in_progress");
	assert.equal((await second.complete(1, result({ head: h.head }))).ok, true);
	assert.equal((await second.update(2, "in_progress")).ok, true, "the assemble passed: the round's steps run");
});

// ---- D13: a manifest car that asks for acceptance

const MANIFEST = [MANIFEST_HEADER, slipBlock(), "", slipBlock({ tickets: "T-16", branch: "fix/t-16", head: SHA_B, uat: "/r/checkpoints.md" }), ""].join("\n");
const ASKED = word("T-16", "UAT (/r/checkpoints.md)", "slip line uat:");
const assembleOf = (r: Rig, spec: Json = {}, over: Json = {}) => sb({ kind: "assemble", name: "round 1", ...over }, { check: check(r), on: { head: SHA_A }, ...spec });

test("a manifest car that asks for acceptance is left out of round 1: the assemble must list it as removed, with the word, and no step is created for it", async () => {
	const r = rig({ manifest: MANIFEST });
	const bad = asRefusal(await r.create(assembleOf(r, { cars: ["T-15"] })));
	assert.ok(bad.startsWith(ASKED), bad);
	assert.match(bad, /Put T-16 in this assemble's spec\.removed and set it returned with train_car; no step carries it\.$/);
	assert.ok(asRefusal(await r.create(assembleOf(r, { cars: ["T-15", "T-16"] }))).startsWith(ASKED), "listing it among the cars is no better");
	assert.ok(asRefusal(await r.create(assembleOf(r, { cars: ["T-15"], removed: [{ ticket: "T-15", why: "x" }] }))).startsWith(ASKED), "removing another car is not it");
	assert.equal(r.list.tasks.length, 0);
	const ok = await r.create(assembleOf(r, { cars: ["T-15"], removed: [{ ticket: "T-16", why: ASKED, evidence: "/r/checkpoints.md" }] }));
	assert.equal(ok.ok, true, ok.reason ?? "");
	// No step carries the car.
	await refused(r.create(sb({ kind: "land", name: "land" }, { check: { type: "notice", cars: ["T-15", "T-16"], state: "landed" } })), "sb: car T-16 was left out of round 1: it asks the train for acceptance; no step carries it");
	await refused(r.create(sb({ kind: "assemble", name: "again" }, { check: check(r, { contains: [SHA_B] }), on: { head: SHA_A }, cars: ["T-15"], removed: [{ ticket: "T-16", why: "asks for acceptance" }] })), "sb: car T-16 was left out of round 1: it asks the train for acceptance; no step carries it");
	await refused(r.create(assembleOf(r, { cars: ["T-15", "T-16"], removed: [{ ticket: "T-16", why: "x" }] })), "sb: car T-16 was left out of round 1: it asks the train for acceptance; no step carries it");
	assert.equal((await r.create(sb({ kind: "land", name: "land" }, { check: { type: "notice", cars: ["T-15"], state: "landed" } }))).ok, true);
	assert.equal(r.list.tasks.length, 2);
	// Only round 1 owes the removal: a re-assembly's assemble lists its own dropped cars, not this one.
	await r.complete(1, result({ outcome: "void", why: "superseded", evidence: "T-15 dropped" }), {});
	await r.complete(2, result({ outcome: "void", why: "superseded", evidence: "T-15 dropped" }));
	const again = await r.create(sb({ kind: "assemble", name: "round 2", round: 2 }, { check: check(r), on: { head: SHA_A }, cars: ["T-15"] }));
	assert.equal(again.ok, true, again.reason ?? "");
});

test("round 1 starts with an assemble when the manifest left a car out (SB4-F002): a merge or a land step before it is refused, in a batch too, and the assemble then opens the round", async () => {
	const r = rig({ manifest: MANIFEST });
	const merge = run(r, { kind: "merge", name: "merge" }, { check: runCheck({ cwd: r.cwd, run: "git merge fix/t-16", log: join(r.cwd, "merge.log") }) });
	const land = sb({ kind: "land", name: "land" }, { check: { type: "notice", cars: ["T-15"], state: "landed" } });
	const why = /^sb: (tasks\[0\]: )?round 1 starts with an assemble: car T-16 was left out of round 1/;
	await refused(r.create(merge), why);
	await refused(r.create(land), why);
	await refused(r.todo({ action: "create", tasks: [{ subject: "merge", metadata: { sb: merge } }, { subject: "asm", metadata: { sb: assembleOf(r, { cars: ["T-15"], removed: [{ ticket: "T-16", why: ASKED }] }) } }] }), why);
	assert.equal(r.list.tasks.length, 0, "nothing was created");
	const ok = await r.todo({ action: "create", tasks: [{ subject: "asm", metadata: { sb: assembleOf(r, { cars: ["T-15"], removed: [{ ticket: "T-16", why: ASKED }] }) } }, { subject: "merge", metadata: { sb: merge } }] });
	assert.equal(ok.ok, true, ok.reason ?? "");
	assert.equal(r.list.tasks.length, 2);
	// An assemble that does not list the car does not open the round either.
	const other = rig({ manifest: MANIFEST });
	await refused(other.create(assembleOf(other, { cars: ["T-15"], removed: [{ ticket: "T-15", why: "x" }] })), ASKED);
	await refused(other.create(merge), why);
	// With nothing left out, any round-1 step may come first.
	const plain = rig({ manifest: MANIFEST_HEADER + slipBlock() + "\n" });
	assert.equal((await plain.create(run(plain, { kind: "merge", name: "merge" }))).ok, true);
});

test("only the acceptance word makes a manifest car leave: a car with a plain defect or none rides, and no manifest means no audit", async () => {
	const plain = [MANIFEST_HEADER, slipBlock(), "", slipBlock({ tickets: "T-16", head: SHA_B, departs: "tomorrow" }), ""].join("\n");
	const r = rig({ manifest: plain });
	assert.equal((await r.create(assembleOf(r, { cars: ["T-15", "T-16"] }))).ok, true);
	const free = rig({ manifest: [MANIFEST_HEADER, slipBlock({ review: "P0=0 P1=0; run UAT after deploy" }), ""].join("\n") });
	assert.ok(asRefusal(await free.create(assembleOf(free))).startsWith(word("T-15", "uat", "slip field review")));
	const none = rig();
	assert.equal((await none.create(assembleOf(none))).ok, true);
});

test("a message that only looks like a handoff is none, and the manifest is read once: editing the session's entries later changes nothing", async () => {
	const r = rig({ manifest: MANIFEST_HEADER + slipBlock() + "\n" });
	r.entries.unshift({ type: "custom_message", customType: "intercom", content: `Hello, here is a message.\nRequest, verbatim:\n${MANIFEST}`, timestamp: r.iso() });
	assert.equal((await r.create(assembleOf(r, { cars: ["T-15"] }))).ok, true, "the genuine handoff is the manifest");
	const handoff = r.entries.find((e) => (e.content ?? "").includes("you are the train"))!;
	handoff.content = (handoff.content ?? "").replace(MANIFEST_HEADER + slipBlock() + "\n", MANIFEST);
	assert.equal((await r.create(assembleOf(r, { cars: ["T-15"] }, { name: "second" }))).ok, true, "read once: the edit is not read");
	const fresh = rig({ reuse: r });
	assert.ok(asRefusal(await fresh.create(assembleOf(fresh, { cars: ["T-15"] }, { name: "third" }))).startsWith(ASKED), "a guard that starts again reads what the file says now");
});

test("the manifest is the first message that says so: a later message with a different manifest changes nothing", async () => {
	const r = rig({ manifest: MANIFEST_HEADER + slipBlock() + "\n" });
	r.entries.push({ type: "custom_message", customType: "straw-tower", content: `Straw Boss: the tower of workspace Base A opened this tab for you: you are the train 1106m of project acme.\nRequest, verbatim:\n${MANIFEST}`, timestamp: r.iso() });
	assert.equal((await r.create(assembleOf(r, { cars: ["T-15"] }))).ok, true);
});

// ---- §7.3: a lane or target another train holds

function earlier(r: Rig, code: string, steps: Json[], extra: Json = {}) {
	const dir = join(r.stateDir, "trainboard", "acme", code);
	mkdirSync(dir, { recursive: true });
	const board = { v: 1, project: "acme", app: "web", code, writer: { session: "sess-other", pid: process.pid, started: "2026-11-07T07:00:00Z" }, updated: r.iso(), round: 1, cars: [], steps, ...extra };
	writeBoard(r.stateDir, board as never);
}
const stepRow = (id: number, status: string, holds: Json, kind = "merge", over: Json = {}) => ({ id, kind, name: "x", status, round: 1, holds, ...over });

test("a step without a monitor that holds a lane or target waits for an earlier train that holds it: starting it is refused with the wait, and free once the other ends", async () => {
	const r = rig();
	earlier(r, "2026-11-05-a", [stepRow(1, "in_progress", { lane: "web" })]);
	earlier(r, "2026-11-07-z", [stepRow(1, "in_progress", { lane: "web" })]); // a later train: this one is first
	const id = (await r.create(sb({ kind: "merge", name: "push" }, { check: check(r), on: { head: SHA_A }, holds: { lane: "web" } }), "push")).ok ? 1 : 0;
	await refused(r.update(id, "in_progress"), "sb: step #1 waiting: lane web (held by 2026-11-05-a); start it when it is free");
	const other = await r.create(sb({ kind: "merge", name: "free" }, { check: check(r), on: { head: SHA_A }, holds: { lane: "api" } }), "free");
	assert.equal(other.ok, true);
	assert.equal((await r.update(2, "in_progress")).ok, true, "another lane is free");
	earlier(r, "2026-11-05-a", [stepRow(1, "completed", { lane: "web" }, "merge", { outcome: "passed" }), stepRow(2, "completed", { kind: "land" }, "land", { holds: undefined, outcome: "passed" })]);
	assert.equal((await r.update(id, "in_progress")).ok, true, "the other train is done with the lane");
	// It is the start that waits: a step already going is not asked again.
	earlier(r, "2026-11-05-a", [stepRow(1, "in_progress", { lane: "web" })]);
	assert.equal((await r.update(id, "in_progress", { sb: { ...r.sbOf(id), name: "push again" } })).ok, true);
	// A target is held apart from a lane.
	earlier(r, "2026-11-05-b", [stepRow(1, "in_progress", { target: "t1" }, "deploy")]);
	const dep = await r.create(sb({ kind: "deploy", name: "d" }, { check: check(r), on: { head: SHA_A }, holds: { target: "t1" } }), "d");
	assert.equal(dep.ok, true);
	await refused(r.update(3, "in_progress"), "sb: step #3 waiting: target t1 (held by 2026-11-05-b); start it when it is free");
});

test("a board that cannot be read holds every lane of its project, and a project folder that cannot be listed refuses the start", async () => {
	const r = rig();
	mkdirSync(join(r.stateDir, "trainboard", "acme", "2026-11-05-a"), { recursive: true });
	writeFileSync(join(r.stateDir, "trainboard", "acme", "2026-11-05-a", "board.json"), "{ not json");
	await r.create(sb({ kind: "merge", name: "push" }, { check: check(r), on: { head: SHA_A }, holds: { lane: "web" } }));
	await refused(r.update(1, "in_progress"), "sb: step #1 waiting: lane web (held by 2026-11-05-a, unreadable); start it when it is free");
	if (process.getuid?.() === 0) return;
	const unlisted = rig();
	mkdirSync(join(unlisted.stateDir, "trainboard", "acme"), { recursive: true });
	await unlisted.create(sb({ kind: "merge", name: "push" }, { check: check(unlisted), on: { head: SHA_A }, holds: { lane: "web" } }));
	chmodSync(join(unlisted.stateDir, "trainboard", "acme"), 0o000);
	try {
		await refused(unlisted.update(1, "in_progress"), /^sb: step #1 cannot start: what trains of project acme hold cannot be known: cannot list/);
	} finally {
		chmodSync(join(unlisted.stateDir, "trainboard", "acme"), 0o700);
	}
});

// ---- §7.2: MonitorCreate

test("a run step's monitor is rewritten in place to the wrapper: command, timeout, and the frozen spec; description stays", async () => {
	const r = rig({ node: "/usr/local/bin/node" });
	const id = await r.begin(run(r));
	const input = { description: r.describe(id), command: "true", timeout: 5000, onDone: "go on" };
	const reply = await r.monitor(input);
	assert.equal(reply.ok, true, reply.reason ?? "");
	assert.equal(reply.input, input, "the same object, changed in place");
	assert.equal(input.description, "train 1106m #1 full-check");
	assert.equal(input.onDone, "go on");
	assert.equal(input.command, `'/usr/local/bin/node' '/pkg/src/server/cli.ts' train gate --spec '${r.frozen(id)}'`);
	assert.equal(input.timeout, 120_000, "never below 120 s, so the inactivity timeout never ends a long gate");
	const file = r.frozen(id);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
	assert.equal(readFileSync(file, "utf8"), frozenText(r.sbOf(id)));
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), r.sbOf(id));
	for (const [given, wanted] of [[3_600_000, 3_600_000], [undefined, 120_000], [0, 120_000], [119_999, 120_000]] as const) {
		const other = rig();
		const step = await other.begin(run(other));
		const call: Json = { description: other.describe(step), command: "true", ...(given === undefined ? {} : { timeout: given }) };
		assert.equal((await other.monitor(call)).ok, true);
		assert.equal(call.timeout, wanted, `timeout ${String(given)}`);
	}
});

test("the frozen text is the step without its result, keys in order; its hash is what the guard keeps", () => {
	const step = run(rig(), { name: "unit" });
	assert.equal(frozenText({ ...step, result: result() }), frozenText(step), "the result is no part of it");
	assert.equal(frozenText({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 2 } }), '{"a":{"c":2,"d":[{"y":2,"z":1}]},"b":1}\n');
	assert.equal(specHash(step), sha(frozenText(step)));
});

test("a `'` in the state folder, the node path or the CLI path is escaped, so the command the shell runs names exactly those paths", async () => {
	const r = rig({ stateName: "it's a state", node: "/bin/echo" });
	const id = await r.begin(run(r));
	const input: Json = { description: r.describe(id), command: "true" };
	assert.equal((await r.monitor(input)).ok, true);
	assert.match(String(input.command), /--spec '.*it'\\''s a state.*step-1\.json'$/);
	assert.equal(execFileSync("/bin/sh", ["-c", String(input.command)], { encoding: "utf8" }).trim(), `/pkg/src/server/cli.ts train gate --spec ${r.frozen(id)}`);
	assert.equal(gateCommand("/o'p/node", "/c'li.mjs", "/s'tate/step-1.json"), `'/o'\\''p/node' '/c'\\''li.mjs' train gate --spec '/s'\\''tate/step-1.json'`);
	for (const hostile of ["$(touch pwned)", "`id`", "a b; rm -rf x", "x\ny"]) {
		const out = execFileSync("/bin/sh", ["-c", gateCommand("/bin/echo", hostile, "/tmp/x y")], { encoding: "utf8" });
		assert.equal(out, `${hostile} train gate --spec /tmp/x y\n`);
	}
});

test("a monitor in a train runs one step: it must be described, name a step of this train, and be that step's command", async () => {
	const r = rig();
	await refused(r.monitor({ command: "npm test" }), 'sb: a train\'s monitor runs one step: describe it "train 1106m #<id> <kind>"');
	await refused(r.monitor({ description: "unit tests", command: "npm test" }), /^sb: a train's monitor runs one step: describe it "train 1106m #<id> <kind>"/);
	await refused(r.monitor({ description: "train 1106n #1 full-check", command: "true" }), /^sb: a train's monitor runs one step/);
	await refused(r.monitor({ description: "train 1106m #1 full-check" }), /^sb: a train's monitor runs one step/);
	await refused(r.monitor({ description: "train 1106m #1 full-check", command: "true" }), /^sb: a train's monitor runs one step/); // there is no step #1
	const id = await r.begin(run(r));
	await refused(r.monitor({ description: `train 1106m #${id} merge`, command: "true" }), /^sb: a train's monitor runs one step/);
	await refused(r.monitor({ description: r.describe(id), command: "npm test" }), 'sb: step #1 runs "true", not this command');
	await refused(r.monitor({ description: r.describe(id), command: "true " }), 'sb: step #1 runs "true", not this command');
	const second = await r.create(run(r, { name: "lint" }));
	assert.equal(second.ok, true);
	await refused(r.monitor({ description: "train 1106m #2 full-check", command: "true" }), "sb: step #2 is pending; a monitor starts only for an in_progress step");
	await r.complete(id, result({ outcome: "failed", evidence: "x" }));
	await refused(r.monitor({ description: r.describe(id), command: "true" }), "sb: step #1 is completed; a monitor starts only for an in_progress step");
	assert.ok(existsSync(join(r.stateDir, "trainboard", "acme", CODE, "step-2.json")) === false, "a refused call freezes nothing");
});

test("a monitor of a step that is not a run check, whose spec is invalid, or that names another train is refused", async () => {
	const r = rig();
	const git = await r.begin(sb({ kind: "assemble", name: "round 1" }, { check: check(r), on: { head: SHA_A } }));
	await refused(r.monitor({ description: r.describe(git), command: "true" }), /^sb: step #1 is a git check; a monitor runs a run check/);
	// A todo list the model edited around the guard (a step with another train's name) is not run either.
	r.list.tasks.push({ id: 9, subject: "forged", status: "in_progress", metadata: { sb: run(r, { train: "2026-11-06-n", name: "forged" }) } });
	r.persist();
	await refused(r.monitor({ description: "train 1106m #9 full-check", command: "true" }), /^sb: step #9 names train 2026-11-06-n, round 1; this train is 2026-11-06-m, round 1/);
	r.list.tasks.push({ id: 10, subject: "no sb", status: "in_progress" });
	await refused(r.monitor({ description: "train 1106m #10 full-check", command: "true" }), /^sb: a train's monitor runs one step|every todo of a train is a step/);
});

test("a herdrPaneId monitor in a train is refused, whatever else it carries", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	await refused(r.monitor({ herdrPaneId: "wA:p3", onSignal: "go" }), "sb: a train's monitor runs a step's command; herdrPaneId is refused");
	await refused(r.monitor({ herdrPaneId: "wA:p3", onSignal: "go", description: r.describe(id), command: "true" }), "sb: a train's monitor runs a step's command; herdrPaneId is refused");
	await refused(r.monitor({ herdrPaneId: "", description: r.describe(id), command: "true" }), "herdrPaneId is refused");
});

test("one monitor at a time for a step: a second is refused while the first starts or runs, and allowed once it ended", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	const first: Json = { description: r.describe(id), command: "true" };
	assert.equal((await r.monitor(first)).ok, true);
	await refused(r.monitor({ description: r.describe(id), command: "true" }), "sb: step #1 already has a running monitor (#starting)");
	const monitor = r.started(first, "m77");
	await refused(r.monitor({ description: r.describe(id), command: "true" }), "sb: step #1 already has a running monitor (#m77)");
	r.output(monitor, r.lines(id, "full-check", "running"));
	r.finished(monitor, { status: "error", exitCode: 1, reportedOutcome: { status: "failed" } });
	assert.equal((await r.monitor({ description: r.describe(id), command: "true" })).ok, true);
});

test("a monitor the tool failed to start does not hold the step: its error result frees it, and so does the passing of a minute", async () => {
	const r = rig();
	const id = await r.begin(run(r));
	const first: Json = { description: r.describe(id), command: "true" };
	await r.fire("tool_call", { toolName: "MonitorCreate", toolCallId: "boom", input: first });
	await r.fire("tool_result", { toolName: "MonitorCreate", toolCallId: "boom", input: first, content: [], isError: true });
	assert.equal((await r.monitor({ description: r.describe(id), command: "true" })).ok, true, "an error result frees it");
	r.tick(61_000);
	assert.equal((await r.monitor({ description: r.describe(id), command: "true" })).ok, true, "so does time");
});

test("monitors outside a train are none of the guard's: a main's MonitorCreate and todo pass untouched", async () => {
	const r = rig({ main: true, train: false });
	const input = { description: "unit tests", command: "npm test" };
	assert.equal((await r.monitor(input)).ok, true);
	assert.deepEqual(input, { description: "unit tests", command: "npm test" });
	assert.equal((await r.todo({ action: "create", subject: "plain" })).ok, true);
	assert.equal((await r.todo({ action: "create", subject: "x", metadata: { other: { sb: 1 } } })).ok, true);
});

// ---- the wrapper itself, end to end

test("the real wrapper under the guard: its lines carry the hash of the file it read, the run passes, and an edited file or a failing command does not", async () => {
	const r = rig({ node: process.execPath, cli: serverCli() });
	const runIn = (input: Json) => {
		const out = execFileSync("/bin/sh", ["-c", String(input.command)], { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		return out.split("\n").filter(Boolean);
	};
	const feed = (input: Json, outLines: string[], exit: number) => {
		const id = r.started(input);
		outLines.forEach((line) => r.output(id, line));
		const last = JSON.parse(outLines.at(-1)!) as { monitorOutcome: { status: string; message: string } };
		r.finished(id, exit === 0 ? { reportedOutcome: last.monitorOutcome } : { status: "error", exitCode: exit, reportedOutcome: last.monitorOutcome });
		return id;
	};
	const id = await r.begin(run(r, { name: "true" }, { check: runCheck({ cwd: r.cwd, run: "true", log: join(r.cwd, "true.log") }) }));
	const input: Json = { description: r.describe(id), command: "true" };
	assert.equal((await r.monitor(input)).ok, true);
	const printed = runIn(input);
	const last = JSON.parse(printed.at(-1)!) as { monitorOutcome: { status: string }; sb: { spec: string; step: number; train: string } };
	assert.equal(last.monitorOutcome.status, "passed");
	assert.deepEqual([last.sb.step, last.sb.train, last.sb.spec], [id, CODE, r.hashOf(id)], "the wrapper says which spec it ran");
	feed(input, printed, 0);
	assert.equal((await r.complete(id, result())).ok, true);

	// A step file edited between the freeze and the wrapper's read: the wrapper runs the edit and says so.
	const edited = await r.begin(run(r, { name: "edited" }, { check: runCheck({ cwd: r.cwd, run: "false", log: join(r.cwd, "edited.log") }) }));
	const second: Json = { description: r.describe(edited), command: "false" };
	assert.equal((await r.monitor(second)).ok, true);
	const file = r.frozen(edited), spec = JSON.parse(readFileSync(file, "utf8")) as Json;
	writeFileSync(file, JSON.stringify({ ...spec, spec: { ...(spec.spec as Json), check: { ...((spec.spec as Json).check as Json), run: "true" } } }));
	const cheat = runIn(second);
	assert.equal((JSON.parse(cheat.at(-1)!) as { monitorOutcome: { status: string } }).monitorOutcome.status, "passed", "the wrapper ran the edit, and it passed");
	feed(second, cheat, 0);
	await refused(r.complete(edited, result()), "(last: ran another spec)");

	// A command that fails fails the run.
	const bad = await r.begin(run(r, { name: "bad" }, { check: runCheck({ cwd: r.cwd, run: "false", log: join(r.cwd, "bad.log") }) }));
	const third: Json = { description: r.describe(bad), command: "false" };
	assert.equal((await r.monitor(third)).ok, true);
	let failed: string[] = [];
	try {
		runIn(third);
	} catch (error) {
		failed = String((error as { stdout?: string }).stdout).split("\n").filter(Boolean);
	}
	assert.equal((JSON.parse(failed.at(-1)!) as { monitorOutcome: { status: string } }).monitorOutcome.status, "failed");
	feed(third, failed, 1);
	await refused(r.complete(bad, result()), "(last: failed)");
});

// ---- the board

test("every todo call rewrites the train's board from the list: steps, round, cars from the manifest, the writer, and the waits", async () => {
	const r = rig({ manifest: MANIFEST_HEADER + slipBlock() + "\n" });
	await r.create(assembleOf(r, { cars: ["T-15"] }));
	const first = readBoard(r.boardFile);
	assert.ok(first.ok, first.ok ? "" : first.reason);
	if (!first.ok) return;
	const { board } = first;
	assert.deepEqual([board.project, board.app, board.code, board.round], ["acme", "web", CODE, 1]);
	assert.deepEqual(board.steps.map((s) => [s.id, s.kind, s.name, s.status, s.round]), [[1, "assemble", "round 1", "pending", 1]]);
	assert.deepEqual(board.cars.map((c) => [c.tickets, c.head, c.coordinator, c.departs, c.accept]), [[["T-15"], SHA_A, "sess-coord-1", "next", "/r/accept.json"]]);
	assert.equal(board.writer.session, "sess-train-1");
	assert.equal(board.writer.pane, "wA:p2");
	assert.equal(board.writer.pid, process.pid);
	assert.deepEqual(validateBoard(board), []);
	assert.equal((await r.create(run(r, { name: "early" }))).ok, true);
	assert.equal((await r.update(2, "in_progress")).ok, false, "a step of the round waits for its assemble");
	await r.complete(1, result({ outcome: "void", why: "skipped", evidence: "the app declares no assemble" }));
	const id = await r.begin(run(r, { name: "unit" }, { holds: { lane: "web" }, lock: "heavy", load: { max: 30, weight: 4 } }));
	await r.runStep(id);
	await r.complete(id, result({ evidence: "exit 0 in 1s" }));
	const after = readBoard(r.boardFile);
	assert.ok(after.ok);
	if (!after.ok) return;
	const step = after.board.steps.find((s) => s.id === id)!;
	assert.deepEqual([step.status, step.outcome, step.holds, step.lock, step.load], ["completed", "passed", { lane: "web" }, "heavy", { max: 30, weight: 4 }]);
	assert.equal(statSync(r.boardFile).mode & 0o777, 0o600);
	assert.equal(statSync(join(r.boardFile, "..")).mode & 0o777, 0o700);
});

test("the board keeps `train clear`'s clears, and mends a board the train's shell rewrote", async () => {
	const r = rig();
	await r.create(run(r, {}, { holds: { lane: "web" } }));
	const read = readBoard(r.boardFile);
	assert.ok(read.ok);
	if (!read.ok) return;
	writeBoard(r.stateDir, { ...read.board, clears: [{ lane: "web", reason: "web reads back 1.0", by: "cli train clear (boss)", at: "2026-11-07T09:00:00Z" }] });
	await r.update(1, "in_progress");
	const kept = readBoard(r.boardFile);
	assert.ok(kept.ok);
	if (!kept.ok) return;
	assert.deepEqual(kept.board.clears, [{ lane: "web", reason: "web reads back 1.0", by: "cli train clear (boss)", at: "2026-11-07T09:00:00Z" }]);
	assert.equal(kept.board.steps[0]!.status, "in_progress");
	// The shell edits the board to say the step passed; the next write is from the list.
	writeFileSync(r.boardFile, JSON.stringify({ ...kept.board, steps: [{ ...kept.board.steps[0]!, status: "completed", outcome: "passed" }] }));
	await r.todo({ action: "list" });
	assert.equal((readBoard(r.boardFile) as { board: { steps: { status: string }[] } }).board.steps[0]!.status, "in_progress", "the next todo call, a read too, writes the board from the list again");
	assert.deepEqual((readBoard(r.boardFile) as { board: { clears: unknown[] } }).board.clears.length, 1, "and the clear is still there");
	writeFileSync(r.boardFile, "garbage");
	await r.update(1, "in_progress");
	assert.ok(readBoard(r.boardFile).ok, "an unreadable board is replaced");
	assert.equal(existsSync(boardPath(r.stateDir, "acme", CODE)), true);
});

test("a land step that completed ends the board; the writer that cannot write a board tells once and never fails the todo call", async () => {
	const r = rig({ cars: { views: [landedView({ attempts: [], deliveredAt: "2026-11-07T08:31:00Z" })] } });
	const id = await r.begin(sb({ kind: "land", name: "land" }, { check: { type: "notice", cars: ["T-15"], state: "landed" } }));
	await r.complete(id, result());
	const board = readBoard(r.boardFile);
	assert.ok(board.ok);
	if (board.ok) assert.equal(boardState(board.board, { now: r.now(), alive: true }), "ended");
	const bad = rig();
	writeFileSync(join(bad.stateDir, "trainboard"), "a file where the folder should be");
	const reply = await bad.create(run(bad));
	assert.equal(reply.ok, true, "the call went through");
	await bad.update(1, "in_progress");
	assert.equal(bad.told.filter((t) => /trainboard/.test(t)).length, 1, "and the board's failure was told once");
});

// ---- the integrator's `train` todo (§7.4)

const trainTodo = (over: Json = {}, car: Json = {}) => ({ v: 1, project: "acme", app: "web", train: CODE, kind: "train", spec: { cars: [{ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "none", ...car }] }, ...over });

/** The server's answer about T-15 once the integrator received it. */
const receivedView = (notice?: Json, over: Json = {}): CarView => ({
	file: { v: 1, project: "acme", app: "web", car: { tickets: ["T-15"], branch: "fix/t-15", head: SHA_A }, coordinator: "sess-coord-1", states: [{ state: "received", at: "2026-11-07T08:00:00Z", by: { role: "main", name: "integ acme", session: "sess-integ-1" }, train: CODE, departs: "next train", ...over }] },
	...(notice ? { notice: { v: 1, states: { received: notice as never } } } : {}),
});

test("the integrator's `train` todo is checked with validateTrainTodo: a well-formed one passes, a malformed one is refused in its words", async () => {
	const r = rig({ main: true, train: false, cars: { views: [receivedView({ attempts: [], deliveredAt: "2026-11-07T08:01:00Z" })] } });
	r.entries.push(forwardEntry("sess-coord-1"));
	assert.equal((await r.create(trainTodo())).ok, true);
	await refused(r.create(trainTodo({ kind: "full-check" })), "sb: metadata.sb.kind must be train");
	await refused(r.create(trainTodo({ spec: { cars: [] } })), /metadata\.sb\.spec\.cars must be a list of 1 to 32 cars/);
	await refused(r.create(trainTodo({ project: "other" })), "sb: step #2 names project other; this integrator's is acme");
	await refused(r.create(trainTodo({ extra: 1 })), "sb: metadata.sb.extra is not a field");
	assert.equal((await r.update(1, "in_progress")).ok, true);
	await refused(r.update(1, "completed"), "sb: completed needs a result in metadata.sb.result");
	await refused(r.complete(1, { outcome: "passed", at: "2026-11-07T08:40:00Z" }), /passed needs result\.session/);
	assert.equal((await r.complete(1, { outcome: "passed", session: "sess-train-1", at: "2026-11-07T08:40:00Z" })).ok, true);
	assert.equal((await r.todo({ action: "create", subject: "plain note" })).ok, true, "a todo with no metadata.sb is none of the guard's");
});

test("the integrator's `train` todo goes in_progress only when every car's received notice is told and the tower's forward names the slip's coordinator (§5.5, §7.4)", async () => {
	const views = { views: [] as CarView[] };
	const r = rig({ main: true, train: false, cars: views });
	assert.equal((await r.create(trainTodo())).ok, true, "creating it waits for nothing");
	await refused(r.update(1, "in_progress"), "sb: car T-15 has no forward by the tower on this branch: a car slip reaches the integrator as the tower's forward, whose header names its sender (fwd-from)");
	// A header that names a sender the broker did not send it from, or is no tower's, is no forward.
	r.entries.push(forwardEntry("sess-coord-1", slipBlock(), { sender: "sess-coord-1", id: "tower-1" }), forwardEntry("sess-coord-1", slipBlock(), { role: "main" }), forwardEntry("sess-coord-1", slipBlock(), { kind: "call_tower" }));
	await refused(r.update(1, "in_progress"), /has no forward by the tower/);
	r.entries.push(forwardEntry("sess-other"));
	await refused(r.update(1, "in_progress"), coordinatorWord("T-15", "sess-coord-1", "sess-other"));
	r.entries.push(forwardEntry("sess-coord-1"));
	await refused(r.update(1, "in_progress"), "sb: car T-15 was never received: set it received with train_car first");
	views.views = [receivedView()];
	await refused(r.update(1, "in_progress"), "sb: waits for sb to tell sess-coord-1 that car T-15 is received (0 attempts)");
	views.views = [receivedView({ attempts: [{ at: "2026-11-07T08:01:00Z", outcome: "queued", answer: "queued" }] })];
	await refused(r.update(1, "in_progress"), "sb: waits for sb to tell sess-coord-1 that car T-15 is received (1 attempt, last: queued)");
	views.views = [receivedView({ attempts: [{ at: "2026-11-07T08:01:00Z", outcome: "not-live" }], escalatedAt: "2026-11-07T08:02:00Z" })];
	assert.equal((await r.update(1, "in_progress")).ok, true, "escalated counts");
	// A car file the integrator wrote itself is no receipt: the guard asks the server.
	const own = rig({ main: true, train: false, cars: { views: [] } });
	own.entries.push(forwardEntry("sess-coord-1"));
	await own.create(trainTodo());
	const dir = join(own.stateDir, "trainboard", "acme", "cars");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `web-${SHA_A.slice(0, 12)}.json`), JSON.stringify(receivedView().file));
	writeFileSync(join(dir, `web-${SHA_A.slice(0, 12)}.notice.json`), JSON.stringify({ v: 1, states: { received: { attempts: [], deliveredAt: "2026-11-07T08:01:00Z" } } }));
	await refused(own.update(1, "in_progress"), "sb: car T-15 was never received: set it received with train_car first");
});

test("at the integrator, a car whose evidence asks for acceptance, names another head, or cannot be read is refused", async () => {
	const r = rig({ main: true, train: false });
	const log = join(r.root, "e2e.log");
	writeFileSync(log, "ok");
	const file = join(r.root, "evidence.json");
	const put = (value: unknown) => writeFileSync(file, JSON.stringify(value));
	put(evidence({}, { evidence: log }));
	assert.equal((await r.create(trainTodo({}, { accept: file }))).ok, true);
	put(evidence({}, { evidence: log, result: "pending" }));
	assert.ok(asRefusal(await r.create(trainTodo({}, { accept: file }))).startsWith(word("T-15", "e2e", "evidence entry 1: result pending")));
	put(evidence({ car: { app: "web", tickets: ["T-15"], branch: "fix/t-15", head: SHA_B } }, { evidence: log, on: { head: SHA_B } }));
	await refused(r.create(trainTodo({}, { accept: file })), "sb: evidence.car.head is not the slip's head");
	await refused(r.create(trainTodo({}, { accept: join(r.root, "missing.json") })), /^sb: car T-15: cannot read the evidence file/);
	put({ ...evidence({}, { evidence: log }), conditions: [] });
	assert.ok(asRefusal(await r.create(trainTodo({}, { accept: file }))).startsWith(word("T-15", "UAT conditions", "evidence file: top-level conditions, the old format")));
	assert.equal(r.list.tasks.length, 1);
});

test("the integrator's yard: every train todo is a forming, departing or opened train in the project's yard.json", async () => {
	const r = rig({ main: true, train: false });
	await r.create(trainTodo());
	await r.create(trainTodo({ train: "2026-11-06-n" }, { tickets: ["T-20"], head: SHA_B }));
	const yard = JSON.parse(readFileSync(r.yardFile, "utf8")) as { project: string; trains: { code: string; app: string; status: string; session?: string; cars: { tickets: string[] }[] }[]; writer: { session: string } };
	assert.equal(yard.project, "acme");
	assert.equal(yard.writer.session, "sess-train-1");
	assert.deepEqual(yard.trains.map((t) => [t.code, t.app, t.status, t.cars[0]!.tickets[0]]), [[CODE, "web", "forming", "T-15"], ["2026-11-06-n", "web", "forming", "T-20"]]);
	await r.update(1, "in_progress");
	await r.complete(1, { outcome: "passed", session: "sess-train-9", at: "2026-11-07T08:40:00Z" });
	const after = JSON.parse(readFileSync(r.yardFile, "utf8")) as typeof yard;
	assert.deepEqual(after.trains.map((t) => [t.code, t.status, t.session]), [[CODE, "opened", "sess-train-9"], ["2026-11-06-n", "forming", undefined]]);
});

// ---- off, and the whole thing through the extension

test("the sidebar's step token: the current step's glyph and kind, at most 24 characters", async () => {
	const { stepToken } = await import("../src/trainboard.ts");
	const row = (id: number, kind: string, status: string, over: Json = {}) => ({ id, kind, status, round: 1, ...over });
	assert.equal(stepToken([row(1, "assemble", "completed", { outcome: "passed" }), row(2, "full-check", "in_progress", { running: true })] as never), "\uF04B full-check");
	assert.equal(stepToken([row(2, "full-check", "in_progress", { waits: [{ load: { max: 30, now: 42 } }] })] as never), "\uF254 full-check");
	assert.equal(stepToken([row(1, "deploy-verify", "completed", { outcome: "failed" })] as never), "\uF00D deploy-verify");
	assert.equal(stepToken([row(1, "land", "completed", { outcome: "passed" })] as never), "\uF00C land");
	assert.equal(stepToken([row(1, "rollback", "in_progress")] as never), "\uF0E2 rollback");
	assert.equal(stepToken([] as never), undefined);
	assert.ok(stepToken([row(1, "deploy-verify", "in_progress")] as never)!.length <= 24);
});

test("agent kinds §2: only the integrator duty writes the yard; after a switch away a turn_end writes none, and a train todo needs the duty", async () => {
	const o = { main: true, train: false, duty: "integrator" };
	const r = rig(o);
	await r.create(trainTodo());
	assert.equal(existsSync(r.yardFile), true);
	rmSync(r.yardFile);
	o.duty = "standing";
	await r.handlers.get("turn_end")![0]!({ type: "turn_end" }, { cwd: r.cwd, sessionManager: { getBranch: () => r.entries, getEntries: () => r.entries } });
	assert.equal(existsSync(r.yardFile), false, "a former integrator stops writing");
	const refused = await r.create(trainTodo({ train: "2026-11-06-n" }, { tickets: ["T-20"], head: SHA_B }));
	assert.equal(refused.ok, false);
	assert.match(refused.reason ?? "", /a train todo is the integrator's: call boss_duty with duty "integrator" first/);
});
