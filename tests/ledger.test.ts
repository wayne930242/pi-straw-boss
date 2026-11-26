import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { WaitWire } from "../src/link/kinds.ts";
import type { InboxItem } from "../src/link/store.ts";
import { parkOpen, returnParked } from "../src/server/autotower.ts";
import { ledgerFile, ledgerRow, noteLedger } from "../src/server/ledger.ts";
import { createLinkWaits } from "../src/server/linkwaits.ts";
import { slotOf, type Slot } from "../src/server/record.ts";
import { startThreads, threadReply } from "../src/server/threadsops.ts";
import { addCardWait, addWait, memoryRequest, noteMessage, updateMemory } from "../src/server/towermemory.ts";
import { checkCard } from "../src/server/waitcard.ts";
import { pressRequest } from "../src/server/waitpress.ts";
import type { Request } from "../src/server/socket.ts";
import { until, World } from "./fakes.ts";

// The event ledger (docs/specs/2026-11-26-event-ledger.md): `<state folder>/ledger/<UTC day>.jsonl`, one line per event of the waits, the link waits, the review threads, call_tower, boss_wrap, and boss_handover, with ids,
// kinds, and times only. Every test plants a marked string in the text the act carries and finds it nowhere in the ledger.

const PLANT = "PLANTED-7f3q secret words";
let root = "", slot: Slot;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-ledger-"));
	slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Every row of the state folder's ledger, the days in order, and the raw text, which must never hold the planted string. */
const rows = (dir = slot.stateDir) => {
	const days = existsSync(join(dir, "ledger")) ? readdirSync(join(dir, "ledger")).sort() : [];
	const text = days.map((d) => readFileSync(join(dir, "ledger", d), "utf8")).join("");
	assert.ok(!text.includes("PLANTED"), "no text of the act reaches the ledger");
	return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};
const kinds = (dir?: string) => rows(dir).map((r) => [r.kind, r.id, ...(r.by ? [r.by] : []), ...(r.why ? [r.why] : [])]);

test("a row is v, at, kind, id, session, workspace and the optional why, item, by; an id that is not id-shaped is null, and a why or by outside its kind's set is left out", () => {
	assert.deepEqual(Object.keys(ledgerRow({ kind: "thread_close", id: "T3", session: "01a2b3c4-x", workspace: "w1", why: "done", item: "t_abcdefgh23" }, 5)!), ["v", "at", "kind", "id", "session", "workspace", "why", "item"]);
	assert.deepEqual(ledgerRow({ kind: "wait_answered", id: "W1", session: "has spaces in it", by: "gui", why: "done" }, 5), { v: 1, at: 5, kind: "wait_answered", id: "W1", session: null, workspace: null, by: "gui" });
	assert.deepEqual(ledgerRow({ kind: "call_tower", id: "r1", why: "unspecified", by: "gui", item: "not an item" }, 5), { v: 1, at: 5, kind: "call_tower", id: "r1", session: null, workspace: null });
	assert.equal(ledgerRow({ kind: "wrap", id: PLANT }, 5), undefined, "no id, no row");
	assert.equal(ledgerRow({ kind: "call_tower", id: "straw-boss-1a2b-3~r1" }, 5), undefined, "a retried request id is cut by its sender (reach.ts), never written as it is");
	assert.equal(ledgerRow({ kind: "nonsense" as never, id: "x" }, 5), undefined);
});

test("one line per event in the UTC day's file, mode 600; a folder that cannot be written never throws and is told once", () => {
	const late = Date.parse("2026-11-26T23:59:59.900Z");
	noteLedger(slot.stateDir, { kind: "wrap", id: "s1", session: "s1", why: "wrapped" }, late);
	noteLedger(slot.stateDir, { kind: "handover", id: "s2", session: "s1" }, late + 200);
	assert.deepEqual(readdirSync(join(slot.stateDir, "ledger")).sort(), ["2026-11-26.jsonl", "2026-11-27.jsonl"]);
	assert.equal(ledgerFile(slot.stateDir, late), join(slot.stateDir, "ledger", "2026-11-26.jsonl"));
	if (process.platform !== "win32") assert.equal(statSync(ledgerFile(slot.stateDir, late)).mode & 0o777, 0o600);
	assert.deepEqual(rows(), [{ v: 1, at: late, kind: "wrap", id: "s1", session: "s1", workspace: null, why: "wrapped" }, { v: 1, at: late + 200, kind: "handover", id: "s2", session: "s1", workspace: null }]);
	const blocked = join(root, "a-file");
	writeFileSync(blocked, "x");
	const told: string[] = [];
	for (let i = 0; i < 3; i++) assert.doesNotThrow(() => noteLedger(blocked, { kind: "wrap", id: "s1" }, late, (t) => void told.push(t)));
	assert.equal(told.length, 1);
	assert.match(told[0]!, /the event ledger .* cannot be written/);
});

const raiser = { id: "main-1", name: "mp-print", role: "main" };
const card = (over: Record<string, unknown> = {}) => {
	const checked = checkCard({ type: "action", from: "main-1", happened: `The key expired. ${PLANT}`, do: `Re-authorize it. ${PLANT}`, url: "https://login.tailscale.com/admin/machines", after: `The main tests it. ${PLANT}`, ...over }, { senders: new Set(["main-1"]), restates: () => undefined });
	assert.equal(checked.ok, true, JSON.stringify(checked));
	return checked as Extract<typeof checked, { ok: true }>;
};
const T = Date.parse("2026-11-26T10:00:00Z");
const pressDeps = () => ({ slot, now: () => T, log: { line() {}, hide() {} } as never, locale: "en" as const, live: async () => false, send: async () => ({ status: "failed" }), boss() {} });

test("waits: raised, parked, answered by the door it came in (page, phone, terminal, a message the tower took), and returned, with the raiser and the workspace", async () => {
	const add = (parked = false) => updateMemory(slot, "wA", T, (m) => addCardWait(m, T, "run-1", card(), raiser, parked)).value.id;
	const [w1, w2, w3, w4] = [add(), add(), add(), add(true)];
	const d = pressDeps();
	assert.equal((await pressRequest(d, "wA", { op: "press", id: w1, act: "done" }, "gui")).status, 200);
	assert.equal((await pressRequest(d, "wA", { op: "press", id: w2, act: "decline", reason: "not now" }, "phone")).status, 200);
	assert.equal((await pressRequest(d, "wA", { op: "press", id: w3, act: "done" }, "prompt")).status, 200);
	assert.equal(memoryRequest(slot, "wA", T, { op: "answer", id: w4 }).status, 200, "a message to the tower named it");
	const w5 = add();
	parkOpen(slot, T, [{ workspace: "wA", label: "Alpha" }]);
	returnParked(slot, T, [{ workspace: "wA", label: "Alpha" }], () => "raiser");
	const agent = updateMemory(slot, "wA", T, (m) => addWait(m, T, "run-1", { text: `the build ${PLANT}`, for: "agent", on: { id: "peer-9", name: "peer" } })).value.id;
	noteMessage(slot, "wA", T, "peer-9");
	assert.deepEqual(kinds(), [
		["wait_raised", "W1"], ["wait_raised", "W2"], ["wait_raised", "W3"], ["wait_raised", "W4"], ["wait_parked", "W4"],
		["wait_answered", w1, "gui"], ["wait_answered", w2, "phone"], ["wait_answered", w3, "terminal"], ["wait_answered", w4, "tower"],
		// Auto mode parks the boss waits still open or answered (W1 and W3 were answered, W2 declined, W4 parked already); its end gives back the one that still waits.
		["wait_raised", w5], ["wait_parked", w1], ["wait_parked", w3], ["wait_parked", w5], ["wait_returned", w5],
		["wait_raised", agent], ["wait_answered", agent, "tower"],
	]);
	const all = rows();
	assert.ok(all.every((r) => r.workspace === "wA" && r.at === T));
	assert.deepEqual([...new Set(all.map((r) => r.session))], ["main-1", "peer-9"], "a card names its raiser, an agent wait the session it is on");
});

test("waits: a secret card's first step is no answer, its done is; a second press refused writes nothing; a wait a teammate's device raised names no session", async () => {
	const secret = updateMemory(slot, "wA", T, (m) => addCardWait(m, T, "run-1", card({ type: "secret", url: undefined, secret: { name: `the key ${PLANT}` } }), raiser)).value.id;
	const d = pressDeps();
	assert.equal((await pressRequest(d, "wA", { op: "press", id: secret, act: "secret" }, "pi")).status, 200);
	assert.equal((await pressRequest(d, "wA", { op: "press", id: secret, act: "done" }, "pi")).status, 200);
	assert.equal((await pressRequest(d, "wA", { op: "press", id: secret, act: "done" }, "gui")).status, 409);
	const link = updateMemory(slot, "wA", T, (m) => addCardWait(m, T, "run-1", card(), { id: "link:boxdevice", name: "box", role: "session" })).value.id;
	assert.deepEqual(kinds(), [["wait_raised", secret], ["wait_answered", secret, "terminal"], ["wait_raised", link]]);
	assert.equal(rows().at(-1)!.session, null);
});

test("link waits: one that opens and one that closes, with the main that holds it; the teammate's text stays out", async () => {
	const w = { t: T, mains: [{ id: "s-work", name: "work-on" }] };
	const router = createLinkWaits({
		slot, now: () => w.t, log: () => {}, locale: () => "en",
		net: async () => ({ sessions: w.mains.map((m, i) => ({ id: m.id, name: m.name, herdrLocation: { paneId: `p${i}` } })) as never, ps: w.mains.map((_m, i) => ({ pane_id: `p${i}`, workspace_id: "w15X", tokens: { sb_role: "main" } })) as never }),
		post: async () => true, send: async () => ({ ok: true }), caps: () => ["tower.wait", "tower-reply", "tower.awaitsReply"], deviceId: () => "ibzkd5ijmtravej475kmrykvye", selfLabel: () => "mac", workspaces: () => ["w15X"],
	});
	const item: InboxItem = {
		v: 1, id: "1".padStart(32, "0"), team: "t1", from: "n2knna6dkfud5sura2vst4gsee", fromLabel: "waydosoft", fromShort: "n2knna", seq: 1, sentAt: 1, received: 1, fromWorkspace: "box", toWorkspace: "", replyExpected: true, text: PLANT, awaitsReply: "c".repeat(32),
		wait: { id: "a".repeat(32), state: "open", owner: "work-on", what: "merge !13", handle: "0123456789abcdef" } as WaitWire,
	};
	assert.equal(await router.take(item, "w15X"), true);
	w.t += 60_000;
	assert.match(await router.act("s-work", "L1", "done", PLANT), /L1 is done/);
	assert.deepEqual(rows().map((r) => [r.kind, r.id, r.session, r.workspace, r.at]), [["link_wait_open", "L1", null, "w15X", T], ["link_wait_done", "L1", "s-work", "w15X", T + 60_000]], "nobody holds it yet when it opens");
});

test("threads on the server: thread_open with the item boss_pair named, thread_close done, and T<n>.json keeps item, closed, and closedAs", async () => {
	const stops: (() => void)[] = [], now = () => T;
	const { threads, sessionsDir } = startThreads({ slot, env: { PI_CODING_AGENT_DIR: join(root, "agent") }, now, log: () => {}, stops, over: { timer: () => () => {} } });
	const ask = (r: Record<string, unknown>) => threadReply(threads, r as Request, sessionsDir)!;
	assert.match(String((await ask({ cmd: "thread-pair", owner: "01a2b3c4-main", worker: "w", reviewer: "r", item: PLANT })).error), /^item is a todo uid/);
	assert.deepEqual(await ask({ cmd: "thread-pair", owner: "01a2b3c4-main", worker: "w", reviewer: "r", item: "01a2b3c4#12" }), { ok: true, thread: "T1", worker: "w", reviewer: "r", rounds: 3, item: "01a2b3c4#12" });
	assert.deepEqual(rows().map((r) => [r.kind, r.id, r.session, r.item]), [["thread_open", "T1", "01a2b3c4-main", "01a2b3c4#12"]]);
	stops.forEach((s) => s());
	const meta = JSON.parse(readFileSync(join(slot.dir, "threads", "01a2b3c4", "T1.json"), "utf8"));
	assert.equal(meta.item, "01a2b3c4#12");
	assert.equal(meta.closed, undefined);
});

test("a main's call_tower, boss_wrap, and boss_handover are events of its extension: why, the successor, and no summary or message", async () => {
	const world = new World();
	try {
		const tower = world.tower("tower-wA", "wA:t9", "wA:p9");
		await tower.start();
		world.autoMains();
		const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1", ui: true });
		await a.start();
		await a.promote();
		await a.tool("call_tower", { message: `MP-1 landed ${PLANT}`, why: "milestone", reply: false });
		await a.tool("call_tower", { message: `I change the port ${PLANT}`, why: "shared", reply: false });
		const no = a.tool("boss_wrap", { summary: `Shipped ${PLANT}` });
		await until(() => a.dialogs.length === 1, "the boss is asked");
		a.dialogs[0]!.settle(false);
		await no;
		await assert.rejects(a.tool("boss_wrap", { summary: " " }), /summary is required/);
		const handoff = join(root, "handoff.md");
		writeFileSync(handoff, `# Handoff ${PLANT}\n`);
		await a.tool("boss_handover", { handoff, reason: `rotate ${PLANT}` });
		const got = rows(world.stateDir).map((r) => [r.kind, r.kind === "call_tower" ? "?" : r.id, r.session, r.workspace, ...(r.why ? [r.why] : [])]);
		assert.deepEqual(got, [["call_tower", "?", "main-1", "wA", "milestone"], ["call_tower", "?", "main-1", "wA", "shared"], ["wrap", "main-1", "main-1", "wA", "refused"], ["wrap", "main-1", "main-1", "wA", "refused"], ["handover", "opened-wA:p101", "main-1", "wA"]]);
		const yes = a.tool("boss_wrap", { summary: `Shipped ${PLANT}` });
		await until(() => a.dialogs.length === 2, "asked again");
		a.dialogs[1]!.settle(true);
		await yes;
		assert.deepEqual(rows(world.stateDir).slice(-2).map((r) => [r.kind, r.why]), [["call_tower", "milestone"], ["wrap", "wrapped"]], "the wrap's own milestone, then the wrap");
	} finally {
		await world.stopAll();
	}
});
