import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readWaits } from "../src/server/linkwaits.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// `ally_escalate` (docs/specs/2026-11-21-box-mac-waits.md §3, §9 anchor 6): an ally run at `reply` hands an item of its sender's message to the wait router with no gate and no Allow, the first line `[waits on you: …]` gives `what`, a
// run may escalate at most 5 items and each once, the run still ends with `tower_done`, and its brief lists the mains here.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV = "a".repeat(26), ASK = "c".repeat(32);

test("ally_escalate runs at reply with no gate, opens L1 from the message's first line with its one ask, refuses a repeat and a sixth item, and the run still ends with tower_done", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.add("m1", DEV, "[waits on you: merge approval-api !13]\nThe box main work-on hands off !13 to the Mac.", { awaitsReply: ASK, replyExpected: true });
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.equal(got.level, "reply");
	const brief = String(got.brief);
	assert.match(brief, /Mains here \(your sender may see them too; name one as the owner of an ally_escalate\):/);
	assert.match(brief, /- ally_escalate \{what, owner\?, kind\?\}/);
	const token = String(got.token);
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
	const escalate = (args: Record<string, unknown>) => ask(s, { cmd: "run-tool", token, tool: "ally_escalate", args });
	// No toolCallId: a gated tool would be refused for want of one, so this passes only because the server holds it free.
	const first = await escalate({ owner: "work-on" });
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.match(String(first.text), /^Escalated as L1/);
	const [w] = readWaits(world.slot, "wA").entries;
	assert.deepEqual([w!.dir, w!.kind, w!.device, w!.owner, w!.what, w!.ask], ["in", "wait", DEV, "work-on", "merge approval-api !13", ASK]);
	assert.match(w!.text, /hands off !13/);
	const again = await escalate({ what: "merge approval-api !13" });
	assert.equal(again.ok, false);
	assert.match(String(again.error), /escalated already/);
	for (const n of [2, 3, 4, 5]) assert.equal((await escalate({ what: `item ${n}`, kind: "incident" })).ok, true, `item ${n}`);
	const sixth = await escalate({ what: "item 6" });
	assert.equal(sixth.ok, false);
	assert.match(String(sixth.error), /escalated 5 items already/);
	assert.equal(readWaits(world.slot, "wA").entries.length, 5);
	const done = await ask(s, { cmd: "run-done", token, note: "escalated the box's handoff of !13" });
	assert.equal(done.ok, true, JSON.stringify(done));
});
