import type { Item } from "../src/items.ts";
import { mountAsk } from "./ask.ts";
import type { Hotkey } from "./hotkeys.ts";
import { keypad } from "./keypad.ts";
import { mountTerminals } from "./mirror.ts";
import { rankOf, unitOf } from "./alerts.ts";
import { type Alert, createStack, tally } from "./overlay.ts";
import { m } from "./paraglide/messages.js";
import { type Answer, post } from "./post.ts";
import { aim, byId, doing, fillPlate, hang, html, mark, PLATE, roleName, say, sync, text } from "./render.ts";

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
const dialogEl = () => html(`<section class="dialog" role="dialog" aria-modal="false" tabindex="-1"><header><b class="tag">${m.dialog_alert()}</b><span class="where"></span><button class="zoom" type="button"></button><button class="x" type="button" aria-label="${m.close()}">×</button></header><div class="who">${PLATE}<div><h3></h3><p><em class="role"></em> <span class="state"></span></p></div></div><div class="intel"><h4>${m.last_transmission()}</h4><p class="said">…</p><p class="pending" hidden><b>${m.waiting_on()}</b> <span></span></p></div><div class="ask-root"></div><footer><a class="go">${m.open_comms()}</a><button class="later" type="button">${m.later()}</button><span class="queued"></span></footer></section>`);
const doneEl = () => html(`<li><a class="done-go">${PLATE}<span><b class="name"></b><small></small></span></a></li>`);
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
		aim(el.querySelector(".go")!, gone ? undefined : { view: "session", ws: a.ws, key: unitOf(a), ...(it?.at && { at: it.at }) });
	};
	const learn = (a: Alert, wait: Intel = { said: "…" }) => {
		intels.set(a.key, wait);
		void deps.recent(unitOf(a)).then(intel, () => ({ failed: true })).then((it) => {
			const el = intels.get(a.key) === wait && (intels.set(a.key, it), dock.querySelector<HTMLElement>(`.dialog[data-key="${CSS.escape(a.key)}"]`));
			if (el) tell(el, a);
			if (a.mark === "done") drawDone(stack.queue);
		});
	};
	// Enlarge turns the dock into a wide panel in the middle of the window, for a long question; kept per browser. A phone has no Enlarge: its dialogs take the width.
	const wide = () => dock.classList.contains("wide");
	const zoom = (on: boolean) => {
		dock.classList.toggle("wide", on);
		try {
			localStorage.setItem("sb.dialog-wide", on ? "1" : "0");
		} catch {} // storage refused: this page keeps the size
		for (const b of dock.querySelectorAll<HTMLButtonElement>(".zoom")) drawZoom(b);
	};
	const drawZoom = (b: HTMLButtonElement) => {
		b.textContent = wide() ? "⤡" : "⤢";
		b.setAttribute("aria-pressed", String(wide()));
		b.setAttribute("aria-label", wide() ? m.dialog_shrink() : m.dialog_enlarge());
		b.title = b.getAttribute("aria-label")!;
	};
	try {
		dock.classList.toggle("wide", localStorage.getItem("sb.dialog-wide") === "1");
	} catch {}
	const fill = (el: HTMLElement, a: Alert, depth: number, queue: Alert[]) => {
		mark(el, a.mark);
		drawZoom(el.querySelector(".zoom")!);
		el.dataset.gone = String(Boolean(a.gone));
		// The ones beneath peek out above the top dialog, smaller and fainter.
		el.style.transform = depth ? `translateY(${-12 * depth}px) scale(${1 - 0.06 * depth})` : "";
		el.style.opacity = String(Math.max(0, 1 - 0.3 * depth));
		el.toggleAttribute("inert", depth > 0);
		el.setAttribute("aria-label", `${a.name}: ${doing(a.note, a.mark)}`);
		fillPlate(el.querySelector(".plate")!, a.role, a.mark);
		text(el, "h3", a.name);
		text(el, ".role", roleName(a.role));
		say(el, ".state", a.note, a.mark, a.gone ? m.left_net() : undefined);
		text(el, ".where", deps.label(a.ws));
		text(el, ".tag", a.gone ? m.tag_gone() : ({ waiting: m.tag_question, error: m.tag_error, done: m.tag_finished }[a.mark as "done"] ?? m.tag_update)());
		text(el, ".queued", queue.length ? m.also_queued({ tally: tally(queue) }) : "");
		el.querySelector<HTMLElement>(".later")!.hidden = rankOf(a.mark) !== 0; // a finished one is read once opened: nothing to keep for later
		if (!intels.has(a.key)) learn(a);
		tell(el, a);
		let ask = asks.get(el);
		if (!ask) asks.set(el, (ask = mountAsk(el.querySelector(".ask-root")!, to(unitOf(a)), undefined, () => deps.showTerminal(a.ws, unitOf(a)), () => el.isConnected && !el.classList.contains("leaving") && (stack.raise(el.dataset.key!), stack.close()))));
		ask.update(a.pending, a.mark === "waiting" && document.body.dataset.stale !== "true"); // what it waits on, answerable or not; the stream state redraws it (report in main.ts)
	};
	// Finished units wait under the HUD's Finished button, apart from what needs the user: a row goes to the unit's comms and clears it, Clear all clears every one.
	const [doneBtn, donePop, doneList] = [byId("done", HTMLButtonElement), byId("done-pop", HTMLElement), byId("done-list", HTMLElement)];
	const drawDone = (queue: Alert[]) => {
		const done = queue.filter((a) => rankOf(a.mark) !== 0);
		doneBtn.hidden = !done.length;
		doneBtn.textContent = `${m.finished_button()} ${done.length}`;
		doneBtn.title = m.finished_title();
		if (!done.length && donePop.matches(":popover-open")) donePop.hidePopover();
		sync(doneList, done.map((a) => ({ ...a, id: a.key })), doneEl, (el, a) => {
			const it = intels.get(a.key);
			fillPlate(el.querySelector(".plate")!, a.role, a.mark);
			text(el, ".name", a.name);
			text(el, "small", `${deps.label(a.ws)} · ${it?.said ?? doing(a.note, a.mark)}`);
			aim(el.querySelector(".done-go")!, { view: "session", ws: a.ws, key: unitOf(a), ...(it?.at && { at: it.at }) });
		});
	};
	byId("done-clear", HTMLButtonElement).textContent = m.clear_all();
	donePop.setAttribute("aria-label", m.finished_title());
	donePop.addEventListener("toggle", (event) => (event as ToggleEvent).newState === "open" && hang(donePop, doneBtn));
	// The router takes the row's click and goes to the comms; the row's unit is read.
	doneList.addEventListener("click", (event) => {
		const row = (event.target as Element).closest<HTMLElement>("li[data-key]");
		if (row) queueMicrotask(() => (stack.resolve([row.dataset.key!]), donePop.hidePopover()));
	});
	byId("done-clear", HTMLButtonElement).addEventListener("click", () => (stack.resolve(stack.queue.map((a) => a.key)), donePop.hidePopover()));
	const asks = new WeakMap<HTMLElement, ReturnType<typeof mountAsk>>(), to = (key: string): SessionPost => deps.post?.(key) ?? ((action, body) => post(`sessions/${encodeURIComponent(key)}/${action}`, body));
	const stack = createStack<HTMLElement>({
		render(open, queue) {
			sync(dock, open.map((a) => ({ ...a, id: a.key })), dialogEl, (el, a) => fill(el, a, open.length - 1 - open.findIndex((o) => o.key === a.key), queue));
			// The HUD alert holds what needs the user; finished units are in their own list.
			const asking = queue.filter((a) => rankOf(a.mark) === 0), head = asking[0];
			button.disabled = !head;
			button.dataset.mark = head?.mark ?? "unknown";
			text(button, "#alert-count", String(asking.length));
			button.title = asking.length ? m.alerts_title({ tally: tally(asking) }) : "";
			text(button, "#alert-text", head ? `${head.name} · ${doing(head.note, head.mark)}` : m.no_alerts());
			sync(button.querySelector(".faces")!, asking.slice(0, 3).map((a) => ({ ...a, id: a.key })), () => html(PLATE), (face, a) => fillPlate(face, a.role, a.mark));
			drawDone(queue);
		},
		// A dialog with a question to answer takes the focus on its first option; the others on Open comms.
		enter(a) {
			const el = dock.querySelector<HTMLElement>(`[data-key="${CSS.escape(a.key)}"]`);
			if (el && !asks.get(el)?.enter()) el.querySelector<HTMLElement>(".go")?.focus();
		},
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
		if (target.closest(".zoom")) zoom(!wide());
		else if (target.closest(".x")) stack.close();
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
		/** A page key (hotkeys.ts): Space is the HUD alert button's click, F the top dialog's ⤢ (a phone hides it). False when it had nothing to do. */
		hotkey(key: Hotkey) {
			if (key === "next") {
				if (button.disabled) return false;
				stack.next();
				return true;
			}
			const zoomer = [...dock.querySelectorAll<HTMLButtonElement>(".dialog:not(.leaving) .zoom")].at(-1);
			if (!zoomer?.getClientRects().length) return false;
			zoomer.click();
			return true;
		},
		/** A snapshot's alerts: the new ones queue, and the queue drops the ones whose unit moved on. */
		alerts(fresh: Alert[], now: Map<string, Alert>) {
			for (const alert of fresh) void (learn(alert), stack.arrive(alert));
			stack.prune((key) => now.get(key));
		},
	};
}
