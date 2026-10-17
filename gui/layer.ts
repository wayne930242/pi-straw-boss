import type { Item } from "../src/items.ts";
import { type Alert, createStack } from "./overlay.ts";
import { aim, byId, doing, fillPlate, html, mark, PLATE, sync, text } from "./render.ts";

// The overlay layer's DOM, a chunk fetched on the first alert, dialog, or tile: the HUD alert with its queue, the dialogs in the dock (stacked; the
// rules are in overlay.ts), and the tiles beside the current view. A tile is a document (show_doc in phase 3, a demo document in the dev fixture); tiles share the
// view's width side by side and turn into tabs when it runs out. Opening a tile never covers or closes a dialog, and a tile that
// arrives on its own shows beside the view without taking focus or the active tab.

export interface Tile { id: string; title: string; body(): HTMLElement }
export interface TilesIO { render(tiles: Tile[], active: string | undefined): void; enter(tile: Tile): void }
export const MAX_TILES = 4;

export function createTiles(io: TilesIO) {
	let tiles: Tile[] = [], active: string | undefined;
	const draw = () => io.render(tiles, active);
	return {
		get tiles() { return tiles; },
		get active() { return active; },
		/** `focus` is false for a tile that arrives on its own. Past four tiles the oldest closes. */
		open(tile: Tile, focus = true) {
			if (!tiles.some((t) => t.id === tile.id)) tiles = [...tiles, tile].slice(-MAX_TILES);
			if (focus || !tiles.some((t) => t.id === active)) active = tile.id;
			draw();
			if (focus) io.enter(tiles.find((t) => t.id === tile.id)!);
		},
		close(id: string) {
			const i = tiles.findIndex((t) => t.id === id);
			if (i < 0) return;
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

export interface PanelDeps { label(ws: string): string; recent(key: string): Promise<Item[]> }
const dialogEl = () => html(`<section class="dialog" role="dialog" aria-modal="false" tabindex="-1"><header><b class="tag">alert</b><span class="where"></span><button class="x" type="button" aria-label="Close">×</button></header><div class="who">${PLATE}<div><h3></h3><p><em class="role"></em> <span class="state"></span></p></div></div><div class="intel"><h4>Last transmission</h4><p class="said">…</p><p class="pending" hidden><b>waiting on</b> <span></span></p></div><footer><a class="go">Open comms</a><button class="later" type="button">Later</button><span class="queued"></span></footer></section>`);
const tileEl = () => html(`<section class="tile" tabindex="-1"><header><svg><use href="#i-doc"/></svg><b></b><button class="x" type="button" aria-label="Close document">×</button></header><div class="tile-body"></div></section>`);

export function mountPanels(deps: PanelDeps) {
	const [dock, work, row, tabs, button] = [byId("dock", HTMLElement), byId("work", HTMLElement), byId("tiles", HTMLElement), byId("tile-tabs", HTMLElement), byId("alerts", HTMLButtonElement)];
	// Read when the alert arrives (again on a new one), so Open comms lands on the entry the alert was about, not on what came after.
	const intels = new Map<string, Intel>();
	const tell = (el: HTMLElement, a: Alert, it = intels.get(a.key)) => {
		text(el, ".said", it?.failed ? "History unavailable." : (it?.said ?? "No messages yet."));
		el.querySelector<HTMLElement>(".pending")!.hidden = !it?.pending;
		text(el, ".pending span", it?.pending ?? "");
		aim(el.querySelector(".go")!, { view: "session", ws: a.ws, key: a.key, ...(it?.at && { at: it.at }) });
	};
	const learn = (a: Alert, wait: Intel = { said: "…" }) => {
		intels.set(a.key, wait);
		void deps.recent(a.key).then(intel, () => ({ failed: true })).then((it) => {
			const el = intels.get(a.key) === wait && (intels.set(a.key, it), dock.querySelector<HTMLElement>(`.dialog[data-key="${CSS.escape(a.key)}"]`));
			if (el) tell(el, a);
		});
	};
	const fill = (el: HTMLElement, a: Alert, depth: number, queued: number) => {
		mark(el, a.mark);
		// The ones beneath peek out above the top dialog, smaller and fainter.
		el.style.transform = depth ? `translateY(${-12 * depth}px) scale(${1 - 0.06 * depth})` : "";
		el.style.opacity = String(Math.max(0, 1 - 0.3 * depth));
		el.toggleAttribute("inert", depth > 0);
		el.setAttribute("aria-label", `${a.name}: ${doing(a.note, a.mark)}`);
		fillPlate(el.querySelector(".plate")!, a.role, a.mark);
		text(el, "h3", a.name);
		text(el, ".role", a.role === "outside" ? "unaligned" : a.role);
		text(el, ".state", doing(a.note, a.mark));
		text(el, ".where", deps.label(a.ws));
		text(el, ".tag", { waiting: "question", error: "error", done: "finished" }[a.mark as "done"] ?? "update");
		text(el, ".queued", queued ? `+${queued} queued` : "");
		if (!intels.has(a.key)) learn(a);
		tell(el, a);
	};
	const stack = createStack<HTMLElement>({
		render(open, queue) {
			sync(dock, open.map((a) => ({ ...a, id: a.key })), dialogEl, (el, a) => fill(el, a, open.length - 1 - open.findIndex((o) => o.key === a.key), queue.length));
			const head = queue[0];
			button.disabled = !head;
			button.dataset.mark = head?.mark ?? "unknown";
			text(button, "#alert-count", String(queue.length));
			text(button, "#alert-text", head ? `${head.name} · ${doing(head.note, head.mark)}` : "no alerts");
			sync(button.querySelector(".faces")!, queue.slice(0, 3).map((a) => ({ ...a, id: a.key })), () => html(PLATE), (face, a) => fillPlate(face, a.role, a.mark));
		},
		enter: (a) => dock.querySelector<HTMLElement>(`[data-key="${CSS.escape(a.key)}"] .go`)?.focus(),
		focused: () => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined),
		restore: (target) => Boolean(target?.isConnected && !target.closest("[inert]") && (target.focus(), document.activeElement === target)), // a disabled HUD alert does not take it
	});
	button.addEventListener("click", () => stack.next());
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
	return {
		tiles,
		stack,
		/** A snapshot's alerts: the new ones queue, and the queue drops the ones whose unit moved on. */
		alerts(fresh: Alert[], now: Map<string, Alert>) {
			for (const alert of fresh) learn(alert), stack.arrive(alert);
			stack.prune((key) => now.get(key));
		},
	};
}
