import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type AskClient, createBossAsk } from "../src/bossask.ts";
import { BOSS_PREFIX } from "../src/owners.ts";
import { startAsks } from "../src/server/askops.ts";
import type { Request } from "../src/server/socket.ts";
import type { Kit } from "../src/state.ts";

// `call_tower`'s boss question as a blocking Ask (docs/specs/2026-11-28-boss-asks.md, The answer path): the store decides which answer won, the pane's, the page's (through the session's dialog relay) or the phone's
// (the relay with `remote`, or the store's own route); the others close, a late one is refused, and Escape closes the Ask with its reason.

let root = "", stops: (() => void)[] = [];
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-bossask-"))));
afterEach(() => (stops.forEach((s) => s()), (stops = []), rmSync(root, { recursive: true, force: true })));
const flush = () => new Promise((r) => setImmediate(r));
async function until(ok: () => boolean, what: string) {
	for (let i = 0; i < 200 && !ok(); i++) await flush();
	assert.ok(ok(), what);
}

function rig(todos?: { id: number; status: string }[]) {
	const ops = startAsks({ stateDir: root, now: () => 1000, watch: () => undefined, log: () => {} });
	stops.push(ops.stop);
	const call = async (r: Record<string, unknown>) => (await ops.reply(r as unknown as Request))!;
	const asks: AskClient = {
		open: async (a) => ((r) => r.ask as { id: string; digest: string })(await call({ cmd: "ask-open", session: "main-1", name: "docs-main", ask: a })),
		answer: async (id, a) => ((r) => ({ status: Number(r.status), body: r.body as Record<string, unknown> }))(await call({ cmd: "ask-answer", id, ...a })),
		get: async (id) => (await call({ cmd: "ask-get", id })).ask as never,
		close: async (id, why) => void (await call({ cmd: "ask-close", id, session: "main-1", why })),
	};
	const events = new EventEmitter(), bus = { emit: (c: string, d: unknown) => void events.emit(c, d), on: (c: string, h: (d: unknown) => void) => (events.on(c, h), () => void events.off(c, h)) };
	const seen: { channel: string; data: Record<string, unknown> }[] = [];
	for (const c of ["pending", "closed", "answer-result"]) events.on(`${BOSS_PREFIX}:${c}`, (data) => seen.push({ channel: c, data }));
	const ticks = new Set<() => void>();
	const kit = { pi: { events: bus }, cfg: { face: { every: (fn: () => void) => (ticks.add(fn), () => void ticks.delete(fn)) }, env: {} }, s: { isTrain: false, isTower: false, remoteOrigin: undefined, autoOn: () => false, branch: () => (todos ? [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: todos.map((t) => ({ ...t, subject: `t${t.id}` })), nextId: 9 } } }] : []) }, role: () => "main", me: () => "main-1", guiDir: root } as unknown as Kit;
	let settle: ((v: string | undefined) => void) | undefined;
	const ui = { select: (_t: string, _o: string[], o: { signal: AbortSignal }) => new Promise<string | undefined>((resolve) => { settle = resolve; o.signal.addEventListener("abort", () => resolve(undefined)); }), input: async () => undefined };
	const bossAsk = createBossAsk(kit, { attended: () => true, remote: () => false, asks });
	const ask = (item?: number) => bossAsk({ question: "Deploy MP-1 now?", options: ["Deploy", "Wait"], ...(item ? { item } : {}) }, undefined, { hasUI: true, ui: ui as never }, "call-1");
	const pending = () => seen.find((x) => x.channel === "pending")?.data as { id: string; digest: string } | undefined;
	const relayAnswer = (choice: number, extra: Record<string, unknown> = {}) => bus.emit(`${BOSS_PREFIX}:answer`, { version: 1, id: pending()!.id, answerId: `page-${choice}-${"x".repeat(12)}`, digest: pending()!.digest, answers: [{ choices: [choice] }], ...extra });
	return { ops, ask, seen, pick: (v: string | undefined) => settle!(v), opened: () => settle !== undefined, relayAnswer, tick: () => ticks.forEach((fn) => fn()), record: () => ops.store.list().at(-1)! };
}
const text = (a: { kind: string; text?: string }) => a.text ?? "";

test("answered in the pane: the store takes it as the terminal's, the page's relay closes, and the page's later answer is refused", async () => {
	const r = rig([{ id: 4, status: "in_progress" }]);
	const done = r.ask();
	await until(() => r.opened(), "drawn");
	assert.equal(r.record().state, "open");
	assert.deepEqual(r.record().item, { session: "main-1", id: 4 }, "bound to the asker's todo in progress");
	r.pick("Wait");
	assert.match(text(await done), /^The boss chose: "Wait"\./);
	assert.deepEqual([r.record().state, r.record().answer?.by, r.record().answer?.replies], ["answered", "terminal", [{ choices: [1] }]]);
	assert.deepEqual(r.seen.find((x) => x.channel === "closed")?.data.by, "local", "the page's panel goes");
});

test("answered on the page through the relay: the store takes it first, the pane's dialog closes, and the result is that answer; a phone's is recorded as the phone", async () => {
	const r = rig();
	const done = r.ask(7);
	await until(() => Boolean(r.opened() && r.seen.length), "drawn and relayed");
	r.relayAnswer(0);
	assert.match(text(await done), /^The boss chose: "Deploy"\./);
	assert.deepEqual([r.record().answer?.by, r.record().item], ["gui", { session: "main-1", id: 7 }]);
	assert.equal(r.seen.find((x) => x.channel === "answer-result")?.data.accepted, true);
	const again = rig();
	const next = again.ask();
	await until(() => Boolean(again.opened() && again.seen.length), "drawn");
	again.relayAnswer(1, { remote: true });
	await next;
	assert.equal(again.record().answer?.by, "phone");
});

test("answered through the store's own route: the asker's look closes the pane and the relay; a page answer after it is taken by nothing", async () => {
	const r = rig();
	const done = r.ask();
	await until(() => r.opened(), "drawn");
	const rec = r.record();
	assert.equal(r.ops.answer(rec.id, { answerId: "p".repeat(16), digest: rec.digest, replies: [{ text: "after QA", note: "not today" }] }, true).status, 200);
	r.tick();
	assert.match(text(await done), /^The boss answered: "after QA"\. His note: "not today"\./);
	assert.deepEqual(r.seen.find((x) => x.channel === "closed")?.data.by, "remote", "the page's panel goes");
	r.relayAnswer(0);
	await flush();
	assert.equal(r.seen.some((x) => x.channel === "answer-result"), false, "a closed relay takes nothing");
	assert.equal(r.record().answer?.by, "phone");
});

test("the pane answers after another answer won in the store: the result is the winner's, not the pane's", async () => {
	const r = rig();
	const done = r.ask();
	await until(() => r.opened(), "drawn");
	const rec = r.record();
	r.ops.answer(rec.id, { answerId: "q".repeat(16), digest: rec.digest, replies: [{ choices: [0] }] }, false);
	r.pick("Wait"); // before the look came round
	assert.match(text(await done), /^The boss chose: "Deploy"\./);
	assert.equal(r.record().answer?.by, "gui");
});

test("Escape closes the Ask with its reason, and nothing is answered", async () => {
	const r = rig();
	const done = r.ask();
	await until(() => r.opened(), "drawn");
	r.pick(undefined);
	assert.match(text(await done), /did not answer \(Esc\)/);
	await until(() => r.record().state === "closed", "closed");
	assert.deepEqual(r.record().closed?.why, "esc");
});
