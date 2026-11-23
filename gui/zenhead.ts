import type { Item } from "../src/items.ts";
import type { HeadUnit } from "../src/nethead.ts";
import type { HistoryEvent } from "./chat.ts";
import { joined } from "./asks.ts";
import { h } from "./dom.ts";
import { CLEAR_MS, createFade, FILL, type HeadLine, headLines, SHOWN } from "./headlines.ts";
import { m } from "./sentences.ts";
import type { Answer } from "./post.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import { headLine } from "./headline.ts";
import type { Target } from "./targets.ts";
import { mountTarget } from "./targetpicker.ts";

// The strip under Zen's breathing circle (docs/specs/2026-11-04-head-tower.md, Zen: the strip under the circle): the last lines of the head's conversation, fading from the moment each is first on screen, and the input that is a hairline
// until a click or Enter unfolds it. The strip knows no page: zen.ts gives it the stream's events, the head unit of each snapshot, and the few things it calls back (the post, the model's look, the history).

/** How long a hover or focus is let go of after the pointer or focus leaves, and how long a tap holds the lines clear. */
export const LET_GO_MS = 1500, TAP_MS = 10_000;
const KEEP = 60, NOTCH = 24, SWIPE = 40, GESTURE_MS = 100;

export interface HeadIo {
	now(): number;
	later(fn: () => void, ms: number): () => void;
	/** The head's session post: `input` with `{ text, as }`. */
	post(action: string, body: Record<string, unknown>): Promise<Answer>;
	/** The head's newest page of history, for a strip that no stream event has filled. */
	latest(): Promise<{ items: Item[] }>;
	online(): boolean;
	sound(s: "low"): void;
	/** The strip is at rest (every line faded, nothing held) or not: the mindfulness line shows only at rest. */
	rest(on: boolean): void;
	/** The Whole conversation link: the head's history opens. */
	history(): void;
	/** How many cards wait for Enter in Zen (Z-D19). */
	cards(): number;
	/** Enter, or a tap on the cue: the next card takes the screen; with none, the head tower is called back. */
	take(): void;
	/**
	 * Headless runs (docs/specs/2026-11-24-zen-f.md §5): the target picker's rows, or none when the head takes no `to` (runs are not headless, or an older server), and then no button is drawn and `@` is the head's text as in 0.84.0. `pick`: the boss chose a tower;
	 * the draft goes with him. `address`: a typed `@<workspace> text` was accepted (2xx), naming the workspace as typed.
	 */
	targets?(): Target[] | undefined;
	pick?(target: Target, draft: string): void;
	address?(to: string): void;
}

/** A wheel gesture over the circle screen: the sign of the travel once it passes a notch (24 px), once per gesture (events within 100 ms of each other are one, inertia included). `edge` is true when the gesture began at the end of what scrolls. */
export function wheelGesture() {
	let last = -Infinity, travel = 0, locked = false, edge = false;
	return (dy: number, at: number, atEdge: boolean): { dir: -1 | 0 | 1; edge: boolean } => {
		if (!dy) return { dir: 0, edge };
		if (at - last >= GESTURE_MS) [locked, travel, edge] = [false, 0, atEdge];
		last = at;
		travel = Math.sign(travel) === Math.sign(dy) ? travel + dy : dy;
		if (locked || Math.abs(travel) < NOTCH) return { dir: 0, edge };
		locked = true;
		return { dir: Math.sign(dy) as -1 | 1, edge };
	};
}
/**
 * The gestures over the circle screen that open and close the history: a wheel gesture up (past a notch) or a swipe up (over 40 px) opens it on the circle; a wheel gesture down that began at the end of the log closes it.
 * `on` says what the stage is for them now: the circle, the open history, or neither.
 */
export function mountGestures(stage: HTMLElement, g: { on(): "circle" | "history" | undefined; open(): unknown; close(): unknown }) {
	const wheel = wheelGesture();
	let from: number | undefined;
	stage.addEventListener("wheel", (e: WheelEvent) => {
		if (e.ctrlKey || !g.on()) return;
		const scroller = (e.target as HTMLElement | null)?.closest?.(".chat-scroll"), end = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
		const r = wheel(e.deltaY * (e.deltaMode === 1 ? 16 : 1), e.timeStamp, end);
		if (r.dir < 0) g.open();
		else if (r.dir > 0 && r.edge) g.close();
	}, { passive: true });
	stage.addEventListener("touchstart", (e: TouchEvent) => void (from = e.touches?.[0]?.clientY), { passive: true });
	stage.addEventListener("touchend", (e: TouchEvent) => {
		const start = from, to = e.changedTouches?.[0]?.clientY ?? 0;
		from = undefined;
		if (start !== undefined && start - to > SWIPE && g.on() === "circle") g.open();
	}, { passive: true });
}

/** What is a control: a tap on one is its own, never the blank space's. */
const CONTROLS = 'button, a, input, textarea, select, summary, label, [role="button"], [tabindex]:not([tabindex="-1"])';
/**
 * A tap or click on the blank space rests the head's strip (docs/specs/2026-11-04-head-tower.md, Resting the strip). `blank` says whether an element is the stage, the page behind it, or the circle, and `on` whether the circle screen is on with nothing open over it.
 * A control, the strip, the end of a drag that selected text, and a press that something else took are not it: the press that folded the head's open input (Esc's order: the fold first), that closed the corner menu or the music list (their veil takes it), or that ended the breathing pause. Those are read at `pointerdown`, before the press has changed anything, since by `click` the menu is shut and the pause is over. `click`, not `pointerdown`, rests: a swipe, a wheel gesture, and a scroll never rest the strip.
 */
export function mountRestTap(root: HTMLElement, o: { blank(at: Element): boolean; on(): boolean; head: Pick<ReturnType<typeof mountHead>, "el" | "isOpen" | "rest"> }) {
	let taken = false; // the press was something else's: the open input's fold, the menu's or the list's close, the pause's end
	root.addEventListener("pointerdown", () => (taken = o.head.isOpen() || !o.on()), true);
	root.addEventListener("click", (e) => {
		const wasTaken = taken, at = e.target as Element | null, selected = globalThis.getSelection?.();
		taken = false;
		if (wasTaken || !at || !o.on() || (selected && !selected.isCollapsed)) return;
		if (o.blank(at) && !o.head.el.contains(at) && !at.closest?.(CONTROLS)) o.head.rest();
	});
}

/** The one line that says how many cards wait for Enter (Z-D19): a button of 44 px that takes the next one, so a phone has the way. It keeps its room when none waits (`data-away`), so nothing moves when a card comes or goes; its words are written only when they change (a polite live region says them again otherwise). */
export function mountCue(take: () => void) {
	const btn = h("button", { type: "button", class: "zen-head-cue-btn" }), el = h("p", { class: "zen-head-cue", role: "status", "aria-live": "polite" }, btn);
	btn.onclick = take;
	return {
		el, btn,
		set(n: number) {
			const said = n === 0 ? "" : n === 1 ? m.zen_cue_one({ n }) : m.zen_cue_many({ n });
			if (btn.textContent !== said) btn.textContent = said;
			btn.disabled = n === 0;
			n === 0 ? (el.dataset.away = "") : delete el.dataset.away;
		},
	};
}

export function mountHead(io: HeadIo) {
	let fade = createFade(io.now);
	const live = h("p", { class: "zen-live zen-head-live", role: "status", "aria-live": "polite" });
	const list = h("ol", { class: "zen-head-lines" }), working = h("p", { class: "zen-head-working" }, m.zen_head_working()), whole = h("button", { type: "button", class: "zen-head-history", "aria-keyshortcuts": "H" }, `${m.zen_head_history()} `, h("span", { class: "zen-head-key", "aria-hidden": "true" }, m.zen_head_key()));
	const hint = h("button", { type: "button", class: "zen-head-hint" }, m.zen_head_hint());
	const cue = mountCue(() => io.take()); // the one line that says a card waits for Enter (Z-D19)
	const box = h("textarea", { class: "zen-head-box", rows: "1", maxlength: "20000", "aria-label": m.zen_head_placeholder(), placeholder: m.zen_head_placeholder(), enterkeyhint: "send" }) as HTMLTextAreaElement;
	// The target button at the start of the unfolded input (§5.1): the head, by name, until the boss picks a tower, which then becomes the companion (§5.3). Only with headless runs.
	const picker = io.targets ? mountTarget({ rows: () => io.targets?.() ?? [], chosen: () => HEAD_KEY, pick: (t) => { if (t.ws === HEAD_KEY) return void box.focus(); const draft = box.value; box.value = ""; grow(); fold(); io.pick?.(t, draft); } }) : undefined;
	const note = h("p", { class: "zen-head-note", role: "alert" }), form = h("form", { class: "zen-head-form" }, h("div", { class: "zen-head-row" }, ...(picker ? [picker.button] : []), box), note);
	const el = h("section", { class: "zen-head", role: "group", "aria-label": m.zen_head_label() }, list, working, live, h("div", { class: "zen-head-meta" }, whole, cue.el), hint, form);
	[working.hidden, form.hidden, el.hidden] = [true, true, true];
	el.dataset.hushed = "";
	let items: Item[] = [], ids = new Set<string>(), seen = false, showing = false, unfolded = false, busy = false, off = false;
	let hushed = true, hushLines = new Set<string>(), first = true; // resting: the lines are sent away until the head answers him or he calls it back (a click or focus on the input, Enter, H; a wait for him is a card in the cue, Z-D19). Every visit starts at rest, and Esc, a tap on the blank space, or the input losing the focus rests again. Page-local. `first`: the visit's first history is what was already said.
	let unit: HeadUnit | undefined, restOn: boolean | undefined, rested = false, kept = 0, stopTimer = () => {}, hover = false, focus = false, touching = false, stopHover = () => {}, stopTouch = () => {}, local = 0;
	const known = new Set<string>(), shown = new Map<string, HTMLElement>(), pending: { id: string; text: string; seen: number }[] = [];
	const one = (text: string) => text.replace(/\s+/g, " ").trim();
	const openWaits = () => new Set(unit?.service?.memory?.bossWaits.filter((w) => !w.answered && !w.state && !w.parked && !w.listed).map((w) => w.id)); // a parked wait (auto mode is on) is no cue: it raises nothing here either
	const bosses = (text: string) => headLines(items).filter((l) => l.who === "boss" && l.text === text).length;

	/** All the lines: the history's, then what the boss just sent that the stream has not brought back yet. */
	function lines(): HeadLine[] {
		const all = headLines(items);
		for (let i = pending.length - 1; i >= 0; i--) if (bosses(one(pending[i]!.text)) > pending[i]!.seen) pending.splice(i, 1); // a sent line goes when the stream brings its copy
		return [...all, ...pending.map((p) => ({ id: p.id, who: "boss" as const, text: one(p.text), at: io.now() }))];
	}
	/** Delays of a line's animation from its age: a line first on screen long ago carries on from where it is. Set when its element is made and when the animation starts again (the strip back on screen). A hover, focus, or tap never stops it (zen.css `--lift`), so none of them sets a delay. */
	const delay = (id: string) => `${(CLEAR_MS - fade.age(id)) / 1000}s`;
	function restart() {
		for (const [id, li] of shown) {
			li.style.animationName = "none"; // the animation really starts again, so the new delay is from its start
			void li.offsetWidth;
			li.style.animationName = "";
			li.style.animationDelay = delay(id);
		}
	}
	const announce = (text: string) => ((live.textContent = ""), (live.textContent = text));

	function draw() {
		const keep = lines().slice(-FILL); // how many show is the page's: three (two on a phone) while quiet, the whole height the circle leaves while awake (zen.css)
		const waits = Boolean(unit?.service?.memory?.bossWaits.some((w) => !w.answered && !w.state && !w.parked && !w.listed)), held = waits && keep.at(-1)?.who !== "boss";
		fade.see(keep.map((l) => l.id));
		for (const [id, li] of shown) if (!keep.some((l) => l.id === id)) (li.remove(), shown.delete(id));
		keep.forEach((l, i) => {
			let li = shown.get(l.id);
			if (!li) (li = h("li", { class: "zen-hl" }), shown.set(l.id, li), (li.style.animationDelay = delay(l.id)));
			const rank = keep.length - 1 - i;
			if (li.textContent !== l.text) li.textContent = l.text;
			li.setAttribute("data-who", l.who);
			li.setAttribute("data-rank", String(rank));
			li.style.setProperty("--rank", String(rank)); // the awake strip lays its lines out newest-first from its foot (zen.css `order`), so the ones that do not fit are the oldest and none is cut in half
			li.toggleAttribute("data-held", held && rank === 0);
			if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
		});
		// The head's next reply is said once to a reader of the page: the lines that were there when the strip first filled are known and never announced.
		if (seen) for (const l of keep.slice(-SHOWN)) if (l.who === "head" && !known.has(l.id)) (known.add(l.id), announce(l.text)); // the newest three, as before the strip kept more: an older line a later page brings is not news
		working.hidden = unit?.mark !== "working" || hushed;
		[rested, kept] = [hushed || fade.rested(keep.map((l) => l.id), held), keep.length];
		settle();
		stopTimer();
		const when = fade.restAt(keep.map((l) => l.id), held);
		stopTimer = when === undefined || when <= io.now() ? () => {} : io.later(draw, Math.max(0, when - io.now()) + 10);
		const cards = io.cards(), news = cards + (hushed ? openWaits().size : 0); // a wait for the boss counts as a card while the strip rests; once he has called the lines up, it is in front of him
		cue.set(news);
		const say = cards > 0 ? m.zen_head_hint_click() : m.zen_head_hint();
		if (!off && hint.textContent !== say) hint.textContent = say; // Enter takes a card first while one waits; not rewritten when unchanged, so a press on the hint keeps its text node (WebKit drops the click otherwise)
		hint.hidden = unfolded && !off;
		form.hidden = !unfolded || off;
		if (picker) (picker.button.hidden = !io.targets?.()?.length, picker.sync());
	}

	function load(reset: boolean, next: Item[]) {
		const fresh = reset ? next : next.filter((it) => !ids.has(it.id));
		if (reset) ids = new Set();
		items = (reset ? [] : items).concat(fresh).slice(-KEEP);
		for (const it of fresh) ids.add(it.id);
		for (const id of [...ids]) if (!items.some((it) => it.id === id)) ids.delete(id);
		if (reset && !seen) (headLines(items).forEach((l) => known.add(l.id)), (seen = true)); // what the first page holds is what was already said
		if (reset && first && hushed) headLines(items).forEach((l) => hushLines.add(l.id)); // and a reply in it is not news to this visit
		first = false;
		if (hushed) wakes();
		if (showing) draw();
	}

	/** A resting strip wakes for a reply to something the boss sent, and for nothing else: not the head's own reports (a tower's answer, a timer), and not a wait for him (Z-D19: that is a card, counted in the cue; Enter calls it up). */
	function wakes() {
		if (headLines(items).some((l) => l.reply && !hushLines.has(l.id))) wake(false);
	}
	/** The lines go and the mindfulness line comes back, whatever a hover, focus, or touch holds clear; what is there now is not news. */
	function hush() {
		[hushed, hushLines, first] = [true, new Set(headLines(items).map((l) => l.id)), false]; // a snapshot after a rest the boss made can carry a reply he is owed
		el.dataset.hushed = "";
		bright();
		if (showing) draw();
	}
	/** Esc, or a tap on the blank space. False when the strip is not on show with lines to send away. */
	function rest() {
		if (!restable()) return false;
		hush();
		return true;
	}
	/** The head tower is called back. By the boss (a click or focus on the input, Enter, H) the lines come up clear, as new; by news (`wakes`) they keep the age they have, and the new line is clear. */
	function wake(byBoss = true) {
		if (!hushed) return false;
		hushed = false;
		delete el.dataset.hushed;
		if (byBoss) fade = createFade(io.now); // the clock starts again
		bright();
		if (showing) (draw(), byBoss && restart());
		return true;
	}
	/** There is something to rest: the strip is on show, awake, with lines that are not already at their rest level. */
	const restable = () => showing && !off && !hushed && kept > 0 && restOn !== true;
	/** H on a resting strip: the lines return (false when it is awake or has none, and H goes on to the history). */
	const recall = () => hushed && kept > 0 && wake();

	/** The strip is quiet (the mindfulness line shows, the link fades out) when every line has faded and nothing brings them back: a hover, focus, or tap makes the lines clear, and then one thing is in paper, not two. */
	function settle() {
		if (!showing) return;
		const quiet = hushed || (rested && !(hover || focus || touching));
		whole.hidden = !kept;
		quiet ? (whole.dataset.away = "") : delete whole.dataset.away; // at rest it fades out and keeps its room: nothing moves when the lines come clear
		if (quiet !== restOn) io.rest((restOn = quiet));
		const fill = !hushed && !(rested && !focus); // the boss's own state, never the pointer's: a hover or tap lifts the lines (--lift) but must not move the page under it
		const was = el.hasAttribute("data-fill");
		el.toggleAttribute("data-fill", fill); // the lines take the mindfulness line's room and the circle's spare height (zen.css)
		if (fill && !was) restart(); // lines hidden while quiet lost their animation: they start again at their age
	}
	function bright() {
		el.toggleAttribute("data-bright", !hushed && (hover || focus || touching));
		settle();
	}
	const letGo = (set: () => void) => (stopHover(), (stopHover = io.later(() => (set(), bright()), LET_GO_MS)));
	el.addEventListener("pointerenter", (e: PointerEvent) => e.pointerType !== "touch" && (stopHover(), (hover = true), bright()));
	el.addEventListener("pointerleave", (e: PointerEvent) => e.pointerType !== "touch" && letGo(() => (hover = false)));
	// A press focuses a button before its mouseup (Chromium): that focus must not fill the strip, or the hint jumps from under the pointer and the click misses. The click wakes it; a focus the keyboard brings (Tab) still does. The input's own focus counts always.
	let pressing = false;
	const lift = () => (pressing = false);
	el.addEventListener("pointerdown", () => (pressing = true), true);
	for (const type of ["click", "keydown"]) el.addEventListener(type, lift, true);
	for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, lift, true); // a press released anywhere is over, a drag onto the circle too
	el.addEventListener("focusin", (e: FocusEvent) => {
		if (pressing && e.target !== box) return;
		stopHover();
		focus = true;
		bright();
	});
	el.addEventListener("focusout", () => letGo(() => (focus = false)));
	el.addEventListener("focusin", (e: FocusEvent) => e.target === hint && !pressing && wake()); // the folded input is the field: a focus on it calls the head back, as a click does
	el.addEventListener("pointerdown", (e: PointerEvent) => {
		if (e.pointerType !== "touch") return;
		stopTouch();
		touching = true;
		bright();
		stopTouch = io.later(() => ((touching = false), bright()), TAP_MS);
	});

	function grow() {
		box.style.height = "auto";
		box.style.height = `${box.scrollHeight}px`; // style.css caps it at four lines
	}
	const say = (text: string) => ((note.textContent = text), (note.dataset.tone = text ? "error" : ""));
	function fold(focusHint = false) {
		if (!unfolded) return false;
		unfolded = false;
		hint.hidden = off;
		form.hidden = true;
		if (focusHint) hint.focus();
		return true;
	}
	function unfold() {
		if (!showing || !unit || off) return false;
		wake(); // calling the head back wakes the strip
		unfolded = true;
		draw();
		box.focus();
		return true;
	}
	/** The stage went to something else: its timers stop, its draft stays. */
	function stop() {
		showing = false;
		stopTimer();
		stopHover();
		stopTouch();
		[hover, focus, touching] = [false, false, false];
		bright();
	}
	function mix() {
		const down = !io.online();
		box.disabled = down || off;
		if (down) say(m.link_offline());
		else if (note.textContent === m.link_offline()) say("");
	}
	async function send() {
		const text = box.value;
		if (!text.trim() || busy || !io.online()) return;
		[busy, box.value] = [true, ""];
		grow();
		say("");
		// `@<workspace> text` (headline.ts) with headless runs: straight to that tower, so no line waits here for the head's history to bring it back (it never would); once accepted, that tower is the companion (§5.3).
		const line = io.targets?.()?.length ? headLine(text) : { text };
		const mine = { id: `local-${++local}`, text, seen: bosses(one(text)) };
		if (!line.to) pending.push(mine);
		draw();
		const refuse = (why: string) => {
			if (pending.includes(mine)) pending.splice(pending.indexOf(mine), 1);
			box.value = box.value ? `${text}\n${box.value}` : text;
			grow();
			say(why);
			io.sound("low");
		};
		try {
			const r = await io.post("input", line.to ? { text: line.text, to: line.to, as: "send" } : { text, as: "send" });
			if (r.ok && line.to) io.address?.(line.to);
			if (!r.ok) refuse(m.zen_head_refused({ reason: joined(r.body.reason ?? r.body.error ?? String(r.status)) }));
		} catch {
			refuse(m.zen_head_unreachable());
		}
		busy = false;
		if (showing) draw();
	}
	box.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "ArrowDown" && e.altKey && picker && !picker.button.hidden) return void (e.preventDefault(), picker.show()); // Alt+↓ opens the target list (§5.2)
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		void send();
	});
	box.addEventListener("input", () => (say(""), grow()));
	form.addEventListener("submit", (e) => (e.preventDefault(), void send()));
	hint.onclick = () => void unfold();
	whole.onclick = () => io.history();
	// A blur with an empty box folds; with a draft it stays. The hint's own blur is not the box's: a click on the folded hint focuses it, and unfolding hides it, which Chrome reports as a focusout of the hint just before the box takes the focus.
	// The strip rests again when the focus leaves it (the input folded or never opened): a window that lost the focus is not the boss leaving, and a move to another control inside the strip is not either.
	el.addEventListener("focusout", (e: FocusEvent) => {
		const into = e.relatedTarget as Node | null, picking = Boolean(picker && (picker.isOpen() || (into && (form.contains(into) || picker.veil.contains(into))))); // to the target button or its list: the input stays unfolded
		const closing = e.target !== hint && unfolded && box.value === "" && !busy && !picking;
		if (closing) fold();
		const to = e.relatedTarget as Node | null, away = !(to && el.contains(to)) && (typeof document === "undefined" || typeof document.hasFocus !== "function" || document.hasFocus());
		if (away && !unfolded && !picking && (closing || e.target === hint)) hush();
	});

	return {
		el,
		/** The head unit of the latest snapshot (none: the server runs no tower service); `ready` is whether a snapshot has come at all. */
		sync(next: HeadUnit | undefined, ready: boolean) {
			unit = next;
			off = ready && !next;
			el.hidden = !ready;
			if (off) hint.textContent = m.zen_head_off();
			hint.disabled = off;
			if (off) fold();
			mix();
			if (hushed) wakes();
			if (showing) draw();
		},
		/** The strip is on the stage: its lines start (or carry on) their fade, and the head's newest page is read when no event has filled it. */
		show() {
			showing = true;
			draw();
			restart();
			if (!seen) void io.latest().then((page) => !seen && load(true, page.items), () => {});
		},
		stop,
		/** Zen hid: the draft is dropped and the input folded. */
		reset() {
			stop();
			picker?.close(false);
			fold();
			[hushed, hushLines, first] = [true, new Set(headLines(items).map((l) => l.id)), true]; // the next visit starts at rest, and what is in memory now is not news to it
			el.dataset.hushed = "";
			delete el.dataset.fill;
			box.value = "";
			say("");
			pending.length = 0;
		},
		history(e: HistoryEvent) {
			if (e.reset || e.items?.length) load(Boolean(e.reset), e.items ?? []);
		},
		unfold,
		fold,
		rest,
		hush,
		wake,
		recall,
		/** The strip is resting (the visit began, or Esc, a tap on the blank space, or the input losing the focus sent its lines away). */
		hushed: () => hushed,
		/** The lines are on show and Esc can send them away (zenkeys.ts `rest`). */
		restable,
		isOpen: () => unfolded && showing,
		/** The target list's veil: the layer puts it at its root, over everything the page shows (zen.ts). */
		veil: picker?.veil,
		/** The target list is open (zenkeys.ts `pick`): Esc closes it, nothing else. */
		picking: () => Boolean(picker?.isOpen()),
		closePick: () => Boolean(picker?.close()),
		/** Nothing is clear and nothing is held. */
		rested: () => restOn ?? true,
		/** A press somewhere on the page: a tap elsewhere ends the touch that holds the lines clear. */
		tapAway(target: unknown) {
			if (!touching || el.contains(target as Node)) return;
			stopTouch();
			touching = false;
			bright();
		},
	};
}

/** The head's history in Zen reads as talk: a `tower_send` row (`(workspace: X)`) becomes one quiet line, "Sent to the X tower"; the card's arguments stay behind its disclosure. Standard's log (chat.ts) is not touched. */
export function quietForwards(root: HTMLElement): () => void {
	const fix = () => root.querySelectorAll<HTMLElement>("details.act > summary").forEach((row) => {
		const name = row.querySelector("code"), sum = row.querySelector<HTMLElement>(".sum"), to = /^\(workspace: (.+?)\)$/.exec(sum?.textContent ?? "")?.[1];
		if (name?.textContent === "tower_send" && sum && to) (name.hidden = true, sum.textContent = m.zen_head_sent({ workspace: to }), row.closest("details")?.classList.add("quiet"));
	});
	const watch = new MutationObserver(fix);
	watch.observe(root, { childList: true, subtree: true });
	fix();
	return () => watch.disconnect();
}
