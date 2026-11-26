import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { stamp } from "../src/header.ts";
import { opener } from "../src/opener.ts";
import { addRoute, readRoutes, type Route } from "../src/server/allyroute.ts";
import { slotOf } from "../src/server/record.ts";
import { openWorker, type WorkerDoor } from "../src/server/workerally.ts";
import { markBook, readBook } from "../src/server/workerbook.ts";
import { createWorkerEnds, workerReport } from "../src/server/workerrelay.ts";
import { workerSpec } from "../src/workerslip.ts";
import { World } from "./fakes.ts";

// Resume a worker by its session (docs/specs/2026-11-26-ally-workers.md, Resume), end to end over the box's real door, opener, git and sweep: open → final report → the sweep removes the clean, pushed worktree → a resume slip
// → pi starts `--session <file>` in the worktree made again → the second report answers the new ask with the Session line. And a kept dirty worktree is reused.

let world = new World(), root = "", checkout = "", home = "", sessions = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "psb-worker-resume-")));
	const origin = join(root, "origin.git"), seed = join(root, "seed");
	(checkout = join(root, "app")), (home = join(root, "home")), (sessions = join(root, "agent", "sessions"));
	git(root, "init", "--quiet", "--bare", "-b", "main", origin);
	git(root, "init", "--quiet", "-b", "main", seed);
	writeFileSync(join(seed, "a.txt"), "a\n");
	git(seed, "add", "a.txt");
	git(seed, "commit", "--quiet", "-m", "a");
	git(seed, "remote", "add", "origin", origin);
	git(seed, "push", "--quiet", "origin", "main");
	git(root, "clone", "--quiet", origin, checkout);
});
afterEach(async () => {
	await world.stopAll();
	world = new World();
	rmSync(root, { recursive: true, force: true });
});

const SID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", DEV = "dev123", PEER = { id: `link:${DEV}`, label: "mac", short: "dev123" }, ASK1 = "a".repeat(32), ASK2 = "b".repeat(32);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const milestone = (text: string) => stamp({ from: { name: "worker", id: SID, role: "main", workspace: "wA" }, kind: "call_tower", scope: "tower", to: [{ name: "tower", id: "t", role: "tower" }], reply: false, why: "milestone" }, text);

/** A box: a tower in wA, pi that starts a new session (writing its file with the pane's folder as cwd) or `--session <file>` as that same session, and the door over the real opener. */
function box() {
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	const slot = slotOf(join(root, "state"), { HOME: home });
	mkdirSync(slot.stateDir, { recursive: true });
	writeFileSync(join(slot.stateDir, "config.json"), JSON.stringify({ workers: { models: ["m/one"] }, capacity: { budget: 4 } }));
	const starts: string[][] = [], handed: { to: string; message: string }[] = [], replies: { ask: string; text: string }[] = [];
	world.herdr.onAgentStart = (pane, args) => {
		starts.push(args);
		const at = args.indexOf("--session"), file = at >= 0 ? args[at + 1]! : join(sessions, "--wt--", `2026-11-26T00-00-00-000Z_${SID}.jsonl`);
		if (at < 0) (mkdirSync(join(sessions, "--wt--"), { recursive: true }), writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: SID, timestamp: "2026-11-26T00:00:00.000Z", cwd: pane.cwd })}\n`));
		pane.agent_session = { value: file };
		const role = pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "";
		void world.agent({ id: SID, name: "worker · MP-1", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: role } }).start();
	};
	const open = opener({ run: world.herdr.runFor("wA:p7"), sleep: (ms) => sleep(Math.min(ms, 2)), workspaceId: "wA", cwd: checkout, sessions: () => world.broker.sessionList() as never, send: async (to, message) => (handed.push({ to, message }), { status: "sent" }), tower: () => ({ id: "tower-wA", name: "tower · wA" }), stateDir: slot.stateDir, workerPanes: () => new Set(readRoutes(slot, "wA", Date.now()).flatMap((r) => (r.pane ? [r.pane] : []))) });
	const door: WorkerDoor = {
		stateDir: slot.stateDir, home, now: Date.now, checkout: async () => checkout, inside: () => true, room: () => undefined, open, sessionsRoot: sessions, workspace: "wA",
		route: (opened, worker, ask) => addRoute(slot, "wA", { device: DEV, label: "mac", short: "dev123", team: "t", teamName: "T", to: opened.main, name: `worker ${worker.label}`, kind: "opened", at: Date.now(), pane: opened.pane, ...(ask ? { ask } : {}), worker }, Date.now()),
		reply: async (ask, text) => void replies.push({ ask, text }), log: () => {}, fileOf: async (pane) => world.herdr.pane(pane).agent_session?.value,
		live: () => ({ routes: readRoutes(slot, "wA", Date.now()).flatMap((r) => (r.worker ? [{ to: r.to, ...(r.final !== undefined ? { final: r.final } : {}), path: r.worker.path }] : [])), listed: new Set(world.broker.sessions.keys()) }),
	};
	const sent: { ask: string; text: string }[] = [];
	const report = async (text: string) => {
		const row = readRoutes(slot, "wA", Date.now()).find((r) => r.to === SID)!;
		assert.ok(workerReport({ slot, workspace: "wA", now: Date.now, log: () => {}, sweep: () => {}, send: async (_d, t, ask) => void sent.push({ ask, text: t }) }, row, milestone(text), () => {}));
		await new Promise((r) => setImmediate(r));
	};
	/** The sweep after the report: pi has quit (tab closed, broker no longer lists it), so the row is tidied and forgotten. */
	const sweep = async () => {
		const row = readRoutes(slot, "wA", Date.now()).find((r) => r.to === SID)!;
		await world.herdr.runFor("wA:p7")(["tab", "close", world.herdr.pane(row.pane!).tab_id]);
		for (const a of world.agents.filter((x) => x.id === SID)) await a.stop();
		const forget: string[] = [];
		await createWorkerEnds({ rows: () => readRoutes(slot, "wA", Date.now()).filter((r) => r.worker).map((route: Route) => ({ workspace: "wA", route })), now: Date.now, look: async () => ({ listed: false, pane: false, working: false }), close: async () => {}, send: async () => {}, forget: (_w, main) => void forget.push(main), stopped: () => {}, notice: () => {}, log: () => {}, book: (main, patch, renew) => markBook(slot.stateDir, Date.now(), main, patch, renew) }).sweep();
		writeFileSync(join(slot.stateDir, "drop"), "");
		const { dropOpened } = await import("../src/server/allyroute.ts");
		for (const m of forget) dropOpened(slot, "wA", m, Date.now());
	};
	return { slot, door, starts, handed, replies, sent, report, sweep };
}

test("open, report, worktree removed, resume: pi --session in the worktree made again, the follow-up handed over, and the second report answers the new ask with the Session line", async () => {
	const b = box();
	await openWorker(b.door, PEER, { request: "brief", sender: PEER.id, peer: PEER, role: "worker", slip: { spec: workerSpec({ label: "MP-1", branch: "feat/x" }), ask: ASK1 } });
	const dir = join(home, ".herdr", "worktrees", "app", "feat-x");
	writeFileSync(join(dir, "b.txt"), "b\n");
	git(dir, "add", "b.txt");
	git(dir, "commit", "--quiet", "-m", "b");
	git(dir, "push", "--quiet", "origin", "feat/x");
	const head = git(dir, "rev-parse", "HEAD");
	await b.report(`Done: feat/x at ${head}, pushed.`);
	assert.equal(b.sent[0]!.ask, ASK1);
	assert.match(b.sent[0]!.text, new RegExp(`\\nSession: ${SID} · resume: call_tower worker`));
	await b.sweep();
	assert.equal(existsSync(dir), false, "the clean, pushed worktree was removed");
	assert.equal(readBook(b.slot.stateDir, Date.now())[0]!.head, head, "the book has the last head");
	await openWorker(b.door, PEER, { request: "Fix the P1.", sender: PEER.id, peer: PEER, role: "worker", slip: { spec: workerSpec({ label: "MP-1", resume: SID }), ask: ASK2 } });
	assert.equal(b.replies.length, 0, b.replies.map((r) => r.text).join("\n"));
	assert.equal(existsSync(dir), true, "the worktree was made again");
	assert.equal(git(dir, "rev-parse", "HEAD"), head, "from origin/feat/x");
	const start = b.starts.at(-1)!;
	assert.deepEqual(start.slice(-2), ["--session", join(sessions, "--wt--", `2026-11-26T00-00-00-000Z_${SID}.jsonl`)]);
	assert.ok(!start.includes("--name") && !start.includes("--model"), "pi restores its own name and model");
	const h = b.handed.at(-1)!;
	assert.equal(h.to, SID);
	assert.match(h.message, /made again from origin\/feat\/x at /);
	assert.ok(h.message.endsWith("Follow-up, verbatim:\nFix the P1."));
	await b.report("Fixed.");
	assert.equal(b.sent[1]!.ask, ASK2);
	assert.match(b.sent[1]!.text, /final report:\nFixed\.\nSession: /);
});

test("a kept dirty worktree is reused; a live one, another device's, a wrong branch, and an off-list recorded model are refused with their cause", async () => {
	const b = box();
	await openWorker(b.door, PEER, { request: "brief", sender: PEER.id, peer: PEER, role: "worker", slip: { spec: workerSpec({ label: "MP-1", branch: "feat/x", model: "m/one" }), ask: ASK1 } });
	const resume = (ask: string, over: Record<string, unknown> = {}, peer = PEER) => openWorker(b.door, peer, { request: "Again.", sender: peer.id, peer, role: "worker", slip: { spec: workerSpec({ label: "MP-1", resume: SID, ...over }), ask } });
	await assert.rejects(resume("1".repeat(32)), /still runs; its report answers your earlier ask/);
	const dir = join(home, ".herdr", "worktrees", "app", "feat-x");
	writeFileSync(join(dir, "wip.txt"), "wip\n");
	await b.report("Stuck.");
	await assert.rejects(resume("2".repeat(32)), /closing after its report/);
	await b.sweep();
	assert.equal(existsSync(dir), true, "dirty: kept");
	const other = { id: "link:other9", label: "pc", short: "other9" };
	await assert.rejects(resume("3".repeat(32), {}, other), /no worker of session 0199a1b2 is on record here for your device/);
	await assert.rejects(resume("4".repeat(32), { branch: "feat/y" }), /worked on branch feat\/x, not feat\/y/);
	writeFileSync(join(b.slot.stateDir, "config.json"), JSON.stringify({ workers: { models: ["m/two"] }, capacity: { budget: 4 } }));
	await assert.rejects(resume("5".repeat(32)), /the model it ran on, m\/one, is no longer in this box's workers.models/);
	await assert.rejects(resume("6".repeat(32), { model: "m/three" }), /model m\/three is not in this box's workers.models/);
	assert.match(b.replies.at(-1)!.text, /^The box did not resume worker MP-1 \(session 0199a1b2, branch feat\/x\): /);
	assert.ok(!b.replies.find((r) => r.ask === "3".repeat(32))!.text.includes("feat/x"), "another device's id tells nothing of the worker");
	await resume("7".repeat(32), { model: "m/two" });
	assert.equal(existsSync(join(dir, "wip.txt")), true, "the kept worktree with its work is reused");
	assert.deepEqual(b.starts.at(-1)!.slice(-4).slice(2), ["--model", "m/two"], "the model given goes to pi");
	assert.match(b.handed.at(-1)!.message, /the worktree was kept on the box, at [0-9a-f]{12}/);
	await assert.rejects(resume("7".repeat(32)), /already opened or resumed/, "the same slip again opens nothing");
});
