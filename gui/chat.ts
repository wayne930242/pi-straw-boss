import type { Pending } from "../src/ask.ts";
import type { Mark } from "../src/dashboard.ts";
import type { Shelf } from "../src/documents.ts";
import type { Item, Todo } from "../src/items.ts";
import { h } from "./dom.ts";
import { createFollow, reach } from "./follow.ts";
import { mount, parse } from "./markdown.ts";
import type { Post } from "./composer.ts";
import { m } from "./paraglide/messages.js";
import { html, ICON } from "./render.ts";

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

export interface HistoryEvent { key: string; state?: string; successor?: string; base?: string; name?: string; role?: string; reset?: boolean; items?: Item[]; before?: string; header?: { id?: string; cwd?: string }; unreadable?: number; todos?: Todo[] | null }
/** `post` stands in for the server's input API (composer.ts) in the dev fixture. */
export interface Data { older(before: string): Promise<Page>; latest(): Promise<Page>; entry(id: string): Promise<Item | undefined>; post?: Post }
export interface Who extends Shelf { key: string; name: string; role: string; mark: Mark; note?: string; control?: boolean; pending?: Pending }
/** `docFor` opens the document a show_doc path names while its session lists it (doc.ts), or is undefined. */
export interface ChatDeps { who(): Who; link(name: string): HTMLAnchorElement | undefined; docFor?(path: string): (() => void) | undefined }
/** `reveal` opens the log at an entry (scrolled into view and lit), or with none at the newest entry. `log` is the scrolling log, a focus target. `docs` shows Open beside on the show_doc cards whose document is listed now. */
export interface Chat { apply(event: HistoryEvent): void; setLive(text: string, mark: Mark): void; reveal(at?: string): void; docs(): void; log: HTMLElement }

const clock = (at?: string) => (at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const size = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} KB` : `${n} B`);
const NOTICE: Record<string, () => string> = { intercom_message: m.notice_intercom, subagent_result: m.notice_result, subagent_ping: m.notice_ping, subagent_status: m.notice_status, "pi-loop-monitor": m.notice_monitor, "memory-context": m.notice_memory, "doc-review": m.notice_doc_review };
const icon = (name: string) => {
	const span = html(`<span class="ava"><svg><use/></svg></span>`);
	span.querySelector("use")!.setAttribute("href", `#i-${ICON[name] ?? name}`);
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

export function mountChat(root: HTMLElement, data: Data, { who, link, docFor }: ChatDeps): Chat {
	const model = createChat(), els = new Map<string, HTMLElement>(), opens = new Set<{ paths: string[]; button: HTMLButtonElement; shown?: boolean }>(); // a card the log dropped leaves it
	const docs = () => opens.forEach((o) => (o.button.isConnected ? ((o.shown = true), (o.button.hidden = !o.paths.some((p) => docFor?.(p)))) : o.shown && opens.delete(o)));
	const list = h("div", { class: "chat-list" }), top = h("div", { class: "chat-top" }), live = h("div", { class: "chat-live" }), pill = h("button", { class: "chat-pill", type: "button", hidden: "" }), empty = h("p", { class: "chat-empty" }, m.no_transmissions());
	const scroller = h("div", { class: "chat-scroll", tabindex: "-1", "aria-label": m.comms_log() }, top, list, live);
	root.replaceChildren(scroller, pill);
	const follow = createFollow();
	let loading = false, loaded = false, target: string | undefined, held: HTMLElement | undefined, release = 0;
	const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	const button = (label = follow.button(model.detached)) => ((pill.hidden = !label), (pill.textContent = label ?? ""));
	const toBottom = () => (follow.jump(), (held = undefined), (scroller.scrollTop = scroller.scrollHeight), button());
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
		el.classList.remove("lit");
		void el.offsetWidth;
		el.classList.add("lit");
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
		return h("details", { class: "act" }, h("summary", { "data-mark": r ? (r.isError ? "error" : "done") : "working" }, h("b", { class: "badge" }), h("code", null, t.name), h("span", { class: "sum" }, t.summary), open), args, whole, r && h("div", { class: "result" }, r.images ? h("em", null, m.images({ count: r.images })) : null, body, more));
	}
	function render(it: Item): HTMLElement {
		const stamp = h("time", null, clock(it.at));
		switch (it.kind) {
			case "user": return h("article", { class: "tx you" }, h("header", null, stamp, h("b", null, m.you()), icon("user")), h("div", { class: "bubble" }, ...plain(it.text ?? ""), it.images ? h("em", null, ` · ${m.images({ count: it.images })}`) : null));
			case "assistant": {
				const me = who(), body = h("pre", { class: "thought-text" }), more = it.thought ? h("button", { class: "thought", type: "button" }, it.thought < 0 ? m.thought_redacted() : m.thought_chars({ count: it.thought.toLocaleString() })) : null;
				if (it.thought && it.thought > 0) more?.addEventListener("click", () => fetchBody(more, body, it.id, (full) => full.thoughtText));
				return h("article", { class: "tx in" }, icon(me.role), h("div", { class: "tx-body" }, h("header", null, h("b", null, me.name), it.model ? h("span", null, it.model) : null, stamp, it.stop ? h("span", { class: "stop", "data-mark": "error" }, it.stop) : null), more, body, it.text ? h("div", { class: "md" }, mount(parse(it.text))) : null, it.error ? h("p", { class: "fault" }, it.error) : null, ...(it.tools ?? []).map((t) => action(t, it.id))));
			}
			case "bash": return h("article", { class: "tx sys" }, h("details", { class: "act" }, h("summary", { "data-mark": it.exit ? "error" : "done" }, h("b", { class: "badge" }), h("code", null, "shell"), h("span", { class: "sum" }, `! ${it.command}`), it.exit ? h("span", { class: "stop", "data-mark": "error" }, m.exit_code({ code: it.exit })) : null), it.text ? h("pre", { class: "out" }, it.text) : null));
			case "notice": return h("article", { class: "tx sys" }, h("details", { class: "notice" }, h("summary", null, icon("comms"), h("em", null, m.incoming()), NOTICE[it.type ?? ""]?.() ?? it.type ?? m.notice(), " ", (it.from && link(it.from)) || (it.from ?? ""), stamp), h("pre", null, it.text ?? "")));
			case "divider": return h("article", { class: "tx rule" }, h("details", null, h("summary", null, it.type === "compaction" ? m.compacted({ tokens: (it.tokens ?? 0).toLocaleString() }) : m.branch_summary()), h("pre", null, it.text ?? "")));
			default: return h("article", { class: "tx note" }, it.text ?? "", " ", stamp);
		}
	}
	function paint(d: Delta) {
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
		if (loaded && !d.front && !d.rebuild) made.forEach((el) => (el.classList.add("fresh"), (el.dataset.born = String(Date.now()))));
		empty.remove();
		if (!model.items.length) list.append(empty);
		top.hidden = !model.before;
	}
	// Calls that just received a result are redrawn in place.
	const touch = (d: Delta) => d.touched.forEach((id) => {
		const old = els.get(id), it = model.items.find((x) => x.id === id);
		if (old && it) {
			const next = render(it);
			if (old.classList.contains("fresh") && Date.now() - Number(old.dataset.born ?? 0) < 400) next.classList.add("fresh"); // its motion goes on
			old.replaceWith(next);
			els.set(id, next);
		}
	});
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
	new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && void older(), { root: scroller }).observe(top);
	pill.addEventListener("click", () => {
		target = undefined;
		if (model.detached) void data.latest().then((page) => (paint(model.reset(page)), toBottom()));
		else toBottom();
	});
	scroller.addEventListener("scroll", () => (follow.scrolled(atBottom()), button()), { passive: true });
	// The user's own scroll ends the hold, and a later reconnect then opens at the end instead of at the anchor again.
	for (const input of ["wheel", "touchstart", "pointerdown", "keydown"]) scroller.addEventListener(input, () => (held = target = undefined), { passive: true });
	// Entries change height as they render (content-visibility estimates the rest), so a pinned log is kept at the bottom, and a held anchor in view.
	const keep = new ResizeObserver(() => (follow.pinned && !model.detached ? (scroller.scrollTop = scroller.scrollHeight) : held?.scrollIntoView({ block: "center" })));
	keep.observe(list);
	keep.observe(scroller);

	return {
		log: scroller,
		docs,
		apply(e) {
			if (e.reset) {
				paint(model.reset({ items: e.items ?? [], before: e.before }));
				loaded = true;
				settle();
			} else if (e.items?.length) {
				const d = model.append(e.items);
				paint(d);
				touch(d);
				if (follow.arrived(d.added.length) && !model.detached) toBottom();
				else button();
			}
		},
		reveal(at) {
			target = at;
			if (loaded) settle();
		},
		/** The unit's live state under the last transmission, with the same badge (spinner, hopping ?) as its token. */
		setLive(text, m) {
			live.dataset.mark = m;
			if (live.lastChild?.textContent !== text) live.replaceChildren(...(text ? [h("b", { class: "badge" }), h("span", null, text)] : []));
		},
	};
}
