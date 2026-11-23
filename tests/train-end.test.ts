import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { run } from "../src/server/cli.ts";
import { runningTrains, trainsRefusal } from "../src/server/restartguard.ts";
import { startMs } from "../src/server/traingate.ts";
import { startOf } from "../src/startof.ts";
import { type Board, boardPath, boardState, endOf, endPath, expired, factsOf, readBoard, readEnd, readTrainboards, validateBoard, validateEnd, writeBoard, writeEnd } from "../src/train/board.ts";
import { holding } from "../src/train/waits.ts";
import { CODE, SHA_A, SHA_B, slip } from "./train-fixtures.ts";

// sb friction 11/20 (0.80.17): A1 `train end` and `train status --state`, A5 and A6 `train check` (the slip's head in git, apps.json from an app's folder, integration.accept by default), A3 the restart guard.

const ROOT = process.env.SB_TEST_ROOT!;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) try { fn(); } catch { /* best effort */ } });
const base = () => { const dir = mkdtempSync(join(ROOT, "te-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const PROJECT = "acme", MIN = 60_000, DAY = 24 * 60 * MIN, NOW = Date.parse("2026-11-07T08:00:00Z");

const board = (code = CODE, over: Partial<Board> = {}): Board => ({
	v: 1, project: PROJECT, app: "web", code, writer: { session: "sess-train-1", pid: 4242, started: "2026-11-07T06:00:00.000Z" }, updated: "2026-11-07T07:00:00.000Z", round: 1,
	cars: [{ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "none" }],
	steps: [{ id: 1, kind: "merge", name: "merge", status: "completed", round: 1, holds: { lane: "web" }, outcome: "failed" }, { id: 2, kind: "land", name: "land", status: "pending", round: 1, holds: { lane: "web" } }],
	...over,
});
const end = (over: Record<string, unknown> = {}) => ({ v: 1 as const, outcome: "landed" as const, commit: SHA_B, reason: "the fetch timed out; the merge is on develop", evidence: "git merge-base --is-ancestor passes on origin/develop", by: "cli train end (tester)", at: "2026-11-07T08:00:00.000Z", ...over });

// ---- the board's end, in end.json beside it (SBR-F001)

/** The top-level keys a board may have in 0.80.16 (6eb292b9 `validateBoard`): an older reader refuses any other, and a refused board holds every lane and target of its project. */
const OLD_BOARD_KEYS = ["v", "project", "app", "code", "writer", "updated", "round", "cars", "steps", "clears", "removed"];

test("A1: an end validates (landed needs a 40-hex commit, none has none), makes the train ended, holds nothing, and expires 30 days after the end", () => {
	assert.deepEqual(validateEnd(end()), []);
	assert.deepEqual(validateEnd(end({ outcome: "none", commit: undefined })), []);
	const refused = (value: unknown, pattern: RegExp) => assert.ok(validateEnd(value).some((r) => pattern.test(r)), `${pattern}: ${JSON.stringify(validateEnd(value))}`);
	refused(end({ commit: undefined }), /end\.commit must be 40 hex for a landed end/);
	refused(end({ outcome: "none" }), /end\.commit is set only for a landed end/);
	refused(end({ outcome: "merged" }), /end\.outcome must be landed or none/);
	refused(end({ v: 2 }), /end\.v must be 1/);
	refused(end({ reason: "" }), /end\.reason/);
	refused(end({ evidence: "x".repeat(601) }), /end\.evidence/);
	refused(end({ at: "yesterday" }), /end\.at/);
	refused(end({ extra: 1 }), /end\.extra is not a field/);
	refused("landed", /end must be an object/);

	const stale = board();
	assert.equal(boardState(stale, { now: NOW, alive: false }), "stale", "a board without an end reads as before");
	assert.equal(boardState(stale, { now: NOW, alive: false, end: end() }), "ended");
	const facts = factsOf({ project: PROJECT, code: CODE, file: "", ok: true, board: stale, end: end() }, { now: NOW, alive: () => false });
	assert.deepEqual(holding(facts), { lanes: [], targets: [], all: false });
	assert.deepEqual(holding(factsOf({ project: PROJECT, code: CODE, file: "", ok: true, board: stale }, { now: NOW, alive: () => false })).lanes, ["web"], "the stale one held its lane");
	const at = Date.parse(end().at);
	assert.equal(expired(stale, { now: at + 30 * DAY - 1, alive: false, end: end() }), false, "30 days after the end, not after the older update");
	assert.equal(expired(stale, { now: at + 30 * DAY, alive: false, end: end() }), true);
	// A session that came back and wrote its board after the end has resumed: the end no longer counts.
	const resumed = board(CODE, { updated: "2026-11-07T08:05:00.000Z" });
	assert.equal(endOf(resumed, end()), undefined);
	assert.equal(boardState(resumed, { now: NOW + 5 * MIN, alive: true, end: end() }), "live");
	assert.equal(expired(resumed, { now: at + 30 * DAY, alive: false, end: end() }), false, "nor does it expire the board, which is stale again and holds");
});

test("SBR-F001: train end leaves board.json as every version reads it, writes end.json beside it, and the new readers see the train ended", async () => {
	const stateDir = join(base(), "state");
	writeBoard(stateDir, board());
	const before = readFileSync(boardPath(stateDir, PROJECT, CODE), "utf8");
	assert.equal(await run(["train", "end", "--project", PROJECT, "--train", CODE, "--outcome", "none", "--reason", "no cars left", "--evidence", "ledger"], { out: () => {}, err: () => {}, stateDir, train: { now: () => NOW, alive: () => false, user: "tester" } }), 0);
	const raw = readFileSync(boardPath(stateDir, PROJECT, CODE), "utf8");
	assert.equal(raw, before, "board.json is not touched");
	assert.deepEqual(Object.keys(JSON.parse(raw)).filter((k) => !OLD_BOARD_KEYS.includes(k)), [], "no key a 0.80.16 reader refuses");
	assert.deepEqual(validateBoard(JSON.parse(raw)), []);
	assert.equal(readEnd(boardPath(stateDir, PROJECT, CODE)).end?.outcome, "none");
	const [read] = readTrainboards(stateDir).trains;
	assert.ok(read?.ok && read.end);
	assert.equal(factsOf(read!, { now: NOW, alive: () => false }).state, "ended");
	// An end.json that does not read is no end: the train reads as it did, stale, and status says why.
	writeFileSync(endPath(stateDir, PROJECT, CODE), "{nope");
	const [bad] = readTrainboards(stateDir).trains;
	assert.ok(bad?.ok && !bad.end && /end\.json: not JSON/.test(bad.endProblem ?? ""));
	assert.equal(factsOf(bad!, { now: NOW, alive: () => false }).state, "stale");
});

// ---- train end

test("A1: train end ends a stale train with landed and a commit, or none; refuses a live, recent, ended or unreadable one and every wrong flag", async () => {
	const stateDir = join(base(), "state"), out: string[] = [], err: string[] = [];
	const go = (code: string, alive: boolean, ...rest: string[]) => (out.length = 0, err.length = 0, run(["train", "end", "--project", PROJECT, "--train", code, ...rest], { out: (t) => out.push(t), err: (t) => err.push(t), stateDir, train: { now: () => NOW, alive: () => alive, user: "tester" } }));
	const landed = ["--outcome", "landed", "--commit", SHA_B, "--reason", "the fetch timed out; the merge is on develop", "--evidence", "merge-base --is-ancestor passes"];
	writeBoard(stateDir, board());
	// usage
	assert.equal(await go(CODE, false, "--outcome", "landed", "--reason", "r", "--evidence", "e"), 2, "landed without a commit");
	assert.match(err.join(""), /--outcome landed needs --commit/);
	assert.equal(await go(CODE, false, "--outcome", "landed", "--commit", "abc123", "--reason", "r", "--evidence", "e"), 2, "a short commit");
	assert.equal(await go(CODE, false, "--outcome", "none", "--commit", SHA_B, "--reason", "r", "--evidence", "e"), 2);
	assert.match(err.join(""), /--commit goes with --outcome landed/);
	assert.equal(await go(CODE, false, "--outcome", "merged", "--reason", "r", "--evidence", "e"), 2);
	assert.equal(await go(CODE, false, "--outcome", "none", "--reason", "r"), 2, "no evidence");
	assert.equal(await go(CODE, false, "--outcome", "none", "--reason", "  ", "--evidence", "e"), 2);
	assert.equal(await go("../x", false, "--outcome", "none", "--reason", "r", "--evidence", "e"), 2);
	// live
	assert.equal(await go(CODE, true, ...landed), 1);
	assert.match(err.join(""), /^sb: train .* session is live \(pid 4242\); only a train whose session is gone can be ended/);
	// recent
	writeBoard(stateDir, board("2026-11-06-b", { updated: "2026-11-07T07:55:00.000Z" }));
	assert.equal(await go("2026-11-06-b", false, ...landed), 1);
	assert.match(err.join(""), /less than 10 minutes ago; it is stale after that, and only a stale train can be ended/);
	// unreadable
	mkdirSync(join(stateDir, "trainboard", PROJECT, "2026-11-06-d"), { recursive: true });
	writeFileSync(join(stateDir, "trainboard", PROJECT, "2026-11-06-d", "board.json"), "garbage");
	assert.equal(await go("2026-11-06-d", false, ...landed), 1);
	assert.match(err.join(""), /cannot be read/);
	// ended by its land step
	writeBoard(stateDir, board("2026-11-06-c", { steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] }));
	assert.equal(await go("2026-11-06-c", false, ...landed), 1);
	assert.match(err.join(""), /has ended already \(its land step completed\)/);
	// the stale one ends
	assert.equal(await go(CODE, false, ...landed), 0, err.join(""));
	assert.deepEqual(JSON.parse(out.join("")), { ok: true, project: PROJECT, train: CODE, end: end({ evidence: "merge-base --is-ancestor passes" }) });
	const after = readBoard(boardPath(stateDir, PROJECT, CODE));
	assert.ok(after.ok);
	if (after.ok) {
		assert.equal(after.board.updated, board().updated, "updated stays");
		assert.equal(boardState(after.board, { now: NOW, alive: false, end: readEnd(boardPath(stateDir, PROJECT, CODE)).end }), "ended");
	}
	assert.equal(await go(CODE, false, "--outcome", "none", "--reason", "r", "--evidence", "e"), 1, "twice");
	assert.match(err.join(""), /has ended already \(landed, by cli train end \(tester\)\)/);
	// F007: a deploy target it still holds is read and cleared first; the lane it holds goes with the end
	writeBoard(stateDir, board("2026-11-06-t", { steps: [{ id: 1, kind: "merge", name: "merge", status: "completed", round: 1, holds: { lane: "web" }, outcome: "passed" }, { id: 2, kind: "deploy", name: "deploy", status: "in_progress", round: 1, holds: { target: "prod" } }] }));
	assert.equal(await go("2026-11-06-t", false, ...landed), 1);
	assert.match(err.join(""), /still holds deploy target prod: read what the target runs, then `train clear --target prod`/);
	assert.equal(await run(["train", "clear", "--project", PROJECT, "--train", "2026-11-06-t", "--target", "prod", "--reason", "prod reads 1.2.3"], { out: () => {}, err: () => {}, stateDir, train: { now: () => NOW, alive: () => false, user: "tester" } }), 0);
	assert.equal(await go("2026-11-06-t", false, ...landed), 0, err.join(""));
	// none
	writeBoard(stateDir, board("2026-11-05-k", { steps: [{ id: 1, kind: "assemble", name: "assemble", status: "completed", round: 2, outcome: "void", why: "skipped" }] }));
	assert.equal(await go("2026-11-05-k", false, "--outcome", "none", "--reason", "round 2 had no cars left", "--evidence", "integ ledger 1116-k: nothing merged"), 0, err.join(""));
	assert.equal(JSON.parse(out.join("")).end.commit, undefined);
});

// ---- train status --state

test("A1: train status --state filters the rows (text and --json), takes a comma list, and shows a train's end", async () => {
	const stateDir = join(base(), "state");
	writeBoard(stateDir, board("2026-11-05-a"));
	writeEnd(stateDir, PROJECT, "2026-11-05-a", end());
	writeBoard(stateDir, board("2026-11-05-b"));
	writeBoard(stateDir, board("2026-11-05-c", { writer: { session: "sess-live", pid: process.pid, started: new Date(startMs(startOf(process.pid)!)).toISOString() } }));
	mkdirSync(join(stateDir, "trainboard", PROJECT, "2026-11-05-d"), { recursive: true });
	writeFileSync(join(stateDir, "trainboard", PROJECT, "2026-11-05-d", "board.json"), "garbage");
	const go = async (...argv: string[]) => {
		const out: string[] = [], err: string[] = [];
		const code = await run(["train", "status", ...argv], { out: (t) => out.push(t), err: (t) => err.push(t), stateDir, train: { now: () => NOW, alive: (w) => w.pid === process.pid, load: () => ({ now: 1, cores: 8 }) } });
		return { code, out: out.join(""), err: err.join("") };
	};
	const codes = (text: string) => (JSON.parse(text) as { trains: { code: string }[] }).trains.map((t) => t.code);
	assert.deepEqual(codes((await go("--json")).out), ["2026-11-05-a", "2026-11-05-b", "2026-11-05-c", "2026-11-05-d"]);
	assert.deepEqual(codes((await go("--json", "--state", "stale")).out), ["2026-11-05-b"]);
	assert.deepEqual(codes((await go("--json", "--state", "live,unreadable")).out), ["2026-11-05-c", "2026-11-05-d"]);
	const ended = await go("--state", "ended");
	assert.match(ended.out, /acme web 2026-11-05-a ended session sess-train-1/);
	assert.match(ended.out, new RegExp(`  end landed ${SHA_B.slice(0, 12)}: the fetch timed out; the merge is on develop \\(evidence: git merge-base`));
	assert.doesNotMatch(ended.out, /2026-11-05-b/);
	assert.equal(JSON.parse((await go("--json", "--state", "ended")).out).trains[0].end.commit, SHA_B);
	const bad = await go("--state", "running");
	assert.equal(bad.code, 2);
	assert.match(bad.err, /--state is a comma list of live, stale, ended, unreadable/);
});

// ---- train check: the project's apps.json from an app's folder, integration.accept by default, the slip's head in git

const git = (cwd: string, ...args: string[]) => {
	const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};

test("A5, A6: train check from an app's own repository reads the project's apps.json above it, requires its integration.accept with no flag, and checks the slip's head is a known commit and the tip of its branch on origin", async () => {
	const dir = base(), project = join(dir, "project"), app = join(project, "apps", "web"), origin = join(dir, "web-origin.git");
	mkdirSync(app, { recursive: true });
	git(dir, "init", "-q", "--bare", origin);
	git(project, "init", "-q");
	git(app, "init", "-q");
	git(app, "remote", "add", "origin", origin);
	git(app, "checkout", "-q", "-b", "fix/t-15");
	git(app, "commit", "-q", "--allow-empty", "-m", "one");
	const older = git(app, "rev-parse", "HEAD");
	git(app, "commit", "-q", "--allow-empty", "-m", "two");
	const tip = git(app, "rev-parse", "HEAD");
	git(app, "push", "-q", "origin", "fix/t-15");
	const apps = (accept: string[]) => (mkdirSync(join(project, ".straw-boss"), { recursive: true }), writeFileSync(join(project, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: "apps/web", integration: { base: "develop", accept } }] })));
	const go = async (head: string, branch = "fix/t-15") => {
		const slipFile = join(dir, "slip.txt"), out: string[] = [], err: string[] = [];
		writeFileSync(slipFile, slip({ head, branch, "tested-on": head, accept: "none" }));
		const code = await run(["train", "check", "--accept", "none", "--slip", slipFile], { out: (t) => out.push(t), err: (t) => err.push(t), stateDir: join(dir, "state"), train: { cwd: app } });
		return { code, refusals: (JSON.parse(out.join("")) as { refusals: string[] }).refusals, err: err.join("") };
	};
	apps(["e2e"]);
	const required = await go(tip);
	assert.equal(required.code, 2);
	assert.match(required.refusals.join(" "), /this app requires e2e/, "found above the app's own repository, and its integration.accept applies without --app-accept");
	apps([]);
	assert.deepEqual(await go(tip), { code: 0, refusals: [], err: "" });
	const typo = `${tip.slice(0, 12)}${"0".repeat(28)}`;
	const unknown = await go(typo);
	assert.equal(unknown.code, 2);
	assert.match(unknown.refusals.join(" "), new RegExp(`slip head ${typo} is not a commit git knows in .*apps/web`));
	const behind = await go(older);
	assert.equal(behind.code, 2);
	assert.match(behind.refusals.join(" "), new RegExp(`slip head ${older} is not the tip of fix/t-15 on origin, which is ${tip}`));
	const unpushed = await go(tip, "fix/other");
	assert.match(unpushed.refusals.join(" "), /origin has no branch fix\/other/);
	git(app, "remote", "set-url", "origin", join(dir, "no-such-origin.git"));
	const offline = await go(tip);
	assert.equal(offline.code, 0, "origin that cannot be asked is a warning, not a refusal");
	assert.match(offline.err, /^sb: warning: the tip of fix\/t-15 on origin could not be read/);
});

// ---- the restart guard

test("A3: a restart is refused while a train runs (its board live and its writer's process the one that wrote it); --force needs --reason", async () => {
	const stateDir = join(base(), "state"), me = { session: "sess-live", pid: process.pid, started: new Date(startMs(startOf(process.pid)!)).toISOString() };
	writeBoard(stateDir, board("2026-11-05-a", { writer: me }));
	writeEnd(stateDir, PROJECT, "2026-11-05-a", end());
	writeBoard(stateDir, board("2026-11-05-b"));
	assert.deepEqual(runningTrains(stateDir), [], "an ended train and a stale one do not run");
	assert.equal(trainsRefusal([], "x"), undefined);
	writeBoard(stateDir, board("2026-11-05-c", { writer: me, updated: new Date().toISOString() }));
	assert.deepEqual(runningTrains(stateDir), [{ project: PROJECT, code: "2026-11-05-c", pid: process.pid }]);
	const err: string[] = [];
	const go = (...argv: string[]) => run(["restart", ...argv], { out: () => {}, err: (t) => err.push(t), stateDir });
	assert.equal(await go("--reason", "roll 0.80.17"), 1);
	assert.match(err.join(""), /^sb: a train runs on this computer: acme 2026-11-05-c \(pid \d+\)\. A restart now loses the server's car book .*give --force with --reason to restart anyway/);
	err.length = 0;
	assert.equal(await go("--force"), 2);
	assert.match(err.join(""), /--force needs --reason/);
});
