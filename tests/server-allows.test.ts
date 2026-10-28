import assert from "node:assert/strict";
import { test } from "node:test";
import type { AllowNote } from "../src/dialogs.ts";
import { argsDigest, canonicalArgs, createAllows } from "../src/server/allows.ts";

// The hub's Allows (docs/specs/2026-10-26-sb-backend.md, Tower tools in a run, The gate's Allow, checked by the server): a gated call of an ally run is taken only against an explicit yes the hub saw for the
// gate dialog of that tool call id, relayed by a session the broker places on the run's pane, over arguments with the same digest, and once.

const gate = (over: Partial<AllowNote> = {}, tool = "bash", args: unknown = { command: "ls", cwd: "/p" }): AllowNote => ({
	from: "S1", pane: "wA:p9", owner: "straw-link-gate", dialogId: "d1", toolCallId: "tc-1", at: 1000,
	title: `Remote request from bob-mac (abcdef): ${tool}\n\n${JSON.stringify(args, null, 2)}`, ...over,
});
const placed = (id = "S1", pane = "wA:p9") => async () => [{ id, herdrLocation: { status: "ok", paneId: pane } }, { id: "T", herdrLocation: { status: "ok", paneId: "wA:p1" } }] as never;
let clock = 1000;
const make = (over: { waitMs?: number } = {}) => createAllows({ now: () => clock, sleep: async (ms) => void (clock += ms), waitMs: over.waitMs ?? 500 });
const ask = (extra: Record<string, unknown> = {}) => ({ pane: "wA:p9", toolCallId: "tc-1", tool: "bash", args: { cwd: "/p", command: "ls" }, sessions: placed(), ...extra });

test("canonical arguments sort their keys, so the digest does not depend on the order the dialog or the run wrote them in", () => {
	assert.equal(canonicalArgs({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "z" } }), '{"a":{"c":"z","d":[3,{"x":2,"y":1}]},"b":1}');
	assert.equal(argsDigest({ a: 1, b: 2 }), argsDigest({ b: 2, a: 1 }));
	assert.notEqual(argsDigest({ a: 1 }), argsDigest({ a: 2 }));
	assert.match(argsDigest({}), /^[0-9a-f]{64}$/);
});

test("an Allow is taken for its pane, tool call id, tool, and arguments, and is used up", async () => {
	clock = 1000;
	const allows = make();
	allows.note(gate());
	assert.deepEqual(await allows.take(ask()), { ok: true });
	const again = await allows.take(ask());
	assert.equal(again.ok, false);
	assert.match(String((again as { reason: string }).reason), /no Allow/);
});

test("other arguments, another tool, another call id, or another run's pane are refused and leave the Allow for the call it was given for", async () => {
	clock = 1000;
	const allows = make({ waitMs: 50 });
	allows.note(gate());
	for (const [what, over, why] of [
		["other arguments", { args: { command: "rm -rf /", cwd: "/p" } }, /arguments/],
		["another tool", { tool: "write" }, /tool/],
		["another call id", { toolCallId: "tc-2" }, /no Allow/],
		["another run's pane", { pane: "wA:p8" }, /no Allow/],
		["a session that is not on the pane", { sessions: placed("S1", "wA:p3") }, /pane/],
		["a session that is gone", { sessions: async () => [] }, /pane/],
	] as const) {
		const got = await allows.take(ask(over));
		assert.equal(got.ok, false, what);
		assert.match(String((got as { reason: string }).reason), why, what);
	}
	assert.deepEqual(await allows.take(ask()), { ok: true }, "the right call still gets it");
});

test("a run's call that comes a moment before the page's Allow reaches the hub waits for it", async () => {
	clock = 1000;
	const allows = createAllows({ now: () => clock, sleep: async (ms) => { clock += ms; if (clock >= 1100) allows.note(gate()); }, waitMs: 500 });
	assert.deepEqual(await allows.take(ask()), { ok: true });
});

test("an Allow older than 15 minutes is gone", async () => {
	clock = 1000;
	const allows = make({ waitMs: 20 });
	allows.note(gate({ at: clock }));
	clock += 16 * 60_000;
	assert.equal((await allows.take(ask())).ok, false);
});

test("a gate's title that does not parse as a remote request over JSON arguments is no Allow", async () => {
	clock = 1000;
	const allows = make({ waitMs: 20 });
	for (const title of ["Remote request from x (abcdef): bash\n\nnot json", "no heading", "Remote request from x (abcdef): bash"]) allows.note(gate({ title, toolCallId: "tc-1" }));
	assert.equal((await allows.take(ask())).ok, false);
});

test("an approval of a link_request is taken for its own call id and a body that starts with what the holder said the request does", async () => {
	clock = 1000;
	const allows = make({ waitMs: 20 });
	const body = ["Create a team at https://relay.example for /p", "Asked by session: a run (abcd1234)", "Reason: set up"].join("\n");
	allows.note({ from: "S1", pane: "wA:p9", owner: "straw-link-request", dialogId: "r1", toolCallId: "tc-9", title: `Link request from a run\n\n${body}`, at: clock });
	const q = { pane: "wA:p9", toolCallId: "tc-9", sessions: placed() };
	assert.equal((await allows.takeRequest({ ...q, lines: ["Create a team at https://relay.example for /p", "Create a team elsewhere"] })).ok, false, "other lines");
	assert.equal((await allows.takeRequest({ ...q, toolCallId: "tc-8", lines: ["Create a team at https://relay.example for /p"] })).ok, false, "another call");
	assert.deepEqual(await allows.takeRequest({ ...q, lines: ["Create a team at https://relay.example for /p"] }), { ok: true });
	assert.equal((await allows.takeRequest({ ...q, lines: ["Create a team at https://relay.example for /p"] })).ok, false, "once");
	// A gate's Allow never stands in for an approval, nor an approval for a gate.
	allows.note(gate({ toolCallId: "tc-5" }));
	assert.equal((await allows.takeRequest({ ...q, toolCallId: "tc-5", lines: ["x"] })).ok, false);
});
