import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net } from "../src/net.ts";
import type { TrustAsk } from "../src/trust/types.ts";

// The page's side of the trust question (gui/alerts.ts, gui/trust.ts), as pure render with a small fake DOM: the alert it raises, what the dialog shows and offers, and how an
// answer's outcome reads. The deploy panel's inline copy is in deploy-panel.test.ts.

class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	onclick: (() => void) | null = null;
	disabled = false;
	tag: string;
	constructor(tag = "") {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	get text(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.text)).join(" ");
	}
	find(pred: (el: El) => boolean): El[] {
		return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.find(pred)))].filter(pred);
	}
}
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag), createElementNS: (_: string, tag: string) => new El(tag) } });
const { alertsOf, arrivals, ownOpenings, rankOf } = await import("../gui/alerts.ts");
const { trustPanel, whereOf } = await import("../gui/trust.ts");

const ASK: TrustAsk = {
	id: "00000000-0000-4000-8000-000000000001", digest: "a".repeat(64), folder: "/Users/me/work/demo",
	found: [
		{ kind: "settings", path: ".pi/settings.json", items: ["package: npm:demo"], more: 0 },
		{ kind: "extensions", path: ".pi/extensions", items: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"], more: 3 },
		{ kind: "mcp", path: ".pi/mcp.json", items: [], more: 0, unreadable: true },
	],
	agents: [{ pane: "p1", base: "Demo base", role: "member", at: 1 }],
};
const net = (trust: TrustAsk[]): Net => ({ bases: [], trust });

test("a trust question is an alert that waits on the user: ranked as a question, keyed by folder and digest, and new when it first arrives", () => {
	const now = alertsOf(net([ASK]), 10), [alert] = [...now.values()];
	assert.equal(now.size, 1);
	assert.equal(alert!.mark, "waiting");
	assert.equal(rankOf(alert!), 0, "it counts in the HUD and Space opens it");
	assert.equal(alert!.name, "demo");
	assert.equal(alert!.role, "member");
	assert.equal(alert!.trust, ASK);
	assert.deepEqual(arrivals(undefined, now), [alert], "it queues, to be heard once");
	const again = alertsOf(net([{ ...ASK, id: "00000000-0000-4000-8000-000000000002" }]), 20);
	assert.deepEqual([...again.keys()], [...now.keys()], "another request of the same folder and digest is the same alert");
	assert.deepEqual(arrivals(now, again), []);
	assert.equal(alertsOf(net([{ ...ASK, digest: "b".repeat(64) }]), 30).size, 1);
	assert.notDeepEqual([...alertsOf(net([{ ...ASK, digest: "b".repeat(64) }]), 30).keys()], [...now.keys()], "what changed in the folder is a new question");
});

test("the opening this page runs shows its question in its deploy panel, not as an alert; another page still gets the alert", () => {
	const mine = { ...ASK, opening: "deploy-mine" };
	assert.equal(alertsOf(net([mine]), 1).size, 1, "a page that did not make the opening queues it");
	ownOpenings.add("deploy-mine");
	assert.equal(alertsOf(net([mine]), 1).size, 0);
	ownOpenings.delete("deploy-mine");
	assert.equal(alertsOf(net([mine]), 1).size, 1);
});

test("the dialog's line says where the agent runs, or how many wait on the folder", () => {
	assert.equal(whereOf(ASK), "member in Demo base");
	assert.equal(whereOf({ ...ASK, agents: [{ pane: "p1", role: "none", base: "B", at: 1 }] }), "session in B");
	assert.equal(whereOf({ ...ASK, agents: [...ASK.agents, { pane: "p2", role: "main", at: 2 }, { pane: "p3", role: "member", at: 3 }] }), "3 agents are waiting on this folder");
});

const settle = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};
function panel(reply: (body: Record<string, unknown>) => unknown) {
	const sent: Record<string, unknown>[] = [];
	const p = trustPanel(async (body) => (sent.push(body), reply(body) as never)) as unknown as El & { update(q?: TrustAsk, live?: boolean): void };
	p.update(ASK);
	const buttons = p.find((e) => e.tag === "button" && e.attrs.has("data-choice"));
	const note = p.find((e) => e.tag === "p" && e.attrs.get("class") === "ask-note")[0]!;
	return { p, sent, buttons, note };
}

test("the panel says what trusting does, lists what the folder holds (folded past five items with the rest counted), and offers the three choices", () => {
	const { p, buttons } = panel(() => ({ ok: true, status: 200, body: { outcome: "accepted" } }));
	assert.match(p.text, /Trusting lets the agent load this folder's settings, extensions, skills, prompts, themes, and MCP servers/);
	assert.match(p.text, /run as programs on this computer/);
	assert.match(p.text, /\.pi\/settings\.json[\s\S]*package: npm:demo/);
	assert.match(p.text, /e\.ts/);
	assert.ok(!/f\.ts/.test(p.text), "past five items it folds");
	assert.match(p.text, /and 5 more/, "the two folded items and the three the server cut");
	assert.match(p.text, /\.pi\/mcp\.json[\s\S]*could not be read/);
	assert.deepEqual(buttons.map((b) => [b.attrs.get("data-choice"), b.text]), [["trust", "Trust"], ["once", "Trust this time"], ["no", "Don't trust"]]);
	assert.match(p.text, /terminal can answer too; the first answer counts/);
});

test("a choice posts the question's id and digest with an answer id, once, and the panel reads the outcome", async () => {
	const accepted = panel(() => ({ ok: true, status: 200, body: { outcome: "accepted" } }));
	accepted.buttons[0]!.onclick!();
	assert.ok(accepted.buttons.every((b) => b.disabled), "no second answer while one is on its way");
	await settle();
	assert.equal(accepted.sent.length, 1);
	assert.deepEqual([accepted.sent[0]!.id, accepted.sent[0]!.digest, accepted.sent[0]!.choice], [ASK.id, ASK.digest, "trust"]);
	assert.match(String(accepted.sent[0]!.answerId), /^[A-Za-z0-9_-]{16,64}$/);
	assert.equal(accepted.note.text, "Answered.");
	assert.ok(accepted.buttons.every((b) => b.disabled), "answered: nothing more to send from here");
	const stale = panel(() => ({ ok: true, status: 200, body: { outcome: "stale", by: "terminal" } }));
	stale.buttons[2]!.onclick!();
	await settle();
	assert.equal(stale.note.text, "Answered in the terminal.");
	const changed = panel(() => ({ ok: false, status: 409, body: { error: "stale", reason: "x" } }));
	changed.buttons[0]!.onclick!();
	await settle();
	assert.match(changed.note.text, /changed or is closed/);
});

test("an answer that was not confirmed is checked again with the same answer id, never sent as a new answer", async () => {
	let n = 0;
	const { sent, buttons, note } = panel(() => (n++ ? { ok: true, status: 200, body: { outcome: "accepted" } } : { ok: false, status: 504, body: { outcome: "unknown" } }));
	buttons[1]!.onclick!();
	await settle();
	assert.match(note.text, /Not confirmed/);
	const again = note.find((e) => e.tag === "button")[0]!;
	again.onclick!();
	await settle();
	assert.equal(sent.length, 2);
	assert.equal(sent[0]!.answerId, sent[1]!.answerId);
	assert.equal(note.text, "Answered.");
});

test("the choices stay off while the stream is down, and a question that went away closes the panel", () => {
	const { p, buttons, note } = panel(() => ({ ok: true, status: 200, body: {} }));
	assert.ok(buttons.every((b) => !b.disabled));
	p.update(ASK, false);
	assert.ok(buttons.every((b) => b.disabled));
	p.update(ASK, true);
	assert.ok(buttons.every((b) => !b.disabled));
	p.update(undefined);
	assert.ok(buttons.every((b) => b.disabled));
	assert.equal(note.text, "This question is closed.");
});

test("a refusal that decided nothing leaves the choices open, with the server's reason", async () => {
	const { buttons, note } = panel(() => ({ ok: false, status: 400, body: { error: "bad_request", reason: "The answer does not name its question." } }));
	buttons[0]!.onclick!();
	await settle();
	assert.equal(note.text, "The answer does not name its question.");
	assert.ok(buttons.every((b) => !b.disabled));
});
