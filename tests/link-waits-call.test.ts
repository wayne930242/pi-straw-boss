import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldsOf, stamp } from "../src/header.ts";
import { callTowerTool } from "../src/link/waitcall.ts";

// A main's side of a link wait (docs/specs/2026-11-21-box-mac-waits.md §2.1, §2.4): `call_tower` `waitsOn` is refused unless the call is blocked and the device resolves, and its header carries `waits-on=` with the owner and what the tower
// run's forward reads; `linkWait` asks the router first, so a refusal sends nothing to the tower. The wake's header names the device without `verified=`.

type Body = (p: Record<string, unknown>) => Promise<{ text: string; details?: unknown }>;
function rig(answers: Record<string, (op: Record<string, unknown>) => Record<string, unknown>> = {}) {
	const calls: { message: string; why?: string; extra?: unknown }[] = [], ops: Record<string, unknown>[] = [];
	let body: Body | undefined;
	callTowerTool(((_name: string, _d: string, _p: unknown, b: Body) => void (body = b)) as never, false,
		(async (message: string, _ws: string | undefined, _reply: boolean, why?: string, extra?: unknown) => (calls.push({ message, ...(why ? { why } : {}), ...(extra ? { extra } : {}) }), { text: "Sent to the tower of Alpha.", details: { towerId: "sb-tower-wa" } })) as never,
		{ waitOp: async (op: Record<string, unknown>) => { ops.push(op); const a = answers[String(op.op)]?.(op); if (!a || a.ok === false) throw new Error(String(a?.error ?? "refused")); return a; } });
	return { calls, ops, call: (p: Record<string, unknown>) => body!(p) };
}
const MAC = { ok: true, id: "ibzkd5ijmtravej475kmrykvye", short: "ibzkd5", label: "mac", team: "t1" };

test("waitsOn goes with why blocked and a what; the device resolves before anything is sent, and the header carries waits-on, waits-owner, and waits-what", async () => {
	const r = rig({ "device-resolve": (op) => (op.device === "mac" ? MAC : { ok: false, error: "No device is named nope" }) });
	await assert.rejects(r.call({ message: "m", why: "milestone", waitsOn: { device: "mac", what: "merge" } }), /waitsOn goes with why blocked/);
	await assert.rejects(r.call({ message: "m", why: "blocked", waitsOn: { device: "mac" } }), /waitsOn\.what is required/);
	await assert.rejects(r.call({ message: "m", why: "blocked", waitsOn: { device: "nope", what: "merge" } }), /No device is named nope/);
	assert.equal(r.calls.length, 0, "nothing went to the tower");
	const done = await r.call({ message: "the box main is blocked on the Mac", why: "blocked", waitsOn: { device: "mac", owner: "work-on", what: "merge approval-api !13\nnow" } });
	assert.match(done.text, /It waits on mac \(ibzkd5\)/);
	// `raise` lets the server refuse an opened main's wait on a device other than its opener (0.81.3, allywait.ts `raiserRefusal`).
	assert.equal(r.ops.filter((op) => op.op === "device-resolve").at(-1)?.raise, true);
	const extra = r.calls[0]!.extra as { waitsOn: { short: string; owner: string; what: string } };
	assert.deepEqual(extra.waitsOn, { short: "ibzkd5", owner: "work-on", what: "merge approval-api !13 now" });
	const line = stamp({ from: { id: "s1", name: "box main", role: "main", workspace: "MP" }, kind: "call_tower", scope: "tower", to: [], reply: true, why: "blocked", ...extra }, "text");
	const f = fieldsOf(line)!;
	assert.deepEqual([f["waits-on"], f["waits-owner"], f["waits-what"]], ["ibzkd5", "work-on", "merge approval-api !13 now"]);
});

test("waitsOn cancel goes with why milestone and withdraws the open wait; linkWait asks the router first and a refusal sends nothing", async () => {
	const r = rig({ "device-resolve": () => MAC, "wait-cancel": () => ({ ok: true, text: "Withdrew 1 open wait to mac; it is told." }), "wait-act": (op) => (op.id === "L3" ? { ok: true, text: "L3 is done." } : { ok: false, error: "No link wait L9 waits on this workspace" }) });
	const cancelled = await r.call({ message: "no longer needed", why: "milestone", waitsOn: { device: "mac", cancel: true } });
	assert.match(cancelled.text, /^Withdrew 1 open wait to mac/);
	assert.match(fieldsOf(stamp({ from: { id: "s", name: "n", role: "main" }, kind: "call_tower", scope: "tower", to: [], reply: false, ...(r.calls[0]!.extra as object) }, "x"))!["waits-cancel"]!, /^yes$/);
	await assert.rejects(r.call({ message: "x", why: "milestone", linkWait: { id: "L9", state: "done" } }), /No link wait L9/);
	assert.equal(r.calls.length, 1, "the refusal sent nothing to the tower");
	const done = await r.call({ message: "merged as 4d2a1f", why: "milestone", linkWait: { id: "L3", state: "done" } });
	assert.match(done.text, /^L3 is done\. Sent to the tower/);
	assert.deepEqual(r.ops.at(-1), { op: "wait-act", id: "L3", state: "done", message: "merged as 4d2a1f" });
	assert.deepEqual(r.calls.at(-1)!.extra, { wait: "L3" });
});

test("the router's lines name the teammate device by remote= and device= without verified=, and a link wait as wait=L<n>", () => {
	const line = stamp({ from: { id: "sb-tower-w15x", name: "tower", role: "tower", workspace: "MP Center" }, kind: "link_wait", scope: "session", to: [{ id: "s", name: "work-on", role: "main" }], reply: false, wait: "L3", peer: { label: "waydosoft", short: "n2knna" } }, "waydosoft waits on this workspace");
	const f = fieldsOf(line)!;
	assert.deepEqual([f.kind, f.wait, f.remote, f.device, f.verified, f.reply], ["link_wait", "L3", "waydosoft", "n2knna", undefined, "none"]);
	assert.throws(() => stamp({ from: { id: "x", name: "x", role: "tower" }, kind: "link_wait", scope: "session", to: [], reply: false, peer: { label: "x", short: "NOPE!!" } }, "x"), /short id/);
});

test("D13: call_tower standing sends the message to the device's standing main through the router's standing-send: a question with why blocked, a notice with milestone; the tower gets no call for it", async () => {
	const r = rig({ "standing-send": (op) => ({ ok: true, text: `Your ${String(op.kind)} went to the standing main of mac (ibzkd5).`, details: { standing: op.kind } }) });
	await assert.rejects(r.call({ message: "m", why: "shared", standing: { device: "mac" } }), /standing goes with why blocked \(a question\) or milestone \(a notice\)/);
	await assert.rejects(r.call({ message: "m", why: "blocked", standing: { device: "mac" }, waitsOn: { device: "mac", what: "x" } }), /do not go together/);
	const asked = await r.call({ message: "Is approval-api !13 safe to merge before the train?", why: "blocked", standing: { device: "mac", what: "merge !13 before the train?" } });
	assert.match(asked.text, /^Your question went to the standing main of mac/);
	const told = await r.call({ message: "The box train 1121 landed.", why: "milestone", standing: { device: "mac" } });
	assert.match(told.text, /^Your notice went/);
	assert.deepEqual(r.ops, [{ op: "standing-send", device: "mac", kind: "question", what: "merge !13 before the train?", message: "Is approval-api !13 safe to merge before the train?" }, { op: "standing-send", device: "mac", kind: "notice", what: "", message: "The box train 1121 landed." }]);
	assert.equal(r.calls.length, 0, "nothing went to the tower");
});
