import type { Mark } from "../src/dashboard.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import type { Entry } from "./log.ts";
import { formatRoute, type Route } from "./router.ts";

// Draws a net into the page by diffing: elements are keyed by id, created once, updated in place, and reordered, so only what changed
// is touched and CSS transitions play on state changes. Motion is CSS on transform and opacity only. The unit token (plate, icon, ring,
// badge) and the keyed `sync` are shared with the focus views, so a unit looks and moves the same on every route.

export const ICON: Record<string, string> = { main: "main", member: "member", subagent: "subagent", outpost: "outpost", outside: "outside", tower: "tower" };
export const LABEL: Record<Mark, string> = { working: "working", waiting: "waiting on a question", idle: "idle", done: "finished", error: "error", unknown: "no status" };
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
	if (changed) (el.classList.remove("flash"), void el.offsetWidth, el.classList.add("flash"));
};
/** "tool:edit" reads as "using edit". */
export const doing = (note: string | undefined, m: Mark) => (note ? note.replace(/^tool:/, "using ") : LABEL[m]);
/** Points a link at a route: a real href, so middle-click and copy-link work, and data-route for the in-page router. */
export const aim = (a: Element, route: Route | undefined) => {
	a.toggleAttribute("hidden", !route);
	if (!route) return;
	a.setAttribute("href", formatRoute(route) || "./");
	a.setAttribute("data-route", formatRoute(route));
};
/** The round unit token: icon, spinning ring, ping, and state badge. */
export const PLATE = `<div class="plate"><i class="ring"></i><svg><use href="#i-main"/></svg><b class="badge"></b></div>`;
export function fillPlate(plate: HTMLElement, role: string, m: Mark) {
	mark(plate, m);
	const use = plate.querySelector("use")!, href = `#i-${ICON[role] ?? "member"}`;
	if (use.getAttribute("href") !== href) use.setAttribute("href", href);
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

const unitEl = () => html(`<div class="unit"><div class="card"><a class="hit"></a>${PLATE}<div class="meta"><span class="name"></span><span class="line"><em class="role"></em><span class="note"></span></span></div></div><div class="subs"></div></div>`);
function fillUnit(el: HTMLElement, u: Omit<Unit, "id" | "key" | "control" | "role" | "subs"> & { key?: string; role: Unit["role"] | "outpost"; subs?: Unit[] }) {
	const ws = el.closest<HTMLElement>(".base")?.dataset.key, hit = el.querySelector(".hit")!;
	aim(hit, u.key && ws ? { view: "session", ws, key: u.key } : undefined);
	hit.setAttribute("aria-label", `${u.name}: ${doing(u.note, u.mark)}`);
	hit.toggleAttribute("data-alert", urgent(u.mark));
	mark(el, u.mark);
	fillPlate(el.querySelector(".plate")!, u.role, u.mark);
	text(el, ".name", u.name);
	text(el, ".role", u.role);
	text(el, ".note", doing(u.note, u.mark));
	sync(el.querySelector(".subs")!, u.subs ?? [], unitEl, fillUnit);
}

const baseEl = () => html(`<section class="base"><header><div class="tower"><i class="sweep"></i><i class="pulse"></i><svg><use href="#i-tower"/></svg><b class="badge"></b></div><div class="title"><span class="crown"><svg><use href="#i-crown"/></svg>head tower</span><h2><a class="enter-base"></a></h2><p></p></div></header><div class="tabs"></div><div class="outposts"></div></section>`);
function fillBase(el: HTMLElement, b: Base) {
	mark(el, b.mark);
	el.classList.toggle("head", b.head);
	const tower = el.querySelector<HTMLElement>(".tower")!;
	tower.classList.toggle("ghost", !b.tower);
	mark(tower, b.tower?.mark ?? "unknown");
	text(el, "h2 a", b.label);
	aim(el.querySelector("h2 a")!, { view: "workspace", ws: b.id });
	text(el, ".title p", b.tower ? `control tower · ${LABEL[b.tower.mark]}` : "no tower yet");
	sync(el.querySelector(".tabs")!, b.tabs, () => html(`<div class="tab"><h3></h3><div class="units"></div></div>`), (tab, t) => {
		text(tab, "h3", `tab ${t.label}`);
		sync(tab.querySelector(".units")!, t.units, unitEl, fillUnit);
	});
	sync(el.querySelector(".outposts")!, b.outposts.map((o) => ({ id: o.id, name: o.label, role: "outpost" as const, mark: o.mark, note: o.mark === "unknown" ? "no agent running" : undefined })), unitEl, fillUnit);
}

/** Draws the head tower's wires to every other tower, with a packet travelling along each, in the map's own coordinates. */
function wire(map: HTMLElement, svg: SVGSVGElement, still: boolean) {
	const towers = [...map.querySelectorAll<HTMLElement>(".base:not(.leaving) .tower")];
	const head = map.querySelector<HTMLElement>(".base.head:not(.leaving) .tower");
	const box = map.getBoundingClientRect();
	const centre = (el: HTMLElement) => {
		const r = el.getBoundingClientRect();
		return [Math.round(r.x + r.width / 2 - box.x), Math.round(r.y + r.height / 2 - box.y)] as const;
	};
	const paths = !head ? [] : towers.filter((t) => t !== head).map((t) => {
		const [[x1, y1], [x2, y2]] = [centre(head), centre(t)], mid = Math.round((x1 + x2) / 2);
		return `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
	});
	const sig = paths.join("|");
	if (svg.dataset.sig === sig) return;
	svg.dataset.sig = sig;
	const ns = "http://www.w3.org/2000/svg";
	const make = (tag: string, attrs: Record<string, string>, ...kids: Element[]) => {
		const node = document.createElementNS(ns, tag);
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
		node.append(...kids);
		return node;
	};
	svg.replaceChildren(...paths.flatMap((d) => [make("path", { class: "wire", d }), ...(still ? [] : [make("circle", { class: "packet", r: "3" }, make("animateMotion", { dur: "5s", repeatCount: "indefinite", path: d }))])]));
}

export interface Page { show(net: Net): void; stats(net: Net): void; log(entries: Entry[]): void; layout(): void; pause(paused: boolean): void; still(map: boolean): void }

export function mountPage(): Page {
	const [map, bases, links, log] = [byId("map", HTMLElement), byId("bases", HTMLElement), byId("links", SVGSVGElement), byId("log", HTMLElement)];
	const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const layout = () => !map.hidden && wire(map, links, still);
	new ResizeObserver(layout).observe(map);
	return {
		layout,
		/** The totals in the header: drawn for every route, since the header is always in view. */
		stats(net) {
			const units = net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs])));
			const count = (m?: Mark) => String(units.filter((u) => !m || u.mark === m).length);
			for (const [id, value] of [["s-bases", String(net.bases.length)], ["s-agents", count()], ["s-working", count("working")], ["s-waiting", count("waiting")]] as const) byId(id, HTMLElement).textContent = value;
		},
		show(net) {
			sync(bases, net.bases, baseEl, fillBase);
			byId("empty", HTMLElement).hidden = net.bases.length > 0;
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
		/** The wires' SVG animation runs only while the map is in view. */
		still(hidden) {
			if (hidden) links.pauseAnimations();
			else links.unpauseAnimations();
		},
	};
}
