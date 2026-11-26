import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { childEnded } from "../src/server/childtie.ts";
import type { Reply, Request } from "../src/server/socket.ts";
import type { LedgerEvent } from "../src/server/ledger.ts";
import { createThreads, IDLE_MS, TTL_MS } from "../src/server/threads.ts";
import { threadReply } from "../src/server/threadsops.ts";
import { fakeClock } from "./fake-clock.ts";

// Review threads on the server (docs/specs/2026-11-23-lite-b2-d-e-f.md §2.3, §2.7 test 1): a main pairs a worker and a reviewer, and the two children, tied to their dispatcher by pi-herdr-agents' own files (laid out here as
// pi-herdr-agents writes them), post and wait through the control commands. The server numbers the posts, keeps the round cap, and closes the thread. The clock and the timers are the test's.

const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-threads-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;

interface Child { session: string; child: string; activityFile: string }
/** pi's sessions folder with parents; `launch` writes a child's launch script, activity file, and session file under one of them. */
function sessions() {
	const dir = join(root, `agent-${++n}`, "sessions"), folder = join(dir, "--Users-me-proj--");
	let k = 0;
	return {
		dir,
		launch(parent: string, name: string, o: { resume?: boolean } = {}): Child {
			const art = join(folder, "artifacts", parent), child = `kid${n}-${++k}`, activityFile = join(art, "subagent-activity", `${child}.json`);
			const session = join(folder, `2026-11-23T00-00-00-000Z_${child}-1a2b-3c4d-5e6f.jsonl`);
			mkdirSync(join(art, "subagent-scripts"), { recursive: true });
			mkdirSync(dirname(activityFile), { recursive: true });
			writeFileSync(activityFile, JSON.stringify({ version: 1, id: child, phase: "active", updatedAt: 1 }));
			writeFileSync(join(art, "subagent-scripts", o.resume ? `${name}-resume-1763078400000.sh` : `${name}-${child}.sh`), `#!/bin/sh\nexport PI_SUBAGENT_ID='${child}'\nexport PI_SUBAGENT_NAME='${name}'\nexport PI_SUBAGENT_SESSION='${session}'\nexec pi\n`);
			writeFileSync(session, `${JSON.stringify({ type: "session", id: child })}\n`);
			return { session, child, activityFile };
		},
	};
}

/** A server's threads on a clock and timers the test moves; `restart` builds them again on the same folder. */
function server(s = sessions(), dir = join(root, `state-${++n}`, "threads")) {
	const clock = fakeClock(1_700_000_000_000), timers = new Set<{ at: number; fn: () => void }>();
	const timer = (ms: number, fn: () => void) => { const t = { at: clock.now() + ms, fn }; timers.add(t); return () => void timers.delete(t); };
	const notes: LedgerEvent[] = [];
	const build = () => createThreads({ dir, now: clock.now, timer, ended: childEnded, holdMs: 45_000, note: (e) => void notes.push(e) });
	let threads = build(), stop = threads.start();
	const ask = (request: Record<string, unknown>) => threadReply(threads, request as Request, s.dir)!;
	return {
		s, dir, clock, notes,
		/** Moves the clock, running the timers it passes in order. */
		advance(ms: number) {
			const end = clock.now() + ms;
			for (let next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]; next; next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]) {
				timers.delete(next);
				clock.advance(next.at - clock.now());
				next.fn();
			}
			clock.advance(end - clock.now());
		},
		restart() { stop(); timers.clear(); threads = build(); stop = threads.start(); },
		pair: (owner: string, worker: string, reviewer: string, rounds?: number) => ask({ cmd: "thread-pair", owner, worker, reviewer, ...(rounds !== undefined ? { rounds } : {}) }),
		member: (c: Child) => ask({ cmd: "thread-member", ...c }),
		post: (c: Child, thread: string, to: string[], tag: string, text: string, refs?: number[]) => ask({ cmd: "thread-post", ...c, thread, to, tag, text, ...(refs ? { refs } : {}) }),
		wait: (c: Child, thread: string, since?: number) => ask({ cmd: "thread-wait", ...c, thread, ...(since !== undefined ? { since } : {}) }),
		read: (owner: string, thread: string) => ask({ cmd: "thread-read", owner, thread }),
		list: (owner: string) => ask({ cmd: "thread-list", owner }),
	};
}
type Server = ReturnType<typeof server>;
/** A main `P…` that paired `w` and `r`, both launched. */
async function paired(rounds?: number, sv: Server = server()) {
	const owner = `P${n}-0000-main`, w = sv.s.launch(owner, "w"), r = sv.s.launch(owner, "r");
	const made = await sv.pair(owner, "w", "r", rounds);
	assert.equal(made.ok, true, JSON.stringify(made));
	return { sv, owner, w, r, thread: String(made.thread) };
}
/** Whether a held wait has answered yet. */
const settled = async (p: Promise<Reply>) => { let done = false; void p.then(() => (done = true)); await new Promise((resolve) => setImmediate(resolve)); return done; };

test("pair opens T1, T2 … per main with the members' names as pi-herdr-agents writes them; a child's member check finds its thread; posts are numbered #1..#n with their sender", async () => {
	const sv = server(), owner = "01a2b3c4-main";
	assert.deepEqual(await sv.pair(owner, "Fix Login", "fix-login-review"), { ok: true, thread: "T1", worker: "fix-login", reviewer: "fix-login-review", rounds: 3 });
	assert.deepEqual(await sv.pair(owner, "b", "c", 1), { ok: true, thread: "T2", worker: "b", reviewer: "c", rounds: 1 });
	assert.equal((await sv.pair(owner, "b", "d")).error, "b is a member of open thread T2: give each pair new names");
	assert.equal((await sv.pair(owner, "x", "X")).error, "worker and reviewer need two names (both read x)");
	assert.equal((await sv.pair(owner, "x", "y", 4)).error, "rounds is 1 to 3");
	assert.equal((await sv.pair(owner, "x", "y", 0)).error, "rounds is 1 to 3");
	const w = sv.s.launch(owner, "fix-login"), r = sv.s.launch(owner, "fix-login-review", { resume: true }), stranger = sv.s.launch(owner, "scout-1");
	assert.deepEqual(await sv.member(w), { ok: true, member: { thread: "T1", as: "worker", rounds: 3 } });
	assert.deepEqual(await sv.member(r), { ok: true, member: { thread: "T1", as: "reviewer", rounds: 3 } }, "a resumed child is known by its resume script's name");
	assert.deepEqual(await sv.member(stranger), { ok: true, member: null });
	const one = await sv.post(w, "T1", ["reviewer"], "review", "branch fix/login, head abc1234, worktree ~/.herdr/worktrees/app/fix-login");
	const two = await sv.post(r, "T1", ["worker"], "fix", "F001: the token is logged", [1]);
	const three = await sv.post(w, "T1", ["reviewer"], "note", "on it");
	assert.deepEqual([one.n, two.n, three.n], [1, 2, 3]);
	assert.deepEqual([two.round, two.rounds], [1, 3]);
	const read = await sv.read(owner, "T1");
	assert.deepEqual((read.list as { n: number; from: string; tag: string; to: string[]; refs?: number[] }[]).map((p) => [p.n, p.from, p.tag, p.to, p.refs]), [[1, "worker", "review", ["reviewer"], undefined], [2, "reviewer", "fix", ["worker"], [1]], [3, "worker", "note", ["reviewer"], undefined]]);
	assert.equal(read.ref, `${owner.slice(0, 8)}/T1`);
	assert.deepEqual((await sv.read("another-main", `${owner.slice(0, 8)}/T1`)).posts, 3, "a successor reads its predecessor's thread by its full reference");
	assert.match(String((await sv.read("another-main", "T1")).error), /^no thread T1 of this session/);
	assert.deepEqual(((await sv.list(owner)).threads as { thread: string }[]).map((t) => t.thread), ["T2", "T1"]);
	const meta = join(sv.dir, owner.slice(0, 8), "T1.jsonl");
	assert.equal(statSync(meta).mode & 0o777, 0o600, "the posts file is the user's only");
});

test("a post wakes only the members it names; a wait returns at once with the posts for it after since, and a hold ends unchanged", async () => {
	const { sv, w, r, thread } = await paired();
	const reviewerWaits = sv.wait(r, thread), workerWaits = sv.wait(w, thread);
	assert.equal(await settled(reviewerWaits), false, "held");
	await sv.post(w, thread, ["reviewer"], "review", "ready: head abc");
	const got = await reviewerWaits;
	assert.equal(got.state, "posts");
	assert.deepEqual((got.posts as { n: number }[]).map((p) => p.n), [1]);
	assert.equal(got.since, 1);
	assert.equal(await settled(workerWaits), false, "a post that does not name the worker leaves its wait held, its own post included");
	await sv.post(r, thread, ["worker"], "note", "reading");
	assert.deepEqual(((await workerWaits).posts as { n: number; text: string }[]).map((p) => [p.n, p.text]), [[2, "reading"]]);
	// A wait with an old since gets what it missed at once; an up-to-date one is held to the hold's end.
	assert.deepEqual(((await sv.wait(w, thread, 0)).posts as { n: number }[]).map((p) => p.n), [2]);
	const quiet = sv.wait(w, thread, 2);
	sv.advance(45_000);
	assert.deepEqual(await quiet, { ok: true, state: "unchanged", thread, posts: [], since: 2 });
});

test("the round cap: the 4th fix with rounds 3 is refused and the thread closes blocked; with rounds 1, the 2nd", async () => {
	const { sv, w, r, thread, owner } = await paired();
	for (let round = 1; round <= 3; round++) {
		await sv.post(w, thread, ["reviewer"], "review", `round ${round}`);
		assert.equal((await sv.post(r, thread, ["worker"], "fix", `findings ${round}`)).round, round);
	}
	await sv.post(w, thread, ["reviewer"], "review", "round 4");
	const waiting = sv.wait(w, thread, 7);
	const fourth = await sv.post(r, thread, ["worker"], "fix", "more findings");
	assert.equal(fourth.ok, false);
	assert.match(String(fourth.error), /^T1 allows 3 repair rounds and all are used: the fix is refused, and the thread is closed blocked/);
	const closed = await waiting;
	assert.equal(closed.state, "closed");
	assert.deepEqual(closed.closed, { by: "sb", tag: "blocked", at: 8, time: sv.clock.now(), reason: "3 repair rounds used" });
	assert.match(String((await sv.post(w, thread, ["reviewer"], "note", "x")).error), /^T1 is closed \(blocked by sb at #8: 3 repair rounds used\)/);
	assert.equal((await sv.read(owner, thread)).fixes, 3);
	const one = await paired(1, sv);
	await sv.post(one.w, one.thread, ["reviewer"], "review", "r1");
	assert.equal((await sv.post(one.r, one.thread, ["worker"], "fix", "f1")).ok, true);
	assert.match(String((await sv.post(one.r, one.thread, ["worker"], "fix", "f2")).error), /allows 1 repair round and all are used/);
});

test("done closes the thread for both members and refuses every later post; blocked from either member closes it too", async () => {
	const { sv, w, r, thread } = await paired();
	await sv.post(w, thread, ["reviewer"], "review", "ready");
	const workerWaits = sv.wait(w, thread, 1), reviewerWaits = sv.wait(r, thread, 1);
	const done = await sv.post(r, thread, ["worker", "main"], "done", "approved: P0=0 P1=0", [1]);
	assert.deepEqual(done.closed, { by: "reviewer", tag: "done", at: 2, time: sv.clock.now() });
	assert.equal((await workerWaits).state, "closed");
	assert.deepEqual(((await workerWaits).posts as { n: number }[]).map((p) => p.n), [2]);
	assert.deepEqual(await reviewerWaits, { ok: true, state: "closed", thread, posts: [], since: 2, closed: done.closed }, "the member that closed it is told too, without its own post");
	assert.match(String((await sv.post(w, thread, ["reviewer"], "note", "thanks")).error), /^T1 is closed \(done by reviewer at #2\)/);
	assert.equal((await sv.member(w)).member, null, "a closed thread has no members to activate");
	const b = await paired(undefined, sv);
	assert.equal((await sv.post(b.w, b.thread, ["reviewer", "main"], "blocked", "the spec contradicts itself")).closed !== undefined, true);
});

test("the tags each member may post, and main only with done or blocked", async () => {
	const { sv, w, r, thread } = await paired();
	assert.equal((await sv.post(w, thread, ["main"], "note", "hi boss")).error, "main may be named only with done or blocked: the main is woken by your final result when the thread closes");
	assert.equal((await sv.post(r, thread, ["worker", "main"], "fix", "x")).error, "main may be named only with done or blocked: the main is woken by your final result when the thread closes");
	assert.equal((await sv.post(w, thread, ["reviewer"], "fix", "x")).error, "only the reviewer posts fix; post review when your work is ready for it");
	assert.equal((await sv.post(w, thread, ["reviewer"], "done", "x")).error, "only the reviewer posts done; post review when your work is ready for it");
	assert.equal((await sv.post(r, thread, ["worker"], "review", "x")).error, "only the worker posts review; the reviewer answers with fix or done");
	assert.equal((await sv.post(w, thread, ["boss"], "note", "x")).error, "to is a list of worker, reviewer, main");
	assert.equal((await sv.post(w, thread, [], "note", "x")).error, "to is a list of worker, reviewer, main");
	assert.equal((await sv.post(w, thread, ["reviewer"], "shout", "x")).error, "tag is one of review, fix, done, blocked, note");
	assert.equal((await sv.post(w, thread, ["reviewer"], "note", "a\u001b[2Jb")).error, "text is 1 to 4000 plain characters");
	assert.equal((await sv.post(w, thread, ["reviewer"], "note", "x".repeat(4001))).error, "text is 1 to 4000 plain characters");
	assert.equal((await sv.post(w, thread, ["reviewer"], "note", "x", [1])).error, "refs are post numbers #1 to #0");
	assert.equal((await sv.post(w, thread, ["reviewer"], "note", "line one\nline\ttwo")).n, 1, "line breaks and tabs are plain");
});

test("only the dispatcher's two children speak on a thread: another child of the same main, a child of another main, a forged tie, and a done child are refused", async () => {
	const { sv, owner, w, thread } = await paired();
	const scout = sv.s.launch(owner, "scout"), foreign = sv.s.launch("Q-other-main", "w");
	assert.match(String((await sv.post(scout, thread, ["reviewer"], "note", "x")).error), /^you \(scout\) are not a member of T1: its worker is w, its reviewer r$/);
	assert.equal((await sv.post(foreign, thread, ["reviewer"], "note", "x")).error, "no thread T1 of the session that dispatched you", "a worker of the same name under another main");
	assert.equal((await sv.wait(foreign, thread)).error, "no thread T1 of the session that dispatched you");
	assert.equal((await sv.post({ ...w, activityFile: join(root, "elsewhere.json") }, thread, ["reviewer"], "note", "x")).error, "outside the sessions folder");
	assert.equal((await sv.post({ ...w, child: "someone-else" }, thread, ["reviewer"], "note", "x")).error, "outside the sessions folder");
	assert.equal((await sv.post({ ...w, session: scout.session }, thread, ["reviewer"], "note", "x")).error, `no launch script ties ${w.child} to that session`);
	assert.equal((await sv.post({ session: w.session, child: w.child } as Child, thread, ["reviewer"], "note", "x")).error, "thread-post needs session, child, and activityFile");
	writeFileSync(w.activityFile, JSON.stringify({ phase: "done" }));
	assert.equal((await sv.post(w, thread, ["reviewer"], "note", "x")).error, "that child is done");
	assert.equal((await sv.read(owner, thread)).posts, 0, "nothing went in");
});

test("the server closes a thread blocked after 2 hours without a post, after 24 hours open, and when a member's run ended", async () => {
	const quiet = await paired();
	quiet.sv.advance(IDLE_MS - 60_000);
	assert.equal((await quiet.sv.post(quiet.w, quiet.thread, ["reviewer"], "review", "late but here")).n, 1, "open until 2 hours pass");
	quiet.sv.advance(IDLE_MS - 30_000);
	const after = quiet.sv.wait(quiet.r, quiet.thread, 1);
	quiet.sv.advance(30_000);
	assert.deepEqual((await after).closed, { by: "sb", tag: "blocked", at: 2, time: quiet.sv.clock.now(), reason: "no post for 2 hours" }, "the sweep's close ends a held wait");
	const long = await paired();
	for (let h = 0; h < 24; h++) (long.sv.advance(3_600_000), await long.sv.post(long.w, long.thread, ["reviewer"], "note", `hour ${h}`));
	assert.ok(long.sv.clock.now() - 1_700_000_000_000 >= TTL_MS);
	long.sv.advance(60_000);
	assert.equal(((await long.sv.read(long.owner, long.thread)).closed as { reason: string }).reason, "open for 24 hours, the thread's limit");
	const gone = await paired();
	await gone.sv.member(gone.w); // the worker's first run: its activity file is known from here
	writeFileSync(gone.w.activityFile, JSON.stringify({ phase: "done" }));
	gone.sv.advance(60_000);
	assert.equal(((await gone.sv.wait(gone.r, gone.thread)).closed as { reason: string }).reason, "the worker w ended without a close");
});

test("a restart keeps the threads, their posts, the round count, and the close; a hold cut by the stop asks again", async () => {
	const { sv, owner, w, r, thread } = await paired();
	await sv.post(w, thread, ["reviewer"], "review", "ready");
	await sv.post(r, thread, ["worker"], "fix", "F1");
	const cut = sv.wait(w, thread, 2);
	sv.restart();
	assert.deepEqual(await cut, { ok: false, error: "the sb server is stopping; ask again" });
	const read = await sv.read(owner, thread);
	assert.deepEqual([read.posts, read.fixes, read.open], [2, 1, true]);
	assert.deepEqual(((await sv.wait(w, thread, 0)).posts as { n: number }[]).map((p) => p.n), [2]);
	assert.equal((await sv.post(w, thread, ["reviewer"], "review", "fixed")).n, 3, "numbering goes on");
	assert.equal((await sv.pair(owner, "w2", "r2")).thread, "T2");
	await sv.post(r, thread, ["worker"], "done", "approved");
	sv.restart();
	assert.equal(((await sv.read(owner, thread)).closed as { by: string }).by, "reviewer");
	// A line cut by a crash at the end of the posts file is dropped, the rest kept.
	const file = join(sv.dir, owner.slice(0, 8), "T2.jsonl");
	writeFileSync(file, `${JSON.stringify({ n: 1, at: sv.clock.now(), from: "worker", to: ["reviewer"], tag: "note", text: "kept" })}\n{"n":2,"at`);
	sv.restart();
	assert.equal((await sv.read(owner, "T2")).posts, 1);
	assert.ok(readFileSync(file, "utf8").startsWith("{"));
});

test("the ledger hears each thread open and close: done, blocked by a member or by the round cap, abandoned by the server; T<n>.json keeps closed and closedAs through a restart", async () => {
	const sv = server();
	const done = await paired(undefined, sv);
	await sv.post(done.w, done.thread, ["reviewer"], "review", "ready");
	await sv.post(done.r, done.thread, ["worker", "main"], "done", "approved");
	const gaveUp = await paired(undefined, sv);
	await sv.post(gaveUp.w, gaveUp.thread, ["reviewer", "main"], "blocked", "cannot build");
	const capped = await paired(1, sv);
	await sv.post(capped.r, capped.thread, ["worker"], "fix", "f1");
	await sv.post(capped.r, capped.thread, ["worker"], "fix", "f2");
	const quiet = await paired(undefined, sv);
	sv.advance(IDLE_MS);
	const closes = sv.notes.filter((e) => e.kind === "thread_close").map((e) => [e.id, e.why, e.session]);
	assert.deepEqual(closes, [[done.thread, "done", done.owner], [gaveUp.thread, "blocked", gaveUp.owner], [capped.thread, "blocked", capped.owner], [quiet.thread, "abandoned", quiet.owner]]);
	assert.equal(sv.notes.filter((e) => e.kind === "thread_open").length, 4);
	const meta = (o: { owner: string; thread: string }) => JSON.parse(readFileSync(join(sv.dir, o.owner.slice(0, 8), `${o.thread}.json`), "utf8")) as { closed?: number; closedAs?: string };
	sv.restart();
	assert.deepEqual([meta(done).closedAs, meta(gaveUp).closedAs, meta(capped).closedAs, meta(quiet).closedAs], ["done", "blocked", "blocked", "abandoned"]);
	assert.equal(meta(done).closed, (await sv.read(done.owner, done.thread)).closed && ((await sv.read(done.owner, done.thread)).closed as { time: number }).time, "closed is the time the done post landed");
	assert.equal(sv.notes.filter((e) => e.kind === "thread_close").length, 4, "a restart closes nothing again");
});
