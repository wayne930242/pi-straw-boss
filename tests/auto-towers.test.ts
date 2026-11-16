import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fieldsOf, header } from "../src/header.ts";
import { reportSummary } from "../src/autostate.ts";
import { basisOf, briefLine, buildReport, endEvent, parkedText, reportText } from "../src/server/autotower.ts";
import { buildHeadBrief } from "../src/server/headbrief.ts";
import type { Slot } from "../src/server/record.ts";
import { buildBrief } from "../src/server/towerbrief.ts";
import { addCardWait, addText, addWait, loadMemory, updateMemory } from "../src/server/towermemory.ts";
import { readQueue } from "../src/server/towerstore.ts";
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

test("the return list covers the towers and the head: the parked waits per tower, the cancels and refusals by session, the head's one event, and boss_status shows the summary", async () => {
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
	assert.match(text, /^Parked waits \(2\)\. Answer them at the tower pane, with \/boss wait, or in the GUI:$/m); // 2026-11-16: the cards are answered where they are drawn, no W<n> to type
	assert.match(text, /- main-1: ask_user_question cancelled "Which database\?" \(from \d\d:\d\d\); robot_hand refused ×2/);
	// the parked flag lived for the period
	assert.equal(memory().entries[0]!.parked, undefined);
	assert.equal(loadMemory(world.slot, head.workspace).memory.entries[0]!.parked, undefined);
	// the panel lists them, so they are `listed`: open waits with no second notice
	assert.equal(memory().entries[0]!.listed, true);
	assert.equal(loadMemory(world.slot, head.workspace).memory.entries[0]!.listed, true);
	// the head gets one event
	const events = readQueue(world.slot, head.workspace).filter((e) => e.kind === "notice" && e.text.startsWith("Auto mode ended at"));
	assert.equal(events.length, 1);
	assert.match(events[0]!.text, /^Auto mode ended at \d\d:\d\d \(pi: a pi\): 2 parked waits on 2 towers, 4 cancels or refusals\.$/);
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
	assert.match(text, /- W4 \(Alpha, action\): Go\?/);
	assert.match(text, /Asks of the boxes you control, left waiting:\n- box-1: Allow edit\?/);
	assert.match(text, /1 foreign or unreadable write to the state file were put back/);
	assert.match(endEvent(r), /^Auto mode ended at \d\d:\d\d \(head: head tower\): 1 parked waits on 1 towers, 1 cancels or refusals\.$/);
	assert.ok(header({ from: { name: "t", id: "sb-tower-wa", role: "tower" }, kind: "wait_parked", scope: "session", to: [{ name: "m", id: "m", role: "main" }], reply: false, wait: "W4" }).includes("kind=wait_parked"));
});

test("AMC-F006: the return list says the boxes' asks are not collected, and lists them when a source gives some", () => {
	const p = { since: "2026-11-10T00:00:00Z", notes: [], foreign: [], decided: [] }, by = { via: "pi" as const, name: "t" };
	assert.match(reportText(buildReport(p, by, by, "2026-11-10T07:00:00Z", [])), /boxes you control: not collected/);
	const listed = reportText(buildReport(p, by, by, "2026-11-10T07:00:00Z", [], [{ box: "ginlee", gist: "Deploy?" }]));
	assert.match(listed, /- ginlee: Deploy\?/);
	assert.ok(!listed.includes("not collected"));
});
