import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Net } from "../src/net.ts";
import { netSource } from "../src/net.ts";
import { createAutoMode, PENDING_MS } from "../src/server/automode.ts";
import { autoPanel } from "../src/server/autoops.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { until } from "./fakes.ts";
import { fakeClock } from "./fake-clock.ts";
import { createControl } from "../src/control.ts";


// The head's confirm button (docs/specs/2026-11-09-auto-mode.md, sections 2 and 7; D9, task 5a): it shows only while the snapshot carries a pending record, a tap sends the record's id and nothing else, and a tap on a lapsed or
// replaced one shows the server's refusal. The snapshot carries `auto` only while it is on or a request waits.

// The page runs on Linux here: nothing the auto mode switch says may name a platform's key (no ⌘, no Ctrl).
Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux" }, configurable: true });
sessionGlobals();
const sent: { path: string; body: Record<string, unknown> }[] = [];
let reply: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 200, body: { entries: [] } };
Object.assign(globalThis, {
	HTMLButtonElement: El, requestAnimationFrame: (run: () => void) => run(), innerWidth: 1000,
	fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: reply.ok, status: reply.status, json: async () => reply.body }),
});
Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
const { fillAuto, io, pendingOf, mountAutoSwitch, clockOf, ARM_MS } = await import("../gui/auto.ts");
const { m } = await import("../gui/paraglide/messages.js");
const { alertsOf, arrivals } = await import("../gui/alerts.ts");
const { cardModel } = await import("../gui/waitcardmodel.ts");
const { waitCard } = await import("../gui/waitcard.ts");
const { waitLine } = await import("../gui/waits.ts");
const { mountBack, openWait } = await import("../gui/autoback.ts");
const { autoDemo } = await import("../gui/demo-auto.ts");

const net = (auto?: Net["auto"]): Net => ({ bases: [], ...(auto ? { auto } : {}) });
const PENDING = { id: "p1", said: "我要睡了", expires: Date.now() + 600_000 };
const box = () => page.createElement("div") as unknown as El;
const button = (b: El) => b.querySelector(".auto-confirm") as El | null;
const note = (b: El) => b.querySelector(".auto-note")!.textContent;

test("the button shows only while a pending record lives: not with auto mode off, not with it on, not after the record lapsed", () => {
	const b = box();
	fillAuto(b as never, net());
	assert.equal(b.hidden, true);
	assert.equal(button(b), null);
	fillAuto(b as never, net({ on: true, since: "2026-11-09T15:10:00Z" }));
	assert.equal(b.hidden, true, "on, nothing pending: no button");
	fillAuto(b as never, net({ on: false, pending: PENDING }));
	assert.equal(b.hidden, false);
	assert.equal(button(b)!.textContent, m.auto_confirm_button());
	assert.match(b.querySelector(".auto-said")!.textContent, /我要睡了/);
	assert.equal(pendingOf(net({ on: false, pending: PENDING }))?.id, "p1");
	fillAuto(b as never, net());
	assert.equal(b.hidden, true, "the record is gone from the snapshot");
	assert.equal(button(b), null);
	fillAuto(b as never, undefined);
	assert.equal(b.hidden, true);
});

test("a tap sends the record's id to auto/confirm, once at a time; the words come from the server's record, never from markup", async () => {
	const posts: [string, Record<string, unknown>][] = [];
	io.post = async (path, body) => (posts.push([path, body]), { ok: true, status: 200, body: {} });
	const b = box();
	fillAuto(b as never, net({ on: false, pending: { ...PENDING, said: "<img src=x onerror=alert(1)>" } }));
	assert.equal(b.querySelector("img"), null, "the said words are text");
	const first = button(b)!;
	first.click();
	first.click();
	await until(() => note(b) === m.auto_confirmed(), "the confirmed line");
	assert.deepEqual(posts, [["auto/confirm", { id: "p1" }]], "one post, the id and nothing else");
	// the same record in the next snapshot does not rebuild the button or clear its line
	fillAuto(b as never, net({ on: false, pending: PENDING }));
	assert.equal(button(b), first);
});

test("a tap on an expired or replaced record shows the server's refusal and the button can be tried again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-autogui-"));
	let now = 1_800_000_000_000, n = 0;
	const auto = createAutoMode({ dir, now: () => now, log: () => {}, id: () => `id${++n}` });
	auto.start();
	const panel = autoPanel(auto);
	assert.equal(panel.snap(), undefined, "off and nothing pending: the snapshot carries nothing");
	auto.stage("我要睡了", { via: "head", name: "head tower" });
	assert.deepEqual(panel.snap(), { on: false, pending: { id: "id1", said: "我要睡了", expires: now + PENDING_MS } });
	io.post = async (path, body) => {
		assert.equal(path, "auto/confirm");
		const r = panel.confirm(body.id, false);
		return { ok: r.status === 200, status: r.status, body: r.body as never };
	};
	const b = box();
	fillAuto(b as never, net({ on: false, pending: panel.snap()!.pending }));
	now += PENDING_MS + 1;
	button(b)!.click();
	await until(() => note(b) !== "", "the refusal");
	assert.equal(note(b), m.auto_stale());
	assert.equal(auto.view().on, false, "an expired confirm switches nothing");
	assert.equal(button(b)!.hasAttribute("disabled"), false);
	// a replaced record
	now -= PENDING_MS;
	auto.stage("我要睡了", { via: "head", name: "head tower" });
	auto.stage("睡覺", { via: "head", name: "head tower" });
	const stale = { id: "id2", said: "x", expires: now + 1000 };
	fillAuto(b as never, net({ on: false, pending: stale }));
	button(b)!.click();
	await until(() => note(b) === m.auto_stale(), "the refusal for a replaced id");
	assert.equal(auto.view().on, false);
	// the live record confirms
	fillAuto(b as never, net({ on: false, pending: panel.snap()!.pending }));
	button(b)!.click();
	await until(() => auto.view().on, "the switch");
	assert.deepEqual(panel.snap(), { on: true, since: auto.view().since });
});

test("the net snapshot carries `auto` only while it is on or a request waits, as the panel reads it", async () => {
	const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: [] } : { workspaces: [] } });
	let snap: Net["auto"];
	const read = () => netSource({ run: herdr, sessions: async () => [], sessionDir: "/s", auto: () => snap }).read();
	assert.ok(!("auto" in (await read())));
	snap = { on: false };
	assert.ok(!("auto" in (await read())), "off and nothing pending: no field");
	snap = { on: false, pending: PENDING };
	assert.deepEqual((await read()).auto, { on: false, pending: PENDING });
	snap = { on: true, since: "2026-11-09T15:10:00Z" };
	assert.deepEqual((await read()).auto, snap);
});

// --- Phase 2 (task 5b): the header chip and its switch, silent parked cards, the return panel, both languages, phone targets, the demo ---------------------------------------------------------------------------------------------------

const chipOf = (box: El) => box.querySelector(".auto-chip") as El;
const swNote = (box: El) => box.querySelector(".auto-sw-note")!.textContent;
const box0 = () => page.createElement("div") as unknown as El;
/** The switch with a clock of its own: the arming lapses by the test's clock, not the machine's. */
function switchWith(posts: [string, Record<string, unknown>][], answer: () => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> = async () => ({ ok: true, status: 200, body: {} }), after?: (off: boolean) => void) {
	const clock = fakeClock(), box = box0();
	io.post = async (path, body) => (posts.push([path, body]), (await answer()) as never);
	const timers: { id: number; at: number; fn: () => void }[] = [];
	let next = 0;
	const sw = mountAutoSwitch(box as never, { timers: { set: (fn, ms) => (timers.push({ id: ++next, at: clock.now() + ms, fn }), next), clear: (id) => void timers.splice(0, timers.length, ...timers.filter((t) => t.id !== id)) }, ...(after ? { after } : {}) });
	const tick = (ms: number) => { clock.advance(ms); for (const t of timers.filter((x) => x.at <= clock.now())) (timers.splice(timers.indexOf(t), 1), t.fn()); };
	return { box, sw, tick };
}
const SINCE = "2026-11-09T15:10:00Z";

test("the chip: off says Auto mode; one tap arms it with the words of the confirm and posts nothing; a second tap posts `on` once and the chip says since when", async () => {
	const posts: [string, Record<string, unknown>][] = [];
	const { box, sw } = switchWith(posts, async () => ({ ok: true, status: 200, body: { on: true, since: SINCE } }));
	sw.net(net());
	const chip = chipOf(box);
	assert.equal(chip.textContent, m.auto_chip_off());
	assert.equal(chip.dataset.state, "off");
	assert.equal(chip.getAttribute("aria-pressed"), "false");
	chip.click();
	assert.deepEqual(posts, [], "the first tap asks, it does not switch");
	assert.equal(chip.dataset.state, "arming");
	assert.equal(chip.textContent, m.auto_arm());
	chip.click();
	chip.click();
	await until(() => chip.dataset.state === "on", "on");
	assert.deepEqual(posts, [["auto", { on: true }]], "one post");
	assert.equal(chip.textContent, m.auto_chip_on({ time: clockOf(SINCE) }));
	assert.equal(chip.getAttribute("aria-pressed"), "true");
});

test("the second tap's words are the boss's: 「代理不能再問你，正在等你的提問會被取消」, and no word names a key of a platform", () => {
	assert.equal(m.auto_arm({}, { locale: "zh-TW" }), "代理不能再問你，正在等你的提問會被取消");
	for (const locale of ["en", "zh-TW"] as const) for (const id of ["auto_chip_off", "auto_arm", "auto_chip_title_off", "auto_chip_title_on", "wait_parked", "wc_secret_parked", "back_title"] as const) assert.doesNotMatch((m[id] as (i: object, o: object) => string)({ time: "23:10" }, { locale }), /⌘|Ctrl|Cmd/, `${id} ${locale}`);
});

test("the arming lapses after a few seconds, and an Escape cancels it: nothing is posted", () => {
	const posts: [string, Record<string, unknown>][] = [];
	const { box, sw, tick } = switchWith(posts);
	sw.net(net());
	const chip = chipOf(box);
	chip.click();
	tick(ARM_MS - 1);
	assert.equal(chip.dataset.state, "arming");
	tick(1);
	assert.equal(chip.dataset.state, "off");
	assert.equal(chip.textContent, m.auto_chip_off());
	chip.click();
	chip.dispatchEvent({ type: "keydown", key: "Escape" } as never);
	assert.equal(chip.dataset.state, "off");
	assert.deepEqual(posts, []);
});

test("a snapshot while arming leaves the arming; a snapshot that says on is on whatever the chip thought, and a pending request is not on", () => {
	const { box, sw } = switchWith([]);
	sw.net(net());
	chipOf(box).click();
	sw.net(net());
	assert.equal(chipOf(box).dataset.state, "arming");
	sw.net(net({ on: true, since: SINCE }));
	assert.equal(chipOf(box).dataset.state, "on");
	assert.equal(chipOf(box).textContent, m.auto_chip_on({ time: clockOf(SINCE) }));
	sw.net(net({ on: false, pending: PENDING }));
	assert.equal(chipOf(box).dataset.state, "off", "a staged request is not auto mode");
});

test("on: one tap posts `off` and tells the page it is back (the return panel opens from it); the state follows the next snapshot", async () => {
	const posts: [string, Record<string, unknown>][] = [], told: boolean[] = [];
	const { box, sw } = switchWith(posts, undefined, (off) => told.push(off));
	sw.net(net({ on: true, since: SINCE }));
	chipOf(box).click();
	await until(() => told.length === 1, "the page is told");
	assert.deepEqual(posts, [["auto", { on: false }]]);
	assert.deepEqual(told, [true]);
	assert.equal(chipOf(box).dataset.state, "off");
});

test("a refusal says why under the chip and the chip is off again, ready to be armed", async () => {
	const { box, sw } = switchWith([], async () => ({ ok: false, status: 409, body: { error: "unattended", reason: "an unattended device has no boss at it" } }));
	sw.net(net());
	chipOf(box).click();
	chipOf(box).click();
	await until(() => swNote(box) !== "", "the refusal");
	assert.equal(swNote(box), "an unattended device has no boss at it");
	assert.equal(chipOf(box).dataset.state, "off");
	chipOf(box).click();
	assert.equal(chipOf(box).dataset.state, "arming");
	assert.equal(swNote(box), "", "arming again clears the old line");
});

// --- parked cards are silent -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const memoryOf = (waits: unknown[]) => ({ rev: 3, standing: 0, decisions: 0, waits: waits.length, bossWaits: waits, proposals: [] });
const towerNet = (waits: unknown[], auto?: Net["auto"]): Net => ({
	bases: [{ id: "w1", label: "Harbor", mark: "idle", tower: { name: "tower · Harbor", mark: "idle", key: "t1", control: true, subs: [], service: { state: "standing", memory: memoryOf(waits) } }, tabs: [], outposts: [], outside: [] }],
	...(auto ? { auto } : {}),
} as never);
const WAIT_AT = new Date(Date.now() - 20 * 60_000).toISOString();
const w = (id: string, extra: object = {}) => ({ id, text: `question ${id}`, at: WAIT_AT, ...extra });

test("a parked wait raises no alert, so no system notification, sound, Zen cue, dock queue entry, or tab count; the same wait unparked does", () => {
	const parked = towerNet([w("W1", { parked: true }), w("W2")], { on: true, since: SINCE });
	const keys = [...alertsOf(parked, Date.now()).values()].filter((a) => a.wait).map((a) => a.wait!.id);
	assert.deepEqual(keys, ["W2"], "W1 is parked: it stays on the card and in the rows, not in the queue");
	const before = alertsOf(towerNet([w("W1", { parked: true })]), Date.now()), after = alertsOf(towerNet([w("W1")]), Date.now());
	assert.equal(arrivals(before, before).length, 0, "nothing new while it stays parked");
	assert.deepEqual(arrivals(before, after).map((a) => a.wait?.id), ["W1"], "a wait the panel never listed is an ordinary wait again");
	const listed = alertsOf(towerNet([w("W1", { listed: true }), w("W2")]), Date.now());
	assert.deepEqual([...listed.values()].filter((a) => a.wait).map((a) => a.wait!.id), ["W2"], "boss decision 11-10: a wait the return panel lists notifies no more when auto mode ends (no notification, sound, dock, or count); it stays on its card");
	assert.equal(arrivals(before, alertsOf(towerNet([w("W1", { listed: true })]), Date.now())).length, 0, "parked to listed: nothing arrives");
});

test("a parked card says it is parked, in both languages; its row line says it too", () => {
	const wait = w("W1", { parked: true });
	for (const locale of ["en", "zh-TW"] as const) {
		const model = cardModel({ wait: wait as never, phase: "open", remote: false, open: false, now: Date.now() }, { locale });
		assert.equal(model.parked, m.wait_parked({}, { locale }));
		assert.match(waitLine(wait as never, Date.now(), { locale }), new RegExp(m.wait_parked({}, { locale })));
	}
	assert.equal(m.wait_parked({}, { locale: "zh-TW" }), "已暫放，等你回來");
	assert.equal(cardModel({ wait: w("W2") as never, phase: "open", remote: false, open: false, now: Date.now() }).parked, undefined);
	const card = waitCard({ host: "row", wait: wait as never, actions: { tell: async () => ({ ok: true, status: 200, body: {} }), press: async () => ({ ok: true, status: 200, body: {} }), read: async () => ({ ok: true, status: 200, body: {} }), goto: { view: "session", ws: "w1", key: "t1" } } as never });
	assert.equal((card.el as unknown as El).querySelector(".wc-parked")!.textContent, m.wait_parked());
});

test("a secret card parked by auto mode has no start button and says to end auto mode first", () => {
	const secret = w("W4", { parked: true, card: { type: "secret", lang: "en", happened: "h", do: "d", secret: { name: "key" }, from: { name: "x", role: "main", key: "a1" } } });
	const model = cardModel({ wait: secret as never, phase: "open", remote: false, open: true, now: Date.now() });
	assert.equal(model.buttons.some((b) => b.id === "secret"), false, "the start button is hidden");
	assert.equal(model.line, m.wc_secret_parked(), "the status line says it");
	assert.equal(model.remote, undefined, "no line of its own above the rows");
	const plain = cardModel({ wait: { ...secret, parked: undefined } as never, phase: "open", remote: false, open: true, now: Date.now() });
	assert.equal(plain.buttons.some((b) => b.id === "secret"), true, "off auto mode the card is as it was");
});

// --- the return panel ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ROW = (id: string, extra: object = {}) => ({ workspace: "w1", tower: "Harbor", id, text: `question ${id}`, type: "action", at: WAIT_AT, ...extra });
const REPORT = {
	v: 1 as const, since: SINCE, until: "2026-11-10T00:40:00Z", on: "gui: the page", off: "gui: the page",
	parked: [ROW("W1"), ROW("W2"), ROW("W9")],
	lines: [{ session: "ops-main", tool: "robot_hand", kind: "cancelled", count: 2, first: "2026-11-09T15:20:00Z", gist: "Deploy needs sudo" }, { session: "api-fix", tool: "secret_drop", kind: "refused", count: 1, first: "2026-11-09T16:00:00Z", gist: "(withheld)" }],
	decided: [{ at: "2026-11-09T17:00:00Z", run: "r1", to: "ops-main", gist: "go on without it", basis: "D3" }],
	stillWaiting: [{ session: "old-pi", tool: "robot_hand", kind: "still-waiting", count: 1, first: SINCE, gist: "a select" }],
	boxes: [{ box: "ci-box", gist: "Deploy to staging?" }], foreign: [{ at: SINCE, why: "foreign" }],
};
const memStore = () => { let v: string | null = null; return { get: () => v, set: (x: string) => void (v = x) }; };
const panelWith = (netNow: Net, over: Partial<Parameters<typeof mountBack>[1]> = {}) => {
	const host = box0(), store = memStore();
	const back = mountBack(host as never, { net: () => netNow, store, now: () => Date.parse("2026-11-10T00:41:00Z"), ...over });
	return { host, store, back };
};
/** A return panel's card is a folded row: a tap unfolds it, the first row (I'm done) is picked, and Send presses (the question panel's way, docs/specs/2026-11-10-wait-cards-tui.md Q1). */
const pressFirst = (host: El) => {
	for (const part of [".auto-back-card .wc-fold", ".auto-back-card .ask-opt", ".auto-back-card .ask-send"]) (host.querySelector(part) as El).click();
};
const cardOf = (type: string) => ({ type, lang: "en", happened: "h", do: "Re-authorize it", after: "a" });

test("the panel lists the parked cards first as pressable cards; one that was answered meanwhile is counted, not drawn; the rest is folded", async () => {
	const { host, back } = panelWith(towerNet([w("W1", { card: cardOf("action") }), w("W2", { card: cardOf("action") })]));
	await back.open(REPORT);
	assert.equal(host.querySelector(".auto-back-title")!.textContent, m.back_title());
	assert.equal(host.querySelectorAll(".auto-back-card").length, 2, "W1 and W2 are open; W9 is gone from the net");
	assert.equal(host.querySelectorAll(".auto-back-card .wait-card").length, 2, "each is a wait card");
	assert.equal(host.querySelector(".auto-back-settled")!.textContent, m.back_settled({ n: "1" }));
	const rest = host.querySelector(".auto-back-rest")!;
	assert.equal(rest.tag, "details");
	assert.equal(rest.hasAttribute("open"), false, "the rest is folded");
	const text = rest.textContent;
	for (const part of ["ops-main", "robot_hand", "Deploy needs sudo", "api-fix", "D3", "old-pi", "ci-box"]) assert.ok(text.includes(part), `the rest names ${part}`);
	assert.ok(text.includes("(withheld)"), "a withheld gist stays withheld");
	assert.equal(host.hidden, false);
});

test("a card of the panel presses through the tower's memory route, as its row does; closing the panel posts nothing and leaves the cards as open waits", async () => {
	sent.length = 0;
	reply = { ok: true, status: 200, body: { rev: 4, proposals: [], entries: [], press: { act: "done", at: WAIT_AT } } };
	const { host, back, store } = panelWith(towerNet([w("W1", { card: cardOf("action") })]));
	await back.open({ ...REPORT, parked: [ROW("W1")] });
	pressFirst(host);
	await until(() => sent.length === 1, "the press");
	assert.deepEqual(sent, [{ path: "api/tower/w1/memory", body: { op: "press", id: "W1", act: "done" } }]);
	sent.length = 0;
	(host.querySelector(".auto-back-close") as El).click();
	assert.equal(host.hidden, true);
	assert.deepEqual(sent, [], "closing answers nothing");
	assert.equal(store.get(), REPORT.until, "this report is seen on this device");
});

test("a mounted parked card follows answered and resolved snapshots", async () => {
	const wait = w("W1", { card: cardOf("action") });
	const { host, back } = panelWith(towerNet([wait]));
	await back.open(REPORT);
	const answered = { ...wait, answered: WAIT_AT, press: { act: "done", at: WAIT_AT } };
	back.net(towerNet([answered]));
	assert.match(host.querySelector(".wc-fold")!.textContent, /I'm done/);
	back.net(towerNet([{ ...answered, state: "resolved", outcome: "verified" }]));
	assert.equal(host.querySelector(".wait-card")!.dataset.phase, "ended");
	assert.match(host.querySelector(".ask-note")!.textContent, /verified/);
});

test("the head's parked card is found in the head's memory and pressed at the head's route", async () => {
	sent.length = 0;
	const netNow: Net = { bases: [], head: { key: "sb-head", name: "head", mark: "idle", state: "running", asks: [], service: { state: "running", memory: memoryOf([w("W5", { card: cardOf("action") })]) } } } as never;
	const { host, back } = panelWith(netNow);
	await back.open({ ...REPORT, parked: [ROW("W5", { workspace: "ws-of-the-head", tower: "head", head: true })] });
	assert.equal(host.querySelectorAll(".auto-back-card").length, 1);
	pressFirst(host);
	await until(() => sent.length === 1, "the press");
	assert.equal(sent[0]!.path, "api/head/memory");
	assert.ok((host.querySelector(".auto-back-card .ask-opts") as El).textContent.includes(m.wc_b_reply_head()), "a head row's card says the head tower (Q3)");
});

test("a head row never finds a tower's wait and a tower row never finds the head's, whatever their ids (AG-F001)", async () => {
	const head = { key: "sb-head", name: "head", mark: "idle", state: "running", asks: [], service: { state: "running", memory: memoryOf([w("W1", { card: cardOf("action") })]) } };
	const gone = { bases: [{ id: "wA", label: "Alpha", mark: "idle", tower: null, tabs: [], outposts: [], outside: [] }], head } as never as Net;
	assert.equal(openWait(gone, ROW("W1", { workspace: "wA", tower: "Alpha" }) as never), undefined, "the tower is gone: its W1 is settled, not the head's");
	assert.equal(openWait({ bases: [], head } as never as Net, ROW("W1", { workspace: "wA" }) as never), undefined, "no such base at all");
	assert.equal(openWait(gone, ROW("W1", { workspace: "ws-head", tower: "head", head: true }) as never)?.key, "sb-head");
	const both = towerNet([w("W1", { card: cardOf("action") })]);
	assert.equal(openWait({ ...both, head } as never, ROW("W1", { head: true }) as never)?.ws, "@head", "a head row looks only in the head, though a tower holds a W1 too");
});

test("Esc closes the panel: the dialog's own close records the list as seen, and the panel holds the keyboard while open (AG-F002)", async () => {
	const { host, back, store } = panelWith(towerNet([w("W1", { card: cardOf("action") })]));
	await back.open({ ...REPORT, parked: [ROW("W1")] });
	assert.equal(store.get(), null);
	host.dispatchEvent({ type: "close" });
	assert.equal(store.get(), REPORT.until, "closed by Esc: seen on this device, so it does not open again on the next load");
	assert.match(readFileSync(new URL("../gui/hotkeys.ts", import.meta.url), "utf8"), /export const MODAL = "[^"]*dialog\.auto-back\[open\]/);
});

test("check(true) opens the report while the snapshot still says on (this page just ended it); check() does not", async () => {
	const post = async () => ({ ok: true, status: 200, body: { report: REPORT } });
	const live = panelWith(towerNet([], { on: true, since: SINCE }), { post: post as never });
	await live.back.check();
	assert.equal(live.host.hidden, true);
	await live.back.check(true);
	assert.equal(live.host.hidden, false, "forced: the snapshot has not caught up");
});

test("the chip's box shows only where this server can switch auto mode, and follows each snapshot; the page feeds it every snapshot (AG-F006, AG-F005)", () => {
	const { box, sw } = switchWith([]);
	assert.equal(box.hidden, true, "before the first snapshot");
	sw.net(net());
	assert.equal(box.hidden, true, "a secondary slot's server or an unattended device: no chip");
	sw.net({ bases: [], autoable: true });
	assert.equal(box.hidden, false);
	sw.net({ bases: [], autoable: true, auto: { on: true, since: SINCE } });
	assert.equal(box.hidden, false);
	sw.net({ bases: [], auto: { on: true, since: SINCE } });
	assert.equal(box.hidden, false, "on stays reachable so it can be ended");
	sw.net(net());
	assert.equal(box.hidden, true);
	assert.match(readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8"), /function draw\(net: Net[^)]*\) \{[\s\S]*?autoSw\.net\(net\);[\s\S]*?moreActs\(\)/, "draw feeds the chip before the ⋯ reads it");
});

test("the server says whether it can switch: the primary's attended panel does, an unattended device does not; the snapshot carries `autoable` for it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-autogui-"));
	const auto = createAutoMode({ dir, now: () => 1_800_000_000_000, log: () => {}, id: () => "id1" });
	auto.start();
	let unattended = false;
	const panel = autoPanel(auto, () => unattended);
	const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: [] } : { workspaces: [] } });
	const read = () => netSource({ run: herdr, sessions: async () => [], sessionDir: "/s", auto: () => panel.snap(), autoable: () => panel.available() }).read();
	assert.equal((await read()).autoable, true);
	unattended = true;
	assert.ok(!("autoable" in (await read())));
	assert.ok(!("autoable" in (await netSource({ run: herdr, sessions: async () => [], sessionDir: "/s" }).read())), "no panel (a secondary slot): none");
});

test("nothing parked says so; check() reads the report once, opens it when this device has not seen it, and not again after it was closed or while auto mode is on", async () => {
	const posts: string[] = [];
	let report: unknown = REPORT;
	const post = async (path: string) => (posts.push(path), { ok: true, status: 200, body: { report } });
	const first = panelWith(towerNet([]), { post: post as never });
	await first.back.check();
	assert.deepEqual(posts, ["auto/report"]);
	assert.equal(first.host.hidden, false);
	(first.host.querySelector(".auto-back-close") as El).click();
	await first.back.check();
	assert.equal(first.host.hidden, true, "seen: it does not open again");
	const live = panelWith(towerNet([], { on: true, since: SINCE }), { post: post as never });
	await live.back.check();
	assert.equal(live.host.hidden, true, "auto mode is on again: the last list is not for now");
	report = { ...REPORT, parked: [] };
	const empty = panelWith(towerNet([]), { post: post as never });
	await empty.back.check();
	assert.equal(empty.host.querySelector(".auto-back-none")!.textContent, m.back_none());
	report = null;
	const none = panelWith(towerNet([]), { post: post as never });
	await none.back.check();
	assert.equal(none.host.hidden, true, "no report, no panel");
	report = { ...REPORT, until: "2026-10-01T00:00:00Z" };
	const old = panelWith(towerNet([]), { post: post as never });
	await old.back.check();
	assert.equal(old.host.hidden, true, "a report weeks old is not news");
});

test("AR-D3: a list written since 2026-11-21 names where each parked card went, as plain lines: back to its raiser, back to the tower, or closed with the raiser gone; no card is drawn to press", async () => {
	const { host, back } = panelWith(towerNet([w("W1", { card: cardOf("action") })]));
	await back.open({ ...REPORT, parked: [ROW("W1", { from: "ops-main", returned: "raiser" }), ROW("W2", { returned: "tower" }), ROW("W9", { from: "api-fix", returned: "gone" })] });
	assert.equal(host.querySelectorAll(".auto-back-card").length, 0, "nothing to press: the raisers ask again themselves");
	assert.equal(host.querySelector(".auto-back-returned h3")!.textContent, m.back_returned({ n: "3" }));
	const lines = host.querySelectorAll(".auto-back-returned li").map((li) => li.textContent);
	assert.deepEqual(lines, [
		`W1 · Harbor: question W1 — ${m.back_to_raiser({ name: "ops-main" })}`,
		`W2 · Harbor: question W2 — ${m.back_to_tower()}`,
		`W9 · Harbor: question W9 — ${m.back_gone({ name: "api-fix" })}`,
	]);
	assert.equal(host.querySelector(".auto-back-settled"), null);
});

test("AR-D3: a card that auto mode's end returned reads as returned, not as confirmed by the tower", () => {
	const model = cardModel({ wait: { id: "W1", text: "x", at: WAIT_AT, state: "resolved", outcome: "returned to ops-main to ask the boss again (auto mode ended)", ended: WAIT_AT, returned: "raiser", card: cardOf("action") } as never, phase: "ended", remote: false, open: false, now: Date.now() });
	assert.equal(model.line, m.wc_returned({ outcome: "returned to ops-main to ask the boss again (auto mode ended)" }));
	assert.equal(m.wc_returned({ outcome: "x" }, { locale: "zh-TW" }), "自動模式結束時：x");
});

test("the panel's words exist in both languages", () => {
	for (const id of ["back_title", "back_parked", "back_none", "back_settled", "back_rest", "back_close", "back_decided", "back_still", "back_boxes", "back_foreign", "back_returned", "back_to_raiser", "back_to_tower", "back_gone"] as const) {
		for (const locale of ["en", "zh-TW"] as const) assert.ok((m[id] as (i: object, o: object) => string)({ n: "2", from: "23:10", until: "07:40" }, { locale }).length > 0, `${id} ${locale}`);
	}
});

// --- the server's route for the report -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("the auto scope answers `report` with the last return list or null, to the page and a paired phone, never to an operate session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-autoback-"));
	const now = 1_800_000_000_000;
	const auto = createAutoMode({ dir, now: () => now, log: () => {}, id: () => "id1" });
	auto.start();
	const control = createControl({ auto: autoPanel(auto), lookup: () => undefined, csrf: "x", canonical: () => undefined });
	assert.deepEqual((await control.run(["auto", "report"], {}, { remote: false } as never)).body, { report: null });
	auto.switchOn({ via: "gui", name: "the page" });
	auto.switchOff({ via: "gui", name: "the page" });
	const got = await control.run(["auto", "report"], {}, { remote: true } as never);
	assert.equal(got.status, 200);
	assert.equal((got.body as { report: { v: number } }).report.v, 1);
	assert.equal((await control.run(["auto", "report"], {}, { remote: false, operate: true } as never)).status, 403);
});

// --- phone targets and where the chip sits -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const phone = css.slice(css.indexOf("@media (max-width: 640px)", css.indexOf("A phone's menus and layout")));

test("on a phone the chip, the panel's buttons, and the confirm are 44 px targets", () => {
	assert.match(phone, /\.auto-chip[^{}]*\{[^}]*min-height: 44px/, "the chip");
	assert.match(phone, /\.auto-back[^{}]*\{[^}]*min-height: 44px/, "the panel's buttons");
	assert.match(phone, /\.auto-confirm[^{}]*\{[^}]*min-height: 44px/, "the head's confirm");
});

test("the chip sits in the strip the phone folds behind the ⋯, and the page mounts it", () => {
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	assert.match(html, /<div class="bar-acts">[\s\S]*id="auto-sw"/, "the switch's box is in the bar's acts, the strip that is the drawer on a phone");
	assert.match(readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8"), /mountAutoSwitch/);
});

// --- the demo -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("`?auto=on` is auto mode on with parked cards on the tower; `?auto=back` is it off with the open waits and the return list; anything else is untouched", () => {
	const now = Date.parse("2026-11-10T00:41:00Z");
	const on = towerNet([]);
	const shown = autoDemo(on, "on", now);
	assert.equal(on.auto!.on, true);
	const waits = on.bases[0]!.tower!.service!.memory!.bossWaits;
	assert.ok(waits.length >= 3 && waits.every((x) => x.parked), "every card is parked");
	assert.ok(waits.some((x) => x.card?.type === "secret"), "a secret card shows the hidden start button");
	assert.equal(shown?.report, undefined);
	const back = towerNet([]);
	const returned = autoDemo(back, "back", now);
	assert.equal(back.auto, undefined);
	assert.ok(back.bases[0]!.tower!.service!.memory!.bossWaits.every((x) => !x.parked));
	assert.ok(returned!.report!.parked.length >= 3 && returned!.report!.lines.length >= 2);
	assert.equal(autoDemo(towerNet([]), null, now), undefined);
	assert.equal(autoDemo(towerNet([]), "x", now), undefined);
});
