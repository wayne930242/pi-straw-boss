import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloser } from "../src/closer.ts";
import type { Session } from "../src/herdr.ts";

// The close buttons: every agent of a squad or base is asked to quit first, and the tab or workspace closes only once they all did.

const PANES = [
	{ pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA", tokens: { sb_role: "main" } },
	{ pane_id: "wA:p2", tab_id: "wA:t1", workspace_id: "wA", tokens: { sb_role: "subagent" } },
	{ pane_id: "wA:p3", tab_id: "wA:t2", workspace_id: "wA", tokens: { sb_role: "member" } },
	{ pane_id: "wA:p7", tab_id: "wA:t7", workspace_id: "wA", tokens: { sb_role: "tower" } },
];
const at = (id: string, paneId: string): Session => ({ id, herdrLocation: { paneId } as Session["herdrLocation"] });

function setup({ refuse = [] as string[], linger = [] as string[] } = {}) {
	let live = [at("a", "wA:p1"), at("kid", "wA:p2"), at("b", "wA:p3"), at("tower", "wA:p7"), at("gui", "wB:p1")];
	const asked: [string, boolean][] = [], ran: string[][] = [];
	const close = createCloser({
		run: async (args) => (ran.push(args), args[0] === "pane" ? JSON.stringify({ result: { panes: PANES } }) : "{}"),
		sleep: async () => {},
		me: () => "gui",
		sessions: async () => live,
		ask: async (key, keepPane) => {
			asked.push([key, keepPane]);
			if (refuse.includes(key)) return { accepted: false, reason: "busy" };
			if (!linger.includes(key)) live = live.filter((s) => s.id !== key);
			return { accepted: true };
		},
	});
	return { close, asked, ran, closes: () => ran.filter((a) => a[1] === "close") };
}

test("closing a squad quits its agents, keeping their panes, then closes the tab; its subagent goes with the tab", async () => {
	const s = setup();
	const r = await s.close("tab", { workspace: "wA", tab: "wA:t1" });
	assert.equal(r.status, 200);
	assert.deepEqual(s.asked, [["a", true]]);
	assert.deepEqual(s.closes(), [["tab", "close", "wA:t1"]]);
});

test("closing a base quits every agent and its tower, then closes the workspace", async () => {
	const s = setup();
	assert.equal((await s.close("base", { workspace: "wA" })).status, 200);
	assert.deepEqual(s.asked.map(([k]) => k).sort(), ["a", "b", "tower"]);
	assert.deepEqual(s.closes(), [["workspace", "close", "wA"]]);
});

test("one refusal closes nothing and names who refused", async () => {
	const s = setup({ refuse: ["b"] });
	const r = await s.close("base", { workspace: "wA" });
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /Nothing was closed: .*busy/);
	assert.deepEqual(s.closes(), []);
});

test("an agent still running after the wait keeps the squad open", async () => {
	const s = setup({ linger: ["a"] });
	const r = await s.close("tab", { workspace: "wA", tab: "wA:t1" });
	assert.equal(r.status, 504);
	assert.deepEqual(s.closes(), []);
});

test("a closer without a stash check stashes nothing", async () => {
	assert.equal((await setup().close("stash", { workspace: "wA", name: "A" })).status, 404);
});

test("one unit closes its own pane; a bad request is refused", async () => {
	const s = setup();
	assert.equal((await s.close("unit", { key: "b" })).status, 200);
	assert.deepEqual(s.asked, [["b", false]]);
	assert.equal((await s.close("unit", {})).status, 400);
	assert.equal((await s.close("tab", { workspace: "wA" })).status, 400);
	assert.equal((await s.close("nope", {})).status, 404);
});
