import type { Chat, Data, HistoryEvent, Who } from "./chat.ts";
import { h } from "./dom.ts";
import { locate } from "./scene.ts";
import type { Net } from "../src/net.ts";

// An item's 「Context」 in Zen (docs/specs/2026-11-01-zen-view.md): the unit's session log, read-only, expanded inside its card on a tap or H and collapsed by the same or Esc. The log is a chunk of
// its own and nothing of it is fetched, mounted, or watched until the first expand; a collapse drops it again. The answer stays possible while it is open: the history is what the boss reads to decide.

/** Whether a unit has a session log to show: a tower only while it runs one; every pi pane (an outside one too) has its session file. */
export function hasHistory(net: Net | undefined, key: string): boolean {
	const hit = locate(net, key);
	if (!hit) return false;
	if (hit.u.role === "tower") return Boolean((hit.u as { service?: { run?: unknown } }).service?.run);
	return true;
}

export interface HistoryDeps {
	key: string;
	chat(): Promise<(root: HTMLElement, data: Data, deps: { who(): Who; link(): undefined; away(): boolean; live?: "quiet" }) => Chat>;
	data(key: string): Data;
	who(): Who;
	/** The unit is a remote base's and its box takes no input now: the log's blocks cannot be submitted. */
	away(): boolean;
	watch(key: string | null): void;
	/** Called after the open state changed (the layer draws its timer again). */
	changed(): void;
}

export function mountHistory(d: HistoryDeps) {
	const host = h("div", { class: "zen-history", role: "region", id: `zen-history-${d.key.replace(/[^\w-]/g, "_")}` }), log = h("div", { class: "zen-log" });
	host.hidden = true;
	host.setAttribute("aria-label", "");
	host.append(log);
	let turn = 0, chat: Chat | undefined, queue: HistoryEvent[] = [], late: HistoryEvent[] | undefined, seen = false, on = false;
	function open() {
		if (on) return;
		on = true;
		host.hidden = false;
		const mine = ++turn;
		[chat, queue, late, seen] = [undefined, [], undefined, false];
		d.watch(d.key);
		void d.chat().then((mountChat) => {
			if (mine !== turn) return;
			const c = (chat = mountChat(log, d.data(d.key), { who: d.who, link: () => undefined, away: d.away, live: "quiet" }));
			c.reveal();
			queue.splice(0).forEach((e) => c.apply(e));
			if (!seen) {
				const pending = (late = []); // the stream may already watch this key and send no reset
				void d.data(d.key).latest().then((page) => {
					late = undefined;
					if (!seen && mine === turn) (c.apply({ key: d.key, reset: true, items: page.items, before: page.before }), pending.forEach((e) => c.apply(e)));
				}, () => void (late = undefined));
			}
		});
		d.changed();
	}
	function close(focus?: HTMLElement) {
		if (!on) return;
		if (focus && host.contains(document.activeElement)) focus.focus();
		on = false;
		turn++;
		host.hidden = true;
		log.replaceChildren();
		[chat, queue] = [undefined, []];
		d.watch(null);
		d.changed();
	}
	return {
		el: host,
		key: d.key,
		isOpen: () => on,
		/** The box may have come or gone. */
		box: () => chat?.box(),
		open,
		close,
		toggle: (focus?: HTMLElement) => (on ? close(focus) : open()),
		apply(e: HistoryEvent) {
			if (!on || e.key !== d.key) return;
			seen ||= Boolean(e.reset);
			if (!e.reset) late?.push(e);
			chat ? chat.apply(e) : queue.push(e);
		},
	};
}
