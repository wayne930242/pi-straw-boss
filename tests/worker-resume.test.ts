import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { OpenRequest } from "../src/opener.ts";
import { openWorker, type WorkerDoor } from "../src/server/workerally.ts";
import { type BookEntry, putBook } from "../src/server/workerbook.ts";
import { workerSpec } from "../src/workerslip.ts";

// The box's resume door, cause by cause (docs/specs/2026-11-26-ally-workers.md, Resume): a fixture repository, a book entry, a session file, and a stub open. Each refusal answers the slip's ask with its cause; a
// worktree the resume made goes again when the open fails, and a kept one stays.

let root = "", checkout = "", home = "", sessions = "", state = "", baseSha = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const SID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", OTHER = "0199a1b2-0000-7000-8000-000000000002", DEV = "dev123", PEER = { id: `link:${DEV}`, label: "mac", short: "dev123" };
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "psb-worker-resume-t-")));
	const origin = join(root, "origin.git");
	(checkout = join(root, "app")), (home = join(root, "home")), (sessions = join(root, "sessions")), (state = join(root, "state"));
	git(root, "init", "--quiet", "--bare", "-b", "main", origin);
	git(root, "clone", "--quiet", origin, checkout);
	writeFileSync(join(checkout, "a.txt"), "a\n");
	git(checkout, "add", "a.txt");
	git(checkout, "commit", "--quiet", "-m", "a");
	git(checkout, "push", "--quiet", "origin", "HEAD:main");
	baseSha = git(checkout, "rev-parse", "HEAD");
	mkdirSync(state, { recursive: true });
	writeFileSync(join(state, "config.json"), JSON.stringify({ workers: { models: [] }, capacity: { budget: 2 } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dir = () => join(home, ".herdr", "worktrees", "app", "feat-x");
function book(over: Partial<BookEntry> = {}, cwd = dir(), id = SID) {
	mkdirSync(join(sessions, "--wt--"), { recursive: true });
	const file = join(sessions, "--wt--", `2026-11-26T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "x", cwd })}\n`);
	putBook(state, Date.now(), { ask: "0".repeat(32), main: id, at: Date.now(), device: DEV, branch: "feat/x", label: "MP-1", path: dir(), base: "origin/main", baseSha, points: 1, ended: { at: Date.now() - 60_000, how: "report" }, ...over });
	return file;
}
function door(o: Partial<WorkerDoor> = {}) {
	const replies: string[] = [], opens: OpenRequest[] = [];
	let fail = false;
	const d: WorkerDoor = {
		stateDir: state, home, now: Date.now, checkout: async () => checkout, inside: () => true, room: () => undefined, sessionsRoot: sessions,
		open: async (r) => { if (fail) throw new Error("pi did not come back"); opens.push(r); return { tab: "t", pane: "p", main: SID, sender: r.sender }; },
		route: () => {}, reply: async (_a, text) => void replies.push(text), log: () => {}, ...o,
	};
	return { d, replies, opens, failNext: () => void (fail = true) };
}
let n = 0;
const resume = (d: WorkerDoor, over: Record<string, unknown> = {}, id = SID) => openWorker(d, PEER, { request: "Again.", sender: PEER.id, peer: PEER, role: "worker", slip: { spec: workerSpec({ label: "x", resume: id, ...over }), ask: (++n).toString(16).padStart(32, "0") } });

test("no record: the cause, with the device's own resumable sessions listed", async () => {
	book({}, dir(), OTHER);
	const { d, replies } = door();
	await assert.rejects(resume(d), /no worker of session 0199a1b2 is on record here for your device .*your resumable ones: 0199a1b2 \(branch feat\/x, report 1 min ago\)/);
	assert.match(replies[0]!, /^The box did not resume worker x \(session 0199a1b2, branch \?\): /);
});

test("the session file gone, its folder not the worktree, and its header id another session's are refused", async () => {
	const file = book();
	unlinkSync(file);
	await assert.rejects(resume(door().d), /its session file is gone/);
	book({}, join(root, "elsewhere"));
	await assert.rejects(resume(door().d), /the session's folder .*elsewhere is not the worker's worktree .*feat-x/);
	writeFileSync(file, `${JSON.stringify({ type: "session", id: OTHER, cwd: dir() })}\n`);
	await assert.rejects(resume(door().d), /header id \(0199a1b2-0000\) is not 0199a1b2-c3d4/);
});

test("a worktree on another branch, and one another live worker holds, are refused; a pi that does not come back drops only a worktree the resume made", async () => {
	book();
	git(checkout, "worktree", "add", "--quiet", "-b", "feat/other", dir(), baseSha);
	await assert.rejects(resume(door().d), /is on branch feat\/other, not feat\/x/);
	git(checkout, "worktree", "remove", "--force", dir());
	await assert.rejects(resume(door({ live: () => ({ routes: [{ to: OTHER, path: dir() }] }) }).d), /another live worker holds the worktree/);
	const made = door();
	made.failNext();
	await assert.rejects(resume(made.d), /pi did not come back/);
	assert.equal(existsSync(dir()), false, "the worktree this resume made went again");
	git(checkout, "worktree", "add", "--quiet", "--no-track", "-b", "feat/x", dir(), baseSha);
	const kept = door();
	kept.failNext();
	await assert.rejects(resume(kept.d), /pi did not come back/);
	assert.equal(existsSync(dir()), true, "a kept worktree stays");
	assert.match(kept.replies[0]!, /\(session 0199a1b2, branch feat\/x\): pi did not come back/);
});

test("the budget is the record's points unless the slip gives some; a branch only on this box with its base gone is refused", async () => {
	book({ points: 3 });
	await assert.rejects(resume(door().d), /this worker needs 3/);
	const ok = door();
	await resume(ok.d, { points: 1 });
	assert.equal(ok.opens[0]!.worker?.points, 1);
	assert.equal(ok.opens[0]!.worker?.resume?.file.endsWith(`_${SID}.jsonl`), true);
	assert.equal(ok.opens[0]!.worker?.resume?.model, undefined, "no --model unless the slip names one");
	git(checkout, "worktree", "remove", "--force", dir());
	git(checkout, "branch", "-D", "feat/x");
	book({ baseSha: "f".repeat(40) });
	await assert.rejects(resume(door().d), /base f{40} is no commit this box has/);
});
