import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import { El, page } from "./fake-dom.ts";
import { alertsOf } from "../gui/alerts.ts";
import { m } from "../gui/paraglide/messages.js";
import type { Pending } from "../src/ask.ts";
import type { StepOpen } from "../gui/terminalthen.ts";

// The Zen terminal layer (gui/zenterm.ts, docs/specs/2026-11-01-zen-view.md, A terminal in Zen): the terminal an answer opens shows inside Zen, over the screen that was there, and goes back to it.
// The terminal itself (mirror.ts, the key pad) is the page's one; here `embed` is a recorder that puts a keyboard sink into the host, as the real tile does.
const { mountZen, real } = await import("../gui/zen.ts");
const { ESC_MS, termStep } = await import("../gui/zenkeys.ts");
const { termHold } = await import("../gui/towerturns.ts");
const { DRIFT_MS, FADE_MS } = await import("../gui/zenterm.ts");

const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[]): Net => ({ bases: [{ id: "w", label: "Harbor", mark: "idle", tower: { name: "tower", mark: "idle", key: "t", control: true, subs: [] }, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust: [] }) as Net;
const select = (): Pending => ({ callId: "c1", tool: "robot_hand", answer: { dialog: "d1", digest: "0".repeat(64), select: { title: "Robot Hand: deploy", choices: [{ label: "Put it in my prompt" }, { label: "No thanks" }] } } });
const readonly = (): Pending => ({ callId: "c4", tool: "ask_user_question", why: "Two dialogs are open.", asks: [{ header: "A", question: "First?", options: [{ title: "x" }], multiple: false, freeform: false }] });

/** The arguments Zen mounted its answer panels with, for a test that reads them. */
const spy: { ask?: (args: unknown[]) => void } = {};
function rig() {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = {
		leave: [] as unknown[],
		embeds: [] as { key: string; name: string; host: El; keys: boolean | undefined; end: (() => void) | undefined; taken: (() => void) | undefined }[],
		watches: [] as { key: string; name: string; w: { rows(rows: string[]): void; state(s: string, c: unknown): void; end(): void; taken(): void } }[],
		off: [] as string[], stops: [] as string[], sinks: [] as El[], posts: [] as { key: string; action: string; body: Record<string, unknown> }[],
		/** The mirror attaches and detaches the page's terminals would make: a key is attached while anything holds it (an embed, a watch). */
		attaches: [] as string[], detaches: [] as string[],
	};
	const holders = new Map<string, number>();
	const hold = (key: string) => (holders.get(key) ?? 0) === 0 && calls.attaches.push(key), join = (key: string) => (hold(key), holders.set(key, (holders.get(key) ?? 0) + 1));
	const leaveKey = (key: string) => (holders.set(key, (holders.get(key) ?? 1) - 1), holders.get(key) === 0 && calls.detaches.push(key));
	let resolveEmbed: (() => void) | undefined;
	const kit = {
		embed: (key: string, name: string, host: El, o: { keys: boolean; end?: () => void; taken?: () => void }) => {
			calls.embeds.push({ key, name, host, keys: o.keys, end: o.end, taken: o.taken });
			join(key);
			const sink = new El("textarea");
			sink.setAttribute("class", "term-sink");
			calls.sinks.push(sink);
			host.replaceChildren(new El("div"), sink);
			return () => (calls.off.push(key), leaveKey(key));
		},
		watch: (key: string, name: string, w: (typeof calls.watches)[number]["w"]) => {
			calls.watches.push({ key, name, w });
			join(key);
			const conn = { key, rows: [] as string[], cols: 80, phase: "live", why: "", stale: () => false };
			return { conn, stop: () => (calls.stops.push(key), leaveKey(key)), retry: () => {} };
		},
		post: (key: string) => async (action: string, body: Record<string, unknown>) => (calls.posts.push({ key, action, body }), { ok: true, status: 200, body: {} }),
		stream: () => "st",
	};
	const deps = {
		data: () => ({ older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined }),
		recent: async () => [],
		post: () => () => new Promise(() => {}), label: (ws: string) => ws, online: () => true,
		remind: () => {}, sound: () => {}, leave: (e: unknown) => void calls.leave.push(e), watch: () => {},
		remote: false, now: () => t, start: () => ({ key: "t", ws: "w" }), // a session for company: a card still takes the screen by itself (on the breathing circle it waits for Enter, Z-D19)
		
		fs: { doc: { addEventListener() {}, documentElement: {} }, standalone: () => false, touch: () => false, seen: { getItem: () => "1", setItem() {} }, later: () => () => {} },
		still: () => false, random: () => 0,
		terminals: () => new Promise<typeof kit>((done) => {
			if (resolveEmbed === undefined) done(kit);
			else resolveEmbed = () => done(kit);
		}),
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			timers.push(e);
			return () => void (timers.includes(e) && timers.splice(timers.indexOf(e), 1));
		},
	};
	const mounts = { ...real, ask: ((...a: Parameters<typeof real.ask>) => (spy.ask?.(a), real.ask(...a))) as never, composer: ((root: El) => (root.replaceChildren(new El("textarea")), { box: new El("textarea"), update() {} })) as never, chat: async () => () => ({ apply() {}, setLive() {}, reveal() {}, box() {} }) as never };
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
	/** An Escape the page hands the layer: `took` is the layer's answer, `prevented` whether it kept the key from the terminal's own handling. */
	const esc = (repeat = false) => {
		const e = { prevented: 0, repeat, preventDefault() { this.prevented++; } };
		return { took: z.escape(e), prevented: e.prevented };
	};
	const layer = () => root.all((el) => (el.getAttribute("class") ?? "").split(" ").includes("zen-term"))[0];
	const back = () => root.all((el) => el.tagName === "button" && el.textContent === m.zen_back_title())[0];
	const stage = () => root.all((el) => el.getAttribute("class") === "zen-stage")[0]!;
	return {
		z, root, calls, advance, settle, esc, layer, back, stage, now: () => t,
		feed: (n: Net) => z.net(alertsOf(n, t), n),
		hold: () => (resolveEmbed = () => {}),
		release: () => resolveEmbed?.(),
		text: () => root.textContent,
		key: (type: string, k: string, target: El) => {
			const e = { key: k, target, prevented: 0, preventDefault() { this.prevented++; } };
			for (const on of root.handlers[type] ?? []) on(e);
			return e.prevented;
		},
	};
}
const item = () => net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select() })]);
const idle = () => net([unit("a", "idle", { name: "ops-main" })]);
const shown = async (n = item()) => {
	const r = rig();
	r.feed(n);
	r.z.show();
	await r.settle();
	r.z.key("talk"); // Enter takes the card: a card never comes by itself (Z-D20)
	await r.settle();
	return r;
};
const sinkOf = (r: ReturnType<typeof rig>) => r.calls.sinks.at(-1)!;
/** The quiet line in the layer's bar after the step is over (before the layer drifts back to Zen). */
const noteOf = (r: ReturnType<typeof rig>) => r.layer()?.all((el) => el.getAttribute("class") === "zen-term-note")[0]?.textContent;

test("termStep: the terminal's keyboard keeps Esc for itself; outside it the first Esc shows the hint, a second within the window returns, a held key does nothing", () => {
	assert.equal(termStep({ typing: true, armed: false }), "pass");
	assert.equal(termStep({ typing: true, armed: true }), "pass", "an armed window does not make a key meant for pi leave");
	assert.equal(termStep({ typing: false, armed: false }), "hint");
	assert.equal(termStep({ typing: false, armed: true }), "leave");
	assert.equal(termStep({ typing: false, armed: false, repeat: true }), "none");
	assert.equal(termStep({ typing: true, armed: false, repeat: true }), "pass", "pi's own repeats are the terminal's");
});

test("a session's terminal opens as a layer inside Zen: the same terminal embedded in a full-screen host, the screen under it held still, and nothing leaves Zen", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.ok(r.layer(), "the layer is on the page");
	assert.deepEqual(r.calls.leave, [], "Standard is never visited");
	assert.deepEqual(r.calls.embeds.map((e) => [e.key, e.name, e.keys]), [["a", "ops-main", true]], "the session's key and name, the keyboard in it");
	assert.ok(r.layer()!.contains(r.calls.embeds[0]!.host), "the terminal sits in the layer");
	assert.equal(r.stage().getAttribute("inert"), "", "the card under it takes no focus and no tab");
	assert.ok(r.back(), "the way back is a button in the layer");
	assert.equal(r.back()!.parent!.getAttribute("class"), "zen-term-bar");
});

test("a granted pane's terminal is named for the pane, and a second open of the same terminal brings the one layer forward", async () => {
	const r = await shown();
	r.z.terminal({ key: "grant:g1" });
	r.z.terminal({ key: "grant:g1" });
	await r.settle();
	assert.deepEqual(r.calls.embeds.map((e) => [e.key, e.name]), [["grant:g1", m.pane_name()]]);
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.deepEqual([r.calls.off, r.calls.embeds.length], [["grant:g1"], 2], "another terminal replaces the first, which is let go");
});

test("Back to Zen returns to the screen that was there: the same card, the terminal let go, the layer gone, never Standard", async () => {
	const r = await shown();
	const card = r.stage().kids[0];
	r.z.terminal({ key: "a" });
	await r.settle();
	r.back()!.focus();
	r.back()!.click();
	await r.settle();
	assert.deepEqual([r.calls.off, r.calls.leave], [["a"], []]);
	assert.equal(r.layer(), undefined);
	assert.equal(r.stage().getAttribute("inert"), null);
	assert.equal(r.stage().kids[0], card, "the item's card is the same one: no redraw, no flash");
	assert.ok((card as El).contains(page.activeElement), "the card has the focus again (its first choice)");
});

test("hiding Zen (Esc, the corner control, a view pick) lets the terminal go with it", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.z.hide();
	assert.deepEqual([r.calls.off, r.layer()], [["a"], undefined]);
	const late = await shown();
	late.hold();
	late.z.terminal({ key: "a" });
	late.z.hide();
	late.release();
	await late.settle();
	assert.deepEqual([late.calls.embeds, late.layer()], [[], undefined], "the terminals still on their way when the layer closes are never used");
});

test("Esc while the terminal has the keyboard goes to the terminal: not taken, not prevented, however often; the layer stays", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	sinkOf(r).focus();
	for (let i = 0; i < 4; i++) assert.deepEqual(r.esc(), { took: false, prevented: 0 });
	assert.ok(r.layer(), "pi's interrupt, vim's escape: the layer does not return on them");
	assert.equal(r.root.dump().includes(m.zen_term_esc_hint()), false, "and no hint");
});

test("Esc with the focus outside the terminal: the first shows the hint, a second within 600 ms returns to Zen, a later one starts again; a held key does nothing", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.back()!.focus();
	assert.deepEqual(r.esc(), { took: true, prevented: 1 }, "the layer's key");
	assert.ok(r.text().includes(m.zen_term_esc_hint()));
	assert.deepEqual(r.esc(true), { took: true, prevented: 1 }, "a held key neither returns nor starts");
	assert.ok(r.layer());
	await r.advance(ESC_MS + 50);
	r.esc();
	assert.ok(r.layer(), "a first again: the window had closed");
	await r.advance(200);
	r.esc();
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.off, r.calls.leave], [undefined, ["a"], []]);
	assert.equal(r.text().includes(m.zen_term_esc_hint()), false, "the hint goes with the layer");
});

test("Esc with the layer closed is Zen's own again: an item's Esc cancels or skips it and never meets the terminal's rule", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.back()!.click();
	assert.equal(r.esc().took, true);
	assert.equal(r.text().includes(m.zen_term_esc_hint()), false, "the terminal's hint is not Zen's");
});

test("a pane that closes or whose grant ends does not return to Zen at once: the layer says so in its bar; a session's terminal that ends says nothing and stays (Z-D20)", async () => {
	const r = await shown();
	r.z.terminal({ key: "grant:g1" });
	await r.settle();
	r.calls.embeds[0]!.end!();
	await r.settle();
	assert.deepEqual([Boolean(r.layer()), r.calls.off, r.calls.leave, noteOf(r)], [true, [], [], m.zen_term_gone()]);
	r.back()!.click();
	assert.deepEqual([r.layer(), r.calls.off], [undefined, ["grant:g1"]], "Back to Zen ends it before the drift");
	const s = await shown();
	s.z.terminal({ key: "a" });
	await s.settle();
	s.calls.embeds[0]!.end!();
	await s.settle();
	assert.ok(s.layer(), "a session's mirror ending says the session left the pane, which the boss should read");
});

test("a terminal opened to look at (no step) is the boss's to end: no mark sequence and no Enter returns it", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	for (const n of [net([unit("a", "working", { name: "ops-main" })]), idle(), net([unit("a", "waiting", { name: "ops-main", since: 9 })]), idle(), net([unit("a", "working", { name: "ops-main" })])]) r.feed(n);
	r.calls.embeds[0]!.taken!();
	await r.settle();
	assert.ok(r.layer(), "the tool's result, an intercom, a wake, even the boss's own Enter: this terminal was not opened for a step");
});

test("a terminal opened for a unit that waits at once (a blocked prompt) is over at its first working and says so in its bar: `armed` says the wait is the terminal step", async () => {
	const r = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5 })]));
	r.z.terminal({ key: "a", armed: true });
	await r.settle();
	assert.equal(noteOf(r), "", "nothing to say while the unit still waits");
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	await r.settle();
	assert.ok(r.layer(), "the unit's work does not close it at once");
	assert.equal(noteOf(r), m.zen_term_working());
	r.feed(idle());
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 9 })]));
	assert.ok(r.layer(), "and no later mark closes it: only the drift does");
});

test("the card under the layer is never replaced by a new card, and the keyboard stays with the terminal (Z-D20)", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	sinkOf(r).focus();
	r.feed(net([unit("a", "idle", { name: "ops-main" }), unit("b", "waiting", { name: "next", since: 6, pending: select() })]));
	for (let i = 0; i < 8; i++) await r.advance(1000); // the old card's question ended: it stays, and the next question waits for Enter
	assert.ok(!r.root.dump().includes("next"), "the next item's card is not drawn under the layer");
	assert.ok(r.root.dump().includes(m.zen_rest()), "the card that was there stays, settled, under the layer");
	assert.equal(page.activeElement, sinkOf(r), "and the keyboard stays with the terminal");
});

test("the pause under the layer ignores the terminal's Enter and Space and its taps, so the keys reach the pane", async () => {
	const r = await shown();
	r.root.all((el) => el.tagName === "button" && el.textContent === m.zen_not_now())[0]!.click();
	await r.settle();
	assert.ok(r.root.dump().includes(m.zen_pause()), "the pause is on the page");
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.equal(r.key("keydown", "Enter", sinkOf(r)), 0, "not prevented");
	assert.equal(r.key("keydown", " ", sinkOf(r)), 0);
	// Since views-core R8 the pause key reaches Zen through the page's keymap (core.hotkey → zen.tap()), not a root listener.
	assert.equal(r.z.tap(), false, "the keymap's pause key does nothing under the layer");
	for (const on of r.root.handlers.pointerdown ?? []) on({ target: sinkOf(r) });
	assert.ok(r.root.dump().includes(m.zen_pause()), "a tap in the terminal does not end the pause under it");
	r.back()!.click();
	await r.settle();
	assert.equal(r.z.tap(), true, "without the layer the pause key ends the pause (control)");
});

test("an Open terminal button (a unit blocked on a terminal prompt, a dialog shown read-only) opens the layer, not Standard", async () => {
	const words = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5 })]));
	const open = words.root.all((el) => el.tagName === "button" && el.textContent === m.zen_open_terminal())[0];
	assert.ok(open, "the button is worded for the terminal, not Standard");
	open.click();
	await words.settle();
	assert.deepEqual([words.calls.leave, words.calls.embeds.map((e) => e.key), Boolean(words.layer())], [[], ["a"], true]);
	words.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.ok(words.layer(), "the wait was the terminal step: it ended with the unit working, and the layer stays for the boss (Z-D20)");
	assert.equal(noteOf(words), m.zen_term_working());
	const ro = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: readonly() })]));
	ro.root.all((el) => el.tagName === "button" && el.textContent === m.zen_open_terminal())[0]!.click();
	await ro.settle();
	assert.deepEqual([ro.calls.leave, ro.calls.embeds.map((e) => e.key)], [[], ["a"]]);
	ro.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.ok(ro.layer(), "a read-only dialog's button is armed too: its unit waits on that dialog now, and its next work ends the step, which the bar says; the layer stays");
	assert.equal(noteOf(ro), m.zen_term_working());
});

test("a terminal asked for while Zen is not shown is not drawn", async () => {
	const r = rig();
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.embeds.length], [undefined, 0]);
});

test("the layer's sheet is ink only: every rule is under the Zen view, takes its colours from the ink tokens (no colour of its own), and stills under reduced motion", () => {
	const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8"), rules = css.split("\n").filter((line) => /\.zen-term/.test(line) && !line.startsWith("/*"));
	assert.ok(rules.length >= 10, "the layer's rules are in the sheet");
	for (const line of rules.filter((l) => !l.startsWith("@media"))) {
		assert.ok(line.startsWith('[data-view="zen"] '), `scoped to Zen: ${line.slice(0, 50)}`);
		assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsl/i.test(line), false, `no colour of its own: ${line.slice(0, 50)}`);
	}
	assert.ok(rules.some((l) => /prefers-reduced-motion: reduce\)[^]*\.zen-term \{ animation: none/.test(l)), "reduced motion stills the layer's fade");
	assert.ok(/\.zen-term \{[^}]*position: fixed; inset: 0/.test(css), "full screen");
});

test("ZT-F002: Esc is the terminal's only while its pad can take it (live or hidden); a dead terminal releases Esc, so Esc Esc returns", async () => {
	const r = await shown();
	r.z.terminal({ key: "grant:g1" });
	await r.settle();
	sinkOf(r).focus();
	sinkOf(r).dataset.pad = "live";
	assert.deepEqual(r.esc(), { took: false, prevented: 0 });
	sinkOf(r).dataset.pad = "hidden";
	assert.deepEqual(r.esc(), { took: false, prevented: 0 }, "a secret's pad still takes Esc");
	sinkOf(r).dataset.pad = "off";
	assert.deepEqual(r.esc(), { took: true, prevented: 1 }, "a dead terminal: the layer's hint");
	assert.ok(r.text().includes(m.zen_term_esc_hint()));
	r.esc();
	await r.settle();
	assert.equal(r.layer(), undefined, "Esc Esc returns from a dead terminal");
});

test("ZT-F005: on a screen without a fine pointer the focus moves into the layer (Back to Zen) when it opens; with one the terminal's sink is the mirror's to focus", async () => {
	const g = globalThis as { matchMedia?: unknown }, was = g.matchMedia;
	try {
		g.matchMedia = () => ({ matches: false });
		const phone = await shown();
		phone.z.terminal({ key: "a" });
		await phone.settle();
		assert.equal(page.activeElement, phone.back(), "the back button holds the focus");
		g.matchMedia = () => ({ matches: true });
		const desk = await shown();
		desk.z.terminal({ key: "a" });
		await desk.settle();
		assert.notEqual(page.activeElement, desk.back(), "a desktop leaves the focus to the sink");
	} finally {
		g.matchMedia = was;
	}
});

test("ZT-F004: a standing or held tower's terminal shows the sentence, not an embed; it embeds when the tower runs again, and the sentence comes back when it stands by", async () => {
	const tower = (mark: Mark, service: object): Net => { const n = net([]); n.bases[0]!.tower = { name: "tower", mark, key: "a", control: true, subs: [], service } as never; return n; };
	const standing = () => tower("idle", { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] });
	const running = () => tower("working", { state: "running", queued: 0, allyRuns: [], notices: [], parked: [], run: { id: "r1", kind: "local", startedAt: "" } });
	const r = await shown(standing());
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.deepEqual(r.calls.embeds, [], "nothing to attach to");
	assert.ok(r.text().includes(termHold({ state: "standing" } as never)!), "the hold sentence stands where the terminal would");
	r.feed(running());
	await r.settle();
	assert.equal(r.calls.embeds.length, 1, "the run is live: the terminal");
	r.feed(standing());
	await r.settle();
	assert.deepEqual(r.calls.off, ["a"], "the terminal is let go");
	assert.ok(r.text().includes(termHold({ state: "standing" } as never)!));
});

const cardOf = (r: ReturnType<typeof rig>) => r.root.all((el) => (el.getAttribute("class") ?? "").split(" ").includes("tcard"))[0];
const fullLink = (r: ReturnType<typeof rig>) => r.root.all((el) => (el.getAttribute("class") ?? "").split(" ").includes("tcard-full"))[0]!;
const step = (o: Partial<StepOpen> = {}): StepOpen => ({ kind: "prompt", key: "a", asker: "a", command: "! ls", ...o });

test("an accepted answer's step opens the terminal card in the layer: the card mode, the connection of the terminal without a full terminal, the unit that asked named, and nothing leaves Zen", async () => {
	const r = await shown();
	r.z.step(step());
	await r.settle();
	assert.equal(r.layer()!.getAttribute("data-mode"), "card");
	assert.ok(cardOf(r), "the card is in the layer");
	assert.ok(r.layer()!.contains(cardOf(r)), "inside the layer's host");
	assert.deepEqual([r.calls.embeds, r.calls.watches.map((x) => [x.key, x.name]), r.calls.leave], [[], [["a", "ops-main"]], []], "no full terminal, one connection, Standard never visited");
	assert.equal(r.stage().getAttribute("inert"), "", "what is under takes no focus");
	assert.ok(r.root.dump().includes("! ls"), "the command the dialog put there");
	assert.equal(r.root.dump().includes(m.card_full()), true, "and the way to the full terminal");
});

test("a pane's step is named for the unit that asked, not 'Herdr pane', and a newer step replaces the card and lets go of the old connection", async () => {
	const r = await shown();
	r.z.step(step({ kind: "pane", key: "grant:g1", command: "sudo apt update" }));
	await r.settle();
	assert.deepEqual(r.calls.watches.map((x) => [x.key, x.name]), [["grant:g1", "ops-main"]]);
	assert.equal(r.root.dump().includes(m.pane_name()), false);
	r.z.step(step({ kind: "pane", key: "grant:g2" }));
	await r.settle();
	assert.deepEqual([r.calls.stops, r.calls.watches.map((x) => x.key), r.root.all((e) => (e.getAttribute("class") ?? "").includes("zen-term")).filter((e) => e.tagName === "section").length], [["grant:g1"], ["grant:g1", "grant:g2"], 1], "one layer, the old connection let go");
});

test("a prompt's card is over when its own Enter is taken and by no mark sequence: the line, the card put out; its mirror ending stays and says why; a pane's is over when the pane is gone", async () => {
	const r = await shown();
	r.z.step(step());
	await r.settle();
	for (const n of [net([unit("a", "working", { name: "ops-main" })]), idle(), net([unit("a", "waiting", { name: "ops-main", since: 9 })]), idle(), net([unit("a", "working", { name: "ops-main" })])]) r.feed(n);
	assert.ok(r.layer(), "the demo's working session: no mark sequence returns a prompt's card");
	r.calls.watches[0]!.w.end();
	assert.ok(r.layer(), "the session left its pane: the boss reads why");
	r.calls.watches[0]!.w.taken();
	await r.settle();
	assert.equal(noteOf(r), m.zen_term_sent(), "its own Enter, taken: the bar says so");
	assert.deepEqual([Boolean(r.layer()), r.calls.stops, r.calls.leave], [true, [], []], "and the layer is still there until the drift");
	assert.equal(cardOf(r)!.getAttribute("inert"), "", "the card is put out: another Run would only send another Enter");
	r.back()!.click();
	assert.deepEqual([r.layer(), r.calls.stops], [undefined, ["a"]], "the boss's Back to Zen ends it");
	const p = await shown();
	p.z.step(step({ kind: "pane", key: "grant:g1" }));
	await p.settle();
	p.calls.watches[0]!.w.taken();
	assert.ok(p.layer(), "an Enter taken does not end a pane's card: a password is followed by more prompts");
	p.calls.watches[0]!.w.end();
	await p.settle();
	assert.deepEqual([Boolean(p.layer()), p.calls.stops, noteOf(p)], [true, [], m.zen_term_gone()], "the pane closed: the layer stays and says so");
});

test("boss 2026-11-26 「輸入完指令，應該逐漸恢復到呼吸」: a step that is over drifts back to Zen: the line shows, the layer fades, the breath comes back; a terminal opened to look at never drifts", async () => {
	const r = await shown();
	r.z.step(step());
	await r.settle();
	r.calls.watches[0]!.w.taken();
	await r.settle();
	await r.advance(DRIFT_MS - 1);
	assert.deepEqual([Boolean(r.layer()), r.layer()!.dataset.leaving, noteOf(r)], [true, undefined, m.zen_term_sent()], "the line shows first");
	await r.advance(1);
	assert.equal(r.layer()!.dataset.leaving, "", "then the layer fades");
	await r.advance(FADE_MS);
	assert.deepEqual([r.layer(), r.calls.stops, r.calls.leave], [undefined, ["a"], []], "and Zen has the page again: the terminal is let go, Zen is not left");
	const p = await shown();
	p.z.terminal({ key: "grant:g1" });
	await p.settle();
	p.calls.embeds[0]!.end!();
	await p.advance(DRIFT_MS);
	await p.advance(FADE_MS);
	assert.deepEqual([p.layer(), p.calls.off], [undefined, ["grant:g1"]], "a pane gone drifts back too");
	const a = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5 })]));
	a.z.terminal({ key: "a", armed: true });
	await a.settle();
	a.feed(net([unit("a", "working", { name: "ops-main" })]));
	await a.advance(DRIFT_MS);
	await a.advance(FADE_MS);
	assert.equal(a.layer(), undefined, "an armed terminal's unit at work drifts back too");
	const look = await shown();
	look.z.terminal({ key: "a" });
	await look.settle();
	look.feed(net([unit("a", "working", { name: "ops-main" })]));
	await look.advance(60_000);
	assert.ok(look.layer(), "a terminal opened to look at has no step: it stays until the boss goes back");
});

test("the drift keeps the layer for a boss who uses it (Z-D20): a tap or a key in it before the fade, or during the fade, keeps it until Back to Zen", async () => {
	for (const [when, type] of [[0, "pointerdown"], [DRIFT_MS, "keydown"], [DRIFT_MS, "wheel"]] as const) {
		const r = await shown();
		r.z.terminal({ key: "a", armed: true });
		await r.settle();
		r.feed(net([unit("a", "working", { name: "ops-main" })]));
		await r.advance(when);
		sinkOf(r).bubble(type, { key: "x" });
		await r.advance(DRIFT_MS);
		await r.advance(FADE_MS);
		assert.deepEqual([Boolean(r.layer()), r.layer()?.dataset.leaving, noteOf(r)], [true, undefined, m.zen_term_working()], `${type} at ${when} ms keeps it, unfaded`);
		r.back()!.click();
		assert.equal(r.layer(), undefined, "Back to Zen still ends it");
	}
	const n = await shown();
	n.z.step(step());
	await n.settle();
	n.calls.watches[0]!.w.taken();
	await n.settle();
	n.z.terminal({ key: "b" });
	await n.settle();
	await n.advance(DRIFT_MS);
	await n.advance(FADE_MS);
	assert.ok(n.layer(), "another terminal replaced the finished one: the old drift does not close the new layer");
});

test("ZNR-F003: the card of a step that is over no longer says the command waits: it says it was sent, as the bar does", async () => {
	const r = await shown();
	r.z.step(step());
	await r.settle();
	const card = () => cardOf(r)!;
	assert.ok(card().textContent.includes(m.card_waits({ name: "ops-main" })), "before the Enter: the command waits");
	r.calls.watches[0]!.w.taken();
	await r.settle();
	assert.equal(noteOf(r), m.zen_term_sent());
	assert.equal(card().textContent.includes(m.card_waits({ name: "ops-main" })), false, "the put-out card does not say the command waits");
	assert.ok(card().textContent.includes(m.card_sent()), "it says what the bar says: sent");
	const wait = card().all((el) => el.getAttribute("class") === "tcard-wait")[0]!;
	assert.equal(wait.hidden, true, "the waiting line is not drawn at all");
});

test("Esc in card mode is the layer's two-press, there being no terminal to keep it; Back to Zen returns", async () => {
	const r = await shown();
	r.z.step(step());
	await r.settle();
	let pressed = 0;
	for (const on of cardOf(r)!.handlers.keydown ?? []) on({ key: "Escape", isComposing: false, preventDefault: () => void pressed++ });
	assert.deepEqual([pressed, Boolean(r.layer())], [0, true], "the card itself takes no Esc: the layer owns it");
	assert.deepEqual(r.esc(), { took: true, prevented: 1 });
	assert.ok(r.text().includes(m.zen_term_esc_hint()));
	await r.advance(200);
	r.esc();
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.stops], [undefined, ["a"]]);
	const b = await shown();
	b.z.step(step());
	await b.settle();
	b.back()!.click();
	assert.deepEqual([b.layer(), b.calls.stops], [undefined, ["a"]]);
});

test("the card's Full terminal link turns the layer to full mode in place: the full terminal joins the card's connection (one attach, no detach), and the step's rule goes with it", async () => {
	const r = await shown();
	r.z.step(step());
	await r.settle();
	fullLink(r).click();
	await r.settle();
	assert.equal(r.layer()!.getAttribute("data-mode"), "full");
	assert.deepEqual([r.calls.embeds.map((e) => [e.key, e.keys]), r.calls.attaches, r.calls.detaches, r.calls.stops, cardOf(r)], [[["a", true]], ["a"], [], ["a"], undefined], "one attach for the card and the full terminal; the card let go only after the terminal joined");
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	r.feed(idle());
	assert.ok(r.layer(), "no mark returns a prompt's full terminal either");
	assert.equal(noteOf(r), "");
	r.calls.embeds[0]!.end!();
	assert.ok(r.layer(), "nor does the session's mirror ending");
	r.calls.embeds[0]!.taken!();
	await r.settle();
	assert.deepEqual([Boolean(r.layer()), r.calls.off, noteOf(r)], [true, [], m.zen_term_sent()], "an Enter from the pad or sink, taken: the bar says so and the layer stays");
	const p = await shown();
	p.z.step(step({ kind: "pane", key: "grant:g1" }));
	await p.settle();
	fullLink(p).click();
	await p.settle();
	p.calls.embeds[0]!.taken!();
	assert.ok(p.layer(), "a pane's full terminal is not over by an Enter");
	p.calls.embeds[0]!.end!();
	assert.ok(p.layer(), "the pane is gone: the layer stays");
	assert.equal(noteOf(p), m.zen_term_gone());
	p.back()!.click();
	assert.deepEqual([p.calls.attaches, p.calls.detaches], [["grant:g1"], ["grant:g1"]]);
});

test("an Open the terminal button's full terminal is armed: the unit's first work is the step's end, which the bar says; the layer stays, and the card's own kind is not changed by it", async () => {
	const r = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5 })]));
	r.z.terminal({ key: "a", armed: true });
	await r.settle();
	assert.equal(r.layer()!.getAttribute("data-mode"), "full");
	assert.deepEqual([r.calls.watches, r.calls.embeds.length], [[], 1], "straight to the full terminal, with no card");
	r.feed(idle());
	assert.ok(r.layer());
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.ok(r.layer());
	assert.equal(noteOf(r), m.zen_term_working());
});

test("a held tower's card shows the sentence and attaches nothing until a run is live, and stands by again with the sentence", async () => {
	const tower = (mark: Mark, service: object): Net => { const n = net([]); n.bases[0]!.tower = { name: "tower", mark, key: "a", control: true, subs: [], service } as never; return n; };
	const standing = () => tower("idle", { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] });
	const running = () => tower("working", { state: "running", queued: 0, allyRuns: [], notices: [], parked: [], run: { id: "r1", kind: "local", startedAt: "" } });
	const r = await shown(standing());
	r.z.step(step());
	await r.settle();
	const watched = () => r.calls.watches.map((x) => x.key);
	assert.deepEqual(watched(), [], "nothing to attach to");
	assert.ok(r.text().includes(termHold({ state: "standing" } as never)!));
	r.feed(running());
	await r.settle();
	assert.deepEqual(watched(), ["a"], "the run is live: the connection");
	assert.equal(r.text().includes(termHold({ state: "standing" } as never)!), false);
});

test("a step asked for while Zen is not shown is not drawn", async () => {
	const r = rig();
	r.z.step(step());
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.watches.length], [undefined, 0]);
});

test("on a phone the focus moves into the layer for a card too (Back to Zen); on a desktop the card takes it", async () => {
	const g = globalThis as { matchMedia?: unknown }, was = g.matchMedia;
	try {
		g.matchMedia = () => ({ matches: false });
		const phone = await shown();
		phone.z.step(step({ kind: "pane", key: "grant:g1" }));
		await phone.settle();
		assert.equal(page.activeElement, phone.back());
		g.matchMedia = () => ({ matches: true });
		const desk = await shown();
		desk.z.step(step({ kind: "pane", key: "grant:g1" }));
		await desk.settle();
		assert.ok(cardOf(desk)!.contains(page.activeElement), "the card's line");
	} finally {
		g.matchMedia = was;
	}
});

const click = (el: El) => (el.onclick as unknown as (e: object) => void)({ isTrusted: true });
const goOf = (r: ReturnType<typeof rig>) => r.root.all((el) => (el.getAttribute("class") ?? "").split(" ").includes("tcard-go"))[0]!;

test("the card in the layer writes to the terminal it shows: a pane's keys go to its grant and a prompt's to the session, never to the unit that asked, and the watch names the same key", async () => {
	const p = await shown();
	p.z.step(step({ kind: "pane", key: "grant:g1", asker: "a" }));
	await p.settle();
	click(goOf(p));
	await p.settle();
	assert.deepEqual(p.calls.posts.map((x) => [x.key, x.action]), [["grant:g1", "keys"]]);
	assert.equal(p.calls.watches[0]!.key, "grant:g1");
	const r = await shown();
	r.z.step(step({ key: "sess", asker: "a" }));
	await r.settle();
	click(goOf(r));
	await r.settle();
	assert.deepEqual(r.calls.posts.map((x) => x.key), ["sess"]);
	assert.equal(r.calls.watches[0]!.key, "sess");
});

test("a card the layer let go of says nothing more: its late reply does not close the layer that stands now", async () => {
	const r = await shown();
	r.z.step(step());
	await r.settle();
	click(goOf(r));
	r.z.step(step({ kind: "pane", key: "grant:g1" }));
	await r.settle();
	assert.ok(r.layer(), "the pane's layer stands after the old Enter was taken");
});

test("the card in the layer of a unit on an unreachable or ended remote base is off with the reason, and follows the snapshots back to live", async () => {
	const remote = (state: string): Net => { const n = item(); (n.bases[0] as unknown as { box: object }).box = { state, can: ["input"] }; return n; };
	const p = await shown(remote("unreachable"));
	p.z.step(step());
	await p.settle();
	assert.ok((goOf(p) as unknown as { disabled: boolean }).disabled, "Run is off");
	assert.ok(p.text().includes(m.box_keys_blocked()));
	click(goOf(p));
	await p.settle();
	assert.equal(p.calls.posts.length, 0, "nothing reaches the box");
	p.feed(remote("live"));
	await p.settle();
	assert.ok(!(goOf(p) as unknown as { disabled: boolean }).disabled, "back with the box");
	const l = await shown();
	l.z.step(step());
	await l.settle();
	assert.ok(!(goOf(l) as unknown as { disabled: boolean }).disabled, "a local base is unchanged");
});

test("BR-F006: Zen mounts a box's unit's answer panel as a remote page's, with the pane choice refused; a local unit's with neither", async () => {
	const mounted: unknown[][] = [];
	spy.ask = (args) => void mounted.push(args);
	try {
		const local = item(), box = item();
		box.bases[0]!.box = { device: "d", short: "s", label: "box", team: "A", scope: "team", can: ["input"], state: "live" };
		for (const n of [box, local]) await shown(n);
		assert.equal(mounted.length, 2);
		assert.equal((mounted[0]![6] as () => boolean)(), true, "a box's unit");
		assert.equal((mounted[1]![6] as () => boolean)(), false, "a local unit: the pane choice is open");
	} finally {
		spy.ask = undefined;
	}
});
