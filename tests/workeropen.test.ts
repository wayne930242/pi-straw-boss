import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { capDir } from "../src/capacity.ts";
import { writeHold } from "../src/hold.ts";
import { createReservations } from "../src/capres.ts";
import { OpenLimitError, type OpenRequest } from "../src/opener.ts";
import { workerSpec } from "../src/workerslip.ts";
import { openWorker, type WorkerDoor } from "../src/server/workerally.ts";
import { closeWorktree, modelRefusal, prepareWorktree, readWorkers } from "../src/server/workeropen.ts";

// The box's git and door for a worker (docs/specs/2026-11-26-ally-workers.md, Device side): a fixture origin and checkout in a temp root, the branch and base rules, rework, the cleanup rule, and the door's refusals answered by code.

let root = "", checkout = "", home = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-workeropen-"));
	const origin = join(root, "origin.git"), seed = join(root, "seed");
	(checkout = join(root, "app")), (home = join(root, "home"));
	git(root, "init", "--quiet", "--bare", "-b", "main", origin);
	git(root, "init", "--quiet", "-b", "main", seed);
	writeFileSync(join(seed, "a.txt"), "a\n");
	git(seed, "add", "a.txt");
	git(seed, "commit", "--quiet", "-m", "a");
	git(seed, "branch", "develop");
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "--quiet", "origin", "main", "develop");
	git(root, "clone", "--quiet", origin, checkout);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const spec = (o: Record<string, unknown>) => workerSpec({ branch: "feat/x", ...o });

test("a new branch gets a worktree under ~/.herdr/worktrees from origin's base; the reserved names, a local-only branch, and an existing path are refused", async () => {
	const p = await prepareWorktree({ checkout, spec: spec({ base: "develop" }), home });
	assert.equal(p.dir, join(home, ".herdr", "worktrees", "app", "feat-x"));
	assert.equal(p.base, "origin/develop");
	assert.equal(git(p.dir, "rev-parse", "--abbrev-ref", "HEAD"), "feat/x");
	assert.equal(p.made, true);
	assert.equal(p.rework, undefined);
	await assert.rejects(prepareWorktree({ checkout, spec: spec({}), home }), /exists on this box but not on origin/, "the branch is local only now");
	await assert.rejects(prepareWorktree({ checkout, spec: workerSpec({ branch: "hotfix/a" }), home, reserved: ["hotfix/a"] }), OpenLimitError);
	assert.throws(() => workerSpec({ branch: "develop" }), /integration or train branch/);
	await assert.rejects(prepareWorktree({ checkout, spec: workerSpec({ branch: "feat/y", base: "nope" }), home }), /origin\/nope does not exist/);
	const d = await prepareWorktree({ checkout, spec: workerSpec({ branch: "feat/z" }), home });
	assert.equal(d.base, "origin/main", "no base: origin's default branch");
});

test("a branch origin has is a rework: the worktree starts from origin/<branch>", async () => {
	git(checkout, "push", "--quiet", "origin", "origin/main:refs/heads/fix/r");
	const p = await prepareWorktree({ checkout, spec: workerSpec({ branch: "fix/r", base: "develop" }), home });
	assert.equal(p.base, "origin/fix/r");
	assert.equal(p.rework, true);
});

test("the worktree goes at close only when clean and pushed, or untouched; otherwise it is kept with the reason", async () => {
	const p = await prepareWorktree({ checkout, spec: spec({}), home });
	writeFileSync(join(p.dir, "b.txt"), "b\n");
	assert.deepEqual(await closeWorktree({ checkout, dir: p.dir, branch: p.branch, baseSha: p.baseSha }), { removed: false, reason: "it has uncommitted changes", head: p.baseSha });
	git(p.dir, "add", "b.txt");
	git(p.dir, "commit", "--quiet", "-m", "b");
	const kept = await closeWorktree({ checkout, dir: p.dir, branch: p.branch, baseSha: p.baseSha });
	assert.equal(kept.removed, false);
	assert.match((kept as { reason: string }).reason, /is not on origin\/feat\/x/);
	git(p.dir, "push", "--quiet", "origin", "feat/x");
	assert.equal((await closeWorktree({ checkout, dir: p.dir, branch: p.branch, baseSha: p.baseSha })).removed, true);
	assert.equal(existsSync(p.dir), false);
	const q = await prepareWorktree({ checkout, spec: workerSpec({ branch: "feat/q" }), home });
	assert.equal((await closeWorktree({ checkout, dir: q.dir, branch: q.branch, baseSha: q.baseSha })).removed, true, "a worktree left at its base goes");
	// RV-F005: HEAD back at the base with the branch ahead of it: the worktree goes, the branch and its commits stay.
	const v = await prepareWorktree({ checkout, spec: workerSpec({ branch: "feat/v" }), home });
	writeFileSync(join(v.dir, "v.txt"), "v\n");
	git(v.dir, "add", "v.txt");
	git(v.dir, "commit", "--quiet", "-m", "v");
	git(v.dir, "checkout", "--quiet", "--detach", v.baseSha);
	assert.equal((await closeWorktree({ checkout, dir: v.dir, branch: v.branch, baseSha: v.baseSha })).removed, true);
	assert.notEqual(git(checkout, "branch", "--list", "feat/v"), "", "the branch with its commit is kept");
});

test("config: workers.models is the allowlist; an omitted model is pi's default", () => {
	const state = join(root, "state");
	mkdirSync(state);
	assert.equal(readWorkers(state), undefined);
	writeFileSync(join(state, "config.json"), JSON.stringify({ workers: { models: ["openai-codex/gpt-6.2-astra", "bad model"] } }));
	assert.deepEqual(readWorkers(state), { models: ["openai-codex/gpt-6.2-astra"] });
	assert.equal(modelRefusal(["a/b"], undefined), undefined);
	assert.match(modelRefusal(["a/b"], "c/d")!, /not in this box's workers.models/);
});

test("the door: each refusal answers the slip's ask by code; an open makes the worktree, writes the route, and claims the reservation; a failed open removes the worktree and its branch", async () => {
	const state = join(root, "state"), replies: string[] = [], routes: unknown[] = [];
	mkdirSync(state);
	let fail = false;
	const door = (o: Partial<WorkerDoor> = {}): WorkerDoor => ({
		stateDir: state, home, now: () => Date.now(), checkout: async () => checkout, inside: () => true, room: () => undefined,
		open: async (r: OpenRequest) => { if (fail) throw new Error("pi did not start"); return { tab: "t1", pane: "p1", main: "worker-1", sender: r.sender }; },
		route: (_o, w, ask) => void routes.push({ w, ask }), reply: async (_ask, text) => void replies.push(text), log: () => {}, ...o,
	});
	const peer = { id: "link:dev", label: "mac", short: "abcdef" }, request = (s = spec({ points: 2 })) => ({ request: "do it", sender: peer.id, peer, role: "worker", slip: { spec: s, ask: "a".repeat(32) } });
	await assert.rejects(openWorker(door(), peer, request()), /no workers section/);
	writeFileSync(join(state, "config.json"), JSON.stringify({ workers: { models: [] } }));
	await assert.rejects(openWorker(door(), peer, request()), /no capacity.budget/);
	writeFileSync(join(state, "config.json"), JSON.stringify({ workers: { models: [] }, capacity: { budget: 1 } }));
	await assert.rejects(openWorker(door(), peer, request(spec({ model: "x/y" }))), /not in this box's workers.models/);
	await assert.rejects(openWorker(door(), peer, request()), /needs 2/, "2 points do not fit a budget of 1");
	await assert.rejects(openWorker(door({ room: () => "at the cap" }), peer, request()), /at the cap/);
	assert.equal(replies.length, 5, "every refusal answered the ask");
	assert.match(replies[0]!, /^The box did not open worker feat\/x \(branch feat\/x\): /);
	writeFileSync(join(state, "config.json"), JSON.stringify({ workers: { models: [] }, capacity: { budget: 4 } }));
	fail = true;
	await assert.rejects(openWorker(door(), peer, request()), /pi did not start/);
	assert.equal(existsSync(join(home, ".herdr", "worktrees", "app", "feat-x")), false, "the worktree went");
	assert.equal(git(checkout, "branch", "--list", "feat/x"), "", "and the branch it made");
	fail = false;
	const opened = await openWorker(door(), peer, request());
	assert.equal(opened.main, "worker-1");
	assert.deepEqual(routes, [{ w: { points: 2, branch: "feat/x", path: join(home, ".herdr", "worktrees", "app", "feat-x"), base: "origin/main", baseSha: git(checkout, "rev-parse", "origin/main"), label: "feat/x" }, ask: "a".repeat(32) }]);
	const held = createReservations(capDir(join(state, "board")), Date.now).live(-Infinity, () => false);
	assert.deepEqual(held.map((r) => [r.session, r.points, r.self, r.launched]), [["worker-1", 2, true, true]], "the reservation names the worker's session");
	// RV-F001: the same slip again (a run that failed before tower_done leaves its messages) opens nothing and answers nothing, so the ask stays the worker's.
	const sent = replies.length;
	await assert.rejects(openWorker(door(), peer, request()), /already opened for this slip/);
	assert.equal(replies.length, sent, "no false refusal on the worker's ask");
	assert.equal(routes.length, 1);
	// RV-F004: once the open returned, a route that cannot be written leaves the running worker its worktree and its ask.
	const other = request(workerSpec({ branch: "feat/r" }));
	other.slip.ask = "b".repeat(32);
	const kept = await openWorker(door({ route: () => { throw new Error("disk full"); } }), peer, other);
	assert.equal(kept.main, "worker-1");
	assert.equal(existsSync(join(home, ".herdr", "worktrees", "app", "feat-r")), true);
	assert.equal(replies.length, sent);
});

test("a held box opens workers for its holder alone (docs/specs/2026-11-26-device-hold.md, D3): another device's slip is refused, its ask answered", async () => {
	const state = join(root, "state"), replies: string[] = [];
	mkdirSync(state);
	writeFileSync(join(state, "config.json"), JSON.stringify({ workers: { models: [] }, capacity: { budget: 1 } }));
	writeHold(capDir(join(state, "board")), { v: 1, at: Date.now(), held: { team: "0f".repeat(16), device: "mac-id", label: "mac", short: "macid0", by: "0123456789abcdef", byName: "work-on", since: Date.now() } });
	const door: WorkerDoor = { stateDir: state, home, now: () => Date.now(), checkout: async () => checkout, inside: () => true, room: () => undefined, open: async () => { throw new Error("not reached"); }, route: () => {}, reply: async (_a, text) => void replies.push(text), log: () => {} };
	// The opener names a peer `link:<device id>` (runtools.ts `peerSender`); the hold names the bare id.
	const slip = (id: string) => { const peer = { id, label: id.slice(5), short: id.slice(5, 11) }; return [peer, { request: "do it", sender: id, peer, role: "worker", slip: { spec: spec({ points: 2 }), ask: "c".repeat(32) } }] as const; };
	await assert.rejects(openWorker(door, ...slip("link:pc-id")), /held by mac \(macid0\): its capacity is that device's/);
	assert.match(replies[0]!, /held by mac/);
	await assert.rejects(openWorker(door, ...slip("link:mac-id")), /needs 2/, "the holder's slip passes the hold and meets the budget");
});
