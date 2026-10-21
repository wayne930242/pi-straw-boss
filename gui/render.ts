import type { Mark } from "../src/dashboard.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import { mountCalm } from "./calm.ts";
import { replay } from "./dom.ts";
import type { Entry } from "./log.ts";
import { m } from "./paraglide/messages.js";
import { packets } from "./packets.ts";
import { aimBase, aimSquad, aimTower, aimUnit } from "./quit.ts";
import { formatRoute, type Route } from "./router.ts";

// Draws a net into the page by diffing: elements are keyed by id, created once, updated in place, and reordered, so only what changed
// is touched and CSS transitions play on state changes. Motion is CSS on transform and opacity only. The unit token (plate, icon, ring,
// badge) and the keyed `sync` are shared with the focus views, so a unit looks and moves the same on every route.

export const ICON: Record<string, string> = { main: "main", member: "member", subagent: "subagent", outpost: "outpost", outside: "outside", tower: "tower" };
export const LABEL: Record<Mark, () => string> = { commanding: m.mark_commanding, working: m.mark_working, waiting: m.mark_waiting, idle: m.mark_idle, done: m.mark_done, error: m.mark_error, unknown: m.mark_unknown };
const ROLE: Record<string, () => string> = { main: m.role_main, member: m.role_member, subagent: m.role_subagent, tower: m.role_tower, outpost: m.role_outpost, outside: m.role_outside, session: m.role_session };
/** The server's fixed status words; any other note (a subagent's tool or phase) shows as it is. */
const NOTE: Record<string, () => string> = { thinking: m.note_thinking, "watching a monitor": m.note_monitoring, idle: m.mark_idle, "waiting on a question": m.mark_waiting, finished: m.mark_done };
/** A role as the page names it; one it does not know shows as it is. */
export const roleName = (role: string) => (Object.hasOwn(ROLE, role) ? ROLE[role]!() : role);
/** Marks that ask for the user: a click on such a unit opens its alert instead of its route. */
export const urgent = (m: Mark) => m === "waiting" || m === "error";

/** Builds an element from one of the page's constant templates; data goes in afterwards through textContent and attributes only. */
export const html = (markup: string): HTMLElement => {
	const root = new DOMParser().parseFromString(markup.trim(), "text/html").body.firstElementChild;
	if (!(root instanceof HTMLElement)) throw new Error("bad template");
	return document.importNode(root, true);
};
export const byId = <T extends Element>(id: string, kind: new () => T): T => {
	const el = document.getElementById(id);
	if (!(el instanceof kind)) throw new Error(`#${id} is missing from the page`);
	return el;
};
export const text = (el: Element, selector: string, value: string) => {
	const node = el.querySelector(selector)!;
	if (node.textContent !== value) node.textContent = value;
};
/** Sets an element's state; a change (not the first value) plays the flash. */
export const mark = (el: HTMLElement, value: Mark) => {
	if (el.dataset.mark === value) return;
	const changed = el.dataset.mark !== undefined;
	el.dataset.mark = value;
	if (changed) replay(el, "flash");
};
/** "tool:edit" reads as "using edit". */
/** A failed monitor's alert notes `monitor:<status>:<what>` (alerts.ts). */
const monitorNote = (note: string) => ((i) => (note.slice(8, i) === "stale" ? m.monitor_stale : m.monitor_failed)({ what: note.slice(i + 1) }))(note.indexOf(":", 8));
export const doing = (note: string | undefined, mk: Mark) => (note ? (note.startsWith("tool:") ? m.using({ tool: note.slice(5) }) : note.startsWith("monitor:") ? monitorNote(note) : Object.hasOwn(NOTE, note) ? NOTE[note]!() : note) : LABEL[mk]());
/** Writes what a unit is doing into `selector`, flagged `data-monitoring` (red in style.css) while it only waits on a running monitor. */
export const say = (el: Element, selector: string, note: string | undefined, mk: Mark, value = doing(note, mk)) => {
	text(el, selector, value);
	el.querySelector(selector)!.toggleAttribute("data-monitoring", value === doing(note, mk) && note === "watching a monitor");
};
/** Points a link at a route: a real href, so middle-click and copy-link work, and data-route for the in-page router. */
export const aim = (a: Element, route: Route | undefined) => {
	a.toggleAttribute("hidden", !route);
	if (!route) return;
	a.setAttribute("href", formatRoute(route) || "./");
	a.setAttribute("data-route", formatRoute(route));
};
/** Hangs a header popover under its button, its right edge on the button's, kept inside the window. Call it on the popover's `toggle`. */
export const hang = (pop: HTMLElement, button: HTMLElement) => {
	const at = button.getBoundingClientRect(), width = pop.offsetWidth;
	pop.style.top = `${at.bottom + 8}px`;
	pop.style.left = `${Math.max(8, Math.min(at.right - width, innerWidth - width - 8))}px`;
};
/** The round unit token: icon, spinning ring, ping, and state badge. */
export const PLATE = `<div class="plate"><i class="ring"></i><svg><use href="#i-main"/></svg><b class="badge"></b></div>`;
/** `docs`: the unit's documents; those on screen in its terminal show as a scroll badge with their count. */
export function fillPlate(plate: HTMLElement, role: string, m: Mark, docs?: { onScreen: boolean }[]) {
	mark(plate, m);
	const use = plate.querySelector("use")!, href = `#i-${ICON[role] ?? "member"}`, n = docs?.filter((d) => d.onScreen).length;
	if (use.getAttribute("href") !== href) use.setAttribute("href", href);
	if (n) plate.dataset.docs = String(n);
	else delete plate.dataset.docs;
}

/** Reconciles the children of `parent` with `items`: new ones enter, gone ones leave, the rest keep their element and move into order. */
export function sync<T extends { id: string }>(parent: Element, items: T[], make: (item: T) => HTMLElement, fill: (el: HTMLElement, item: T) => void) {
	const live = new Map<string, HTMLElement>();
	for (const el of parent.children) if (!el.classList.contains("leaving") && (el as HTMLElement).dataset.key) live.set((el as HTMLElement).dataset.key!, el as HTMLElement);
	let cursor = parent.firstElementChild;
	for (const item of items) {
		let el = live.get(item.id);
		if (!el) {
			el = make(item);
			el.dataset.key = item.id;
			el.classList.add("enter");
			setTimeout(() => el!.classList.remove("enter"), 600);
		}
		live.delete(item.id);
		while (cursor?.classList.contains("leaving")) cursor = cursor.nextElementSibling;
		if (el === cursor) cursor = cursor.nextElementSibling;
		else parent.insertBefore(el, cursor);
		fill(el, item);
	}
	for (const el of live.values()) {
		el.classList.add("leaving");
		setTimeout(() => el.remove(), 400);
	}
}

const unitEl = () => html(`<div class="unit"><div class="card"><a class="hit"></a>${PLATE}<div class="meta"><span class="name"></span><span class="line"><em class="role"></em><span class="note"></span></span></div><button type="button" class="quit-btn" data-close="unit" hidden></button></div><div class="subs"></div></div>`);
function fillUnit(el: HTMLElement, u: Omit<Unit, "id" | "key" | "control" | "role" | "subs"> & { key?: string; control?: boolean; role: Unit["role"] | "outpost"; subs?: Unit[] }) {
	const ws = el.closest<HTMLElement>(".base")?.dataset.key, hit = el.querySelector(".hit")!;
	aim(hit, u.key && ws ? { view: "session", ws, key: u.key } : undefined);
	hit.setAttribute("aria-label", `${u.name}: ${doing(u.note, u.mark)}`);
	hit.toggleAttribute("data-alert", urgent(u.mark));
	mark(el, u.mark);
	fillPlate(el.querySelector(".plate")!, u.role, u.mark, u.docs);
	text(el, ".name", u.name);
	text(el, ".role", roleName(u.role));
	say(el, ".note", u.note, u.mark);
	aimUnit(el.querySelector(":scope > .card > .quit-btn")!, u);
	sync(el.querySelector(".subs")!, u.subs ?? [], unitEl, fillUnit);
}

/** Points an opening button at its base (main.ts opens the tile): a base with a tower takes mains, one without takes members, a squad only members. */
export function aimOpening(button: HTMLElement, b: Base, tab?: string) {
	const kind = b.tower ? "main" : "member";
	button.hidden = Boolean(tab && b.tower);
	button.dataset.open = kind;
	button.dataset.ws = b.id;
	if (tab) button.dataset.tab = tab;
	if (button.textContent !== (kind === "main" ? m.open_main() : m.open_member())) button.textContent = kind === "main" ? m.open_main() : m.open_member();
}

const baseEl = () => html(`<section class="base"><header><div class="tower"><i class="sweep"></i><i class="pulse"></i><svg><use href="#i-tower"/></svg><b class="badge"></b></div><div class="title"><span class="crown"><svg><use href="#i-crown"/></svg>${m.head_tower()}</span><h2><a class="enter-base"></a></h2><p></p><button type="button" class="quit-btn tower-quit" data-close="unit" hidden></button></div><button type="button" class="quit-btn" data-close="base"></button></header><div class="subs tower-subs"></div><div class="spawn-btns"><button type="button" class="pair-btn"></button></div><div class="tabs"></div><div class="outposts" data-label="${m.outposts()}"></div></section>`);
function fillBase(el: HTMLElement, b: Base) {
	mark(el, b.mark);
	el.classList.toggle("head", b.head);
	const tower = el.querySelector<HTMLElement>(".tower")!;
	tower.classList.toggle("ghost", !b.tower);
	mark(tower, b.tower?.mark ?? "unknown");
	text(el, "h2 a", b.label);
	aim(el.querySelector("h2 a")!, { view: "workspace", ws: b.id });
	text(el, ".title p", b.tower ? m.control_tower({ state: LABEL[b.tower.mark]() }) : m.no_tower());
	aimOpening(el.querySelector(".spawn-btns button")!, b);
	aimBase(el.querySelector("header > .quit-btn")!, b);
	aimTower(el.querySelector(".tower-quit")!, b.tower);
	sync(el.querySelector(".tower-subs")!, b.tower?.subs ?? [], unitEl, fillUnit);
	sync(el.querySelector(".tabs")!, b.tabs, () => html(`<div class="tab"><h3><span></span><button type="button" class="tab-add"></button><button type="button" class="quit-btn" data-close="tab"></button></h3><div class="units"></div></div>`), (tab, t) => {
		text(tab, "h3 span", m.tab_label({ label: t.label }));
		aimSquad(tab.querySelector(".quit-btn")!, b, t);
		aimOpening(tab.querySelector(".tab-add")!, b, t.id);
		sync(tab.querySelector(".units")!, t.units, unitEl, fillUnit);
	});
	sync(el.querySelector(".outposts")!, b.outposts.map((o) => ({ id: o.id, name: o.label, role: "outpost" as const, mark: o.mark, note: o.mark === "unknown" ? m.no_agent() : undefined })), unitEl, fillUnit);
}

/** Draws the head tower's wires to every other tower, with a packet travelling along each while one end of it works, in the map's own coordinates. */
function wire(map: HTMLElement, svg: SVGSVGElement, dots: HTMLElement, still: boolean) {
	const towers = [...map.querySelectorAll<HTMLElement>(".base:not(.leaving) .tower")];
	const head = map.querySelector<HTMLElement>(".base.head:not(.leaving) .tower");
	const box = map.getBoundingClientRect();
	const centre = (el: HTMLElement) => {
		const r = el.getBoundingClientRect();
		return [Math.round(r.x + r.width / 2 - box.x), Math.round(r.y + r.height / 2 - box.y)] as const;
	};
	const ends = !head ? [] : towers.filter((t) => t !== head);
	const wires = ends.map((t) => {
		const [[x1, y1], [x2, y2]] = [centre(head!), centre(t)];
		return { x1, y1, x2, y2, mid: Math.round((x1 + x2) / 2) };
	});
	const paths = wires.map(({ x1, y1, x2, y2, mid }) => `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`);
	const sig = paths.join("|");
	if (svg.dataset.sig !== sig) {
		svg.dataset.sig = sig;
		svg.replaceChildren(...paths.map((d) => ((line) => (line.setAttribute("class", "wire"), line.setAttribute("d", d), line))(document.createElementNS("http://www.w3.org/2000/svg", "path"))));
		dots.replaceChildren(...packets(wires, still));
	}
	dots.querySelectorAll<HTMLElement>(".packet").forEach((dot, i) => dot.toggleAttribute("data-live", ["working", "commanding"].includes(head!.dataset.mark ?? "") || ["working", "commanding"].includes(ends[i]!.dataset.mark ?? "")));
}

export interface Page { show(net: Net): void; stats(net: Net): void; log(entries: Entry[]): void; layout(): void; pause(paused: boolean): void }

export function mountPage(): Page {
	const [map, bases, links, dots, log] = [byId("map", HTMLElement), byId("bases", HTMLElement), byId("links", SVGSVGElement), byId("packets", HTMLElement), byId("log", HTMLElement)];
	const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const layout = () => !map.hidden && wire(map, links, dots, still);
	new ResizeObserver(layout).observe(map);
	mountCalm();
	return {
		layout,
		/** The totals in the header: drawn for every route, since the header is always in view. */
		stats(net) {
			const units = net.bases.flatMap((b) => [...(b.tower?.subs ?? []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs]))]);
			const count = (m?: Mark) => String(units.filter((u) => !m || u.mark === m).length);
			byId("s-commanding", HTMLElement).parentElement!.toggleAttribute("data-on", units.some((u) => u.mark === "commanding"));
			for (const [id, value] of [["s-bases", String(net.bases.length)], ["s-agents", count()], ["s-working", count("working")], ["s-commanding", count("commanding")], ["s-waiting", count("waiting")]] as const) byId(id, HTMLElement).textContent = value;
		},
		show(net) {
			sync(bases, net.bases, baseEl, fillBase);
			requestAnimationFrame(layout);
		},
		log(entries) {
			const time = new Date().toLocaleTimeString([], { hour12: false });
			for (const e of entries) {
				const li = html(`<li><span></span><time></time></li>`);
				li.dataset.mark = e.mark;
				text(li, "span", e.text);
				text(li, "time", time);
				log.prepend(li);
			}
			while (log.children.length > 12) log.lastElementChild!.remove();
		},
		pause(paused) {
			document.documentElement.classList.toggle("paused", paused);
		},
	};
}
