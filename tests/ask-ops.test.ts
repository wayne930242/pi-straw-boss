import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createControl } from "../src/control.ts";
import type { Net } from "../src/net.ts";
import { startAsks } from "../src/server/askops.ts";
import type { Request } from "../src/server/socket.ts";

// The server's side of the Asks (docs/specs/2026-11-28-boss-asks.md): the control socket's ask-open, ask-answer, ask-get, ask-close and asks-rows, the page's `POST api/asks/<id>/answer` (this computer's page is
// `gui`, a paired device `phone`), and the store kept in step with every reading of the net.

let root = "", stops: (() => void)[] = [];
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-askops-"))));
afterEach(() => (stops.forEach((s) => s()), (stops = []), rmSync(root, { recursive: true, force: true })));
const net = (units: string[]): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "wA:t1", label: "docs", units: units.map((key) => ({ id: key, key, control: true, name: `${key}-name`, role: "main" as const, mark: "idle" as const, subs: [] })) }] }] });
function rig() {
	let now = 1000, current = net(["main-1"]), reads = 0;
	const listeners = new Set<(n: Net) => void>(), told = (n: Net) => (listeners.forEach((cb) => cb(n)), n);
	const watch = { onRead: (cb: (n: Net) => void) => (listeners.add(cb), () => void listeners.delete(cb)), read: async () => (reads++, told(current)), lookup: (key: string) => (key === "main-1" ? { key, base: "wA", name: "m", role: "main", pane: "wA:p1", live: true } : undefined) };
	const ops = startAsks({ stateDir: root, now: () => now, watch: () => watch, log: () => {} });
	stops.push(ops.stop);
	const ask = async (r: Record<string, unknown>) => (await ops.reply(r as unknown as Request))!;
	return { ops, ask, read: (n: Net) => told((current = n)), set: (t: number) => void (now = t), reads: () => reads, show: (n: Net) => (current = n) };
}
const question = { subject: "Deploy MP-1 now?", questions: [{ question: "The boss decides: Deploy MP-1 now?", options: ["Deploy", "Wait"] }], toolCallId: "call-1", item: 3 };

test("ask-open records the asker with its place from the last reading; ask-answer takes the first, answers 409 to the next, and the asker reads the winner with ask-get", async () => {
	const r = rig();
	r.read(net(["main-1"]));
	const opened = await r.ask({ cmd: "ask-open", session: "main-1", name: "docs-main", ask: question });
	assert.equal(opened.ok, true);
	const rec = opened.ask as { id: string; n: number; digest: string; asker: Record<string, unknown>; item: unknown };
	assert.deepEqual(rec.asker, { session: "main-1", name: "main-1-name", role: "main", workspace: "wA", workspaceLabel: "Alpha", tab: "wA:t1", tabLabel: "docs", pane: "wA:p1" });
	assert.deepEqual(rec.item, { session: "main-1", id: 3 });
	assert.equal((await r.ask({ cmd: "ask-open", session: "main-1", ask: { questions: [] } })).ok, false, "one to four questions");
	const first = await r.ask({ cmd: "ask-answer", id: rec.id, answerId: "a".repeat(16), digest: rec.digest, replies: [{ choices: [0] }], by: "terminal" });
	assert.deepEqual([first.status, (first.body as { outcome: string }).outcome], [200, "accepted"]);
	const second = await r.ask({ cmd: "ask-answer", id: rec.id, answerId: "b".repeat(16), digest: rec.digest, replies: [{ text: "no" }], by: "gui" });
	assert.deepEqual([second.status, (second.body as { by: string }).by], [409, "terminal"]);
	assert.equal((await r.ask({ cmd: "ask-answer", id: rec.id, answerId: "c".repeat(16), digest: rec.digest, replies: [{ text: "no" }], by: "owner" })).ok, false, "the owner is never a way in");
	assert.equal(((await r.ask({ cmd: "ask-get", id: rec.id })).ask as { state: string }).state, "answered");
	assert.equal((await r.ask({ cmd: "ask-get", id: "f".repeat(32) })).ok, false);
});

test("ask-close is the asker's own, for its blocking Ask, with esc, abort or auto; an Ask open before a restart is there for the new server", async () => {
	const r = rig();
	const rec = (await r.ask({ cmd: "ask-open", session: "main-1", name: "docs-main", ask: question })).ask as { id: string };
	assert.equal((await r.ask({ cmd: "ask-close", id: rec.id, session: "main-2", why: "esc" })).ok, false, "another session");
	assert.equal((await r.ask({ cmd: "ask-close", id: rec.id, session: "main-1", why: "answered" })).ok, false, "not a reason the asker gives");
	const again = startAsks({ stateDir: root, now: () => 2000, watch: () => undefined, log: () => {} });
	stops.push(again.stop);
	assert.equal(((await again.reply({ cmd: "ask-get", id: rec.id } as unknown as Request))!.ask as { state: string }).state, "open", "kept across a restart");
	assert.equal(((await r.ask({ cmd: "ask-close", id: rec.id, session: "main-1", why: "esc" })).ask as { closed: unknown }).closed !== undefined, true);
});

test("asks-rows reads the net again when the last reading is ten seconds old, and gives the session its rows with `mine`", async () => {
	const r = rig();
	r.read(net(["main-1", "main-2"]));
	await r.ask({ cmd: "ask-open", session: "main-2", name: "api-main", ask: question });
	const before = r.reads();
	const rows = (await r.ask({ cmd: "asks-rows", session: "main-1" })).rows as { id: string; mine: boolean; where: string }[];
	assert.equal(r.reads(), before, "a fresh reading is used as it is");
	assert.deepEqual(rows.map((x) => [x.id, x.mine, x.where]), [["Q1", false, "Alpha › docs"]]);
	r.set(20_000);
	r.show(net(["main-1"]));
	await r.ask({ cmd: "asks-rows", session: "main-2" });
	assert.equal(r.reads(), before + 1, "an old reading is made again");
});

test("the page's answer route: this computer's page answers as gui, a paired device as phone; a box's operate request is refused", async () => {
	const r = rig();
	const rec = (await r.ask({ cmd: "ask-open", session: "main-1", name: "docs-main", ask: question })).ask as { id: string; digest: string };
	const control = createControl({ asks: { answer: (id, json, remote) => r.ops.answer(id, json, remote) }, lookup: () => undefined, csrf: "x", canonical: () => undefined });
	const body = { answerId: "d".repeat(16), digest: rec.digest, replies: [{ choices: [1], note: "after QA" }] };
	assert.equal((await control.run(["asks", rec.id, "answer"], body, { remote: true, secure: true, operate: true })).status, 404, "never from an operated box");
	const won = await control.run(["asks", rec.id, "answer"], body, { remote: true, secure: true });
	assert.deepEqual([won.status, (won.body as { outcome: string }).outcome], [200, "accepted"]);
	assert.equal(r.ops.store.get(rec.id)?.answer?.by, "phone");
	const late = await control.run(["asks", rec.id, "answer"], { ...body, answerId: "e".repeat(16) }, { remote: false, secure: false });
	assert.deepEqual([late.status, (late.body as { reason: string }).reason], [409, "Q1 was already answered on the phone."]);
	assert.equal((await createControl({ lookup: () => undefined, csrf: "x", canonical: () => undefined }).run(["asks", rec.id, "answer"], body, { remote: false, secure: false })).status, 503);
});
