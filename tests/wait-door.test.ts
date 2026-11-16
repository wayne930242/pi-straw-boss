import assert from "node:assert/strict";
import { test } from "node:test";
import { HEAD_KEY } from "../src/headkey.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { serverSource } from "../src/towerprompt/serversource.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The door of the boss's words (docs/specs/2026-11-16-wait-cards-flow.md, D4): a run shows him a card with `boss_wait_ask` only while his last words in it were written at its own pane. A reply to a card is his words too: written in
// the idle pane's card view to that pane's own tower, or to the head from the head's own pane, it says `door: "pane"`; a reply to another tower's card names none, since that tower's run is in a pane he is not at.

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
type Taken = { id: string; kind: string; door?: string };
const started = async (tw: TowerWorld) => {
	const s: Running = await tw.start();
	await s.handle.ready;
	const ask = (cmd: Record<string, unknown>) => callControl(s.handle.endpoint, tw.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
	/** The next event a run of the workspace is given, taken: its door. */
	const door = async (token: string) => {
		let got: Taken | undefined;
		await until(async () => ((got = (await ask({ cmd: "run-poll", token, idle: true })).event as Taken | undefined), got !== undefined), "an event");
		await ask({ cmd: "run-taken", token, id: got!.id });
		return [got!.kind, got!.door];
	};
	return { ask, door };
};
const world = () => {
	const tw = new TowerWorld();
	tw.setFlag(true);
	tw.env.LANG = "en_US.UTF-8";
	return tw;
};

test("a reply written in the idle pane's card view reaches the pane's own tower as words written at the pane; a reply to another tower's card names no door", async () => {
	const tw = world();
	try {
		const { ask, door } = await started(tw);
		for (const workspace of ["wA", "wB"]) await ask({ cmd: "ensure-tower", workspace });
		const source = serverSource(tw.ctx(), "wA", 4100);
		await source.pick!.reply({ workspace: "wA" }, "to my own tower", "W1");
		assert.deepEqual(await door(tw.expose!.runs.mint("wA", { kind: "local" })), ["boss", "pane"]);
		await source.pick!.reply({ workspace: "wB" }, "to the tower next door", "W1");
		assert.deepEqual(await door(tw.expose!.runs.mint("wB", { kind: "local" })), ["boss", undefined]);
	} finally {
		await tw.close();
	}
});

test("head-event carries the door: the boss's words written at the head's own pane reach its run marked so, from its prompt's reply to a head card too; any other head-event names none", async () => {
	const tw = world();
	try {
		const { ask, door } = await started(tw);
		const head = await tw.expose!.head.ensure();
		await ask({ cmd: "ensure-tower", workspace: "wA" });
		// the head's own standing pane: its prompt's poll says it is the head's, and its reply to the head's card is written there
		const own = serverSource(tw.ctx(), head.workspace, 4100);
		const polled = await own.poll();
		assert.equal(polled.kind === "state" && polled.answer.head, true);
		await own.pick!.reply({ workspace: HEAD_KEY, head: true }, "from the head's pane", "W1");
		await until(() => tw.pis.size >= 1, "the head's run");
		const [id, pi] = [...tw.pis.entries()][0]!;
		await until(() => readRun(tw.slot, head.workspace, id)?.pid, "the pid");
		const token = String((await ask({ cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).token);
		assert.deepEqual(await door(token), ["boss", "pane"]);
		// another tower's idle pane answers the head's card: not the head's pane
		const other = serverSource(tw.ctx(), "wA", 4101);
		await other.poll();
		await other.pick!.reply({ workspace: HEAD_KEY, head: true }, "from Alpha's pane", "W1");
		assert.deepEqual(await door(token), ["boss", undefined]);
		// the command itself: `door: "pane"` is carried, any other word is none
		assert.equal((await ask({ cmd: "head-event", text: "typed in the head run's pi", door: "pane" })).ok, true);
		assert.deepEqual(await door(token), ["boss", "pane"]);
		assert.equal((await ask({ cmd: "head-event", text: "the GUI's composer", door: "gui" })).ok, true);
		assert.deepEqual(await door(token), ["boss", undefined]);
	} finally {
		await tw.close();
	}
});
