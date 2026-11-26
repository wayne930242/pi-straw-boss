import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpenRequest } from "../src/opener.ts";
import { runTool, type ToolHost } from "../src/server/runtools.ts";

// An ally run's `boss_open_main` `role: "worker"` (docs/specs/2026-11-26-ally-workers.md, Device side): only at dispatch, for its own sender, on a slip from the run's own messages (never the model's words), and refused before
// the gate; a local run's is refused. The open carries the slip's spec and the ask of the message it came in.

const DEV = "a".repeat(26), TEAM = "1".repeat(32), ASK = "c".repeat(32);
const SLIP = "worker: MP-1 | branch: feat/x | points: 2\nDo the brief.";
function host(level: string, messages: { id: string; text: string; ask?: string }[] = [{ id: "e1", text: SLIP, ask: ASK }]) {
	const allows: unknown[] = [], opens: OpenRequest[] = [];
	const h = {
		allow: async (q: unknown) => (allows.push(q), { ok: true }),
		open: async (r: OpenRequest) => (opens.push(r), { tab: "t1", pane: "p1", main: "w-1", sender: r.sender }),
		allyMessages: () => messages,
		who: { device: DEV, deviceLabel: "mac", team: TEAM, level, pane: "px" },
	} as unknown as ToolHost;
	return { h, allows, opens };
}
const open = (h: ToolHost, args: Record<string, unknown> = {}, kind: "ally" | "local" = "ally") => runTool(h, kind, "boss_open_main", { request: "ignored: the slip's brief goes", sender: `link:${DEV}`, role: "worker", ...args }, { toolCallId: "c1" });

test("at dispatch the worker opens on the run's own slip, with its ask; the model's request text is not the brief", async () => {
	const { h, opens, allows } = host("dispatch");
	const r = await open(h);
	assert.equal(allows.length, 0);
	assert.equal(opens.length, 1);
	assert.equal(opens[0]!.request, "Do the brief.");
	assert.deepEqual(opens[0]!.slip, { spec: { label: "MP-1", branch: "feat/x", points: 2 }, ask: ASK });
	assert.equal(opens[0]!.role, "worker");
	assert.equal(opens[0]!.peer?.id, `link:${DEV}`);
	assert.match(r.text, /Its final report goes back to mac by code/);
});

test("below dispatch, for another sender, with no slip, with two slips and no branch, and in a local run: refused, no Allow, nothing opened", async () => {
	for (const level of ["reply", "forward"]) {
		const { h, opens, allows } = host(level);
		await assert.rejects(open(h), /only for a device this computer trusts at dispatch/);
		assert.deepEqual([opens.length, allows.length], [0, 0]);
	}
	await assert.rejects(open(host("dispatch").h, { sender: `link:${"b".repeat(26)}` }), /its own sender only/);
	await assert.rejects(open(host("dispatch", [{ id: "e1", text: "hello" }]).h), /carries a worker slip/);
	await assert.rejects(open(host("dispatch", [{ id: "e1", text: "worker: x | branch: develop\nb" }]).h), /cannot be opened: .*integration or train branch/);
	const two = host("dispatch", [{ id: "e1", text: SLIP }, { id: "e2", text: "worker: y | branch: feat/y\nOther." }]);
	await assert.rejects(open(two.h), /give branch/);
	await open(two.h, { branch: "feat/y" });
	assert.equal(two.opens[0]!.request, "Other.");
	await assert.rejects(open(host("dispatch").h, {}, "local"), /dispatch a worker subagent instead/);
});
