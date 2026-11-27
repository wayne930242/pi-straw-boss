import type { BoardViewRow, CapView } from "../src/boardview.ts";
import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts"; import { noun } from "./nouns.ts";
import { type Answer, post } from "./post.ts";
import { choose } from "./quit.ts";
import { LABEL } from "./render.ts";
import { formatRoute } from "./router.ts";
import { locate } from "./scene.ts";
import type { Mark } from "../src/netdata.ts";
import { iconRef, unitIcon } from "./icons.ts";
import { alliesOf, colsHead, fillMini, fillTray, icon, rowSupply } from "./supply.ts";
import { graphed, planLine, planView } from "./plangraph.ts";

// The work board on the head page (docs/specs/2026-11-09-board-view.md): this computer's board as the net snapshot carries it (`net.board`), folded to one line by default, opened to the rows grouped by workspace in tab order. Every field of a row is
// model-written text, so it is drawn as text only (`h` makes text nodes; a value goes into an attribute only as a title) and nothing a row says becomes a link or a route: the one link is a live main's name, whose route is made from the net's own unit key.
// The two acts: Ask progress posts the fixed prompt below to the main's input and reads "Asked" for a minute, and Clear (only a row the server marked clearable) asks in the page's sheet, Cancel first, then posts `board/clear`.

/** What Ask progress sends the main (agents read English): the boss's question, and the reminder to keep its board line true. */
export const ASK_PROMPT = "The boss asks from the work board: how far has this work got? Reply in two or three lines (Traditional Chinese), and update your board line (board_set) if it is out of date.";
/** How long the button reads "Asked" and cannot be pressed again. */
export const ASKED_MS = 60_000;
/** The seam a test replaces: the page's sheet, its post, and the clock. */
export const io = { choose, post: (path: string, body: Record<string, unknown>): Promise<Answer> => post(path, body), now: () => Date.now(), later: (fn: () => void, ms: number): void => void setTimeout(fn, ms) };

const asked = new Map<string, number>(), sending = new Set<string>(), clearing = new Set<string>(), latest = new WeakMap<HTMLElement, Net | undefined>(), notes = new WeakMap<HTMLElement, string>(), unfolded = new WeakMap<HTMLElement, Set<string>>(), trays = new WeakMap<HTMLElement, HTMLElement>();
type Opts = { locale?: "en" | "zh-TW" };
const nameOf = (r: BoardViewRow) => r.main || r.session.slice(0, 8);
const live = (r: BoardViewRow) => r.state !== "ended";

/** The fold's counts: `12 lines (2 idle, 1 ended, 3 not written)`. A line is a row that has text; a live main with none is "not written". */
export function boardCounts(rows: BoardViewRow[], o?: Opts) {
	const idle = rows.filter((r) => r.stale).length, ended = rows.filter((r) => !live(r)).length, bare = rows.filter((r) => live(r) && r.now === undefined).length, lines = rows.length - bare;
	const parts = [idle && m.board_part_idle({ count: idle }, o), ended && m.board_part_ended({ count: ended }, o), bare && m.board_part_bare({ count: bare }, o)].filter(Boolean);
	return { lines, idle, ended, bare, text: `${lines === 1 ? m.board_line_one({}, o) : m.board_lines({ count: lines }, o)}${parts.length ? m.board_notes({ list: parts.join(m.board_sep({}, o)) }, o) : ""}` };
}
/** The rows grouped by workspace in the order the net lists them (tab order inside); the ended rows, which belong to no workspace, are the last group. */
export function boardGroups(rows: BoardViewRow[]): { label: string; ended: boolean; rows: BoardViewRow[] }[] {
	const groups: { label: string; ended: boolean; rows: BoardViewRow[] }[] = [];
	for (const r of rows.filter(live)) (groups.find((g) => !g.ended && g.label === r.workspace) ?? groups[groups.push({ label: r.workspace, ended: false, rows: [] }) - 1]!).rows.push(r);
	const gone = rows.filter((r) => !live(r));
	return gone.length ? [...groups, { label: m.board_ended_group(), ended: true, rows: gone }] : groups;
}
/** `12 min ago`: the count of the largest unit. */
export function ageText(ms: number, o?: Opts): string {
	const n = Math.max(0, Math.floor(ms / 1000));
	return m.board_ago({ age: n < 60 ? m.age_s({ n: String(n) }, o) : n < 3600 ? m.age_m({ n: String(Math.floor(n / 60)) }, o) : n < 86_400 ? m.age_h({ n: String(Math.floor(n / 3600)) }, o) : m.age_d({ n: String(Math.floor(n / 86_400)) }, o) }, o);
}
/** The device's capacity for the fold (docs/specs/2026-11-24-capacity.md): `6 / 20 pts · load 0.24 / 32 cores · 5 ready · capacity idle 12 min · 1 paused`. */
export function capText(c: CapView, o?: Opts): string {
	return [c.budget !== undefined ? m.board_cap_budget({ points: String(c.points), budget: String(c.budget) }, o) : m.board_cap_points({ points: String(c.points) }, o), m.board_cap_load({ load: String(c.load1), cores: String(c.cores) }, o), m.board_cap_ready({ count: c.ready }, o),
		...(c.underMinutes !== undefined ? [m.board_cap_under({ minutes: String(c.underMinutes) }, o)] : []), ...(c.paused ? [m.board_cap_paused({ count: c.paused }, o)] : []),
		...(c.held ? [m.board_held({ main: c.held.main, device: c.held.label }, o)] : []), ...(c.holds ?? []).map((h) => m.board_holds({ device: h.label, main: h.main, state: h.honoured ? m.board_hold_on({}, o) : m.board_hold_off({}, o) }, o))].join(m.board_cap_sep({}, o)); // device holds (docs/specs/2026-11-26-device-hold.md)
}
const hm = (at: number) => new Date(at).toTimeString().slice(0, 5);
/** A row's pause with the local time it resumes. */
const pauseText = (r: BoardViewRow, o?: Opts) => (r.pausedUntil !== undefined ? m.board_paused({ time: hm(r.pausedUntil) }, o) : m.board_paused_bare({}, o));
/** A row's capacity: its points and ready todos, and its pause (Geek's plain line; the other views draw the supply line, docs/specs/2026-11-24-capacity-supply/spec.md). */
export function rowCapText(r: BoardViewRow, o?: Opts): string {
	return [...(r.points !== undefined ? [m.board_cap_points({ points: String(r.points) }, o)] : []), ...(r.ready ? [m.board_cap_ready({ count: r.ready }, o)] : []), ...(r.paused ? [pauseText(r, o)] : [])].join(m.board_cap_sep({}, o));
}
const stateWord = (r: BoardViewRow) => (!live(r) ? (r.open ? m.board_open_word() : m.board_ended_word()) : r.stale ? m.board_idle_word() : (LABEL[r.state as Mark] ?? LABEL.unknown)());

const say = (box: HTMLElement, text: string) => {
	notes.set(box, text);
	const el = box.querySelector(".board-note"), list = box.querySelector<HTMLElement>(".board-rows");
	if (el) el.textContent = text;
	if (text && list) list.scrollTop = 0; // the note is the list's first line: a row cleared far down would leave it out of view (VR-F001)
};
const redraw = (box: HTMLElement) => fillBoard(box, latest.get(box), true);
const failure = (r: Answer) => r.body.reason ?? (r.status ? m.refused({ status: r.status }) : m.no_answer());

async function ask(box: HTMLElement, row: BoardViewRow) {
	if (sending.has(row.session) || (asked.get(row.session) ?? 0) > io.now()) return;
	sending.add(row.session);
	redraw(box);
	const r = await io.post(`sessions/${row.session}/input`, { text: ASK_PROMPT, as: "send" }).catch((): Answer => ({ ok: false, status: 0, body: {} }));
	sending.delete(row.session);
	if (r.ok) (asked.set(row.session, io.now() + ASKED_MS), io.later(() => redraw(box), ASKED_MS + 50), say(box, ""));
	else say(box, failure(r));
	redraw(box);
}
async function clear(box: HTMLElement, row: BoardViewRow) {
	if (clearing.has(row.session)) return;
	clearing.add(row.session);
	try {
		const sure = await io.choose((live(row) ? m.board_clear_ask_stale : row.open ? m.board_clear_ask_open : m.board_clear_ask_ended)({ name: nameOf(row), now: row.now ?? "" }), [{ label: m.board_clear(), value: "clear", tone: "danger" }]);
		if (!sure) return;
		redraw(box); // the button is disabled while the request is on its way
		const r = await io.post("board/clear", { session: row.session }).catch((): Answer => ({ ok: false, status: 0, body: {} }));
		say(box, r.ok ? (r.body.told === "delivered" ? m.board_cleared_told() : r.body.told === "queued" ? m.board_cleared_queued() : m.board_cleared()) : failure(r));
	} finally {
		clearing.delete(row.session);
		redraw(box);
	}
}

function rowOf(box: HTMLElement, net: Net | undefined, r: BoardViewRow, now: number, keep: Set<string>): HTMLElement {
	const hit = live(r) ? locate(net, r.session) : undefined, name = nameOf(r);
	const route = hit ? formatRoute({ view: "session", ws: hit.base.id, key: r.session }) : undefined, count = r.count ?? (r.items.length ? { done: r.items.filter((i) => i.done).length, total: r.items.length } : undefined);
	const wait = (asked.get(r.session) ?? 0) > now, busy = sending.has(r.session);
	const askButton = h("button", { type: "button", class: "pair-btn board-ask", title: m.board_ask_title({ name }), ...(wait || busy ? { disabled: "" } : {}) }, wait ? m.board_asked() : m.board_ask());
	askButton.onclick = () => void ask(box, r);
	const clearButton = h("button", { type: "button", class: "pair-btn board-clear", title: m.board_clear_title({ name }), ...(clearing.has(r.session) ? { disabled: "" } : {}) }, m.board_clear());
	clearButton.onclick = () => void clear(box, r);
	// An auto line's plan with graph data takes the checklist's place (gui/plangraph.ts); an older main's line, and one with none, keeps the checklist.
	const done = count ? m.board_done({ done: count.done, total: count.total }) : "", plan = graphed(r.plan) ? r.plan : undefined;
	const items = plan ? h("details", { class: "board-items board-plan" }, h("summary", null, [done, planLine(plan)].filter(Boolean).join(m.board_cap_sep())), planView(plan, now, { net, main: r.session })) : r.items.length ? h("details", { class: "board-items" }, h("summary", null, done), h("ul", null, ...r.items.map((i) => h("li", { "data-done": String(i.done) }, i.t)))) : undefined;
	if (items) {
		if (keep.has(r.session)) items.setAttribute("open", "");
		items.addEventListener("toggle", () => void (items.hasAttribute("open") ? keep.add(r.session) : keep.delete(r.session)));
	}
	const supply = rowSupply(r);
	return h("li", { class: "board-row", "data-session": r.session, "data-state": r.state, ...(r.stale ? { "data-stale": "" } : {}), ...(supply ? { "data-supply": "" } : {}) },
		h("div", { class: "board-line" },
			...(live(r) ? [icon(r.role === "train" ? "train" : unitIcon("main", (hit?.u as { duty?: string } | undefined)?.duty), "board-mark")] : []),
			route ? h("a", { class: "board-name", href: route, "data-route": route }, name) : h("b", { class: "board-name" }, name),
			...(r.role === "train" ? [h("span", { class: "board-tag" }, noun("role_train"))] : []),
			h("span", { class: "board-state" }, ...(r.stale && live(r) ? [icon("stale")] : []), stateWord(r)),
			...(r.paused ? [h("span", { class: "board-pause" }, icon("paused"), pauseText(r))] : []),
			...(rowCapText(r) ? [h("span", { class: "board-cap", ...(r.paused ? { "data-paused": "" } : {}) }, rowCapText(r))] : []),
			...(r.updated !== undefined ? [h("span", { class: "board-age", "data-updated": String(r.updated) }, ageText(now - r.updated))] : [])),
		r.now === undefined ? h("p", { class: "board-none" }, m.board_no_line()) : h("p", { class: "board-now" }, r.now),
		...(supply ? [supply] : []),
		...(items ? [items] : []),
		...(live(r) || r.clearable ? [h("div", { class: "board-acts" }, ...(live(r) ? [askButton] : []), ...(r.clearable ? [clearButton] : []))] : []));
}

/**
 * Draws the section into `box` (the `<details class="head-board">` of the head page): hidden with no row, else the fold's line with its mini slots and, inside, the note of the last act, the supply tray (supply.ts, rebuilt on its own signature), the commanders' head, the groups, and the teammate devices. The rows are rebuilt only when what they show changes (so a tap never
 * lands on a button that was replaced, and a fold the boss opened stays open); the ages are rewritten in place at every call. `now` is the page's clock.
 */
export function fillBoard(box: HTMLElement, net: Net | undefined, force = false, now = io.now()) {
	latest.set(box, net);
	const rows = net?.board ?? [];
	box.hidden = !rows.length;
	if (!rows.length) return void delete box.dataset.sig;
	const counts = boardCounts(rows), set = (sel: string, text: string) => { const el = box.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
	set("summary b", m.board_title());
	set("summary span", net?.capacity ? `${counts.text}${m.board_cap_sep()}${capText(net.capacity)}` : counts.text);
	const mini = box.querySelector<HTMLElement>(".board-mini"), tray = trays.get(box) ?? trays.set(box, h("section", { class: "board-supply" })).get(box)!, voice = `${m.board_title()}${iconRef("unit")}`, traySig = JSON.stringify([voice, net?.capacity, rows.map((r) => [r.state, r.units])]); // `voice`: a new language or view redraws the words and icons
	if (tray.dataset.sig !== traySig || force) {
		tray.dataset.sig = traySig;
		if (mini) fillMini(mini, net?.capacity, rows);
		if (net?.capacity) fillTray(tray, net.capacity, rows);
		tray.hidden = !net?.capacity;
	}
	const sig = JSON.stringify([rows, [...asked].filter(([, until]) => until > now).map(([s]) => s), [...sending], [...clearing], net?.bases.map((b) => b.id), net?.capacity ? 1 : 0, net?.link?.allies.map((a) => [a.device, a.label, a.online]), voice]);
	if (force || box.dataset.sig !== sig) {
		box.dataset.sig = sig;
		const keep = unfolded.get(box) ?? unfolded.set(box, new Set()).get(box)!, body = box.querySelector<HTMLElement>(".board-rows");
		body?.setAttribute("aria-label", m.board_label());
		body?.replaceChildren(h("p", { class: "board-note", role: "status" }, notes.get(box) ?? ""), tray, ...(net?.capacity ? [colsHead()] : []), ...boardGroups(rows).map((g) => h("section", { class: "board-group", "data-ended": String(g.ended) }, h("h4", null, g.label), h("ul", null, ...g.rows.map((r) => rowOf(box, net, r, now, keep))))), ...[alliesOf(net)].filter((x) => x !== undefined));
	}
	for (const age of box.querySelectorAll<HTMLElement>("[data-updated]")) age.textContent = ageText(now - Number(age.dataset.updated));
}
