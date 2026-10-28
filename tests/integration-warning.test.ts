import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { until, World } from "./fakes.ts";

// Herdr's pi integration (desk-mode spec S6): a session whose pane Herdr reports as an agent without an `agent_session` cannot join the net, and says so once per process.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const GRACE = 60;
const warnings = (a: { notices: { text: string; level?: string }[] }) => a.notices.filter((n) => /integration is missing/.test(n.text));
const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a session whose pane has an agent but no agent_session warns once after the grace, naming the fix, and never again", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { integrationMs: GRACE } });
	await a.start();
	await until(() => warnings(a).length === 1, "the warning");
	assert.equal(warnings(a)[0]!.level, "warning");
	assert.equal(warnings(a)[0]!.text, "Herdr's pi integration is missing for this agent directory, so this session cannot join the net; run `herdr integration install pi` and restart pi.");
	await a.fire("session_start", { reason: "new" }); // another session in the same pi process
	await nap(GRACE * 3);
	assert.equal(warnings(a).length, 1, "once per process, however long it lives");
});

test("nothing is said before the grace: a session still within it has no warning", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { integrationMs: 60_000 } });
	await a.start();
	await nap(100);
	assert.deepEqual(warnings(a), []);
});

test("a session whose pane has its agent_session does not warn, and neither does a pane Herdr reports no agent for", async () => {
	Object.assign(world.herdr.addPane("wA:p1", "wA:t1"), { agent_session: { value: "/s/2026_a.jsonl" } });
	world.herdr.addPane("wB:p1", "wB:t1", "shell");
	const [a, b] = [world.agent({ id: "a", pane: "wA:p1", deps: { integrationMs: GRACE } }), world.agent({ id: "b", pane: "wB:p1", deps: { integrationMs: GRACE } })];
	await Promise.all([a.start(), b.start()]);
	await nap(GRACE * 4);
	assert.deepEqual([warnings(a), warnings(b)], [[], []]);
});

test("a session that ended before the grace warns of nothing", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { integrationMs: GRACE } });
	await a.start();
	await a.stop("reload");
	await nap(GRACE * 3);
	assert.deepEqual(warnings(a), []);
});

test("a tower warns too, and a Herdr that fails the listing leaves it quiet", async () => {
	const tower = world.tower("t1", "wT:t1", "wT:p1", false, { integrationMs: GRACE });
	await tower.start();
	await until(() => warnings(tower).length === 1, "the tower's warning");
	world.herdr.failPanes = true;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { integrationMs: GRACE } });
	await a.start();
	await nap(GRACE * 3);
	assert.deepEqual(warnings(a), []);
});

test("a session in a sub workspace (a linked worktree) stays alive and warns once, with no unhandled rejection", async () => {
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: true, repo_key: "/r/alpha" };
	const rejections: unknown[] = [];
	const onReject = (e: unknown) => rejections.push(e);
	process.on("unhandledRejection", onReject);
	try {
		const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { integrationMs: GRACE } });
		await a.start();
		await until(() => warnings(a).length === 1, "the warning");
		await nap(GRACE * 2);
		assert.deepEqual(rejections, []);
		assert.equal(warnings(a).length, 1);
	} finally {
		process.off("unhandledRejection", onReject);
	}
});

test("a check that finishes after the session ended says nothing", async () => {
	let open!: () => void;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { integrationMs: 400 } });
	await a.start();
	world.herdr.paneListGate = new Promise((resolve) => (open = resolve));
	await until(() => world.herdr.gated > 0, "the check's listing");
	await a.stop("quit");
	world.herdr.paneListGate = undefined;
	open();
	await nap(200);
	assert.deepEqual(warnings(a), []);
});
