import type { Mark } from "../src/dashboard.ts";
import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { MODAL } from "./hotkeys.ts";
import { m } from "./paraglide/messages.js";
import type { Locale } from "./paraglide/runtime.js";
import { aim, fillPlate, html, mark, PLATE, roleName, say, sync, text } from "./render.ts";
import type { Route } from "./router.ts";
import { chainOf, ignored, intent, settles } from "./swipe.ts";

// The phone's quick switch: a swipe to the right from anywhere pulls a drawer out of the left edge, a condensed map of the net, one row per unit grouped
// as the map groups them (the base, its tower, each tab, the units outside the net) with the map's own plate, colours, and names, plus one short word
// for its state. Tapping a row goes to that unit's comms and shuts the drawer, as does a swipe to the left, a tap on the veil, or Escape. It follows the
// finger while dragged and settles open or shut on release (swipe.ts has the rules). Only the phone layout has it; it stays current with the net.

export interface Row { id: string; key: string; ws: string; name: string; role: string; mark: Mark; note?: string; ended: boolean; sub: boolean }
export interface Group { id: string; label?: string; rows: Row[] }
export interface Section { id: string; label: string; mark: Mark; groups: Group[] }
type Who = { key: string; name: string; role: string; mark: Mark; note?: string; ended?: boolean; subs: Who[] };

const SHORT: Record<Mark, typeof m.short_working> = { working: m.short_working, waiting: m.short_waiting, idle: m.short_idle, done: m.short_done, error: m.short_error, unknown: m.short_unknown, commanding: m.short_commanding };
/** A unit's state in one short word (a finished subagent: ended). */
export const shortState = (state: Mark, ended: boolean, locale?: Locale) => (ended ? m.short_done : SHORT[state])({}, locale && { locale });

const rows = (ws: string, units: Who[]): Row[] => units.flatMap((u) => [u, ...u.subs.map((c) => ({ ...c, sub: true }))].map((x): Row => ({ id: x.key, key: x.key, ws, name: x.name, role: x.role, mark: x.mark, note: x.note, ended: Boolean(x.ended), sub: "sub" in x })));
/** Every unit of every base, in the map's groups: the tower with its subagents, each tab's units with theirs, then the units outside the net. A base with nothing in it is left out. */
export function groupUnits(net: Net): Section[] {
	return net.bases.flatMap((b) => {
		const groups: Group[] = [
			{ id: "tower", rows: b.tower ? rows(b.id, [{ ...b.tower, role: "tower" }]) : [] },
			...b.tabs.map((t) => ({ id: t.id, label: m.tab_label({ label: t.label }), rows: rows(b.id, t.units) })),
			{ id: "outside", label: m.outside_net(), rows: rows(b.id, b.outside) },
		].filter((g) => g.rows.length);
		return groups.length ? [{ id: b.id, label: b.label, mark: b.mark, groups }] : [];
	});
}

/** A group's rows with each subagent under the unit before it, as the map hangs them. */
const nest = (list: Row[]) => list.reduce<(Row & { subs: Row[] })[]>((out, r) => (r.sub ? out.at(-1)?.subs.push(r) : out.push({ ...r, subs: [] }), out), []);
const unitEl = () => html(`<div class="unit"><div class="card"><a class="hit"></a>${PLATE}<div class="meta"><span class="name"></span><span class="line"><em class="role"></em><b class="dstate"></b><span class="note"></span></span></div></div><div class="subs"></div></div>`);
const sectionEl = () => html(`<section class="dbase"><h3><a></a><small></small></h3><div class="dgroups"></div></section>`);
const groupEl = () => html(`<div class="dgroup"><h4></h4><div class="drows"></div></div>`);
const phone = () => matchMedia("(max-width: 640px)").matches;

export function mountDrawer() {
	const body = h("div", { class: "drawer-body" }), close = h("button", { type: "button", class: "x", "aria-label": m.drawer_close() }, "×");
	const panel = h("aside", { class: "drawer", "aria-label": m.drawer_label() }, h("header", null, h("b", null, m.drawer_title()), close), body), veil = h("div", { class: "drawer-veil" });
	document.body.append(veil, panel);
	let latest: Net | undefined, here: string | undefined, open = false, x = 0, width = 0, t: { x0: number; y0: number; mode: "wait" | "drag" | "pass"; was: boolean; base: number; last: number; at: number; v: number } | undefined;
	const draw = () => {
		const fillRow = (el: HTMLElement, r: Row & { subs?: Row[] }) => {
			aim(el.querySelector(".hit")!, { view: "session", ws: r.ws, key: r.key });
			el.querySelector(".hit")!.setAttribute("aria-label", `${r.name}: ${shortState(r.mark, r.ended)}`);
			el.classList.toggle("current", r.key === here);
			mark(el, r.mark);
			fillPlate(el.querySelector(".plate")!, r.role, r.mark);
			text(el, ".name", r.name);
			text(el, ".role", roleName(r.role));
			text(el, ".dstate", shortState(r.mark, r.ended));
			say(el, ".note", r.note, r.mark, r.note ? undefined : "");
			sync(el.querySelector(".subs")!, r.subs ?? [], unitEl, fillRow);
		};
		sync(body, groupUnits(latest ?? { bases: [] }), sectionEl, (el, s) => {
			mark(el, s.mark);
			text(el, "h3 a", s.label);
			aim(el.querySelector("h3 a")!, { view: "workspace", ws: s.id });
			text(el, "small", m.unit_count({ count: s.groups.reduce((n, g) => n + g.rows.length, 0) }));
			sync(el.querySelector(".dgroups")!, s.groups, groupEl, (g, group) => {
				text(g, "h4", group.label ?? "");
				g.querySelector("h4")!.toggleAttribute("hidden", !group.label);
				sync(g.querySelector(".drows")!, nest(group.rows), unitEl, fillRow);
			});
		});
	};
	/** Puts the drawer `px` out of the left edge (0 hides it, its width shows it whole) and dims the page behind it to match. */
	const place = (px: number) => {
		x = Math.max(0, Math.min(width, px));
		panel.style.setProperty("--dx", `${x}px`);
		veil.style.opacity = String(width ? x / width : 0);
		veil.style.pointerEvents = x > 0 ? "auto" : "none";
	};
	const settle = (to: boolean) => {
		open = to;
		panel.classList.toggle("on", to);
		panel.inert = !to;
		document.documentElement.classList.remove("drawer-drag");
		place(to ? width : 0);
	};
	const begin = () => {
		width = panel.offsetWidth;
		draw();
		panel.classList.add("on");
		document.documentElement.classList.add("drawer-drag");
	};
	panel.inert = true;
	document.addEventListener("touchstart", (e) => {
		const el = e.target as Element, inside = panel.contains(el) || el === veil;
		t = undefined;
		if (!phone() || e.touches.length !== 1 || document.querySelector(MODAL) || (open ? !inside : ignored(chainOf(el), Boolean(getSelection()?.toString())))) return;
		const p = e.touches[0]!;
		t = { x0: p.clientX, y0: p.clientY, mode: "wait", was: open, base: x, last: p.clientX, at: performance.now(), v: 0 };
	}, { passive: true });
	document.addEventListener("touchmove", (e) => {
		if (!t || t.mode === "pass") return;
		const p = e.touches[0]!, dx = p.clientX - t.x0, dy = p.clientY - t.y0;
		if (t.mode === "wait") {
			const read = intent(dx, dy, t.was);
			if (read === "wait") return;
			if (read === "pass") return void (t.mode = "pass");
			t.mode = "drag";
			begin();
		}
		e.preventDefault(); // a drag under way is the drawer's; a vertical move never gets here
		const now = performance.now();
		t.v = (p.clientX - t.last) / Math.max(1, now - t.at);
		[t.last, t.at] = [p.clientX, now];
		place(t.base + dx);
	}, { passive: false });
	const lift = () => {
		const done = t;
		t = undefined;
		if (done?.mode === "drag") settle(settles(x, width, done.v));
	};
	document.addEventListener("touchend", lift);
	document.addEventListener("touchcancel", lift);
	veil.addEventListener("click", () => settle(false));
	panel.addEventListener("click", (e) => (e.target as Element).closest("a[data-route], .x") && settle(false)); // the router goes on to the unit
	document.addEventListener("keydown", (e) => open && e.key === "Escape" && (e.preventDefault(), settle(false)), true);
	document.addEventListener("sb-drawer", () => (open || begin(), settle(!open))); // the demo's toolbar
	return {
		/** The net as it is now; the list follows it while the drawer is out. */
		net(next: Net) {
			latest = next;
			if (open) draw();
		},
		/** The route shown, so its unit is marked in the list. */
		route(r: Route) {
			here = r.view === "session" ? r.key : undefined;
			if (open) draw();
		},
	};
}
export type Drawer = ReturnType<typeof mountDrawer>;
