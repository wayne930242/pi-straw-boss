import assert from "node:assert/strict";
import { test } from "node:test";
import { BOSS_MARK } from "../src/eventmarks.ts";
import type { Item } from "../src/items.ts";
import type { Mark } from "../src/netdata.ts";
import type { HeadUnit } from "../src/nethead.ts";
import type { Net, TowerService, Unit } from "../src/net.ts";
import { alertsOf } from "../gui/alerts.ts";
import type { Chat, HistoryEvent } from "../gui/chat.ts";
import type { Answer } from "../gui/post.ts";
import { joined } from "../gui/asks.ts";
import { quietForwards } from "../gui/zenhead.ts";
import { hotkeyOf } from "../gui/hotkeys.ts";
import "../gui/zenrows.ts"; // the Zen chunk registers the Zen rows
import { El, page } from "./fake-dom.ts";
import { noun } from "../gui/nouns.ts";

// The strip under Zen's circle, as the page drives it (docs/specs/2026-11-04-head-tower.md, Zen: the strip under the circle): the last lines of the head's conversation fading, the folded input that unfolds on a click or
// Enter, what a send and a refusal do, the draft that holds the screen, the history as a companion, and the keys. The layer is the real one on the fake document; the log and the composer are stand-ins that record.
const { mountZen, real } = await import("../gui/zen.ts");
const { CLEAR_MS, FADE_MS, FILL } = await import("../gui/headlines.ts");
const { LET_GO_MS } = await import("../gui/zenhead.ts");
const { entriesOf } = await import("../gui/paletteentries.ts");
const { m } = await import("../gui/paraglide/messages.js");

const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 9, min)).toISOString();
const bossLine = (id: string, text: string, min = 0): Item => ({ id, kind: "notice", type: "straw-tower", event: "boss", text: `${BOSS_MARK}\n${text}`, at: at(min) });
const headLine = (id: string, text: string, min = 0): Item => ({ id, kind: "assistant", text, at: at(min) });
const service = (o: Partial<TowerService> = {}): TowerService => ({ state: "running", queued: 0, notices: [], parked: [], allyRuns: [], ...o });
const head = (o: Partial<HeadUnit> = {}): HeadUnit => ({ key: "sb-head", name: "head tower", mark: "idle", state: "running", service: service(), asks: [], ...o });
const waiting = (): Unit => ({ id: "a", key: "a", control: true, name: "ops-main", role: "main", mark: "waiting" as Mark, since: 5, subs: [], pending: { callId: "c1", tool: "robot_hand", answer: { dialog: "d1", digest: "0".repeat(64), select: { title: "Deploy", choices: [{ label: "Yes" }, { label: "No" }] } } } } as Unit);
const net = (h?: HeadUnit, units: Unit[] = []): Net => ({ bases: units.length ? [{ id: "w", label: "Harbor", mark: "idle", tower: null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }] : [], trust: [], ...(h ? { head: h } : {}) }) as Net;

function rig(o: { head?: HeadUnit | null; items?: Item[]; offline?: boolean; music?: unknown; reply?: (action: string, body: Record<string, unknown>) => Promise<Answer> } = {}) {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = { sound: [] as string[], leave: [] as unknown[], watch: [] as (string | null)[], posts: [] as { key: string; action: string; body: Record<string, unknown> }[], composers: [] as { key: string; box: El }[], logs: [] as string[], applied: [] as HistoryEvent[] };
	let items = o.items ?? [];
	const mounts = {
		...real,
		composer: ((root: El, key: string) => {
			const box = new El("textarea");
			root.replaceChildren(box);
			calls.composers.push({ key, box });
			return { box, update() {} };
		}) as never,
		chat: async () => (_root: El, _data: unknown, _deps: unknown) => (calls.logs.push("mounted"), { apply: (e: HistoryEvent) => calls.applied.push(e), setLive() {}, reveal() {}, box() {} } as unknown as Chat),
	};
	const deps = {
		data: (key: string) => ({ older: async () => ({ items: [] }), latest: async () => ({ items: key === "sb-head" ? items : [] }), entry: async () => undefined }),
		recent: async () => [],
		post: (key: string) => (action: string, body: Record<string, unknown>) => (calls.posts.push({ key, action, body }), (o.reply ?? (async () => ({ ok: true, status: 200, body: { accepted: true } })))(action, body)),
		label: (ws: string) => ws, online: () => !o.offline, remote: false, remind() {}, sound: (s: string) => void calls.sound.push(s), leave: (e: unknown) => void calls.leave.push(e),
		terminals: async () => ({}), watch: (key: string | null) => void calls.watch.push(key), start: () => undefined,
		fs: { doc: { addEventListener() {}, documentElement: {} }, standalone: () => false, touch: () => false, seen: { getItem: () => "1", setItem() {} }, later: () => () => {} },
		still: () => false, random: () => 0, now: () => t,
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			timers.push(e);
			return () => void (timers.includes(e) && timers.splice(timers.indexOf(e), 1));
		},
	};
	const root = new El("section");
	page.body.replaceChildren(root);
	[page.focused, page.hidden, page.focus] = [undefined, false, true];
	const z = mountZen(root as unknown as HTMLElement, (o.music ? { ...deps, music: o.music } : deps) as never, mounts as never);
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
	const by = (cls: string) => root.all((el) => el.classes.has(cls));
	const r = {
		z, root, calls, advance, settle, now: () => t, by,
		feed: (n: Net) => z.net(alertsOf(n, t), n),
		put: (next: Item[]) => ((items = next), z.history({ key: "sb-head", reset: true, items: next })),
		strip: () => by("zen-head")[0],
		lines: () => by("zen-hl").map((el) => el.textContent),
		hint: () => by("zen-head-hint")[0]!,
		form: () => by("zen-head-form")[0]!,
		box: () => by("zen-head-box")[0]!,
		note: () => by("zen-head-note")[0]!.textContent,
		mind: () => by("zen-line")[0],
		/** Whether the mindfulness line is faded away (zen.css `data-away`): it is never taken out of the layout. */
		away: () => by("zen-line")[0]?.dataset.away !== undefined,
		start: async (n: Net | undefined = net(o.head === null ? undefined : (o.head ?? head()))) => (n && r.feed(n), z.show(), await settle()),
		/** A Zen key as the page routes it: the keymap's row for the face, then the layer's answer (hotkeys.ts, pagecore.ts). */
		press: (key: string, target: unknown = undefined, extra: object = {}) => {
			const hot = hotkeyOf({ key, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target, ...extra }, false, false, "zen");
			return hot ? z.key(hot) : false;
		},
		/** Types into the box as a keyboard does and presses a key in it. */
		typed: (text: string) => { r.box().value = text; r.box().bubble("input"); },
		enter: (extra: object = {}) => r.box().bubble("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...extra }),
		unfold: () => r.hint().click(),
		/** H on a strip at rest: the lines come back (and nothing else when there are none: H then opens the history). */
		wake: () => (r.strip()?.dataset.hushed !== undefined && r.lines().length > 0 ? r.z.key("history") : false),
		esc: () => z.escape({ preventDefault() {} }),
	};
	return r;
}

test("the Whole conversation link names its key: the words, then \"· H\" in a span of its own (zen.css quiets it and hides it with no keyboard), in both languages", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start();
	const link = r.by("zen-head-history")[0]!, key = r.by("zen-head-key");
	assert.equal(key.length, 1);
	assert.equal(key[0]!.textContent, m.zen_head_key());
	assert.equal(key[0]!.textContent, "· H");
	assert.equal(link.textContent, `${m.zen_head_history()} · H`, "one link: the words and the key, as the input's hint names Enter");
	assert.equal(link.getAttribute("aria-keyshortcuts"), "H");
	assert.equal(key[0]!.getAttribute("aria-hidden"), "true", "aria-keyshortcuts names the key, so the span is not read a second time as \"middle dot H\"");
	assert.equal(key[0]!.parent, link, "the key is inside the link: one control, one target");
});

test("under the circle stand the mindfulness line and the folded input with its hint; the stream watches the head, nothing else is on show", async () => {
	const r = rig();
	await r.start();
	assert.equal(r.by("zen-circle").length, 1);
	assert.equal(r.away(), false, "a fresh head has no lines: the mindfulness line shows, as before");
	assert.equal(r.hint().textContent, "Enter to talk to the head tower");
	assert.equal(r.hint().tagName, "button", "the folded input is one control");
	assert.equal(r.form().hidden, true, "the box is folded");
	assert.deepEqual(r.lines(), []);
	assert.equal(r.calls.watch.at(-1), "sb-head", "the stream watches the head while the strip shows");
});

test("the strip keeps the lines in order, the newest last, and the whole text is in the line (the page clamps it, and shows as many as fit: three while quiet, zen.css); the mindfulness line stays away while any is clear", async () => {
	const r = rig({ items: [bossLine("u1", "first", 1), headLine("a1", "second", 2), bossLine("u2", "third", 3), headLine("a2", "fourth\nwith a second line", 4)] });
	await r.start();
	await r.settle();
	assert.equal(r.wake(), true, "a visit starts at rest: H calls the lines up");
	assert.deepEqual(r.lines(), ["first", "second", "third", "fourth with a second line"]);
	assert.deepEqual(r.by("zen-hl").map((el) => el.getAttribute("data-who")), ["boss", "head", "boss", "head"]);
	assert.deepEqual(r.by("zen-hl").map((el) => el.getAttribute("data-rank")), ["3", "2", "1", "0"], "rank 0 is the newest");
	assert.equal(r.away(), true, "one thing is in paper at a time (Z-D15)");
});

test("the page keeps FILL lines, not three: a long conversation hands the awake strip the oldest lines it has room for, and each line carries its rank for the page's newest-first layout (--rank)", async () => {
	const long: Item[] = Array.from({ length: 30 }, (_, i) => (i % 2 ? headLine(`a${i}`, `reply ${i}`, i + 1) : bossLine(`u${i}`, `question ${i}`, i + 1)));
	const r = rig({ items: long });
	await r.start();
	await r.settle();
	r.wake();
	assert.equal(FILL, 24);
	assert.deepEqual(r.lines(), long.slice(-FILL).map((_, i) => (i + 30 - FILL) % 2 ? `reply ${i + 30 - FILL}` : `question ${i + 30 - FILL}`), "the newest 24, oldest first");
	assert.deepEqual(r.by("zen-hl").map((el) => el.style["--rank"]), Array.from({ length: FILL }, (_, i) => String(FILL - 1 - i)), "the rank is what `order` sorts by: newest first from the strip's foot");
	assert.deepEqual(r.by("zen-hl").map((el) => el.getAttribute("data-rank")), Array.from({ length: FILL }, (_, i) => String(FILL - 1 - i)));
});

test("a later page that carries older head lines than the strip first held reads none of them out: only the newest three are news, as before the strip kept 24", async () => {
	const turn = (i: number): Item[] => [bossLine(`u${i}`, `ask ${i}`, i * 2), headLine(`a${i}`, `answer ${i}`, i * 2 + 1)];
	const r = rig({ items: [3, 4, 5].flatMap(turn) });
	await r.start();
	await r.settle();
	const live = () => r.by("zen-head-live")[0]!.textContent;
	r.put([0, 1, 2, 3, 4, 5].flatMap(turn));
	await r.settle();
	assert.equal(r.by("zen-hl").length, 12, "the older turns are on the page");
	assert.equal(live(), "", "nothing read out: the newer lines were known, and the older ones are history");
	r.put([0, 1, 2, 3, 4, 5, 6].flatMap(turn));
	await r.settle();
	assert.equal(live(), "answer 6", "a new reply still is");
});

test("the strip fills the page while the boss has it awake (data-fill): not at rest, not once every line has faded, back with the open input (a hover only sends the mindfulness line away), gone with Esc and with the next visit (Z-D21)", async () => {
	const r = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "ok", 2)] });
	const fill = () => r.strip()!.dataset.fill !== undefined;
	await r.start();
	await r.settle();
	assert.equal(fill(), false, "a visit starts at rest: the page is as it was");
	assert.equal(r.away(), false);
	r.wake();
	assert.equal(fill(), true, "called back: the lines take the mindfulness line's room and the circle's spare height");
	assert.equal(r.away(), true, "the two are never both on: fill is the mindfulness line's absence");
	assert.equal(r.esc(), true);
	assert.equal(fill(), false, "Esc rests the strip, and the page goes back as it was");
	assert.equal(r.away(), false);
	r.wake();
	assert.equal(fill(), true);
	await r.advance(CLEAR_MS + FADE_MS + 20);
	assert.equal(fill(), false, "every line faded: the mindfulness line is back and the page with it");
	assert.equal(r.away(), false);
	r.strip()!.bubble("pointerenter", { pointerType: "mouse" });
	assert.equal(fill(), false, "a hover lifts the faded lines but never moves the page under the pointer (ZHF-F001)");
	assert.equal(r.strip()!.dataset.bright !== undefined, true);
	r.strip()!.bubble("pointerleave", { pointerType: "mouse" });
	await r.advance(LET_GO_MS + 20);
	assert.equal(fill(), false, "and nothing moves when the pointer goes either");
	r.strip()!.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(fill(), false, "a tap lifts the lines but does not fill either");
	r.wake();
	r.unfold();
	assert.equal(fill(), true, "the open input holds the lines clear, and the room");
	r.z.hide();
	assert.equal(fill(), false, "the next visit starts at rest, as the page does");
});

test("a line is clear for 20 s from the moment it is first on screen, then fades over 3 minutes; the mindfulness line comes back only when every line has", async () => {
	const r = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "ok", 2)] });
	await r.start();
	await r.settle();
	r.wake();
	const delays = () => r.by("zen-hl").map((el) => el.style.animationDelay);
	assert.deepEqual(delays(), [`${CLEAR_MS / 1000}s`, `${CLEAR_MS / 1000}s`], "clear for 20 s, then the one CSS animation of opacity; no timer repaints");
	await r.advance(CLEAR_MS + FADE_MS - 1);
	assert.equal(r.away(), true);
	await r.advance(20); // the timer carries a little slack
	assert.equal(r.away(), false, "all at rest: the mindfulness line is back");
	r.put([bossLine("u1", "go", 1), headLine("a1", "ok", 2), bossLine("u2", "and again", 3), headLine("a2", "a new one", 4)]);
	await r.settle();
	assert.equal(r.away(), true, "a new line starts clear, whatever the time of its item");
	const [, , fresh] = r.by("zen-hl");
	assert.equal(fresh!.style.animationDelay, `${CLEAR_MS / 1000}s`);
});

test("when fill turns on after the lines faded, every line carries on from its age, not from the stale delay it had when it was hidden (ZHF-F002)", async () => {
	const r = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "ok", 2)] });
	await r.start();
	await r.settle();
	r.wake();
	await r.advance(CLEAR_MS + FADE_MS + 20);
	assert.equal(r.strip()!.dataset.fill, undefined);
	r.put([bossLine("u1", "go", 1), headLine("a1", "ok", 2), bossLine("u2", "and again", 3), headLine("a2", "a new one", 4)]);
	await r.settle();
	assert.notEqual(r.strip()!.dataset.fill, undefined);
	const [old1, old2] = r.by("zen-hl").map((el) => el.style.animationDelay);
	assert.notEqual(old1, `${CLEAR_MS / 1000}s`, "the old line's delay is its age's");
	assert.notEqual(old2, `${CLEAR_MS / 1000}s`);
});

test("a click on the hint unfolds the input, focused; Enter on the circle does the same when no control has the focus, and nothing else on the keyboard does", async () => {
	const r = rig();
	await r.start();
	assert.equal(r.press(" "), false, "Space is not Enter: it ends a pause, and there is none");
	assert.equal(r.press("a"), false, "typing anything else while it is folded does nothing");
	assert.equal(r.form().hidden, true);
	assert.equal(r.press("Enter", r.hint()), false, "a focused control keeps its own Enter (the button's click does it)");
	assert.equal(r.press("Enter"), true);
	assert.equal(r.form().hidden, false);
	assert.equal(r.hint().hidden, true, "the hint gives way to the box");
	assert.equal(page.focused, r.box(), "focused");
	assert.equal(r.box().getAttribute("placeholder"), "Tell the head tower what to do");
	const again = rig();
	await again.start();
	again.unfold();
	assert.equal(again.form().hidden, false, "a click unfolds it too");
});

test("a mouse click on the hint, which Chrome focuses first, still unfolds the input: the hint's own focusout when it gives way to the box folds nothing", async () => {
	const r = rig();
	await r.start();
	r.hint().focus();
	r.unfold();
	r.hint().bubble("focusout"); // Chrome: the focused hint became hidden, and it reports the blur with no related target
	assert.equal(r.form().hidden, false, "still unfolded");
	assert.equal(page.focused, r.box(), "and focused");
});

test("Enter sends the text to the head's input as a send; Shift+Enter, an Enter that belongs to an input method, and an empty box send nothing", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.enter();
	assert.deepEqual(r.calls.posts, [], "an empty box sends nothing");
	r.typed("tell Harbor to fix the rounding");
	r.enter({ shiftKey: true });
	r.enter({ isComposing: true });
	r.enter({ keyCode: 229 });
	assert.deepEqual(r.calls.posts, []);
	r.enter();
	await r.settle();
	assert.deepEqual(r.calls.posts, [{ key: "sb-head", action: "input", body: { text: "tell Harbor to fix the rounding", as: "send" } }]);
});

test("a sent message shows at once as the boss's line; the box empties and stays open; the stream's copy of it takes the place of the local one", async () => {
	const r = rig({ items: [headLine("a1", "Ready.", 1)] });
	await r.start();
	r.unfold();
	r.typed("start MP-4129");
	r.enter();
	assert.equal(r.box().value, "", "emptied");
	assert.deepEqual(r.lines(), ["Ready.", "start MP-4129"], "his line, at once, before any answer");
	assert.equal(r.by("zen-hl").at(-1)!.getAttribute("data-who"), "boss");
	await r.settle();
	assert.equal(r.form().hidden, false, "the box stays open");
	r.put([headLine("a1", "Ready.", 1), bossLine("u9", "start MP-4129", 2)]);
	await r.settle();
	assert.deepEqual(r.lines(), ["Ready.", "start MP-4129"], "not twice");
});

test("a refusal shows the server's words under the box with the low bowl, takes the line back, and the draft stays; no answer at all says it could not reach the server", async () => {
	const r = rig({ reply: async () => ({ ok: false, status: 409, body: { error: "refused", reason: "The head tower is busy." } }) });
	await r.start();
	r.unfold();
	r.typed("do it");
	r.enter();
	await r.settle();
	assert.equal(r.note(), "The head tower did not take it: the head tower is busy.");
	assert.equal(r.box().value, "do it", "the draft stays");
	assert.deepEqual(r.calls.sound, ["low"]);
	assert.deepEqual(r.lines(), [], "his line is taken back");
	const down = rig({ reply: async () => Promise.reject(new Error("net")) });
	await down.start();
	down.unfold();
	down.typed("again");
	down.enter();
	await down.settle();
	assert.equal(down.note(), "Could not reach the server");
	assert.equal(down.box().value, "again");
	down.typed("again, more");
	assert.equal(down.note(), "", "typing clears the words");
});

test("Esc folds the input and does nothing else; the draft is kept for this visit and is there at the next unfold; an empty box folds when it loses the focus, one with text does not", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.typed("half a thought");
	assert.equal(r.esc(), true);
	assert.equal(r.form().hidden, true, "folded");
	assert.equal(r.calls.leave.length, 0, "and nothing else: no hint, no leaving");
	assert.equal(r.by("zen-esc")[0]?.textContent, "", "the quiet line did not show");
	r.unfold();
	assert.equal(r.box().value, "half a thought", "the draft came back");
	r.typed("");
	r.box().blur();
	assert.equal(r.form().hidden, true, "a blur with an empty box folds it");
	r.unfold();
	r.typed("kept");
	r.box().blur();
	assert.equal(r.form().hidden, false, "a blur with text folds nothing");
});

test("Zen hiding drops the draft, and every visit starts at the circle with the input folded", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.typed("secret draft");
	r.z.hide();
	r.z.show();
	await r.settle();
	assert.equal(r.form().hidden, true);
	r.unfold();
	assert.equal(r.box().value, "", "the draft did not survive hiding");
});

test("while the stream is down the box is disabled and says why; it comes back with the stream", async () => {
	const r = rig({ offline: true });
	await r.start();
	r.unfold();
	assert.equal(r.box().disabled, true);
	assert.equal(r.note(), "offline");
	const ok = rig();
	await ok.start();
	ok.unfold();
	assert.equal(ok.box().disabled, false);
});

test("with no tower service the folded line says so and does not unfold; before the first snapshot there is no strip", async () => {
	const r = rig({ head: null });
	await r.start();
	assert.equal(r.hint().textContent, "The head tower needs the tower service (towerRuns)");
	assert.equal(r.hint().disabled, true);
	r.unfold();
	assert.equal(r.press("Enter"), false);
	assert.equal(r.form().hidden, true);
	assert.equal(r.calls.watch.at(-1), null, "nothing to watch");
	const none = rig();
	none.z.show();
	await none.settle();
	assert.equal(none.strip()!.hidden, true, "no snapshot yet: the strip is not drawn");
});

test("an item takes the screen from the strip on Enter (Z-D19) and the stream stops watching the head; what the head says meanwhile changes nothing until the circle is back, where the new line starts clear", async () => {
	const r = rig({ items: [headLine("a1", "old words", 1)] });
	await r.start();
	await r.advance(CLEAR_MS + FADE_MS + 20);
	assert.equal(r.away(), false, "at rest");
	r.feed(net(head(), [waiting()]));
	await r.settle();
	assert.equal(r.by("zen-card").length, 0, "the item waits: it does not take the screen by itself");
	assert.equal(r.by("zen-head").length, 1, "the strip stays");
	assert.equal(r.press("Enter"), true, "Enter takes it, not the head's input");
	await r.settle();
	assert.equal(r.by("zen-head").length, 0, "the card replaced the strip");
	assert.equal(r.calls.watch.at(-1), null, "nothing watches the head now");
	r.z.history({ key: "sb-head", reset: true, items: [headLine("a1", "old words", 1), bossLine("u2", "more", 4), headLine("a2", "new words", 5)] });
	assert.equal(r.root.textContent.includes("new words"), false, "the reply changes nothing on the card");
	r.feed(net(head())); // the question ended: the card stays until the boss closes it (Z-D20)
	await r.advance(5000);
	assert.equal(r.by("zen-card").length, 1, "the card stays");
	assert.equal(r.press("Enter"), true, "Enter closes it: the pause, then the circle");
	await r.advance(5000);
	assert.equal(r.calls.watch.at(-1), "sb-head", "back at the circle the stream watches the head again");
	assert.ok(r.lines().includes("new words"));
	assert.equal(r.by("zen-hl").at(-1)!.style.animationDelay, `${CLEAR_MS / 1000}s`, "clear again");
	assert.ok(r.by("zen-hl")[0]!.style.animationDelay.startsWith("-"), "an old line carries on from where it was: its animation starts with a negative delay");
});

test("a card does not interrupt the boss writing to the head: it waits for Enter however long the draft is; the draft is kept, and the cue says one waits", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.typed("writing to the head");
	r.root.bubble("keydown", { key: "x" });
	r.feed(net(head(), [waiting()]));
	await r.advance(60_000 * 3);
	assert.equal(r.by("zen-card").length, 0, "the item waits");
	assert.equal(r.box().value, "writing to the head", "the draft stays");
	assert.equal(cueOf(r), "1 card waits for Enter. No rush, when you're ready.");
	await r.enter();
	assert.equal(r.box().value, "", "Enter in the box is the box's: it sent the message");
	assert.equal(r.by("zen-card").length, 0);
	const quiet = rig({ items: [headLine("a0", "from before", 1)] });
	await quiet.start();
	await quiet.settle();
	assert.equal(quiet.by("zen-head-live")[0]!.textContent, "", "the lines that were already there are not announced");
});

test("while the head runs the lines say it is on it, with no spinner, and the live region says its next reply once", async () => {
	const r = rig({ head: head({ mark: "working" }) });
	await r.start();
	assert.equal(r.by("zen-head-working")[0]!.hidden, true, "at rest the strip says nothing");
	r.unfold();
	assert.equal(r.by("zen-head-working")[0]!.hidden, false);
	assert.equal(r.by("zen-head-working")[0]!.textContent, "The head tower is on it…");
	r.feed(net(head()));
	assert.equal(r.by("zen-head-working")[0]!.hidden, true, "idle again");
	r.put([headLine("a1", "Done: sent to Harbor.", 3)]);
	await r.settle();
	assert.equal(r.by("zen-head-live")[0]!.textContent, "Done: sent to Harbor.");
	const quiet = rig({ items: [headLine("a0", "from before", 1)] });
	await quiet.start();
	await quiet.settle();
	assert.equal(quiet.by("zen-head-live")[0]!.textContent, "", "the lines that were already there are not announced");
});

test("a wait for the boss, once he has called the lines up, keeps the newest line clear and the mindfulness line away until he writes", async () => {
	const waits = service({ memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [{ id: "w1", text: "orchard?", at: at(5) }], proposals: [] } });
	const r = rig({ head: head({ service: waits }), items: [headLine("a1", "Should I rerun the ETL tonight?", 5)] });
	await r.start();
	assert.equal(hushed(r), true, "a wait is a card in the cue (Z-D19): it does not wake the strip");
	assert.equal(cueOf(r), "1 card waits for Enter. No rush, when you're ready.");
	r.unfold();
	assert.equal(cueOf(r), "", "called up: the wait is in front of him, not a card to count");
	await r.advance(CLEAR_MS + FADE_MS + 60_000);
	assert.equal(r.away(), true, "held: the mindfulness line stays away");
	assert.equal(r.by("zen-hl")[0]!.getAttribute("data-held"), "", "and the newest line is marked held, which the page keeps clear");
	r.typed("tonight, yes");
	r.enter();
	await r.settle();
	assert.equal(r.by("zen-hl").at(-1)!.getAttribute("data-held"), null, "he wrote: nothing is held by the old question");
});

test("a wait the boss already answered holds nothing: the line fades as any other", async () => {
	const waits = service({ memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [{ id: "w1", text: "orchard?", at: at(5), answered: at(6) }], proposals: [] } });
	const r = rig({ head: head({ service: waits }), items: [headLine("a1", "Should I rerun the ETL tonight?", 5)] });
	await r.start();
	await r.advance(CLEAR_MS + FADE_MS + 60_000);
	assert.equal(r.by("zen-hl")[0]!.getAttribute("data-held"), null, "an answered wait does not keep the newest line clear");
});

test("a parked or listed wait (auto mode, docs/specs/2026-11-09-auto-mode.md D8) is no cue and holds no line", async () => {
	for (const flag of [{ parked: true as const }, { listed: true as const }]) {
		const waits = service({ memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [{ id: "w1", text: "orchard?", at: at(5), ...flag }], proposals: [] } });
		const r = rig({ head: head({ service: waits }), items: [headLine("a1", "Should I rerun the ETL tonight?", 5)] });
		await r.start();
		assert.equal(cueOf(r), "", `${Object.keys(flag)[0]}: no card waits for Enter`);
		await r.advance(CLEAR_MS + FADE_MS + 60_000);
		assert.equal(r.by("zen-hl")[0]!.getAttribute("data-held"), null, `${Object.keys(flag)[0]}: the newest line is not held`);
	}
});

test("pointing at the strip or focusing it brightens the lines at once and lets them go 1.5 s after; a touch holds them for 10 s, and a touch elsewhere ends it", async () => {
	const r = rig({ items: [headLine("a1", "fading", 1)] });
	await r.start();
	await r.settle();
	r.wake();
	const strip = r.strip()!, link = r.by("zen-head-history")[0]!;
	strip.bubble("pointerenter", { pointerType: "mouse" });
	assert.equal(strip.getAttribute("data-bright"), "");
	strip.bubble("pointerleave", { pointerType: "mouse" });
	await r.advance(1400);
	assert.equal(strip.getAttribute("data-bright"), "", "still bright 1.4 s after");
	await r.advance(200);
	assert.equal(strip.getAttribute("data-bright"), null, "back on its curve");
	link.bubble("focusin");
	assert.equal(strip.getAttribute("data-bright"), "", "focus anywhere in the strip");
	link.bubble("focusout");
	await r.advance(1600);
	assert.equal(strip.getAttribute("data-bright"), null);
	strip.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(strip.getAttribute("data-bright"), "", "a tap");
	await r.advance(9000);
	assert.equal(strip.getAttribute("data-bright"), "");
	await r.advance(1100);
	assert.equal(strip.getAttribute("data-bright"), null, "10 s");
	strip.bubble("pointerdown", { pointerType: "touch" });
	r.root.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(strip.getAttribute("data-bright"), null, "a tap elsewhere ends it");
});

test("lines at rest that a hover, a focus, or a tap makes clear are not at rest: the mindfulness line steps aside and the Whole conversation link shows, and both come back when the lines let go", async () => {
	const r = rig({ items: [headLine("a1", "fading", 1)] });
	await r.start();
	await r.settle();
	r.wake();
	await r.advance(CLEAR_MS + FADE_MS + 20);
	const strip = r.strip()!, link = () => r.by("zen-head-history")[0]!, gone = () => link().dataset.away !== undefined && link().hidden === false;
	assert.equal(r.away(), false, "at rest");
	assert.equal(gone(), true, "faded out, its room kept");
	const delays = () => r.by("zen-hl").map((el) => el.style.animationDelay);
	const before = delays();
	strip.bubble("pointerenter", { pointerType: "mouse" });
	assert.equal(r.away(), true, "pointed at: the line is clear, so it is the one thing in paper");
	assert.equal(link().dataset.away, undefined, "and the way to the whole conversation fades in");
	strip.bubble("pointerleave", { pointerType: "mouse" });
	await r.advance(1600);
	assert.equal(r.away(), false, "let go: the breath's line is back");
	assert.equal(gone(), true, "faded out, its room kept");
	assert.deepEqual(delays(), before, "the lines' animation ran on under the hover, so a hover let go sets no new delay: a changed delay on a running animation would move its clock");
	link().bubble("focusin");
	assert.equal(r.away(), true, "focus in the strip brightens the lines too");
	link().bubble("focusout");
	await r.advance(1600);
	strip.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(r.away(), true, "a tap");
	await r.advance(10_100);
	assert.equal(r.away(), false, "10 s later");
});

// The history: the head as a companion, opened four ways and closed four ways.
const stage = (r: ReturnType<typeof rig>) => r.by("zen-stage")[0]!;
const open = (r: ReturnType<typeof rig>) => r.by("zen-company").length === 1;

test("the history opens by a wheel gesture up past 24 px, a swipe up over 40 px, H, and the Whole conversation link; its composer posts to the head", async () => {
	const ways: [string, (r: ReturnType<typeof rig>) => void][] = [
		["wheel", (r) => stage(r).bubble("wheel", { deltaY: -30, deltaMode: 0, timeStamp: 10 })],
		["swipe", (r) => (stage(r).bubble("touchstart", { touches: [{ clientY: 400 }], timeStamp: 10 }), stage(r).bubble("touchend", { changedTouches: [{ clientY: 340 }], timeStamp: 200 }))],
		["H", (r) => (assert.equal(r.z.key("history"), true), assert.equal(open(r), false, "the first H calls the lines up"), assert.equal(r.z.key("history"), true))],
		["link", (r) => r.by("zen-head-history")[0]!.click()],
	];
	for (const [name, go] of ways) {
		const r = rig({ items: [headLine("a1", "something", 1)] });
		await r.start();
		await r.settle();
		assert.equal(open(r), false);
		go(r);
		await r.settle();
		assert.equal(open(r), true, name);
		assert.equal(r.calls.watch.at(-1), "sb-head", `${name}: the log is the head's`);
		assert.deepEqual(r.calls.composers.map((c) => c.key), ["sb-head"], `${name}: the composer is the head's`);
		assert.equal(r.by("zen-who")[0]!.textContent, "Head tower");
	}
	const small = rig({ items: [headLine("a1", "something", 1)] });
	await small.start();
	stage(small).bubble("wheel", { deltaY: -10, deltaMode: 0, timeStamp: 10 });
	stage(small).bubble("wheel", { deltaY: 10, deltaMode: 0, timeStamp: 20 });
	assert.equal(open(small), false, "a short gesture is not one");
	stage(small).bubble("touchstart", { touches: [{ clientY: 400 }], timeStamp: 10 });
	stage(small).bubble("touchend", { changedTouches: [{ clientY: 370 }], timeStamp: 200 });
	assert.equal(open(small), false, "nor is a short swipe");
});

test("the link shows only while the lines are clear; the history closes by Esc, H again, Back to the breath, and a wheel gesture down past the bottom, each to the strip with the input folded", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start();
	await r.settle();
	r.wake();
	assert.equal(r.by("zen-head-history")[0]!.dataset.away, undefined, "shown while a line is clear");
	await r.advance(CLEAR_MS + FADE_MS + 20);
	assert.equal(r.by("zen-head-history")[0]!.dataset.away, "", "faded out at rest, its room kept: the wheel, swipe, and H still open it");
	for (const close of [
		(x: ReturnType<typeof rig>) => assert.equal(x.esc(), true),
		(x: ReturnType<typeof rig>) => assert.equal(x.z.key("history"), true),
		(x: ReturnType<typeof rig>) => x.by("zen-rest")[0]!.click(),
		(x: ReturnType<typeof rig>) => stage(x).bubble("wheel", { deltaY: 30, deltaMode: 0, timeStamp: 10, target: x.by("zen-log")[0] }),
	]) {
		const x = rig({ items: [headLine("a1", "something", 1)] });
		await x.start();
		await x.settle();
		x.unfold();
		x.typed("a draft");
		x.z.key("history");
		await x.settle();
		assert.equal(open(x), true);
		close(x);
		await x.settle();
		assert.equal(open(x), false);
		assert.equal(x.by("zen-head-hint").length, 1, "the strip is back");
		assert.equal(x.form().hidden, true, "with the input folded");
		assert.equal(hushed(x), true, "at rest: the way back is to the breath");
		assert.equal(x.calls.leave.length, 0, "and Zen was not left");
		assert.equal(x.calls.watch.at(-1), "sb-head");
	}
});

test("ZNR-F002: a snapshot without the head while the whole conversation is open does not make it a session that ended or lost control: no note, no second way back, its own Back to the breath and H still close it, and the head's return continues it", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start();
	r.z.key("history");
	r.z.key("history");
	await r.settle();
	assert.equal(open(r), true);
	for (const next of [net(undefined), net(head())]) {
		r.feed(next);
		await r.settle();
		assert.equal(open(r), true, "the conversation stays open");
		assert.equal(r.by("zen-company-note")[0]!.textContent, "", "no 已結束 and no 已失去控制 for the head");
		assert.equal(r.by("zen-company-rest").length, 0, "no session's way back beside the head's own");
		assert.equal(r.by("zen-rest").length, 1, "the one way back is the head's Back to the breath");
		assert.equal(r.by("zen-who")[0]!.textContent, "Head tower");
	}
	r.feed(net(undefined));
	await r.settle();
	r.by("zen-rest")[0]!.click();
	await r.settle();
	assert.equal(open(r), false, "Back to the breath works while the head is away");
	const h = rig({ items: [headLine("a1", "something", 1)] });
	await h.start();
	h.z.key("history");
	h.z.key("history");
	await h.settle();
	h.feed(net(undefined));
	await h.settle();
	assert.equal(h.z.key("history"), true, "H closes it too");
	await h.settle();
	assert.equal(open(h), false);
	assert.equal(h.calls.leave.length, 0, "and Zen was not left");
});

test("ZNR upgrade: the head's whole conversation, and its unfolded input, hold a new build's reload with the quiet line; Back to the breath lets it load", async () => {
	for (const [name, begin, end] of [
		["the whole conversation", async (r: ReturnType<typeof rig>) => (r.z.key("history"), await r.settle(), assert.equal(open(r), true)), async (r: ReturnType<typeof rig>) => (r.by("zen-rest")[0]!.click(), await r.settle())],
		["the unfolded input", async (r: ReturnType<typeof rig>) => (r.unfold(), await r.settle()), async (r: ReturnType<typeof rig>) => (r.esc(), await r.settle())],
	] as const) {
		const r = rig({ items: [] });
		await r.start();
		await begin(r);
		let reloads = 0;
		r.z.upgrade(() => void reloads++);
		assert.equal(reloads, 0, `${name}: not reloaded under the boss`);
		assert.equal(r.by("zen-update")[0]!.textContent, m.zen_update(), `${name}: the quiet line`);
		for (let i = 0; i < 6; i++) await r.advance(500);
		assert.equal(reloads, 0, `${name}: still held`);
		await end(r);
		for (let i = 0; i < 6; i++) await r.advance(500);
		assert.equal(reloads, 1, `${name}: back on the breath it loads`);
	}
});

test("the history is not a step of [ and ]: the ring still wraps at the circle", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start();
	r.wake();
	r.z.key("history");
	await r.settle();
	assert.equal(open(r), true);
	assert.equal(r.z.cycle(1), false, "nothing to step to: no candidates");
	assert.equal(open(r), true);
});

test("the palette gains talk, the whole conversation, and the Standard page on the circle; they act through the layer", () => {
	const calls: string[] = [];
	const entries = entriesOf({ standard() {}, head: { talk: () => calls.push("talk"), history: () => calls.push("history"), page: () => calls.push("page") } }, {});
	assert.deepEqual(entries.filter((e) => e.id.startsWith("head")).map((e) => [e.id, e.label]), [["head-talk", "Talk to the head tower"], ["head-history", "The head tower's whole conversation"], ["head-page", "Open the head tower in Standard"]]);
	for (const e of entries.filter((x) => x.id.startsWith("head"))) e.run();
	assert.deepEqual(calls, ["talk", "history", "page"]);
	assert.equal(entriesOf({ standard() {} }, {}).some((e) => e.id.startsWith("head")), false, "no head, no entries");
});

test("the head page is one palette step away: its entry leaves Zen for the head route", async () => {
	const r = rig();
	await r.start();
	r.z.palette();
	const items = r.by("palette-item");
	const page = items.find((el) => el.textContent.includes("Open the head tower in Standard"));
	assert.ok(page, "listed");
	page!.click();
	assert.deepEqual(r.calls.leave.at(-1), { route: { view: "head" } });
});

test("nothing in the strip counts anything: no number for the asks, the queue, or the unread", async () => {
	const busy = head({ asks: [{ id: "H3", group: "H2", workspace: "w1", label: "Harbor", since: 1, at: 1, first: "go", state: "waiting", answers: 0 }, { id: "H2", group: "H2", workspace: "w2", label: "Lighthouse", since: 1, at: 1, first: "go", state: "waiting", answers: 0 }], service: service({ queued: 4 }), queued: [{ id: "q1" }, { id: "q2" }] as never, said: Date.now() });
	const r = rig({ head: busy, items: [headLine("a1", "Handed over.", 1)] });
	await r.start();
	await r.settle();
	assert.equal(/\d/.test(r.strip()!.textContent), false, `no digit in what the strip says: ${r.strip()!.textContent}`);
	assert.equal(r.by("zen-head-working")[0]!.hidden, true);
});

test("a refusal's reason reads after the colon in lower case when it is a plain English sentence, and an acronym or Chinese stays", () => {
	assert.equal(joined("The head tower is busy."), "the head tower is busy.");
	assert.equal(joined("API is down"), "API is down");
	assert.equal(joined("主塔台忙碌"), "主塔台忙碌");
});

test("the head's history in Zen reads a tower_send row as one quiet line, keeps every other row, and follows rows the log adds later", () => {
	const seen: { cb: () => void; on: boolean }[] = [], real = (globalThis as { MutationObserver?: unknown }).MutationObserver;
	(globalThis as { MutationObserver?: unknown }).MutationObserver = class { cb: () => void; entry = { cb: () => {}, on: true }; constructor(cb: () => void) { this.cb = cb; this.entry.cb = cb; seen.push(this.entry); } observe() {} disconnect() { this.entry.on = false; } };
	const row = (name: string, sum: string) => { const details = new El("details"), summary = new El("summary"), code = new El("code"), span = new El("span"); details.className = "act"; span.className = "sum"; code.textContent = name; span.textContent = sum; summary.append(code, span); details.append(summary); return { details, code, span }; };
	const root = new El("div"), forward = row("tower_send", "(workspace: Harbor API)"), other = row("bash", "(workspace: not a forward)");
	root.append(forward.details, other.details);
	const stop = quietForwards(root as unknown as HTMLElement);
	assert.equal(forward.span.textContent, "Sent to the Harbor API tower");
	assert.equal(forward.code.hidden, true, "the tool's name is not read");
	assert.ok(forward.details.classes.has("quiet"));
	assert.equal(other.span.textContent, "(workspace: not a forward)", "another tool's row is as it was");
	assert.equal(other.code.hidden, false);
	const later = row("tower_send", "(workspace: Lighthouse Web)");
	root.append(later.details);
	seen[0]!.cb();
	assert.equal(later.span.textContent, "Sent to the Lighthouse Web tower", "a row that comes with the stream is rewritten too");
	stop();
	assert.equal(seen[0]!.on, false);
	(globalThis as { MutationObserver?: unknown }).MutationObserver = real;
});

// Resting the strip (docs/specs/2026-11-04-head-tower.md, Resting the strip; boss decision 2026-11-05, options 1 and 2): Esc or a tap on the blank space sends the head's lines away and brings the mindfulness line back; the head's own unsolicited lines do not wake it.
const hushed = (r: ReturnType<typeof rig>) => r.strip()?.dataset.hushed !== undefined && r.strip() !== undefined;
const tower = (id: string, min: number): Item => ({ id, kind: "notice", type: "straw-tower", event: "intercom", at: at(min), text: `[intercom from tower · Harbor (abc123)]\n[straw net from="tower · Harbor" id=abc123 role=tower workspace="Harbor" kind=tower_send scope=one to="head tower" reply=none in-reply-to=H12] Opened main.` });
const ready = async (items: Item[] = [bossLine("u1", "go", 1), headLine("a1", "On it.", 2)], o: Parameters<typeof rig>[0] = {}) => {
	const r = rig({ items, ...o });
	await r.start();
	await r.settle();
	r.wake(); // a visit starts at rest: these tests begin with the lines up
	return r;
};

test("Esc rests the strip at once: the lines go, the mindfulness line comes back, the input stays folded, and Zen is not left", async () => {
	const r = await ready();
	assert.equal(r.away(), true, "a clear line is the one thing in paper");
	assert.equal(hushed(r), false);
	assert.equal(r.esc(), true);
	assert.equal(hushed(r), true, "the lines are sent away");
	assert.equal(r.away(), false, "the maxim is back");
	assert.equal(r.by("zen-head-history")[0]!.dataset.away, "", "the link fades with the lines, keeping its room");
	assert.equal(r.form().hidden, true);
	assert.equal(r.hint().hidden, false, "the folded input is how a phone calls the head back");
	assert.equal(r.calls.leave.length, 0);
	assert.equal(r.by("zen-esc")[0]!.textContent, "", "no \"press again\" line: this Esc was taken");
	assert.equal(r.lines().length, 2, "the lines are kept for the whole conversation and for the wake; only their showing goes");
});

test("after the rest, the Esc rows are as they were: the first says \"press again\", the second leaves", async () => {
	const r = await ready();
	r.esc();
	r.esc();
	assert.equal(r.by("zen-esc")[0]!.textContent, "Press Esc again for Standard");
	assert.equal(r.calls.leave.length, 0);
	r.esc();
	assert.equal(r.calls.leave.length, 1);
});

test("a strip with nothing to rest (no lines, or every line already at its rest level) does not take Esc: the hint comes first", async () => {
	const empty = await ready([]);
	empty.esc();
	assert.equal(empty.by("zen-esc")[0]!.textContent, "Press Esc again for Standard");
	const faded = await ready();
	await faded.advance(CLEAR_MS + FADE_MS + 20);
	faded.esc();
	assert.equal(hushed(faded), false, "already at rest on its own: nothing to send away");
	assert.equal(faded.by("zen-esc")[0]!.textContent, "Press Esc again for Standard");
});

test("Esc folds an open input first (its draft kept); the next Esc rests the strip", async () => {
	const r = await ready();
	r.unfold();
	r.typed("half a thought");
	r.esc();
	assert.equal(r.form().hidden, true, "folded");
	assert.equal(hushed(r), false, "not yet rested");
	assert.equal(r.box().value, "half a thought");
	r.esc();
	assert.equal(hushed(r), true);
});

test("a tap on the blank space rests the strip: the stage, the page behind it, and the circle", async () => {
	for (const where of [(r: ReturnType<typeof rig>) => stage(r), (r: ReturnType<typeof rig>) => r.root, (r: ReturnType<typeof rig>) => r.by("zen-circle")[0]!, (r: ReturnType<typeof rig>) => r.mind()!]) {
		const r = await ready();
		where(r).bubble("click");
		assert.equal(hushed(r), true);
		assert.equal(r.away(), false);
		assert.equal(r.calls.leave.length, 0);
	}
});

test("a tap does not rest the strip when it is a control's, the strip's own, a selection's, or the one that folded the input", async () => {
	const tapped = async (act: (r: ReturnType<typeof rig>) => void) => {
		const r = await ready();
		act(r);
		return hushed(r);
	};
	assert.equal(await tapped((r) => r.hint().click()), false, "the folded input");
	assert.equal(await tapped((r) => r.by("zen-head-history")[0]!.click()), false, "the Whole conversation link");
	assert.equal(await tapped((r) => r.strip()!.bubble("click")), false, "the lines: a phone's tap clears them");
	assert.equal(await tapped((r) => r.by("zen-hl")[0]!.bubble("click")), false);
	assert.equal(await tapped((r) => r.by("zen-corner")[0]!.bubble("click")), false, "the corner");
	assert.equal(await tapped((r) => r.by("zen-corner")[0]!.all((el) => el.tagName === "button")[0]!.click()), false, "a corner button");
	const sel = globalThis as { getSelection?: () => { isCollapsed: boolean } };
	sel.getSelection = () => ({ isCollapsed: false });
	try {
		assert.equal(await tapped((r) => stage(r).bubble("click")), false, "the end of a drag that selected text");
	} finally {
		delete sel.getSelection;
	}
	const open = await ready();
	open.unfold();
	stage(open).bubble("pointerdown", { pointerType: "mouse" });
	open.box().blur();
	stage(open).bubble("click");
	assert.equal(open.form().hidden, true, "the press folded the empty input");
	assert.equal(hushed(open), true, "and the input losing the focus rested the strip with it: the click adds nothing, and nothing wakes it again");
	assert.equal(open.by("zen-esc")[0]?.textContent, "", "the click was not a second rest to answer for");
});

/** A press and its click, as a mouse makes them: the press first (the menu and the music list close on it, at the document), then the click. */
const pressed = (r: ReturnType<typeof rig>, at: El) => {
	at.bubble("pointerdown", { pointerType: "mouse" });
	for (const on of page.on.pointerdown ?? []) on({ target: at });
	at.bubble("click");
};

test("a tap on the blank space does nothing on an item, the pause, a companion, the history, or with the palette or menu open", async () => {
	const item = rig({ items: [headLine("a1", "x", 1)] });
	await item.start(net(head(), [waiting()]));
	await item.settle();
	item.z.key("talk"); // Enter takes the card (Z-D19)
	assert.equal(item.by("zen-card").length, 1);
	stage(item).bubble("click");
	assert.equal(item.by("zen-head").length, 0);
	const hist = await ready();
	hist.z.key("history");
	await hist.settle();
	stage(hist).bubble("click");
	assert.equal(open(hist), true, "the history stays open");
	const pal = await ready();
	pal.z.palette();
	stage(pal).bubble("click");
	assert.equal(hushed(pal), false, "the palette's own backdrop is the palette's");
	const pause = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "On it.", 2)] });
	await pause.start(net(head()));
	await pause.settle();
	pause.wake(); // the boss called the lines up, then an item came and was answered
	pause.feed(net(head(), [waiting()]));
	await pause.settle();
	pause.z.key("talk"); // Enter takes the card (Z-D19)
	pause.root.all((el) => el.tagName === "button" && el.textContent === "Maybe later")[0]!.click();
	await pause.settle();
	assert.equal(pause.root.all((el) => el.getAttribute("role") === "img" && el.getAttribute("aria-label") === m.zen_pause()).length, 1, "the pause is on");
	pause.z.history({ key: "sb-head", reset: true, items: [bossLine("u1", "go", 1), headLine("a1", "On it.", 2)] }); // the strip has its lines when the pause ends
	await pause.settle();
	pressed(pause, stage(pause));
	await pause.settle();
	assert.deepEqual(pause.lines(), ["go", "On it."], "the lines are there to be rested");
	assert.equal(hushed(pause), false, "the item and the pause keep the strip as it was, and the tap that ends the pause is the pause's: the strip is not rested with it");
	pressed(pause, stage(pause));
	assert.equal(hushed(pause), true, "the next tap is the blank space's");
	const menu = await ready();
	menu.by("zen-menubtn")[0]!.click();
	pressed(menu, stage(menu));
	assert.equal(menu.by("zen-menu")[0]!.hidden, true, "the press closed the menu");
	assert.equal(hushed(menu), false, "the menu's veil takes that press: the strip is not rested with it");
	pressed(menu, stage(menu));
	assert.equal(hushed(menu), true, "the next one is the blank space's");
});

test("a press outside the open music list closes it and does not rest the strip", async () => {
	const tracks = [{ file: "a.mp3" }, { file: "b.mp3" }];
	const music = { tracks: async () => tracks, player: async () => ({ start: async () => true, stop() {} }), unlock: async () => true, running: () => true, background: { on: () => true, onChange() {} }, prefs: { on: () => false, setOn() {}, track: () => null, setTrack() {} }, coarse: () => false };
	const r = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "On it.", 2)], music: music as never });
	await r.start();
	await r.settle();
	r.wake();
	r.by("zen-musicmore")[0]!.click();
	assert.equal(r.by("zen-musicpanel")[0]!.hidden, false, "the list is open");
	pressed(r, stage(r));
	assert.equal(r.by("zen-musicpanel")[0]!.hidden, true, "the press closed it");
	assert.equal(hushed(r), false, "the list's veil takes that press");
	pressed(r, stage(r));
	assert.equal(hushed(r), true);
});

test("an unsolicited head line does not wake a rested strip: a tower's answer and the head's report of it arrive and the strip stays at rest", async () => {
	const r = await ready();
	r.esc();
	r.put([bossLine("u1", "go", 1), headLine("a1", "On it.", 2), tower("n1", 5), headLine("a2", "Main is open (unasked).", 6)]);
	await r.settle();
	assert.equal(hushed(r), true);
	assert.equal(r.away(), false, "the maxim stays");
	assert.equal(r.by("zen-head-history")[0]!.dataset.away, "");
	assert.ok(r.lines().includes("Main is open (unasked)."), "it is in the strip, held back, and in the history");
	await r.advance(60_000);
	assert.equal(hushed(r), true, "time wakes nothing");
});

test("a head line that answers the boss wakes the strip; so does the same reply to a message sent from elsewhere", async () => {
	const r = await ready();
	r.esc();
	r.put([bossLine("u1", "go", 1), headLine("a1", "On it.", 2), bossLine("u2", "and the tests?", 7)]);
	await r.settle();
	assert.equal(hushed(r), true, "his own message, sent from another page, wakes nothing");
	r.put([bossLine("u1", "go", 1), headLine("a1", "On it.", 2), bossLine("u2", "and the tests?", 7), headLine("a2", "Tests pass.", 8)]);
	await r.settle();
	assert.equal(hushed(r), false, "the reply to what he sent wakes it");
	assert.equal(r.away(), true);
	assert.equal(r.by("zen-head-history")[0]!.dataset.away, undefined);
});

test("a reply to the message he just sent from this strip wakes it (Esc while the head works)", async () => {
	const r = await ready([headLine("a0", "Ready.", 0)]);
	r.unfold();
	r.typed("start it");
	await r.enter();
	await r.settle();
	r.esc();
	r.esc();
	assert.equal(hushed(r), true);
	r.z.history({ key: "sb-head", items: [bossLine("u9", "start it", 3), headLine("a9", "Started.", 4)] });
	await r.settle();
	assert.equal(hushed(r), false);
});

test("a wait or question for the boss never wakes the strip (Z-D19: it is a card, counted in the cue, and Enter calls it up); a reply to something he sent still does", async () => {
	const wait = (id: string, answered?: string) => ({ id, text: "orchard?", at: at(5), ...(answered ? { answered } : {}) });
	const mem = (...bossWaits: ReturnType<typeof wait>[]) => service({ memory: { rev: 1, standing: 0, decisions: 0, waits: bossWaits.length, bossWaits, proposals: [] } });
	const r = await ready([headLine("a1", "Should I rerun the ETL tonight?", 5)], { head: head({ service: mem(wait("w1")) }) });
	r.esc();
	assert.equal(hushed(r), true);
	assert.equal(cueOf(r), "1 card waits for Enter. No rush, when you're ready.");
	r.feed(net(head({ service: mem(wait("w1", at(6))) })));
	assert.equal(hushed(r), true);
	assert.equal(cueOf(r), "", "answering it clears the cue");
	r.feed(net(head({ service: mem(wait("w1", at(6)), wait("w2")) })));
	assert.equal(hushed(r), true, "a new question for the boss does not wake it either");
	assert.equal(cueOf(r), "1 card waits for Enter. No rush, when you're ready.");
	r.feed(net(head({ service: mem(wait("w1", at(6)), wait("w2"), wait("w3")) })));
	assert.equal(cueOf(r), "2 cards wait for Enter. No rush, when you're ready.");
	assert.equal(r.press("Enter"), true, "Enter calls it up: the lines, with the input open");
	assert.equal(hushed(r), false);
	assert.equal(r.form().hidden, false);
	assert.equal(cueOf(r), "", "he is looking at it now");
});

test("Enter calls the head back: the strip wakes and the input unfolds, focused", async () => {
	const r = await ready();
	r.esc();
	assert.equal(r.press("Enter"), true);
	assert.equal(hushed(r), false);
	assert.equal(r.form().hidden, false);
	assert.equal(r.away(), true, "the lines are back, so the maxim steps aside");
});

test("H calls the head back first (the lines return, the input stays folded); the next H opens the whole conversation", async () => {
	const r = await ready();
	r.esc();
	assert.equal(r.press("h"), true);
	await r.settle();
	assert.equal(hushed(r), false);
	assert.equal(r.form().hidden, true, "the input stays folded");
	assert.equal(open(r), false, "the history did not open on the same key");
	assert.equal(r.press("h"), true);
	await r.settle();
	assert.equal(open(r), true, "as today");
});

test("a click on the folded input wakes the strip too (a phone has no Enter)", async () => {
	const r = await ready();
	r.esc();
	r.unfold();
	assert.equal(hushed(r), false);
	assert.equal(r.form().hidden, false);
});

test("H and Enter are not the strip's while the boss is typing or an IME composes: a rested strip stays at rest", async () => {
	const r = await ready();
	r.esc();
	assert.equal(r.press("h", r.box()), false, "typed in the box: it is a letter");
	assert.equal(r.press("h", new El("input")), false);
	assert.equal(r.press("h", undefined, { isComposing: true }), false, "an IME composing");
	assert.equal(r.press("Enter", r.box()), false);
	assert.equal(r.press("Enter", undefined, { isComposing: true }), false);
	assert.equal(hushed(r), true);
});

test("a hover, a focus, or a touch does not bring a rested strip's lines back; reduced motion changes nothing about it", async () => {
	const r = await ready();
	r.esc();
	r.strip()!.bubble("pointerenter", { pointerType: "mouse" });
	assert.equal(hushed(r), true);
	assert.equal(r.away(), false, "the maxim stays under a pointer");
	r.by("zen-head-history")[0]!.bubble("focusin");
	r.strip()!.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(hushed(r), true);
	assert.equal(r.away(), false);
});

test("the strip is the page's own for this visit: Zen hiding puts it back at rest, and an item that comes and goes keeps it as it was", async () => {
	const r = await ready();
	assert.equal(hushed(r), false, "called up");
	r.z.hide();
	r.z.show();
	await r.settle();
	assert.equal(hushed(r), true, "every visit starts at rest (Z-D16, and the boss's 2026-11-06 ruling)");
	r.feed(net(head(), [waiting()]));
	await r.settle();
	r.z.key("talk"); // Enter takes the card (Z-D19)
	assert.equal(r.by("zen-card").length, 1);
	r.feed(net(head()));
	await r.settle();
	r.z.key("talk"); // the card whose question ended: Enter closes it (Z-D20)
	await r.advance(5000);
	assert.equal(hushed(r), true, "the strip is back at rest after the item");
	r.wake();
	r.feed(net(head(), [waiting()]));
	await r.settle();
	r.z.key("talk");
	r.feed(net(head()));
	await r.settle();
	r.z.key("talk");
	await r.advance(5000);
	assert.equal(hushed(r), false, "and called up it stays up");
});

// Rest is the default (boss ruling 2026-11-06: 「我覺得應該預設是呼吸，這是主塔台不是嗎？主塔台應該是 click input field 再顯示 session 吧」): a visit starts at the breath and the input line; the head's lines come up when the boss calls them.
/** The cue above the input (Z-D19): empty when it is away. */
const cueOf = (r: ReturnType<typeof rig>) => (r.by("zen-head-cue")[0]!.dataset.away === undefined ? r.by("zen-head-cue-btn")[0]!.textContent : "");
const waitOf = (id: string, answered?: string) => ({ id, text: "orchard?", at: at(5), ...(answered ? { answered } : {}) });
const memOf = (...bossWaits: ReturnType<typeof waitOf>[]) => service({ memory: { rev: 1, standing: 0, decisions: 0, waits: bossWaits.length, bossWaits, proposals: [] } });
const talk = [bossLine("u1", "go", 1), headLine("a1", "On it.", 2)];

test("a visit starts at rest: the head's lines are sent away, the mindfulness line shows, and the folded input is there; nothing else on the strip is on show", async () => {
	const r = rig({ items: talk, head: head({ mark: "working" }) });
	await r.start();
	await r.settle();
	assert.equal(hushed(r), true);
	assert.equal(r.away(), false, "the maxim, not the lines, is under the circle");
	assert.equal(r.hint().hidden, false);
	assert.equal(r.form().hidden, true);
	assert.equal(r.by("zen-head-working")[0]!.hidden, true, "not even the on-it line");
	assert.equal(r.by("zen-head-history")[0]!.dataset.away, "");
	assert.equal(r.lines().length, 2, "the lines are kept for the wake and the history");
	await r.advance(60_000);
	assert.equal(hushed(r), true, "time wakes nothing");
});

test("what calls the lines up: a click on the folded input, a focus on it, Enter, and H; the lines come up clear even when the visit has run a while", async () => {
	for (const call of [(r: ReturnType<typeof rig>) => r.unfold(), (r: ReturnType<typeof rig>) => r.hint().focus(), (r: ReturnType<typeof rig>) => r.press("Enter"), (r: ReturnType<typeof rig>) => r.press("h")]) {
		const r = rig({ items: talk });
		await r.start();
		await r.settle();
		await r.advance(CLEAR_MS + FADE_MS + 20);
		assert.equal(hushed(r), true);
		call(r);
		await r.settle();
		assert.equal(hushed(r), false);
		assert.equal(r.away(), true, "the lines are in paper, the maxim steps aside");
		assert.deepEqual(r.by("zen-hl").map((el) => el.style.animationDelay), [`${CLEAR_MS / 1000}s`, `${CLEAR_MS / 1000}s`], "the boss asked for them: clear for the whole of 20 s again, not as faded as the minutes since the page began");
	}
});

test("H with no lines to call up opens the whole conversation at once", async () => {
	const r = rig({ items: [] });
	await r.start();
	await r.settle();
	assert.equal(r.z.key("history"), true);
	await r.settle();
	assert.equal(open(r), true);
});

test("the strip rests again when the focus leaves it: an empty box that loses the focus, the hint that loses it, and Esc twice; a draft, a move inside the strip, and a window that lost the focus do not", async () => {
	const r = await ready();
	r.unfold();
	assert.equal(hushed(r), false);
	r.box().blur();
	assert.equal(r.form().hidden, true);
	assert.equal(hushed(r), true, "an empty box that loses the focus: the boss left");
	r.hint().focus();
	assert.equal(hushed(r), false, "a focus on the folded input calls the lines up");
	r.hint().blur();
	assert.equal(hushed(r), true, "and its loss rests them");
	const draft = await ready();
	draft.unfold();
	draft.typed("kept");
	draft.box().blur();
	assert.equal(hushed(draft), false, "a draft stays up");
	const inside = await ready();
	inside.unfold();
	inside.box().bubble("focusout", { relatedTarget: inside.by("zen-head-history")[0] });
	assert.equal(inside.form().hidden, true, "folded");
	assert.equal(hushed(inside), false, "the focus went to a control of the strip: not leaving it");
	const away = await ready();
	away.unfold();
	page.focus = false;
	away.box().blur();
	page.focus = true;
	assert.equal(away.form().hidden, true);
	assert.equal(hushed(away), false, "a window that lost the focus is not the boss leaving");
});

test("a head line that arrives at rest, and an old reply the page already holds, wake nothing; a reply to what the boss sends in this visit does", async () => {
	const old = [bossLine("u1", "go", 1), headLine("a1", "On it.", 2)]; // a1 answers u1
	const r = rig({ items: old });
	await r.start();
	await r.settle();
	assert.equal(hushed(r), true, "the history's reply is not news to this visit");
	r.put([...old, tower("n1", 5), headLine("a2", "Main is open (unasked).", 6)]);
	await r.settle();
	assert.equal(hushed(r), true, "an unsolicited line stays away");
	r.z.hide();
	r.z.show();
	await r.settle();
	assert.equal(hushed(r), true, "nor does the next visit wake for what the last one held");
	r.unfold();
	r.typed("and the tests?");
	await r.enter();
	await r.settle();
	r.esc();
	r.esc();
	assert.equal(hushed(r), true);
	r.z.history({ key: "sb-head", items: [bossLine("u2", "and the tests?", 7), headLine("a3", "Tests pass.", 8)] });
	await r.settle();
	assert.equal(hushed(r), false, "the reply to what he sent surfaces");
});

test("the cue is a polite status, and its words are written only when they change: a polite live region that is written again with the same words may be read out again (ZD19-F003)", async () => {
	const r = rig({ items: talk });
	await r.start();
	const cue = r.by("zen-head-cue")[0]!, btn = r.by("zen-head-cue-btn")[0]!;
	assert.equal(cue.getAttribute("role"), "status");
	assert.equal(cue.getAttribute("aria-live"), "polite", "said when the boss is free, never over what he is doing");
	const writes: string[] = [], own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(btn), "textContent")!;
	Object.defineProperty(btn, "textContent", { get: () => own.get!.call(btn), set: (v: string) => (writes.push(v), own.set!.call(btn, v)), configurable: true });
	await r.settle();
	assert.deepEqual(writes, [], "no card, no words, nothing written");
	r.feed(net(head(), [waiting()]));
	assert.deepEqual(writes, ["1 card waits for Enter. No rush, when you're ready."]);
	for (let i = 0; i < 5; i++) {
		r.feed(net(head(), [waiting()])); // every snapshot draws the strip again
		r.hint().focus();
		r.hint().bubble("pointerenter", { pointerType: "mouse" });
		await r.advance(CLEAR_MS + FADE_MS);
	}
	assert.equal(writes.length, 1, "drawn over and over, written once");
	r.feed(net(head(), [waiting(), { ...waiting(), id: "b", key: "b" }]));
	assert.equal(writes.length, 2, "a second card changes the words, and they are written");
	assert.equal(cueOf(r), "2 cards wait for Enter. No rush, when you're ready.");
});

test("a wait for the boss that is open when the visit starts does not wake the strip: it is in the cue, and Enter opens it; an answered one counts for nothing", async () => {
	const waiting = rig({ items: [headLine("a1", "Should I rerun the ETL tonight?", 5)], head: head({ service: memOf(waitOf("w1")) }) });
	await waiting.start();
	await waiting.settle();
	assert.equal(hushed(waiting), true);
	assert.equal(waiting.away(), false, "the maxim, not the question");
	assert.equal(cueOf(waiting), "1 card waits for Enter. No rush, when you're ready.");
	waiting.press("Enter");
	assert.equal(hushed(waiting), false, "Enter opens it");
	assert.equal(waiting.away(), true);
	const answered = rig({ items: [headLine("a1", "Done.", 5)], head: head({ service: memOf(waitOf("w1", at(6))) }) });
	await answered.start();
	await answered.settle();
	assert.equal(cueOf(answered), "");
});

test("only the visit's first history is what was already said: a snapshot after it that carries a reply to the boss wakes the strip", async () => {
	const r = rig({ items: [headLine("a0", "Ready.", 0)] }); // the newest page the strip reads
	await r.start();
	await r.settle();
	assert.equal(hushed(r), true);
	r.z.history({ key: "sb-head", reset: true, items: [bossLine("u1", "go", 1), headLine("a1", "On it.", 2)] }); // a reset that came later: a1 answers u1, which is new
	await r.settle();
	assert.equal(hushed(r), false);
});

test("Z-D20 (box trial C, 10:38): the head's whole conversation open on the circle (the link, H, a wheel or swipe up) is a session for company, and no card takes its screen: not on the next snapshot, not a minute later; the cue under the name counts it and Enter takes it", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start(net(head(), [waiting()]));
	assert.equal(cueOf(r), "1 card waits for Enter. No rush, when you're ready.", "queued on the circle");
	r.by("zen-head-history")[0]!.click(); // the whole conversation opens: Zen is no longer on the breathing circle
	await r.settle();
	assert.equal(r.by("zen-company").length, 1, "the head's history is the screen");
	r.feed(net(head(), [waiting()])); // the next snapshot
	await r.advance(60_000);
	assert.equal(r.by("zen-card").length, 0, "no card took the screen");
	assert.equal(r.by("zen-company").length, 1, "the history is still the screen");
	assert.deepEqual(r.calls.sound, [], "no bowl");
	assert.equal(cueOf(r), "1 card waits for Enter. No rush, when you're ready.", "the cue is under the name, on the history's screen");
	assert.ok(r.by("zen-company")[0]!.all((el) => el.classes.has("zen-head-cue-btn")).length === 1, "inside the history");
	assert.equal(r.press("Enter", r.root), true, "Enter, off a field, takes it");
	await r.settle();
	assert.equal(r.by("zen-card").length, 1);
	assert.deepEqual(r.calls.sound, ["bowl"]);
	const typing = rig({ items: [headLine("a1", "something", 1)] });
	await typing.start(net(head(), [waiting()]));
	typing.by("zen-head-history")[0]!.click();
	await typing.settle();
	const box = typing.by("zen-company")[0]!.all((el) => el.tagName === "textarea")[0]!;
	assert.equal(typing.press("Enter", box), false, "Enter in the history's box is the box's");
	assert.equal(typing.by("zen-card").length, 0);
});

test("Z-D20 (box trial C, 10:38): a card that resolves while it queues behind the head's open history never renders or sounds", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start(net(head(), [waiting()]));
	r.by("zen-head-history")[0]!.click();
	await r.settle();
	r.feed(net(head(), [])); // answered in the terminal
	await r.advance(60_000);
	assert.equal(r.by("zen-card").length, 0);
	assert.deepEqual(r.calls.sound, []);
	assert.equal(r.by("zen-company").length, 1, "the history stays the screen");
	assert.equal(cueOf(r), "", "and the cue is gone");
});

test("a press on a control in the strip fills nothing until its click, so the page does not move under the pointer; a focus from the keyboard still wakes and fills (ZHR-F001)", async () => {
	const r = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "ok", 2)] });
	const fill = () => r.strip()!.dataset.fill !== undefined;
	await r.start();
	await r.settle();
	assert.equal(fill(), false);
	// a fresh visit (resting): Chromium focuses the hint on mousedown, before mouseup
	r.hint().bubble("pointerdown", { pointerType: "mouse" });
	r.hint().focus();
	assert.equal(fill(), false, "the press's focus does not fill");
	assert.equal(r.strip()!.dataset.hushed !== undefined, true, "and does not wake the strip");
	r.hint().bubble("pointerup", { pointerType: "mouse" });
	r.hint().click();
	assert.equal(fill(), true, "the click wakes it and opens the input");
	r.z.hide();
	// all lines faded, awake: the same press does not fill
	await r.start();
	await r.settle();
	r.wake();
	await r.advance(CLEAR_MS + FADE_MS + 20);
	assert.equal(fill(), false);
	r.hint().bubble("pointerdown", { pointerType: "mouse" });
	r.hint().focus();
	assert.equal(fill(), false, "aged strip: the press's focus does not fill");
	r.hint().bubble("pointerup", { pointerType: "mouse" });
	r.hint().click();
	assert.equal(fill(), true);
	r.z.hide();
	// the keyboard: Tab onto the hint
	await r.start();
	await r.settle();
	r.hint().focus();
	assert.equal(fill(), true, "a focus without a press (Tab) wakes the strip and fills");
	r.z.hide();
	// a press in the strip released outside it (a drag onto the circle): the press is over, so a later Tab still wakes (ZHR2-F001)
	await r.start();
	await r.settle();
	r.hint().bubble("pointerdown", { pointerType: "mouse" });
	for (const on of page.on.pointerup ?? []) on({ target: page.body });
	r.hint().focus();
	assert.equal(fill(), true, "a release outside the strip ends the press: the Tab after it wakes and fills");
});

test("once every line has rested the strip stops redrawing: no timer re-arms and the hint's text is not rewritten (ZHR-F003)", async () => {
	const r = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "ok", 2)] });
	await r.start();
	await r.settle();
	r.wake();
	await r.advance(CLEAR_MS + FADE_MS + 20);
	let writes = 0;
	const hint = r.hint(), was = hint.replaceChildren.bind(hint);
	hint.replaceChildren = (...k: never[]) => (writes++, was(...k));
	await r.advance(1000);
	assert.equal(writes, 0, "the hint keeps its text node");
});

// The target picker and the addressed companion (docs/specs/2026-11-24-zen-f.md §5): the button at the start of the unfolded input, only with headless runs; its list; a pick or an accepted `@` makes the tower the companion for the visit.
const towers = (h: HeadUnit) => ({ ...net(h), bases: [{ id: "wK", label: "Knowledge", mark: "idle", tower: { name: "tower", mark: "idle", key: "tK", control: true, subs: [], service: service({ headless: true }) }, tabs: [], outposts: [], outside: [] }, { id: "wQ", label: "Quarry", mark: "idle", tower: null, tabs: [], outposts: [], outside: [] }] }) as Net;
const headless = () => head({ service: service({ headless: true }) });

test("ZF §5.1: the target button is drawn only on the unfolded input and only with headless runs; at rest the circle screen is unchanged", async () => {
	const r = rig();
	await r.start(towers(headless()));
	const btn = () => r.by("target-btn")[0];
	assert.equal(r.form().hidden, true, "folded: the form, and the button in it, is hidden");
	r.unfold();
	await r.settle();
	assert.ok(btn() && !btn()!.hidden, "unfolded: the button is there");
	assert.equal(btn()!.textContent?.startsWith(noun("head_tower")), true, "it names the head");
	assert.equal(btn()!.getAttribute("aria-label"), m.target_aria({ name: noun("head_tower") }));
	const off = rig();
	await off.start(towers(head()));
	off.unfold();
	await off.settle();
	assert.equal(off.by("target-btn")[0]?.hidden ?? true, true, "switch off: no button, as in 0.84.0");
	off.typed("@Knowledge hello");
	off.enter();
	await off.settle();
	assert.deepEqual(off.calls.posts.map((p) => p.body), [{ text: "@Knowledge hello", as: "send" }], "switch off: `@` is the head's text, no `to`");
});

test("ZF §5.2: the list opens over a veil, holds the head first then every base, no digit and no count; ↑ ↓ Enter pick, Esc (row `pick`) closes with nothing changed, a tap on the veil closes", async () => {
	const r = rig();
	await r.start(towers(headless()));
	r.unfold();
	await r.settle();
	const veil = () => r.by("target-veil")[0]!;
	r.by("target-btn")[0]!.click();
	assert.equal(veil().hidden, false);
	assert.deepEqual(r.by("target-label").map((el) => el.textContent), [noun("head_tower"), "Knowledge", "Quarry"]);
	assert.ok(!/\d/.test(r.by("target-rows")[0]!.textContent ?? ""), "no digit in any row");
	r.esc();
	assert.equal(veil().hidden, true, "Esc closed the list, and only that");
	assert.equal(r.form().hidden, false, "the input is still unfolded");
	assert.equal(r.calls.posts.length, 0);
	r.by("target-btn")[0]!.click();
	veil().bubble("click");
	assert.equal(veil().hidden, true, "a tap on the veil closes it");
	r.by("target-btn")[0]!.click();
	veil().bubble("keydown", { key: "ArrowDown" });
	veil().bubble("keydown", { key: "Enter" });
	await r.settle();
	assert.equal(veil().hidden, true);
	assert.equal(r.calls.composers.at(-1)?.key, "tK", "Enter on the second row picked Knowledge: its conversation is the companion");
});

test("ZF §5.3: a pick moves the draft and the focus to the tower's companion; the head row returns to the circle with the input open; Esc (row `back`) returns to the breath at rest; hiding Zen forgets the target", async () => {
	const r = rig();
	await r.start(towers(headless()));
	r.unfold();
	r.typed("where is MP-5383 stuck?");
	r.by("target-btn")[0]!.click();
	r.by("target-row")[1]!.click();
	await r.settle();
	const c = r.calls.composers.at(-1)!;
	assert.equal(c.key, "tK");
	assert.equal(c.box.value, "where is MP-5383 stuck?", "the draft moved with him");
	assert.equal(page.focused, c.box, "the focus is in the tower's box");
	assert.ok(r.root.textContent.includes(m.zen_direct({ base: "wK" })), "the header says the words go straight to the tower");
	const own = r.by("target-btn").find((b) => b.textContent?.startsWith("Knowledge"));
	assert.ok(own, "the companion's composer has the button, naming the tower");
	own!.click();
	r.by("target-row").find((x) => x.textContent?.startsWith(noun("head_tower")))!.click();
	await r.settle();
	assert.equal(r.by("zen-company").length, 0, "the head row returns to the circle");
	assert.equal(r.form().hidden, false, "with the strip's input open: he chose to talk to the head");
	r.by("target-btn")[0]!.click();
	r.by("target-row")[1]!.click();
	await r.settle();
	r.esc();
	assert.equal(r.by("zen-company").length, 1, "the first Esc lets go of the box that holds the draft (row `blur`)");
	r.esc();
	await r.settle();
	assert.equal(r.by("zen-company").length, 0, "the next Esc (row `back`) went back to the breath, not out of Zen");
	assert.equal(r.calls.leave.length, 0);
	assert.equal(r.form().hidden, true, "the strip at rest, its input folded");
	assert.equal(r.box().value, "", "the strip's box is empty: the draft went with him");
	// The head row returns with the input open.
	r.unfold();
	r.by("target-btn")[0]!.click();
	r.by("target-row")[2]!.click(); // Quarry: no tower yet
	await r.settle();
	assert.equal(r.calls.composers.at(-1)!.key, "addr:wQ", "a workspace with no tower is still a target");
	assert.ok(r.root.textContent.includes(m.zen_no_tower_yet()));
	r.z.leave();
	const dest = { route: { view: "workspace", ws: "wQ" } };
	assert.deepEqual(r.calls.leave.at(-1), dest);
	r.z.palette();
	const rows = r.by("palette-item");
	assert.ok(!rows.some((row) => /terminal/i.test(row.textContent)));
	rows[0]!.click();
	assert.deepEqual(r.calls.leave.slice(-2), [dest, dest]);
	r.z.hide();
	r.z.show();
	await r.settle();
	assert.equal(r.by("zen-company").length, 0, "the next visit starts at the breath with the head");
});

test("ZF §5.3: a typed `@<workspace> text` posts `to` on the head's route, adds no line to the strip, and makes the tower the companion only after a 2xx; a refusal keeps the strip and the draft", async () => {
	let status = 409;
	const r = rig({ reply: async () => ({ ok: status < 400, status, body: status < 400 ? { accepted: true, label: "Knowledge" } : { reason: "No workspace matches" } }) });
	await r.start(towers(headless()));
	r.unfold();
	r.typed("@Knowledge check the deploy");
	r.enter();
	await r.settle();
	assert.deepEqual(r.calls.posts.at(-1)?.body, { text: "check the deploy", to: "Knowledge", as: "send" });
	assert.equal(r.lines().length, 0, "no strip line for a direct send");
	assert.equal(r.by("zen-company").length, 0, "refused: the strip stays");
	assert.equal(r.box().value, "@Knowledge check the deploy", "the draft is back");
	assert.deepEqual(r.calls.sound, ["low"]);
	status = 200;
	r.box().value = "";
	r.typed("@Knowledge check the deploy");
	r.enter();
	await r.settle();
	assert.equal(r.calls.composers.at(-1)?.key, "tK", "accepted: Knowledge is the companion, so its answer is on the screen");
	assert.equal(r.lines().length, 0);
});
