import type { Item } from "../src/items.ts";
import { mountAsk } from "./ask.ts";
import { keypad } from "./keypad.ts";
import { mountTerminals } from "./mirror.ts";
import { type Alert, createStack, tally } from "./overlay.ts";
import { m } from "./paraglide/messages.js";
import { type Answer, post } from "./post.ts";
import { aim, byId, doing, fillPlate, html, mark, PLATE, roleName, sync, text } from "./render.ts";

// The overlay layer's DOM, a chunk fetched on the first alert, dialog, or tile: the HUD alert with its queue, the dialogs in the dock (stacked; the
// rules are in overlay.ts), and the tiles beside the current view. A tile is a document (a demo document in the dev fixture) or a session's terminal (mirror.ts); tiles share the
// view's width side by side and turn into tabs when it runs out. Opening a tile never covers or closes a dialog, and a tile that
// arrives on its own shows beside the view without taking focus or the active tab.

/** `icon` names the header's symbol (a document by default); `closed` runs when the tile closes, by its × or pushed out by a fifth, or is refused. */
export interface Tile { id: string; title: string; body(): HTMLElement; icon?: string; closed?(): void }
export interface TilesIO { render(tiles: Tile[], active: string | undefined): void; enter(tile: Tile): void }
export const MAX_TILES = 4;
const CLICKABLE = "a, button, input, textarea, select, summary, label, [role=button]";

export function createTiles(io: TilesIO) {
	let tiles: Tile[] = [], active: string | undefined;
	const draw = () => io.render(tiles, active);
	return {
		get tiles() { return tiles; },
		get active() { return active; },
		/** `focus` is false for a tile that arrives on its own, which never pushes one out: with four open it is refused. Past four the oldest closes. */
		open(tile: Tile, focus = true) {
			if (!focus && tiles.length >= MAX_TILES && !tiles.some((t) => t.id === tile.id)) return void tile.closed?.();
			if (!tiles.some((t) => t.id === tile.id)) (tiles = [...tiles, tile]).slice(0, -MAX_TILES).forEach((t) => t.closed?.());
			tiles = tiles.slice(-MAX_TILES);
			if (focus || !tiles.some((t) => t.id === active)) active = tile.id;
			draw();
			if (focus) io.enter(tiles.find((t) => t.id === tile.id)!);
		},
		close(id: string) {
			const i = tiles.findIndex((t) => t.id === id);
			if (i < 0) return;
			tiles[i]!.closed?.();
			tiles = tiles.filter((t) => t.id !== id);
			if (active === id) active = (tiles[i] ?? tiles[i - 1])?.id;
			draw();
		},
		activate(id: string) {
			active = id;
			draw();
		},
	};
}

/** From a session's newest items when the alert arrives: its last line, the open tool call it waits on, and `at`, the entry Open comms lands on. */
export function intel(items: Item[]): Intel {
	const answered = new Set(items.flatMap((i) => (i.kind === "result" && i.callId ? [i.callId] : [])));
	const replies = items.filter((i) => i.kind === "assistant"), last = replies.at(-1);
	const open = last?.tools?.find((t) => !answered.has(t.id));
	const said = replies.findLast((i) => i.text?.trim())?.text?.trim().split("\n").filter(Boolean).at(-1);
	return { said: said?.slice(0, 280), pending: open && `${open.name} · ${open.summary}`.slice(0, 200), at: (last ?? items.findLast((i) => i.kind !== "result"))?.id };
}
export interface Intel { said?: string; pending?: string; at?: string; failed?: boolean }

/** `post` is the demo fixture's stand-in for the server's session endpoints; `stream` the newest `hello` of the page's stream, as it came. */
export type SessionPost = (action: string, body: Record<string, unknown>) => Promise<Answer>;
export interface PanelDeps { label(ws: string): string; recent(key: string): Promise<Item[]>; post?(key: string): SessionPost | undefined; stream(): string; showTerminal(ws: string, key: string): void }
const dialogEl = () => html(`<section class="dialog" role="dialog" aria-modal="false" tabindex="-1"><header><b class="tag">${m.dialog_alert()}</b><span class="where"></span><button class="x" type="button" aria-label="${m.close()}">×</button></header><div class="who">${PLATE}<div><h3></h3><p><em class="role"></em> <span class="state"></span></p></div></div><div class="intel"><h4>${m.last_transmission()}</h4><p class="said">…</p><p class="pending" hidden><b>${m.waiting_on()}</b> <span></span></p></div><div class="ask-root"></div><footer><a class="go">${m.open_comms()}</a><button class="later" type="button">${m.later()}</button><span class="queued"></span></footer></section>`);
const tileEl = () => html(`<section class="tile" tabindex="-1"><header><svg><use href="#i-doc"/></svg><b></b><button class="x" type="button" aria-label="${m.close_document()}">×</button></header><div class="tile-body"></div></section>`);

export function mountPanels(deps: PanelDeps) {
	const [dock, work, row, tabs, button] = [byId("dock", HTMLElement), byId("work", HTMLElement), byId("tiles", HTMLElement), byId("tile-tabs", HTMLElement), byId("alerts", HTMLButtonElement)];
	// Read when the alert arrives (again on a new one), so Open comms lands on the entry the alert was about, not on what came after.
	const intels = new Map<string, Intel>();
	const tell = (el: HTMLElement, a: Alert, it = intels.get(a.key)) => {
		const gone = el.dataset.gone === "true"; // a unit that left the net has no comms to open and nothing it waits on
		text(el, ".said", it?.failed ? m.history_unavailable() : (it?.said ?? m.no_messages()));
		el.querySelector<HTMLElement>(".pending")!.hidden = !it?.pending || gone;
		text(el, ".pending span", it?.pending ?? "");
		aim(el.querySelector(".go")!, gone ? undefined : { view: "session", ws: a.ws, key: a.key, ...(it?.at && { at: it.at }) });
	};
	const learn = (a: Alert, wait: Intel = { said: "…" }) => {
		intels.set(a.key, wait);
		void deps.recent(a.key).then(intel, () => ({ failed: true })).then((it) => {
			const el = intels.get(a.key) === wait && (intels.set(a.key, it), dock.querySelector<HTMLElement>(`.dialog[data-key="${CSS.escape(a.key)}"]`));
			if (el) tell(el, a);
		});
	};
	const fill = (el: HTMLElement, a: Alert, depth: number, queue: Alert[]) => {
		mark(el, a.mark);
		el.dataset.gone = String(Boolean(a.gone));
		// The ones beneath peek out above the top dialog, smaller and fainter.
		el.style.transform = depth ? `translateY(${-12 * depth}px) scale(${1 - 0.06 * depth})` : "";
		el.style.opacity = String(Math.max(0, 1 - 0.3 * depth));
		el.toggleAttribute("inert", depth > 0);
		el.setAttribute("aria-label", `${a.name}: ${doing(a.note, a.mark)}`);
		fillPlate(el.querySelector(".plate")!, a.role, a.mark);
		text(el, "h3", a.name);
		text(el, ".role", roleName(a.role));
		text(el, ".state", a.gone ? m.left_net() : doing(a.note, a.mark));
		text(el, ".where", deps.label(a.ws));
		text(el, ".tag", a.gone ? m.tag_gone() : ({ waiting: m.tag_question, error: m.tag_error, done: m.tag_finished }[a.mark as "done"] ?? m.tag_update)());
		text(el, ".queued", queue.length ? m.also_queued({ tally: tally(queue) }) : "");
		if (!intels.has(a.key)) learn(a);
		tell(el, a);
		let ask = asks.get(el);
		if (!ask) asks.set(el, (ask = mountAsk(el.querySelector(".ask-root")!, to(a.key), undefined, () => deps.showTerminal(a.ws, a.key))));
		ask.update(a.pending, a.mark === "waiting" && document.body.dataset.stale !== "true"); // what it waits on, answerable or not; the stream state redraws it (report in main.ts)
	};
	const asks = new WeakMap<HTMLElement, ReturnType<typeof mountAsk>>(), to = (key: string): SessionPost => deps.post?.(key) ?? ((action, body) => post(`sessions/${encodeURIComponent(key)}/${action}`, body));
	const stack = createStack<HTMLElement>({
		render(open, queue) {
			sync(dock, open.map((a) => ({ ...a, id: a.key })), dialogEl, (el, a) => fill(el, a, open.length - 1 - open.findIndex((o) => o.key === a.key), queue));
			const head = queue[0];
			button.disabled = !head;
			button.dataset.mark = head?.mark ?? "unknown";
			text(button, "#alert-count", String(queue.length));
			button.title = queue.length ? m.alerts_title({ tally: tally(queue) }) : "";
			text(button, "#alert-text", head ? `${head.name} · ${doing(head.note, head.mark)}` : m.no_alerts());
			sync(button.querySelector(".faces")!, queue.slice(0, 3).map((a) => ({ ...a, id: a.key })), () => html(PLATE), (face, a) => fillPlate(face, a.role, a.mark));
		},
		enter: (a) => dock.querySelector<HTMLElement>(`[data-key="${CSS.escape(a.key)}"] .go`)?.focus(),
		focused: () => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined),
		restore: (target) => Boolean(target?.isConnected && !target.closest("[inert]") && (target.focus(), document.activeElement === target)), // a disabled HUD alert does not take it
	});
	button.addEventListener("click", () => stack.next());
	// A dialog beneath the top one is inert, so a click on the part that peeks out falls through to the page: it raises that dialog instead,
	// unless the click really hit something that takes clicks (a HUD button or a link under the strip), which keeps it.
	document.addEventListener("click", (event) => {
		const at = (el: Element) => { const r = el.getBoundingClientRect(); return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom; };
		const all = [...dock.querySelectorAll<HTMLElement>(".dialog:not(.leaving)")], hit = all.slice(0, -1).reverse().find(at);
		if (event.defaultPrevented || !hit || !all.length || at(all.at(-1)!) || (event.target as Element | null)?.closest?.(CLICKABLE)) return; // a click another listener took (an alert link) or a control under the strip stays its
		event.preventDefault(), event.stopPropagation(), stack.raise(hit.dataset.key!);
	}, true);
	dock.addEventListener("click", (event) => {
		const target = event.target as Element;
		if (target.closest(".x")) stack.close();
		else if (target.closest(".later")) stack.close("later");
		// The link navigates to the unit's comms (the router takes the click); the dialog it came from is done, and nothing queued opens
		// over the comms the user is going to.
		else if (target.closest(".go")) queueMicrotask(() => void stack.close("go"));
	});

	let shown = 0;
	const fit = () => row.classList.toggle("tabbed", tiles.tiles.length > 1 && work.clientWidth < 460 + tiles.tiles.length * 400);
	const tiles = createTiles({
		render(list, active) {
			row.hidden = !list.length;
			sync(row, list, (t) => {
				const el = tileEl();
				el.querySelector("use")!.setAttribute("href", `#${t.icon ?? "i-doc"}`);
				el.querySelector(".x")!.setAttribute("aria-label", m.close_tile({ title: t.title }));
				el.querySelector(".tile-body")!.append(t.body());
				el.querySelector(".x")!.addEventListener("click", () => tiles.close(t.id));
				return el;
			}, (el, t) => {
				text(el, "header b", t.title);
				el.classList.toggle("active", t.id === active);
			});
			sync(tabs, list, () => html(`<button type="button" class="tab-btn"></button>`), (el, t) => {
				el.textContent = t.title;
				el.classList.toggle("active", t.id === active);
				el.onclick = () => tiles.activate(t.id);
			});
			row.prepend(tabs);
			if (list.length !== shown) {
				shown = list.length;
				fit();
			}
		},
		enter: (t) => requestAnimationFrame(() => row.querySelector<HTMLElement>(`.tile[data-key="${CSS.escape(t.id)}"]`)?.focus()),
	});
	new ResizeObserver(fit).observe(work);
	const terminal = mountTerminals({ tiles, post: to, stream: deps.stream, pad: keypad });
	return {
		tiles,
		stack,
		terminal,
		/** A snapshot's alerts: the new ones queue, and the queue drops the ones whose unit moved on. */
		alerts(fresh: Alert[], now: Map<string, Alert>) {
			for (const alert of fresh) void (learn(alert), stack.arrive(alert));
			stack.prune((key) => now.get(key));
		},
	};
}
