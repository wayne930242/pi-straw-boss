import type { BoardViewRow, CapView } from "../src/boardview.ts";
import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { iconRef } from "./icons.ts";
import { noun } from "./nouns.ts";
import { m } from "./sentences.ts";

// The supply board on the head page (docs/specs/2026-11-24-capacity-supply/spec.md): the device's budget drawn as 1-point slots, each deployed unit a chip that spans its points, the free slots
// (a soft pulse only while the device is flagged under capacity), the barracks with the ready work, the fold's mini slots, each main's units, and the teammate devices. One DOM for every view:
// Standard draws it as the frames show, Raven Keep (themes/raven: its sprite, sentences, and sheet) as candle graves and the keep's gate, and Geek hides it for the plain lines (geek.css).
// Unit names come from this computer's device row (`BoardViewRow.units`), which no link, remote turn, or operate slice carries; a teammate device shows only what crosses (its label, online).

/** Slots drawn at most, in the tray and in the fold: a larger budget still counts right in the words. */
export const MAX_CELLS = 60;
export interface Chip { name: string; points: number; cells: number; start: number }
export interface Tray { chips: Chip[]; filler: number; free: number; budget?: number; under: boolean }

const NS = "http://www.w3.org/2000/svg", EPS = 1e-9;
const pts = (n: number) => String(Math.round(n * 100) / 100), two = (n: number) => String(n + 1).padStart(2, "0");
/** A `<svg><use>` of a sprite icon (icons.ts: the view's own when its sprite has it), hidden from assistive technology: the words beside it say the same. */
export function icon(name: string, cls = "supply-icon"): SVGSVGElement {
	const svg = document.createElementNS(NS, "svg"), use = document.createElementNS(NS, "use");
	svg.setAttribute("class", cls);
	svg.setAttribute("aria-hidden", "true");
	use.setAttribute("data-icon", name);
	use.setAttribute("href", iconRef(name));
	svg.append(use);
	return svg;
}

/** The tray's layout: the live rows' units in order, each taking whole slots (half a point takes one); the points no unit names (a train no todo names) fill used slots; the rest of the budget is free. */
export function trayOf(c: CapView, rows: BoardViewRow[]): Tray {
	let at = 0;
	const chips = rows.filter((r) => r.state !== "ended").flatMap((r) => r.units ?? []).map((u): Chip => {
		const cells = Math.max(1, Math.ceil(u.points - EPS)), chip = { name: u.name, points: u.points, cells, start: at };
		at += cells;
		return chip;
	});
	const free = c.budget !== undefined ? Math.max(0, Math.floor(c.budget - Math.max(c.points, at) + EPS)) : 0;
	return { chips, filler: Math.max(0, Math.ceil(c.points - EPS) - at), free, ...(c.budget !== undefined ? { budget: c.budget } : {}), under: free > 0 && c.underMinutes !== undefined };
}

const unitsLine = (chips: Chip[]) => !chips.length ? m.supply_units_none() : chips.every((c) => c.points === chips[0]!.points) ? m.supply_units_same({ count: chips.length, points: pts(chips[0]!.points) }) : m.supply_units_mixed({ count: chips.length, points: pts(chips.reduce((n, c) => n + c.points, 0)) });
const spans = (li: HTMLElement, cells: number) => ((li.style.gridColumn = `span ${cells}`), li.style.setProperty("--cells", String(cells)), li);
const cell = (i: number, lit: string) => h("span", { class: "supply-cell" }, h("i", null, two(i)), icon(lit));

/** The tray's section: its header (the points against the budget, the load), the slots, the line under them, and the barracks. */
export function fillTray(el: HTMLElement, c: CapView, rows: BoardViewRow[]) {
	const t = trayOf(c, rows), filler = Math.min(t.filler, MAX_CELLS), shown = Math.min(t.free, Math.max(0, MAX_CELLS - t.chips.reduce((n, x) => n + x.cells, 0) - filler)), base = t.chips.reduce((n, x) => n + x.cells, 0);
	const kind = noun("role_subagent"), waiting = Math.min(c.ready, 8);
	el.setAttribute("aria-label", m.supply_title());
	el.replaceChildren(
		h("header", { class: "supply-head" }, h("h4", null, m.supply_title()), h("span", { class: "supply-points" }, h("span", null, m.supply_points()), " ", h("b", null, t.budget !== undefined ? m.board_cap_budget({ points: pts(c.points), budget: pts(t.budget) }) : m.supply_used({ points: pts(c.points) }))), h("span", { class: "supply-load" }, m.board_cap_load({ load: String(c.load1), cores: String(c.cores) }))),
		h("ol", { class: "supply-tray", "aria-label": m.supply_label(), ...(t.under ? { "data-under": "" } : {}), ...(t.budget === undefined ? { "data-unset": "" } : {}) },
			...t.chips.map((x) => spans(h("li", { class: "supply-chip", "aria-label": m.supply_unit({ name: x.name, points: pts(x.points) }) }, h("span", { class: "supply-cells", "aria-hidden": "true" }, ...Array.from({ length: x.cells }, (_, i) => cell(x.start + i, "lit"))), h("span", { class: "supply-name" }, icon("unit"), h("span", { class: "supply-kind" }, `${kind} · `), h("b", null, x.name))), x.cells)),
			...Array.from({ length: filler }, (_, i) => h("li", { class: "supply-chip", "data-anon": "", "aria-label": m.supply_slot_used({ n: two(base + i) }) }, h("span", { class: "supply-cells", "aria-hidden": "true" }, cell(base + i, "lit")))),
			...Array.from({ length: shown }, (_, i) => h("li", { class: "supply-slot", "aria-label": m.supply_slot_free({ n: two(base + filler + i) }) }, h("i", { "aria-hidden": "true" }, two(base + filler + i)), icon("slot")))),
		h("p", { class: "supply-foot" }, ...(t.budget === undefined ? [h("b", { class: "supply-unset" }, m.supply_unset())] : [h("span", null, m.supply_each())]), h("span", { class: "supply-units" }, unitsLine(t.chips)), ...(t.budget !== undefined ? [h("b", { class: "supply-free" }, m.supply_free({ count: t.free }))] : [])),
		h("aside", { class: "supply-barracks" }, h("h5", null, m.supply_barracks()), h("b", { class: "supply-ready" }, m.supply_ready({ count: c.ready })), icon("barracks", "supply-gate"),
			h("span", { class: "supply-waiting", "aria-hidden": "true" }, ...Array.from({ length: waiting }, () => icon("unit")), ...(c.ready > waiting ? [m.supply_more({ count: c.ready - waiting })] : [])), h("p", null, m.supply_ready_note())));
}

/** The fold's mini slots: the budget's (all of them lit up to the points in use), or with no budget the used ones only; none without a capacity row. */
export function fillMini(el: HTMLElement, c: CapView | undefined, rows: BoardViewRow[]) {
	const t = c && trayOf(c, rows), used = t ? t.chips.reduce((n, x) => n + x.cells, 0) + t.filler : 0, all = t ? Math.min(MAX_CELLS, used + t.free) : 0;
	el.replaceChildren(...Array.from({ length: all }, (_, i) => h("i", i < used ? { "data-on": "" } : null)));
}

/** A main's supply line: its unit chips (or none, with its points), its ready count, and the phone's one line in their place. Nothing for a row without a capacity reading. */
export function rowSupply(r: BoardViewRow): HTMLElement | undefined {
	if (r.points === undefined || r.state === "ended") return undefined;
	const units = r.units ?? [];
	return h("div", { class: "board-supply-row" },
		h("span", { class: "board-units" }, ...(units.length ? units.map((u) => h("span", { class: "board-unit", title: m.supply_unit({ name: u.name, points: pts(u.points) }) }, icon("unit"), u.name)) : [r.units ? m.supply_none({ points: pts(r.points) }) : m.board_cap_points({ points: pts(r.points) })])),
		h("span", { class: "board-ready" }, m.supply_row_ready({ count: r.ready ?? 0 })),
		h("span", { class: "board-cap-phone" }, m.supply_row_phone({ points: pts(r.points), count: r.ready ?? 0 })));
}

/** The commanders' head over the rows, with the two columns of the supply line. */
export const colsHead = () => h("p", { class: "supply-cols" }, h("span", null, m.supply_mains()), h("span", null, m.supply_col_units()), h("span", null, m.supply_col_ready()));

/** The teammate devices, one row each (a device in two teams is one): its label, online or out of touch, and its capacity unknown here (no figure crosses to the page). */
export function alliesOf(net: Net | undefined): HTMLElement | undefined {
	const seen = new Map<string, { label: string; online: boolean }>();
	for (const a of net?.link?.allies ?? []) seen.set(a.device, { label: a.label, online: (seen.get(a.device)?.online ?? false) || a.online });
	if (!seen.size) return undefined;
	return h("ul", { class: "board-allies" }, ...[...seen.values()].map((d) => h("li", { class: "board-ally", ...(d.online ? { "data-online": "" } : {}) }, icon("fog", "supply-fog"), h("b", null, d.label), h("span", null, m.supply_ally()), h("span", null, d.online ? m.link_online() : m.supply_ally_off()),
		h("span", { class: "board-ally-cap" }, ...(d.online ? [] : [h("span", { class: "board-ally-fog" }, `${m.supply_ally_fog()} · `)]), m.supply_ally_unknown()))));
}
