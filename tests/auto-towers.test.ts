import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fieldsOf, header } from "../src/header.ts";
import { reportSummary } from "../src/autostate.ts";
import { basisOf, briefLine, buildReport, endEvent, ownReturnedText, parkedText, reportText, returnedText } from "../src/server/autotower.ts";
import { buildHeadBrief } from "../src/server/headbrief.ts";
import type { Slot } from "../src/server/record.ts";
import { buildBrief } from "../src/server/towerbrief.ts";
import { addCardWait, addText, addWait, loadMemory, updateMemory } from "../src/server/towermemory.ts";
import { HEAD_KEY, readQueue } from "../src/server/towerstore.ts";
import { pressRequest } from "../src/server/waitpress.ts";
import { checkCard } from "../src/server/waitcard.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";
import { callControl } from "../src/server/socket.ts";

// Towers under auto mode (docs/specs/2026-11-09-auto-mode.md, §6 and §8; task 4): the brief line only while on, a card recorded or open when it turns on is parked and its raiser told once under `wait_parked`, the replies that settle a
// blocked call are listed with a checked `basis`, a secret card's start is refused, and the return list covers the towers and the head.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const tool = (s: Running, token: string, name: string, args: Record<string, unknown>) => ask(s, { cmd: "run-tool", token, tool: name, args });
const WHO = { name: "a pi", session: "sess-1", pane: "p1", pid: 42 };
const autoOn = async (s: Running) => {
	const staged = await ask(s, { cmd: "auto-on", ...WHO });
	assert.equal((await ask(s, { cmd: "auto-confirm", id: (staged.pending as { id: string }).id, ...WHO })).ok, true);
};
const coordinator = { id: "main-1", name: "docs-main" };
const blockedCall = `[straw net from=docs-main id=main-1 role=main workspace=Alpha kind=call_tower scope=tower to=x reply=expected why=blocked] I need the deploy go`;
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
/** A run of wA that took these events from `main-1`; `ids` are the ids the server queued them under. */
async function run(s: Running, texts: string[]) {
	world.sessions = [{ id: "main-1", name: "docs-main" }, { id: "integ-1", name: "integ acme" }] as never;
	texts.forEach((text, i) => world.client("sb-tower-wa")!.incoming(coordinator, { id: `m${i}`, content: { text } } as never));
	await until(() => world.pis.size === 1, "the run");
	const [id, pi] = [...world.pis.entries()][0]!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	const token = String(got!.token), ids: string[] = [];
	for (;;) {
		const ev = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!ev) break;
		await ask(s, { cmd: "run-taken", token, id: ev.id });
		ids.push(ev.id);
	}
	return { token, ids, brief: String(got!.brief) };
}
const card = (extra: Record<string, unknown> = {}) => ({ op: "add", kind: "wait", for: "boss", type: "action", happened: "The deploy needs the boss's go.", do: "Say go in the terminal.", after: "The main deploys.", command: "echo go", from: "main-1", ...extra });
const memory = () => loadMemory(world.slot, "wA").memory;
const sentTo = (to: string) => world.client("sb-tower-wa")!.sent.filter((m) => m.to === to).map((m) => ({ ...m, fields: fieldsOf(m.text)! }));
const reportFile = () => JSON.parse(readFileSync(join(world.slot.stateDir, "auto-report.json"), "utf8")) as ReturnType<typeof buildReport>;

test("the brief line is in a tower's and the head's brief only while auto mode is on, and a run claimed after it turns on carries it", async () => {
	assert.match(briefLine("2026-11-09T15:10:00Z"), /^Auto mode: on since \d\d:\d\d \(the boss is away\)\. A wait for the boss you record is parked and raises no alert\. Answer a blocked call yourself only from your memory's standing instructions and decisions or a boss event you took; a sender's quote alone is not enough: record the wait and tell the sender with tower_reply to go on without it\.$/);
	const base = { label: "Alpha", workspace: "wA", head: "standing by", woken: "10:00", counts: { boss: 1 }, identity: "sb-tower-wa", mains: [], obligations: [], digest: [], flags: [], tools: ["- x"] };
	assert.ok(!buildBrief(base).includes("Auto mode:"));
	assert.ok(buildBrief({ ...base, auto: briefLine("2026-11-09T15:10:00Z") }).includes("Auto mode: on since"));
	const head = { identity: "sb-head", woken: "10:00", boss: true, chapter: { n: 1, since: "2026-11-09T00:00:00Z", turns: 0, resumed: false }, workspaces: [], asks: [], tools: ["- y"], flags: [] };
	assert.ok(!buildHeadBrief(head).includes("Auto mode:"));
	assert.ok(buildHeadBrief({ ...head, auto: briefLine("2026-11-09T15:10:00Z") }).includes("Auto mode: on since"));
	// end to end: the claim of a run after the switch
	const s = await setup();
	await autoOn(s);
	const { brief } = await run(s, ["hello"]);
	assert.match(brief, /Auto mode: on since \d\d:\d\d \(the boss is away\)/);
});

test("a card recorded while on is parked and its raiser is told once under wait_parked; one open when it turns on is parked and told once; a card of the tower itself is parked and tells no one", async () => {
	const s = await setup();
	const { token } = await run(s, ["hello"]);
	assert.equal((await tool(s, token, "tower_memory", card())).ok, true);
	assert.equal(memory().entries[0]!.parked, undefined, "off: an ordinary card");
	assert.equal(sentTo("main-1").filter((m) => m.fields.kind === "wait_parked").length, 0);
	await autoOn(s);
	await until(() => sentTo("main-1").some((m) => m.fields.kind === "wait_parked"), "the notice for the card open at the switch");
	assert.equal(memory().entries[0]!.parked, true);
	let told = sentTo("main-1").filter((m) => m.fields.kind === "wait_parked");
	assert.equal(told.length, 1);
	assert.equal(told[0]!.fields.wait, "W1");
	assert.ok(told[0]!.text.endsWith(parkedText("W1")), told[0]!.text);
	assert.equal(parkedText("W1"), "Wait W1 is parked: the boss is away (auto mode). Do not wait on it; when they are back it comes back to you as a wait_returned message, and you ask them again yourself then.", "AR-D3: no wait_card answer is promised");
	assert.equal(told[0]!.fields.role, "tower");
	// recorded while on
	assert.equal((await tool(s, token, "tower_memory", card({ happened: "Another go is needed." }))).ok, true);
	assert.equal((await tool(s, token, "tower_memory", card({ from: "self", happened: "The tower itself waits.", do: "Look at the page." }))).ok, true);
	assert.deepEqual(memory().entries.map((e) => [e.id, e.parked]), [["W1", true], ["W2", true], ["W3", true]]);
	told = sentTo("main-1").filter((m) => m.fields.kind === "wait_parked");
	assert.deepEqual(told.map((m) => m.fields.wait), ["W1", "W2"], "one message per card, none for the tower's own");
	// the switch again and a restart-like re-read tell nobody twice
	await autoOn(s).catch(() => {});
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sentTo("main-1").filter((m) => m.fields.kind === "wait_parked").length, 2);
	// the kind is its own: wait_card means the boss's answer
	assert.ok(sentTo("main-1").every((m) => m.fields.kind !== "wait_card"));
});

test("a tower_reply to a session whose blocked call the run took is noted with basis: a decision or standing id is checked, a boss event that is no press counts, anything else is none", async () => {
	const s = await setup();
	updateMemory(world.slot, "wA", Date.now(), (m) => (addText(m, Date.now(), "gui", "decision", "Deploys to ws01 are authorized"), addText(m, Date.now(), "gui", "standing", "Never touch production"), undefined));
	const { token, ids } = await run(s, [blockedCall]);
	await autoOn(s);
	world.expose!.runs.boss("wA", "ok, deploy to ws01 is fine");
	world.expose!.runs.boss("wA", "W1 done", "the boss (wait card)", { press: true });
	const bossIds: string[] = [];
	await until(async () => {
		const ev = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string; kind: string } | undefined;
		if (ev) { await ask(s, { cmd: "run-taken", token, id: ev.id }); if (ev.kind === "boss") bossIds.push(ev.id); }
		return bossIds.length === 2;
	}, "both boss events");
	assert.equal(bossIds.length, 2);
	const reply = (args: Record<string, unknown>) => tool(s, token, "tower_reply", { to: "main-1", message: `go ahead ${String(args.basis)}`, ...args });
	for (const basis of ["D1", "S1", "S9", bossIds[0], bossIds[1], "made-up"]) assert.equal((await reply({ basis })).ok, true, String(basis));
	assert.equal((await tool(s, token, "tower_reply", { to: "main-1", message: "go ahead, no basis" })).ok, true);
	// a session that sent no blocked call is not listed
	assert.equal((await tool(s, token, "tower_reply", { to: "integ-1", message: "something else", basis: "D1" })).ok, true);
	const off = await ask(s, { cmd: "auto-off", ...WHO });
	assert.equal(off.ok, true);
	const decided = reportFile().decided;
	assert.deepEqual(decided.map((d) => [d.to, d.basis]), [["main-1", "D1"], ["main-1", "S1"], ["main-1", "none"], ["main-1", bossIds[0]], ["main-1", "none"], ["main-1", "none"], ["main-1", "none"]]);
	assert.equal(decided[0]!.gist, "go ahead D1");
	assert.ok(ids.length === 1);
	assert.match(String(off.report), /answered a blocked call itself \(7\)/);
});

test("nothing is noted while auto mode is off, and basisOf checks ids against the memory and the run's non-press boss events", () => {
	const m = { entries: [{ id: "D1", kind: "decision" }, { id: "S2", kind: "standing" }, { id: "W3", kind: "wait" }] } as never;
	const events = [{ id: "e1" }, { id: "e2", press: true as const }];
	assert.equal(basisOf("D1", m, events), "D1");
	assert.equal(basisOf("S2", m, events), "S2");
	assert.equal(basisOf("W3", m, events), "none", "a wait is no basis");
	assert.equal(basisOf("e1", m, events), "e1");
	assert.equal(basisOf("e2", m, events), "none", "a press is no basis");
	assert.equal(basisOf(undefined, m, events), "none");
	assert.equal(basisOf(5, m, events), "none");
});

test("a secret card's start button is refused while auto mode is on, and a plain press still works", async () => {
	const slot = { dir: world.slot.stateDir } as Slot, now = Date.now();
	const checked = checkCard({ type: "secret", happened: "A token is needed.", do: "Enter the deploy token.", after: "The main deploys.", secret: { name: "deploy token" }, from: "main-1" }, { senders: new Set(["main-1"]), lang: "en", restates: () => undefined });
	assert.equal(checked.ok, true);
	updateMemory(slot, "wS", now, (m) => addCardWait(m, now, "r1", checked as never, { id: "main-1", name: "docs-main", role: "main" }));
	const deps = (on: boolean) => ({ slot, now: () => now, log: { line() {}, hide() {} }, locale: "en" as const, live: async () => true, send: async () => ({ status: "sent" }), boss: () => {}, autoOn: () => on });
	const refused = await pressRequest(deps(true), "wS", { op: "press", id: "W1", act: "secret" });
	assert.equal(refused.status, 409);
	assert.match(String(refused.body.reason), /end auto mode first \(\/boss auto off\)/);
	assert.equal(loadMemory(slot, "wS").memory.entries[0]!.press, undefined, "nothing was recorded");
	assert.equal((await pressRequest(deps(false), "wS", { op: "press", id: "W1", act: "secret" })).status, 200);
});

test("AR-D3: the return list covers the towers and the head: the parked waits per tower go back to the towers that raised them, the cancels and refusals by session, the head's one event, and boss_status shows the summary", async () => {
	const s = await setup();
	const head = await world.expose!.head.ensure();
	const now = Date.now();
	updateMemory(world.slot, "wA", now, (m) => void addWait(m, now, "r1", { text: "Approve the production deploy", for: "boss" }));
	updateMemory(world.slot, head.workspace, now, (m) => void addWait(m, now, "r2", { text: "Which customer first?", for: "boss" }));
	await autoOn(s);
	assert.equal(memory().entries[0]!.parked, true);
	assert.equal(loadMemory(world.slot, head.workspace).memory.entries[0]!.parked, true);
	for (const [session, tool, kind] of [["main-1", "ask_user_question", "cancelled"], ["main-1", "robot_hand", "refused"], ["main-1", "robot_hand", "refused"], ["child-2", "question", "refused"]]) assert.equal((await ask(s, { cmd: "auto-note", session, tool, kind, gist: "Which database?" })).ok, true);
	assert.equal((await ask(s, { cmd: "auto-note", session: "main-3", tool: "robot_hand", kind: "still-waiting", gist: "List it" })).ok, true);
	const off = await ask(s, { cmd: "auto-off", ...WHO });
	assert.equal(off.ok, true);
	const report = reportFile();
	assert.deepEqual(report.parked.map((p) => [p.id, p.tower]).sort(), [["W1", "Alpha"], ["W1", head.label]].sort());
	assert.deepEqual(report.parked.map((p) => [p.tower, p.head]).sort(), [["Alpha", undefined], [head.label, true]].sort(), "only the head's row is marked, so the page never mixes the two W1");
	assert.deepEqual(report.lines.map((l) => [l.session, l.tool, l.kind, l.count]), [["main-1", "ask_user_question", "cancelled", 1], ["main-1", "robot_hand", "refused", 2], ["child-2", "question", "refused", 1]]);
	assert.deepEqual(report.stillWaiting.map((l) => l.session), ["main-3"]);
	const text = String(off.report);
	assert.ok(text.indexOf("Parked waits (2)") >= 0 && text.indexOf("Parked waits") < text.indexOf("Cancelled or refused"), "the parked waits come first");
	// AR-D3: they are not answered at the tower pane any more; each went back to whoever raised it (here the towers themselves: waits with no raiser)
	assert.match(text, /^Parked waits \(2\) went back to whoever raised them, to ask you again directly; sb closed the cards:$/m);
	assert.match(text, /^- W1 \(Alpha, legacy\): Approve the production deploy → back to the tower$/m);
	assert.match(text, /- main-1: ask_user_question cancelled "Which database\?" \(from \d\d:\d\d\); robot_hand refused ×2/);
	assert.deepEqual(report.parked.map((p) => p.returned), ["tower", "tower"]);
	// the parked flag lived for the period, and the card is closed as returned
	for (const e of [memory().entries[0]!, loadMemory(world.slot, head.workspace).memory.entries[0]!]) {
		assert.equal(e.parked, undefined);
		assert.equal(e.state, "resolved");
		assert.equal(e.returned, "tower");
		assert.equal(e.outcome, "returned to the tower to ask again (auto mode ended)");
	}
	// each tower gets its own card back as an event, to record it again if it still needs the boss
	const back = (ws: string) => readQueue(world.slot, ws).filter((e) => e.kind === "notice" && e.text.startsWith("Your wait W1"));
	assert.equal(back("wA").length, 1);
	assert.match(back("wA")[0]!.text, /^Your wait W1 \(Approve the production deploy\) was parked while the boss was away\. Auto mode ended at \d\d:\d\d and the boss is back; sb closed the card instead of keeping it for them\. If it still needs the boss, record it again with tower_memory \(add kind wait\): it reaches them now as a new card\.$/);
	assert.equal(back(head.workspace).length, 1, "the head's own card goes to the head");
	// the head gets one event
	const events = readQueue(world.slot, head.workspace).filter((e) => e.kind === "notice" && e.text.startsWith("Auto mode ended at"));
	assert.equal(events.length, 1);
	assert.match(events[0]!.text, /^Auto mode ended at \d\d:\d\d \(pi: a pi\): 2 parked waits on 2 towers went back to whoever raised them, to ask the boss again; 4 cancels or refusals\.$/);
	// boss_status (the files a waking session reads)
	assert.deepEqual(reportSummary(world.slot.stateDir), { since: report.since, until: report.until, off: "pi: a pi", parked: 2, towers: 2, cancels: 4, decided: 0, stillWaiting: 1 });
	// a second off changes nothing and builds no second report
	const again = await ask(s, { cmd: "auto-off", ...WHO });
	assert.equal(again.changed, false);
	assert.equal(readQueue(world.slot, head.workspace).filter((e) => e.kind === "notice" && e.text.startsWith("Auto mode ended at")).length, 1);
});

test("the report text and the head event are built from one period: pure", () => {
	const by = { via: "gui" as const, name: "the page" };
	const period = { since: "2026-11-09T15:10:00Z", notes: [{ session: "s1", tool: "robot_hand", kind: "refused" as const, gist: "x", at: "2026-11-09T16:00:00Z" }], foreign: [{ at: "2026-11-09T17:00:00Z", why: "foreign" }], decided: [] };
	const r = buildReport(period, by, { via: "head", name: "head tower" }, "2026-11-09T23:40:00Z", [{ workspace: "wA", tower: "Alpha", id: "W4", text: "Go?", type: "action", at: "2026-11-09T16:00:00Z" }], [{ box: "box-1", gist: "Allow edit?" }]);
	const text = reportText(r);
	assert.match(text, /- W4 \(Alpha, action\): Go\? → back to the raiser/);
	assert.match(text, /Asks of the boxes you control, left waiting:\n- box-1: Allow edit\?/);
	assert.match(text, /1 foreign or unreadable write to the state file were put back/);
	assert.match(endEvent(r), /^Auto mode ended at \d\d:\d\d \(head: head tower\): 1 parked waits on 1 towers went back to whoever raised them, to ask the boss again; 1 cancels or refusals\.$/);
	assert.ok(header({ from: { name: "t", id: "sb-tower-wa", role: "tower" }, kind: "wait_parked", scope: "session", to: [{ name: "m", id: "m", role: "main" }], reply: false, wait: "W4" }).includes("kind=wait_parked"));
});

test("AMC-F006: the return list says the boxes' asks are not collected, and lists them when a source gives some", () => {
	const p = { since: "2026-11-10T00:00:00Z", notes: [], foreign: [], decided: [] }, by = { via: "pi" as const, name: "t" };
	assert.match(reportText(buildReport(p, by, by, "2026-11-10T07:00:00Z", [])), /boxes you control: not collected/);
	const listed = reportText(buildReport(p, by, by, "2026-11-10T07:00:00Z", [], [{ box: "ginlee", gist: "Deploy?" }]));
	assert.match(listed, /- ginlee: Deploy\?/);
	assert.ok(!listed.includes("not collected"));
});

// --- AR-D3, AR-D4 (docs/specs/2026-11-21-auto-return.md): a parked card goes back to its raiser when auto mode ends ----------------------------------------------------------------

/** A card raised by main-1, parked at the switch on; the run that recorded it, and the raiser told it was parked. */
async function parkedCard(s: Running) {
	const { token } = await run(s, ["hello"]);
	assert.equal((await tool(s, token, "tower_memory", card())).ok, true);
	await autoOn(s);
	await until(() => sentTo("main-1").some((m) => m.fields.kind === "wait_parked"), "the parked notice");
	return token;
}

test("AR-D3: at the end of auto mode a parked card goes back to the main that raised it under wait_returned, is closed as returned, and is on the list as such; a card recorded after the end is an ordinary card", async () => {
	const s = await setup();
	const token = await parkedCard(s);
	const off = await ask(s, { cmd: "auto-off", ...WHO });
	assert.equal(off.ok, true);
	// closed in the same write as the switch: no press can land on it for the boss
	const e = memory().entries[0]!;
	assert.deepEqual([e.state, e.returned, e.parked, e.outcome], ["resolved", "raiser", undefined, "returned to docs-main to ask the boss again (auto mode ended)"]);
	assert.equal((await pressRequest({ slot: world.slot, now: Date.now, log: { line() {}, hide() {} }, locale: "en", live: async () => true, send: async () => ({ status: "sent" }), boss: () => {} }, "wA", { op: "press", id: "W1", act: "done" })).status, 409, "a press after the end is refused");
	await until(() => sentTo("main-1").some((m) => m.fields.kind === "wait_returned"), "the message to the raiser");
	const told = sentTo("main-1").filter((m) => m.fields.kind === "wait_returned");
	assert.equal(told.length, 1);
	assert.equal(told[0]!.fields.wait, "W1");
	assert.match(told[0]!.text, /Wait W1 \(Say go in the terminal\.\) comes back to you: auto mode ended at \d\d:\d\d and the boss is back\. sb closed the card instead of keeping it for them, so no wait_card answer will come for it\. If you still need it, ask them again yourself now with ask_user_question \(or call_tower again if this session cannot ask them\)\.$/);
	assert.ok(sentTo("main-1").every((m) => m.fields.kind !== "wait_card"), "the tower relays nothing: no wait_card");
	assert.deepEqual(reportFile().parked.map((p) => [p.id, p.from, p.returned]), [["W1", "docs-main", "raiser"]]);
	assert.match(String(off.report), /^- W1 \(Alpha, action, from docs-main\): Say go in the terminal\. → back to docs-main$/m);
	assert.equal(readQueue(world.slot, "wA").filter((ev) => ev.kind === "notice" && /Your wait W1/.test(ev.text)).length, 0, "a card a main raised is not the tower's to ask again");
	// a card recorded while auto mode is off is not parked, and nothing returns it
	assert.equal((await tool(s, token, "tower_memory", card({ happened: "One more go." }))).ok, true);
	const later = memory().entries.find((x) => x.id === "W2")!;
	assert.deepEqual([later.state, later.parked, later.returned], ["open", undefined, undefined]);
	assert.equal((await ask(s, { cmd: "auto-off", ...WHO })).changed, false);
	assert.equal(memory().entries.find((x) => x.id === "W2")!.state, "open");
	assert.equal(sentTo("main-1").filter((m) => m.fields.kind === "wait_returned").length, 1);
});

test("AR-D3: a parked card the boss answered while away is not returned: it only loses the flag, and the tower resolves it", async () => {
	const s = await setup();
	await parkedCard(s);
	const pressed = await pressRequest({ slot: world.slot, now: Date.now, log: { line() {}, hide() {} }, locale: "en", live: async () => true, send: async () => ({ status: "sent" }), boss: () => {} }, "wA", { op: "press", id: "W1", act: "done" });
	assert.equal(pressed.status, 200);
	assert.equal((await ask(s, { cmd: "auto-off", ...WHO })).ok, true);
	const e = memory().entries[0]!;
	assert.deepEqual([e.state, e.parked, e.returned, e.listed], ["answered", undefined, undefined, true]);
	assert.deepEqual(reportFile().parked, []);
	await new Promise((r) => setImmediate(r));
	assert.equal(sentTo("main-1").filter((m) => m.fields.kind === "wait_returned").length, 0);
});

test("AR-D4: a raiser that is gone at the end is told nothing, its card is closed as such, and the return list says so", async () => {
	const s = await setup();
	await parkedCard(s);
	world.sessions = [] as never; // main-1 closed
	assert.equal((await ask(s, { cmd: "auto-off", ...WHO })).ok, true);
	await until(() => memory().entries[0]!.returned === "gone", "the card closed as gone");
	assert.deepEqual([memory().entries[0]!.state, memory().entries[0]!.outcome], ["resolved", "closed: docs-main was gone when auto mode ended"]);
	await until(() => reportFile().parked[0]?.returned === "gone", "the list written again");
	assert.equal(sentTo("main-1").filter((m) => m.fields.kind === "wait_returned").length, 0);
	assert.equal(readQueue(world.slot, "wA").filter((ev) => ev.kind === "notice" && /Your wait W1/.test(ev.text)).length, 0, "nothing is left for the boss or the tower");
});

test("AR-D4: a message the broker does not take closes the card as not reached", async () => {
	const s = await setup();
	await parkedCard(s);
	world.client("sb-tower-wa")!.deliver = { delivered: false, delivery: "failed", reason: "no route" };
	assert.equal((await ask(s, { cmd: "auto-off", ...WHO })).ok, true);
	await until(() => memory().entries[0]!.returned === "gone", "the card closed");
	assert.equal(memory().entries[0]!.outcome, "closed: docs-main could not be reached when auto mode ended");
	await until(() => reportFile().parked[0]?.returned === "gone", "the list written again");
});

test("AR-D3: returnedText tells a tower raiser to record the wait again, and ownReturnedText names the tower's own card", () => {
	assert.match(returnedText("W2", "Pick a host.", "2026-11-21T07:40:00Z", "tower"), /If you still need it, record it again with tower_memory as a wait for the boss, or ask as you asked before\.$/);
	assert.match(returnedText("W2", "Pick a host.", "2026-11-21T07:40:00Z", "main"), /ask them again yourself now with ask_user_question/);
	assert.match(ownReturnedText("W3", "Look.", "2026-11-21T07:40:00Z"), /^Your wait W3 \(Look\.\) was parked while the boss was away\./);
	assert.ok(header({ from: { name: "t", id: "sb-tower-wa", role: "tower" }, kind: "wait_returned", scope: "session", to: [{ name: "m", id: "m", role: "main" }], reply: false, wait: "W2" }).includes("kind=wait_returned"));
});

test("AR-F002: the head's parked card goes back when auto mode ends after the head was closed: closed as gone, and on the list", async () => {
	const s = await setup();
	const head = await world.expose!.head.ensure();
	const now = Date.now();
	updateMemory(world.slot, head.workspace, now, (m) => void addWait(m, now, "r2", { text: "Which customer first?", for: "boss" }));
	await autoOn(s);
	await world.expose!.head.close();
	assert.equal(world.expose!.head.status(), undefined, "no head service stands");
	assert.equal((await ask(s, { cmd: "auto-off", ...WHO })).ok, true);
	const e = loadMemory(world.slot, HEAD_KEY).memory.entries[0]!;
	assert.deepEqual([e.state, e.parked, e.returned], ["resolved", undefined, "gone"]);
	assert.deepEqual(reportFile().parked.map((p) => [p.id, p.head, p.returned]), [["W1", true, "gone"]]);
});

test("AR-F003: a parked card the head tower raised goes back to the head as its event, not as a message its gate refuses", async () => {
	const s = await setup();
	await parkedCard(s);
	const head = await world.expose!.head.ensure(), headId = world.expose!.head.status()!.id;
	updateMemory(world.slot, "wA", Date.now(), (m) => void Object.assign(m.entries[0]!.card!.from!, { id: headId, name: "head tower", role: "session" }));
	assert.equal((await ask(s, { cmd: "auto-off", ...WHO })).ok, true);
	const back = readQueue(world.slot, head.workspace).filter((ev) => ev.kind === "notice" && ev.text.startsWith("Wait W1 "));
	assert.equal(back.length, 1);
	assert.match(back[0]!.text, /^Wait W1 \(Say go in the terminal\.\) comes back to you: .* If you still need it, record it again with tower_memory as a wait for the boss, or ask as you asked before\.$/);
	await world.expose!.returning();
	assert.equal(sentTo(headId).length, 0, "nothing goes through the head's gate");
	assert.deepEqual([memory().entries[0]!.state, memory().entries[0]!.returned], ["resolved", "raiser"], "not closed as gone");
	assert.equal(reportFile().parked[0]!.returned, "raiser");
});

test("AR-F004: a stop right after the end waits for the raisers' messages before the towers leave the broker", async () => {
	const s = await setup();
	await parkedCard(s);
	const client = world.client("sb-tower-wa")!, order: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const send = client.send.bind(client), disconnect = client.disconnect.bind(client);
	client.send = async (to, options) => {
		if (fieldsOf(options.text)?.kind !== "wait_returned") return send(to, options);
		order.push("posting");
		await gate;
		order.push("posted");
		return send(to, options);
	};
	client.disconnect = async () => (order.push("disconnect"), disconnect());
	const towers = world.expose!, drain = towers.returning.bind(towers);
	towers.returning = () => (order.push("drain"), drain());
	assert.equal((await ask(s, { cmd: "auto-off", ...WHO })).ok, true);
	await until(() => order.includes("posting"), "the message under way");
	const ending = s.handle.shutdown(0);
	await until(() => order.includes("drain") || order.includes("disconnect"), "the shutdown at the drain");
	assert.deepEqual(order, ["posting", "drain"], "the tower is still on the broker");
	release();
	await ending;
	assert.deepEqual(order, ["posting", "drain", "posted", "disconnect"]);
	assert.equal(memory().entries[0]!.returned, "raiser");
});
