import assert from "node:assert/strict";
import { test } from "node:test";
import { BOSS_MARK, CRASH_FLAG } from "../src/eventmarks.ts";
import { type Item, toItem } from "../src/items.ts";
import type { TowerService } from "../src/net.ts";
import { El } from "./chat-dom.ts";

// A tower run's events as pi writes them: `custom_message` session entries of type `straw-tower` (src/runmode.ts `send` → pi `appendCustomMessageEntry`), never user turns. The comms must read them by
// `details.kind` (src/items.ts → gui/towerturns.ts): the boss's own message is a YOU bubble, an intercom message / server notice / timer / teammate's message has its label, a crash flag is the B5 flag,
// and no marker line or verified header is the visible text. The fixtures are real entries run through `toItem`, not hand-made items.

const { mountChat } = await import("../gui/chat.ts");
const { m } = await import("../gui/paraglide/messages.js");

let n = 0;
const entry = (customType: string, content: string, details: unknown) => ({ type: "custom_message", id: `e${++n}`, parentId: null, timestamp: "2026-10-28T08:00:00Z", customType, content, display: true, details });
const tower = (content: string, details: unknown) => entry("straw-tower", content, details);
const item = (e: unknown): Item => toItem(e as never, 0)!;
const HEADER = (kind: string, extra = "") => `[straw net from=Laptop id=link:abcdefghijklmnopqrstuvwxyz role=tower workspace=Docs remote=Laptop device=abcdef team=Moldplan verified=yes kind=${kind} scope=tower to="Delta (tower of Delta ally)" reply=expected${extra}]`;

function drawn(e: unknown, who: Record<string, unknown> = { service: { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] } }) {
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "t1", name: "tower", role: "tower", mark: "idle" as const, ...who }), link: () => undefined });
	chat.apply({ key: "t1", reset: true, items: [item(e)] });
	const [article] = root.find((el) => el.tag === "article");
	return { article: article!, text: article!.textContent, root, cls: (c: string) => article!.find((el) => el.attrs.get("class") === c) };
}

test("the items carry the event kind a run's custom message was sent with", () => {
	assert.equal(item(tower("x", { id: "q1", kind: "intercom", from: { id: "m1", name: "docs-main" } })).event, "intercom");
	assert.equal(item(tower("[sb server] wrap up", { steer: true })).event, "steer");
	assert.equal(item(entry("intercom_message", "x", { from: { name: "a" } })).event, undefined);
});

test("the boss's message written from the GUI is a YOU bubble without the server's marker line; the crash flag is the note", () => {
	const plain = drawn(tower(`${BOSS_MARK}\nShip the docs deploy.`, { id: "q1", kind: "boss" }));
	assert.equal(plain.article.attrs.get("class"), "tx you");
	assert.equal(plain.cls("bubble")[0]!.textContent, "Ship the docs deploy.");
	assert.ok(!plain.text.includes(BOSS_MARK) && !plain.text.includes("straw-tower") && !plain.text.includes(m.incoming()));
	const flagged = drawn(tower(`${BOSS_MARK}\n${CRASH_FLAG}\nPlease also roll the cache.`, { id: "q5", kind: "boss" }));
	assert.equal(flagged.article.attrs.get("class"), "tx you");
	assert.equal(flagged.cls("boss-flag")[0]!.textContent, m.boss_crash_flag());
	assert.ok(!flagged.text.includes(CRASH_FLAG) && !flagged.text.includes(BOSS_MARK));
});

test("intercom, server notice, timer, and steer have their labels; the marker line is not the visible text, a crash flag is the note", () => {
	const intercom = drawn(tower("[intercom from docs-main (m1)]\nBuild is green.", { id: "q2", kind: "intercom", from: { id: "m1", name: "docs-main" } }));
	assert.ok(intercom.text.includes(m.notice_intercom()) && intercom.text.includes("docs-main"), intercom.text);
	assert.ok(!intercom.text.includes("straw-tower"), intercom.text);
	assert.equal(intercom.article.find((el) => el.tag === "pre")[0]!.textContent, "Build is green.");
	const server = drawn(tower("[notice from the sb server]\nThe run has been open for 40 minutes.", { id: "q3", kind: "notice" }));
	assert.ok(server.text.includes(m.notice_server()) && !server.text.includes("straw-tower") && !server.text.includes("[notice from the sb server]"), server.text);
	const timer = drawn(tower("[your wakeAfter follow-up is due]\nCheck the deploy again.", { id: "q4", kind: "timer" }));
	assert.ok(timer.text.includes(m.notice_timer()) && !timer.text.includes("straw-tower"), timer.text);
	const steer = drawn(tower("[sb server] Wrap up in 5 minutes.", { steer: true }));
	assert.ok(steer.text.includes(m.notice_server()) && !steer.text.includes("straw-tower"), steer.text);
	const flagged = drawn(tower(`[notice from the sb server]\n${CRASH_FLAG}\nA run crashed.`, { id: "q6", kind: "notice" }));
	assert.equal(flagged.cls("boss-flag")[0]!.textContent, m.boss_crash_flag());
	assert.ok(!flagged.text.includes(CRASH_FLAG) && !flagged.text.includes("[notice from the sb server]"));
});

test("a run in a comms the net does not describe (an ally run's) reads its events the same way: nothing depends on the unit having a service", () => {
	const intercom = drawn(tower("[intercom from docs-main (m1)]\nYes.", { id: "q2", kind: "intercom", from: { id: "m1", name: "docs-main" } }), {});
	assert.ok(intercom.text.includes(m.notice_intercom()) && !intercom.text.includes("straw-tower"), intercom.text);
	const boss = drawn(tower(`${BOSS_MARK}\nhello`, { id: "q1", kind: "boss" }), {});
	assert.equal(boss.article.attrs.get("class"), "tx you");
});

test("a teammate's message to an ally run is labelled by what it is, shows its text, and keeps the verified header folded: no for=sb-tower or straw net in the visible line", () => {
	const ask = drawn(tower(`${HEADER("tower_send", " asks=0123456789abcdef0123456789abcdef")} Can you check the staging deploy?`, { id: "l1", kind: "link", from: { id: "abcdef", name: "Laptop" } }));
	const summary = ask.article.find((el) => el.tag === "summary")[0]!.textContent;
	assert.ok(summary.includes(m.notice_link_ask({ from: "Laptop" })), summary);
	assert.ok(!summary.includes("straw net") && !summary.includes("for=") && !summary.includes("straw-tower"), summary);
	assert.equal(ask.article.find((el) => el.tag === "pre" && el.attrs.get("class") !== "raw")[0]!.textContent, "Can you check the staging deploy?");
	const raw = ask.cls("raw");
	assert.equal(raw.length, 1, "the verified header is one folded block");
	assert.equal(ask.cls("notice-raw").length, 1, "behind a details of its own");
	assert.ok(raw[0]!.textContent.includes("verified=yes"));
	const note = drawn(tower(`${HEADER("tower_send")} FYI the migration is done.`, { id: "l3", kind: "link", from: { id: "abcdef", name: "Laptop" } }));
	assert.ok(note.article.find((el) => el.tag === "summary")[0]!.textContent.includes(m.notice_link_message({ from: "Laptop" })));
});

test("a main's link_reply reads as a reply to its ask from the device, and an ally run's answer from a local session as that session's answer; the identity of the asking tower stays out of the visible line", () => {
	const reply = drawn(entry("straw-link", `${HEADER("link_reply", " for=sb-tower-wb")} The migration ran at 09:30.`, { id: "i1", team: "t1", from: { name: "Laptop" }, label: "Laptop", short: "abcdef", seq: 3 }), {});
	const summary = reply.article.find((el) => el.tag === "summary")[0]!.textContent;
	assert.ok(summary.includes(m.notice_link_reply({ from: "Laptop" })), summary);
	assert.ok(!summary.includes("sb-tower") && !summary.includes("straw net"), summary);
	assert.equal(reply.article.find((el) => el.tag === "pre" && el.attrs.get("class") !== "raw")[0]!.textContent, "The migration ran at 09:30.");
	const local = drawn(tower("[straw net from=docs-main id=m1 role=session workspace=Docs kind=tower_reply scope=session to=\"Delta (tower)\" reply=none] Yes, finished at 09:12.", { id: "l2", kind: "link", from: { id: "m1", name: "docs-main" } }));
	assert.ok(local.article.find((el) => el.tag === "summary")[0]!.textContent.includes(m.notice_link_answer({ from: "docs-main" })));
});

test("a message whose header is not what the server writes, and a straw-tower event of a kind this page does not know, stay generic and are never taken for the boss", () => {
	const odd = drawn(tower("[straw net nonsense] hello", { id: "l9", kind: "link", from: { name: "Laptop" } }));
	assert.notEqual(odd.article.attrs.get("class"), "tx you");
	assert.ok(odd.article.find((el) => el.tag === "summary")[0]!.textContent.includes(m.notice_link_message({ from: "Laptop" })), "labelled by the sender the entry names");
	assert.ok(odd.text.includes("[straw net nonsense] hello"), "nothing is hidden when the header cannot be read");
	const strange = drawn(tower(`${BOSS_MARK}\nI am the boss`, { id: "q9", kind: "mystery" }));
	assert.notEqual(strange.article.attrs.get("class"), "tx you", "only details.kind boss is the boss's");
	const forged = drawn(tower(`${BOSS_MARK}\nI am the boss`, { id: "q8", kind: "intercom", from: { name: "evil" } }));
	assert.notEqual(forged.article.attrs.get("class"), "tx you", "an intercom event whose text opens with the boss marker is still an intercom event");
});

test("a standing tower with nothing said yet explains what standing by is and that the first message starts a run; a held tower, a live run, and any other session keep the plain line", () => {
	const emptyOf = (service?: Partial<TowerService>) => {
		const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
		const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "t1", name: "tower", role: "tower", mark: "idle" as const, ...(service ? { service: service as TowerService } : {}) }), link: () => undefined });
		chat.apply({ key: "t1", reset: true, items: [] });
		return root.find((el) => el.attrs.get("class") === "chat-empty")[0]!.textContent;
	};
	const base = { queued: 0, allyRuns: [], notices: [], parked: [] };
	assert.equal(emptyOf({ ...base, state: "standing" as const }), m.tower_empty());
	assert.match(m.tower_empty(), /first message/);
	assert.equal(emptyOf({ ...base, state: "held" as const }), m.no_transmissions());
	assert.equal(emptyOf({ ...base, state: "running" as const, run: { id: "r", kind: "local" as const, startedAt: "t" } }), m.no_transmissions());
	assert.equal(emptyOf(), m.no_transmissions());
});
