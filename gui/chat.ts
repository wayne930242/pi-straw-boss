import type { Pending } from "../src/ask.ts";
import type { Mark } from "../src/netdata.ts";
import type { Shelf } from "../src/documents.ts";
import type { Item, Todo } from "../src/items.ts";
import type { Queued, RunDialog, TowerService } from "../src/net.ts";
import type { Monitor } from "../src/monitors.ts";
import { h, replay } from "./dom.ts";
import { createFollow, reach } from "./follow.ts";
import { readAnswered } from "./answered.ts";
import { deliverToUnit } from "./blockanswer.ts";
import type { Away } from "./blocks.ts";
import { copyButton } from "./copy.ts";
import { mdBody } from "./mdbody.ts";
import { post } from "./post.ts";
import { onSelectionEnd, selectedIn } from "./selection.ts";
import type { Post } from "./composer.ts";
import { m } from "./sentences.ts"; import { iconRef } from "./icons.ts"; import { noun } from "./nouns.ts";
import { getLocale } from "./paraglide/runtime.js";
import { html, roleName } from "./render.ts"; import { ICON, kindIcon } from "./icons.ts";
import { conversationDivider } from "./towermodel.ts";
import { bossTurn, eventTurn, heard, senderOf, type Turn } from "./towerturns.ts";

// The comms log of one session. The model is pure: items merge by entry id (a repeated one is ignored), tool results attach to their call by
// callId, a reset replaces everything, and at most 600 items stay mounted (the farthest page is dropped and fetched again on scroll).
// The view builds DOM with `h` and the markdown renderer only, never from markup strings, and loads older pages when the top comes into view.

export const CAP = 600;
export interface Page { items: Item[]; before?: string }
export interface Delta { rebuild: boolean; added: Item[]; touched: string[]; dropped: string[]; front: boolean }

export function createChat(cap = CAP) {
	let items: Item[] = [], before: string | undefined, detached = false;
	const ids = new Set<string>(), results = new Map<string, Item>(), owner = new Map<string, string>();
	const forget = (gone: Item[]) => gone.forEach((it) => (ids.delete(it.id), it.tools?.forEach((t) => (owner.delete(t.id), results.delete(t.id)))));
	/** Takes the new items: results go to `results` (touching the call they answer), the rest are returned in order. */
	function take(list: Item[], touched: Set<string>) {
		const shown: Item[] = [];
		for (const it of list) {
			if (ids.has(it.id)) continue;
			ids.add(it.id);
			if (it.kind === "result" && it.callId) {
				results.set(it.callId, it);
				if (owner.has(it.callId)) touched.add(owner.get(it.callId)!);
			} else {
				it.tools?.forEach((t) => owner.set(t.id, it.id));
				shown.push(it);
			}
		}
		return shown;
	}
	const done = (d: Partial<Delta>): Delta => ({ rebuild: false, added: [], touched: [], dropped: [], front: false, ...d });
	return {
		get items() { return items; },
		get before() { return before; },
		get detached() { return detached; },
		result: (callId: string) => results.get(callId),
		reset(page: Page): Delta {
			[items, before, detached] = [[], page.before, false];
			ids.clear(), results.clear(), owner.clear();
			items = take(page.items, new Set());
			return done({ rebuild: true, added: items });
		},
		/** New items at the end. While the end is not mounted (an older page pushed it out) they are ignored; "latest" reloads. */
		append(list: Item[]): Delta {
			if (detached) return done({});
			const touched = new Set<string>(), added = take(list, touched);
			items.push(...added);
			const dropped = items.length > cap ? items.splice(0, items.length - cap) : [];
			forget(dropped);
			if (dropped.length) before = items[0]!.id;
			return done({ added, touched: [...touched], dropped: dropped.map((d) => d.id) });
		},
		/** An older page at the front; past the cap the newest items go and the chat is detached from the live end. */
		prepend(page: Page): Delta {
			const touched = new Set<string>(), added = take(page.items, touched);
			items.unshift(...added);
			before = page.before;
			const dropped = items.length > cap ? items.splice(cap) : [];
			forget(dropped);
			if (dropped.length) detached = true;
			return done({ added, touched: [...touched], dropped: dropped.map((d) => d.id), front: true });
		},
	};
}

export interface HistoryEvent { key: string; state?: string; successor?: string; base?: string; name?: string; role?: string; reset?: boolean; items?: Item[]; before?: string; header?: { id?: string; cwd?: string }; unreadable?: number; todos?: Todo[] | null; /** A tower's headless run: the message it writes now ("" when none; src/watch.ts). */ live?: string; /** The dialogs its runs wait on, on this computer's page only. */ dialogs?: RunDialog[] }
/** `post` stands in for the server's input API (composer.ts) in the dev fixture. */
/** `pic` is the URL of an entry's n-th image. */
export interface Data { older(before: string): Promise<Page>; latest(): Promise<Page>; entry(id: string): Promise<Item | undefined>; pic?(id: string, n: number): string; post?: Post }
export interface Who extends Shelf { key: string; name: string; role: string; mark: Mark; /** The head tower (its words are named for it). */ head?: boolean; note?: string; control?: boolean; ended?: boolean; pending?: Pending; queued?: Queued[]; monitors?: Monitor[]; service?: TowerService; /** A main's kind and the plan's graph (src/net.ts `Unit.duty`, `todo.graph`). */ duty?: string; todo?: { graph?: string } }
/** `docFor` opens the document a show_doc path names while its session lists it (doc.ts), or is undefined. */
export interface ChatDeps { /** `quiet` (Zen, docs/specs/2026-11-24-zen-f.md §3): the message under way is still ash text, with no "Writing now" tag, no caret, no motion, and no live region (a region that grows every 2 s would be read again and again). */ live?: "quiet"; who(): Who; link(name: string): HTMLAnchorElement | undefined; docFor?(path: string): (() => void) | undefined; /** The session route's log: for the head it shows the words only (docs/specs/2026-11-06-head-page-minimal.md). Zen's companion log leaves it out and shows the head's cards as before. */ page?: boolean; /** Whether the unit is a remote base's and its box takes no input now (unreachable or ended): its blocks cannot be submitted, with box_answer_blocked shown. Read at every answer and at `box()`. Without it the unit is local. */ away?(): boolean }
/** `reveal` opens the log at an entry (scrolled into view and lit), or with none at the newest entry. `log` is the scrolling log, a focus target. `docs` shows Open beside on the show_doc cards whose document is listed now. */
export interface Chat { apply(event: HistoryEvent): void; reveal(at?: string): void; docs(): void; /** The unit's box may have come or gone (`ChatDeps.away`): the blocks drawn read it again. */ box(): void; /** The boss conversation's runs (src/server/runs.ts `LocalRunRow`): a divider opens each in the log, with how it ended once it has. */ runs(rows: ConversationRun[]): void; log: HTMLElement }
export type ConversationRun = NonNullable<TowerService["localRuns"]>[number];

/** Who an assistant message is from, as its header says: the unit's role, since the page header already names the session. */
/** The chapter divider's reason in the page's language: by the server's code, the raw text only for a code this page does not know. */
export const chapterWhy = (code?: string, text?: string) => ({ first: m.head_why_first, new: m.head_why_new, size: m.head_why_size, unreadable: m.head_why_unreadable } as Record<string, (() => string) | undefined>)[code ?? ""]?.() ?? text ?? "";
export const speaker = (who: { role: string; head?: boolean }) => (who.head ? noun("head_tower") : roleName(who.role));
const clock = (at?: string) => (at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const size = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} KB` : `${n} B`);
const NOTICE: Record<string, () => string> = { intercom_message: m.notice_intercom, subagent_result: m.notice_result, subagent_ping: m.notice_ping, subagent_status: m.notice_status, "pi-loop-monitor": m.notice_monitor, "memory-context": m.notice_memory, "doc-review": m.notice_doc_review, "straw-tower": m.notice_tower, "straw-link": m.notice_straw_link };
const icon = (name: string, duty?: string) => {
	const span = html(`<span class="ava"><svg><use/></svg></span>`);
	const use = span.querySelector("use")!, role = kindIcon(name, duty) ?? ICON[name] ?? name;
	use.dataset.icon = role;
	use.setAttribute("href", iconRef(role));
	return span;
};

/** Plain text with line breaks and autolinks (user messages are not markdown). */
function plain(text: string) {
	const out: (Node | string)[] = [];
	let at = 0;
	for (const m of text.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
		out.push(text.slice(at, m.index), h("a", { href: m[0], rel: "noopener noreferrer", target: "_blank" }, m[0]));
		at = m.index + m[0].length;
	}
	return [...out, text.slice(at)];
}

export function mountChat(root: HTMLElement, data: Data, { who, link, docFor, page, away, live: liveMode }: ChatDeps): Chat {
	let pendingQuiet = false; // the live text may clear before its assistant entry arrives
	const model = createChat(), els = new Map<string, HTMLElement>(), opens = new Set<{ paths: string[]; button: HTMLButtonElement; shown?: boolean }>(); // a card the log dropped leaves it
	const docs = () => opens.forEach((o) => (o.button.isConnected ? ((o.shown = true), (o.button.hidden = !o.paths.some((p) => docFor?.(p)))) : o.shown && opens.delete(o)));
	const list = h("div", { class: "chat-list" }), top = h("div", { class: "chat-top" }), foot = h("div", { class: "chat-end" }), pill = h("button", { class: "chat-pill", type: "button", hidden: "" }), empty = h("p", { class: "chat-empty" }, m.no_transmissions());
	const scroller = h("div", { class: "chat-scroll", tabindex: "-1", "aria-label": m.comms_log() }, top, list, foot);
	root.replaceChildren(scroller, pill);
	const follow = createFollow();
	let loading = false, loaded = false, target: string | undefined, held: HTMLElement | undefined, release = 0, down = false, coast: ReturnType<typeof setTimeout> | undefined;
	// A finger on the log, a wheel or key moving it up, or the fling after them still coasting (no input and no scroll for 250 ms ends it), hold the log where the user put it: nothing pulls it to the bottom, and
	// when it ends a log still following lands there in one jump. A wheel down at the end holds nothing: the entry lands at once, so the tail of that fling has no new room to glide into.
	// Text selected in the log holds it too (selection.ts: a long press and its handles send no touch event), and so does the redraw of the message that holds it; both wait for the selection to end.
	const selecting = () => selectedIn(scroller), touching = () => down || coast !== undefined || selecting(), coasting = () => (clearTimeout(coast), (coast = setTimeout(() => ((coast = undefined), follow.pinned && !model.detached && !selecting() && toBottom()), 250)));
	const button = (label = follow.button(model.detached)) => ((pill.hidden = !label), (pill.textContent = label ?? ""));
	const park = () => ((scroller.scrollTop = scroller.scrollHeight), follow.parked(scroller.scrollTop));
	const toBottom = () => (follow.jump(), (held = undefined), park(), button());
	/** Scrolls the anchor into view and lights it; older pages load first when it is not mounted. Gone from the history, the log opens at the end. */
	async function anchor(at: string) {
		loading = true;
		const found = await reach(model, data, at, (d) => (paint(d), touch(d))).finally(() => (loading = false));
		const el = els.get(at);
		if (target !== at) return;
		if (!found || !el) return toBottom();
		follow.hold();
		held = el;
		el.scrollIntoView({ block: "center" });
		replay(el, "lit");
		// Entries near it take their real height as they render (content-visibility), so it is kept in view until the user scrolls.
		clearTimeout(release);
		release = window.setTimeout(() => ((held = undefined), el.classList.remove("lit")), 2000);
		button();
	}
	const settle = () => (target ? void anchor(target) : toBottom());
	const fetchBody = (button: HTMLButtonElement, body: HTMLElement, id: string, pick: (it: Item) => string | undefined) => {
		button.disabled = true;
		void data.entry(id).then((full) => {
			const text = full && pick(full);
			if (text === undefined) return void (button.textContent = m.unavailable());
			body.textContent = text;
			button.remove();
		}, () => (button.textContent = m.unavailable()));
	};

	/** An entry's images as thumbnails, each opening the lightbox on it; one that cannot be read says so in its place. */
	function thumbs(id: string, count = 0) {
		if (!count || !data.pic) return null;
		const srcs = Array.from({ length: count }, (_, n) => data.pic!(id, n));
		return h("div", { class: "pics" }, ...srcs.map((src, n) => {
			const img = h("img", { src, alt: m.image_n({ n: n + 1 }), loading: "lazy", decoding: "async" }), b = h("button", { type: "button", class: "pic", "aria-label": m.open_image({ n: n + 1 }) }, img);
			img.addEventListener("error", () => b.replaceWith(h("em", { class: "pic-gone" }, m.image_unavailable())));
			b.addEventListener("click", () => void import("./lightbox.ts").then(({ lightbox }) => lightbox(srcs, n)));
			return b;
		}));
	}
	/** A tool call of entry `of` as an action card: its state badge (running, done, failed), name, and one line; arguments (all of them on request) and result inside. */
	function action(t: NonNullable<Item["tools"]>[number], of: string) {
		const r = model.result(t.id), body = h("pre", { class: "out" }, r?.text ?? ""), args = h("pre", { class: "args" }, t.args ?? ""), whole = t.cut ? h("button", { class: "more", type: "button" }, m.show_all_arguments()) : null;
		whole?.addEventListener("click", () => fetchBody(whole, args, of, (it) => ((x) => x && `${x.args ?? ""}${x.cut ? `\n${m.cut_at()}` : ""}`)(it.tools?.find((x) => x.id === t.id))));
		const more = r?.more ? h("button", { class: "more", type: "button" }, m.show_all({ size: size(r.bytes ?? 0) })) : null;
		more?.addEventListener("click", () => fetchBody(more, body, r!.id, (it) => it.text));
		// Open beside while the document is listed: the session shows it now, so the server serves it (a card whose document closed stays text).
		const open = t.name === "show_doc" && docFor ? h("button", { class: "more open", type: "button", hidden: "" }, m.open_beside()) : null;
		open?.addEventListener("click", (event) => (event.preventDefault(), t.summary.split(", ").forEach((p) => docFor?.(p)?.())));
		if (open) opens.add({ paths: t.summary.split(", "), button: open });
		if (open) queueMicrotask(docs);
		const card = h("details", { class: "act" }, h("summary", { "data-mark": r ? (r.isError ? "error" : "done") : "working" }, h("b", { class: "badge" }), h("code", null, t.name), h("span", { class: "sum" }, t.summary), open), args, whole, r && h("div", { class: "result" }, r.images ? h("em", null, m.images({ count: r.images })) : null, body, more));
		const pics = r && thumbs(r.id, r.images); // shown under the card, closed or open
		return pics ? [card, pics] : [card];
	}
	const stamp = (it: Item) => h("time", null, clock(it.at));
	/** The boss's own message: a YOU bubble. `raw` is the whole text, kept as the tooltip when the server's marker lines were taken off. */
	const you = (it: Item, body: string, crashed: boolean | undefined, raw: string) => {
		const bubble = h("div", { class: "bubble", title: raw }, crashed ? h("small", { class: "boss-flag" }, m.boss_crash_flag()) : null, ...plain(body), thumbs(it.id, it.images));
		return h("article", { class: "tx you" }, h("header", null, copyButton(() => body, () => bubble), stamp(it), h("b", null, noun("you")), icon("user")), bubble);
	};
	/** An incoming message: its label on one collapsed line, its text (and the crash flag, or the verified header folded behind "details") inside. */
	const notice = (it: Item, label: (Node | string)[], body: string, more: { crashed?: boolean; raw?: string } = {}) => {
		const pre = h("pre", null, body);
		return h("article", { class: "tx sys" }, h("details", { class: "notice" }, h("summary", null, icon("comms"), h("em", null, m.incoming()), ...label, stamp(it)), more.crashed ? h("small", { class: "boss-flag" }, m.boss_crash_flag()) : null, pre, copyButton(() => body, () => pre), more.raw ? h("details", { class: "notice-raw" }, h("summary", null, m.notice_details()), h("pre", { class: "raw" }, more.raw)) : null));
	};
	/** A message from a session on this computer: its name (a link to it when the net lists it), its id, and where it comes from; a teammate's message through Straw Link says so too, so the two never read alike. */
	const intercomLabel = (from: string | undefined): (Node | string)[] => {
		const s = senderOf(from);
		return [m.notice_intercom(), " ", (s.name && link(s.name)) || s.name, s.id ? ` (${s.id})` : "", " · ", m.notice_origin_local()];
	};
	const turnLabel = (t: Exclude<Turn, { kind: "boss" }>): (Node | string)[] => {
		if (t.kind === "link") return [{ ask: m.notice_link_ask, reply: m.notice_link_reply, answer: m.notice_link_answer, message: m.notice_link_message }[t.what]({ from: t.from }), " · ", m.notice_origin_teammate()];
		if (t.kind === "intercom") return intercomLabel(t.from);
		return [t.kind === "server" ? m.notice_server() : m.notice_timer()];
	};
	// The blocks drawn, told when the box comes or goes (`box()`); weakly, so a block the log dropped is forgotten.
	const blocks = new Set<WeakRef<{ refresh(): void }>>(), sweep = () => blocks.forEach((ref) => ref.deref() || blocks.delete(ref));
	const gate: Away | undefined = away && { why: () => (away() ? m.box_answer_blocked() : undefined), watch: (v) => (blocks.size >= 256 && sweep(), void blocks.add(new WeakRef(v))) };
	/** An agent message's text: its blocks are pi-better-show's elements, compact, and an answer from one is the boss's message to this unit through the composer's route (blockanswer.ts), locked per session, entry, and block. */
	const textOf = (id: string, text: string) => {
		const key = who().key, route = (b: Record<string, unknown>) => (data.post ? data.post("input", b) : post(`sessions/${encodeURIComponent(key)}/input`, b));
		return mdBody(text, "md", { density: "compact", doc: `chat:${id}`, scope: [key, id], ready: () => readAnswered(key), ...(gate ? { away: gate } : {}), send: (answer, said) => deliverToUnit(route, { entry: id, index: answer.ref!.block, fields: answer.fields })(said) });
	};
	/** Whether the log being drawn is the head's own page (not Zen's log, not another tower's). */
	const bare = () => page === true && who().head === true;
	/** An entry the head's page does not show (docs/specs/2026-11-06-head-page-minimal.md): it keeps its place in the log, hidden. */
	const skipped = () => h("article", { class: "tx skip", hidden: "" });
	function render(it: Item): HTMLElement {
		switch (it.kind) {
			case "user": {
				// A run of a tower the sb server runs gets what came to the tower as user turns; the server wrote their first line, and they are not the boss's (towermodel.ts `heard`).
				const said = who().service ? heard(it.text) : undefined;
				if (said) return notice(it, said.kind === "intercom" ? intercomLabel(said.from) : [said.kind === "server" ? m.notice_server() : m.notice_timer()], it.text ?? "");
				const boss = who().service ? bossTurn(it.text) : undefined; // the server's marker line is not shown
				return you(it, boss ? boss.body : (it.text ?? ""), boss?.crashed, boss ? (it.text ?? "") : "");
			}
			case "assistant": {
				const me = who();
				if (bare() && !it.text && !it.thought && !it.error && !it.stop) return skipped(); // the head's page shows its words: an entry of tool calls alone is not content there
				const body = h("pre", { class: "thought-text" }), more = it.thought ? h("button", { class: "thought", type: "button" }, it.thought < 0 ? m.thought_redacted() : m.thought_chars({ count: it.thought.toLocaleString() })) : null;
				if (it.thought && it.thought > 0) more?.addEventListener("click", () => fetchBody(more, body, it.id, (full) => full.thoughtText));
				const words = it.text ? textOf(it.id, it.text) : null;
				return h("article", { class: me.head ? "tx in head" : "tx in" }, icon(me.head ? "crown" : me.role, me.duty), h("div", { class: "tx-body" }, h("header", null, h("b", null, speaker(me)), it.model ? h("span", null, it.model) : null, stamp(it), it.stop ? h("span", { class: "stop", "data-mark": "error" }, it.stop) : null, it.text ? copyButton(() => it.text!, () => words) : null), more, body, words, it.error ? h("p", { class: "fault" }, it.error) : null, ...(bare() ? [] : it.tools ?? []).flatMap((t) => action(t, it.id))));
			}
			case "bash": if (bare()) return skipped(); return h("article", { class: "tx sys" }, h("details", { class: "act" }, h("summary", { "data-mark": it.exit ? "error" : "done" }, h("b", { class: "badge" }), h("code", null, "shell"), h("span", { class: "sum" }, `! ${it.command}`), it.exit ? h("span", { class: "stop", "data-mark": "error" }, m.exit_code({ code: it.exit })) : null), it.text ? h("pre", { class: "out" }, it.text) : null));
			case "notice": {
				// A run's event is read by what the server sent it as, not by its text (towerturns.ts `eventTurn`); a message to an ally run or a main carries the verified header, folded.
				// The boss's own message is a YOU bubble only in a run of a tower the sb server runs: that is the one writer of `kind: "boss"` (runmode.ts), so anywhere else the same entry is a message another party wrote into a session, and shows as one.
				const turn = eventTurn(it);
				if (turn?.kind === "boss" && who().service) return you(it, turn.body, turn.crashed, it.text ?? "");
				if (bare() && (turn?.kind === "server" || turn?.kind === "timer")) return skipped(); // the sb server's own markers are protocol, not something the boss reads
				if (turn && turn.kind !== "boss") return notice(it, turnLabel(turn), turn.body, turn.kind === "link" ? { raw: turn.raw } : { crashed: turn.crashed });
				return notice(it, [NOTICE[it.type ?? ""]?.() ?? it.type ?? m.notice(), " ", (it.from && link(it.from)) || (it.from ?? "")], it.text ?? "");
			}
			case "divider": if (it.type === "chapter") return h("article", { class: "tx rule chapter" }, h("p", null, m.head_chapter({ date: it.at ? new Date(it.at).toLocaleDateString(getLocale(), { year: "numeric", month: "short", day: "numeric" }) : "", why: chapterWhy(it.code, it.text) })));
				return h("article", { class: "tx rule" }, h("details", null, h("summary", null, it.type === "compaction" ? m.compacted({ tokens: (it.tokens ?? 0).toLocaleString() }) : m.branch_summary()), h("pre", null, it.text ?? "")));
			default: return h("article", { class: "tx note" }, it.text ?? "", " ", stamp(it));
		}
	}
	function paint(d: Delta, quietId?: string) {
		if (d.rebuild) {
			els.clear();
			list.replaceChildren();
		}
		for (const id of d.dropped) {
			els.get(id)?.remove();
			els.delete(id);
		}
		const made = d.added.map((it) => (els.set(it.id, render(it)), els.get(it.id)!));
		if (d.front) list.prepend(...made);
		else list.append(...made);
		// A message that just arrived or went out comes in with a motion; older pages and a redraw do not.
		if (loaded && !d.front && !d.rebuild) made.forEach((el, i) => d.added[i]!.id !== quietId && (el.classList.add("fresh"), (el.dataset.born = String(Date.now())))); // a quiet log (Zen) takes the entry that replaces the live text in place, with no fade
		empty.remove();
		const svc = who().service;
		empty.textContent = svc?.state === "standing" && !svc.run ? m.tower_empty() : m.no_transmissions(); // a tower the sb server stands in for says what standing by is
		if (!model.items.length) list.append(empty);
		top.hidden = !model.before;
		place();
	}
	// A divider for each run of the boss conversation: before the first entry written since the run began (the session file is one line of talk across runs, so the run's own start is the only marker).
	let convRuns: ConversationRun[] = [];
	const rules = new Map<string, { el: HTMLElement; sig: string }>();
	function place() {
		const shown = new Set<string>();
		for (const r of convRuns) {
			const at = Date.parse(r.startedAt), index = model.items.findIndex((it) => it.at !== undefined && Date.parse(it.at) >= at);
			if (index === 0 && model.before) continue; // it began before the part of the log that is mounted
			const anchor = index < 0 ? "" : model.items[index]!.id, sig = JSON.stringify([anchor, conversationDivider(r)]), old = rules.get(r.id);
			shown.add(r.id);
			if (old && old.sig === sig && old.el.isConnected) continue;
			old?.el.remove();
			const say = conversationDivider(r), el = h("article", { class: "tx rule conv-rule" }, h("div", null, h("b", null, say.title), say.ended ? h("small", null, say.ended) : null));
			rules.set(r.id, { el, sig });
			const before = anchor ? els.get(anchor) : undefined;
			before ? before.before(el) : list.append(el);
		}
		for (const [id, rule] of rules) if (!shown.has(id)) (rule.el.remove(), rules.delete(id));
	}
	// Calls that just received a result are redrawn in place; one that holds the reader's selection waits until the selection is gone (a redraw would drop it).
	const later = new Set<string>();
	const redraw = (id: string) => {
		const old = els.get(id), it = model.items.find((x) => x.id === id);
		later.delete(id);
		if (!old || !it) return;
		if (selectedIn(old)) return void later.add(id);
		const next = render(it);
		if (old.classList.contains("fresh") && Date.now() - Number(old.dataset.born ?? 0) < 400) next.classList.add("fresh"); // its motion goes on
		old.replaceWith(next);
		els.set(id, next);
	};
	const touch = (d: Delta) => d.touched.forEach(redraw);
	onSelectionEnd(scroller, () => ([...later].forEach(redraw), follow.pinned && !model.detached && !touching() && toBottom()));
	const older = async () => {
		if (loading || !model.before || !loaded) return;
		loading = true;
		try {
			const height = scroller.scrollHeight, d = model.prepend(await data.older(model.before));
			paint(d);
			touch(d);
			scroller.scrollTop += scroller.scrollHeight - height;
		} finally {
			loading = false;
		}
		// A page too short to scroll leaves the top in view: keep going.
		if (model.before && scroller.clientHeight && top.getBoundingClientRect().bottom >= scroller.getBoundingClientRect().top) void older();
	};
	pill.addEventListener("click", () => {
		target = undefined;
		if (model.detached) void data.latest().then((page) => (paint(model.reset(page)), toBottom()));
		else toBottom();
	});
	// Whether the log is at its top or its end is read off two sentinels (the end's is in its last pixel, with 80 px of margin below the log), so no geometry is read while it scrolls; a log that is not
	// rendered says nothing. An observer that watches anything makes every running animation cost a frame per vsync, so they watch only while the log scrolls and for a moment after (`watch`).
	const sentries = [new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && void older(), { root: scroller }), new IntersectionObserver((seen) => scroller.clientHeight && (follow.scrolled(seen.at(-1)!.isIntersecting), button()), { root: scroller, rootMargin: "0px 0px 67px" })] /* 80 px from the scroll end: the end line sits above 12 px of padding */;
	let watching: ReturnType<typeof setTimeout> | undefined;
	const watch = () => (watching ?? (sentries[0]!.observe(top), sentries[1]!.observe(foot)), clearTimeout(watching), (watching = setTimeout(() => ((watching = undefined), sentries.forEach((s) => s.disconnect())), 600)));
	scroller.addEventListener("scroll", () => (watch(), follow.moved(scroller.scrollTop, () => scroller.scrollHeight - scroller.clientHeight) && button(), !down && coast !== undefined && coasting()), { passive: true });
	scroller.addEventListener("wheel", (e) => e.deltaY < 0 && coasting(), { passive: true });
	scroller.addEventListener("keydown", (e) => (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) && coasting(), { passive: true });
	scroller.addEventListener("touchstart", () => ((down = true), clearTimeout(coast), (coast = undefined)), { passive: true });
	for (const end of ["touchend", "touchcancel"]) scroller.addEventListener(end, () => ((down = false), coasting()), { passive: true });
	// The user's own scroll ends the hold, and a later reconnect then opens at the end instead of at the anchor again.
	for (const input of ["wheel", "touchstart", "pointerdown", "keydown"]) scroller.addEventListener(input, () => (held = target = undefined), { passive: true });
	// Entries change height as they render (content-visibility estimates the rest), so a pinned log is kept at the bottom, and a held anchor in view.
	const keep = new ResizeObserver(() => (touching() ? follow.parked(scroller.scrollTop) : follow.pinned && !model.detached ? park() : held?.scrollIntoView({ block: "center" })));
	keep.observe(list);
	keep.observe(scroller);

	/** The run's message under way, after the last entry; "" takes it away. */
	const live = liveMode === "quiet" ? h("article", { class: "tx in live live-quiet" }, h("span", { class: "ava", "aria-hidden": "true" }), h("div", { class: "tx-body" }, h("p", { class: "live-text" }))) : h("article", { class: "tx live", "aria-live": "polite" }, h("small", { class: "live-tag" }, m.run_live_label()), h("p", { class: "live-text" }));
	function writing(text: string) {
		if (!text) return void live.remove();
		live.querySelector(".live-text")!.textContent = text;
		if (!live.isConnected || live.nextSibling) list.append(live);
		if (follow.pinned && !model.detached && !touching()) toBottom();
	}
	return {
		log: scroller,
		docs,
		box: () => blocks.forEach((ref) => {
			const view = ref.deref();
			if (view) view.refresh();
			else blocks.delete(ref);
		}),
		runs(rows) {
			if (JSON.stringify(rows) === JSON.stringify(convRuns)) return;
			convRuns = rows;
			place();
		},
		apply(e) {
			const replacement = pendingQuiet && !e.reset ? e.items?.find((it) => it.kind === "assistant") : undefined;
			if (e.reset || replacement) pendingQuiet = false;
			if (liveMode === "quiet" && e.live) pendingQuiet = true;
			// A headless run's message under way (src/watch.ts `live`): shown after the log's last entry until the session file has the message, which arrives as an entry and takes its place.
			if (e.live !== undefined || e.reset || e.items?.some((it) => it.kind === "assistant")) writing(e.live !== undefined ? e.live : "");
			if (e.reset) {
				paint(model.reset({ items: e.items ?? [], before: e.before }));
				loaded = true;
				settle();
			} else if (e.items?.length) {
				const d = model.append(e.items);
				paint(d, replacement?.id);
				touch(d);
				if (follow.arrived(d.added.length, selecting()) && !model.detached && !touching()) toBottom();
				else button();
			}
			if (live.isConnected) list.append(live); // the message under way stays the last thing in the log
		},
		reveal(at) {
			target = at;
			if (loaded) settle();
		},
	};
}
