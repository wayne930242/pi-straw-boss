import type { Mark } from "../src/netdata.ts";
import type { DeviceUnits, LinkSummary } from "../src/link/holder.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import type { HeadUnit } from "../src/nethead.ts";
import { mountCalm } from "./calm.ts";
import { menuAround, nameMenu } from "./menu.ts";
import { replay } from "./dom.ts";
import { m } from "./sentences.ts"; import { repoint, iconRef, ICON, unitIcon } from "./icons.ts"; import { type NounKey, noun } from "./nouns.ts";
import { closed } from "./scene.ts";
import { allyMark, mergeAllies, stateName, unitCards, type AllyCard, type UnitCard } from "./linkmodel.ts";
import { fillAllies } from "./towerallies.ts";
import { fillNotices } from "./towernotes.ts";
import { queueChip, statusLine } from "./towermodel.ts";
import { mountMinimap } from "./minimap.ts";
import { bandModel, gutter, routePackets } from "./headband.ts";
import { aimBase, aimSquad, aimStash, aimTower, aimUnit } from "./quit.ts";
import { formatRoute, type Route } from "./router.ts";
import { arrange, can, canIn } from "./boxmodel.ts";

// Draws a net into the page by diffing: elements are keyed by id, created once, updated in place, and reordered, so only what changed
// is touched and CSS transitions play on state changes. Motion is CSS on transform and opacity only. The unit token (plate, icon, ring,
// badge) and the keyed `sync` are shared with the focus views, so a unit looks and moves the same on every route.

export { ICON, unitIcon }; // icons.ts keeps them: the one chokepoint for a unit's icon
export const LABEL: Record<Mark, () => string> = { commanding: m.mark_commanding, working: m.mark_working, waiting: m.mark_waiting, idle: m.mark_idle, done: m.mark_done, error: m.mark_error, unknown: m.mark_unknown };
const ROLE: Record<string, NounKey> = { ally: "role_ally", run: "role_run", main: "role_main", member: "role_member", train: "role_train", subagent: "role_subagent", tower: "role_tower", outpost: "role_outpost", outside: "role_outside", session: "role_session" };
/** The server's fixed status words; any other note (a subagent's tool or phase) shows as it is. */
const NOTE: Record<string, () => string> = { thinking: m.note_thinking, "watching a monitor": m.note_monitoring, idle: m.mark_idle, "waiting on a question": m.mark_waiting, finished: m.mark_done };
/** A role as the page names it; one it does not know shows as it is. */
export const roleName = (role: string) => (Object.hasOwn(ROLE, role) ? noun(ROLE[role]!) : role);
const KIND: Record<string, () => string> = { coordinator: m.kind_coordinator, integrator: m.kind_integrator, standing: m.kind_standing, worker: m.kind_worker, scout: m.kind_scout, planner: m.kind_planner, reviewer: m.kind_reviewer };
const GRAPH: Record<string, () => string> = { "single-loop": m.graph_single, "fan-out/fan-in": m.graph_fan, "orchestrator-worker": m.graph_orch };
/** A unit's kind word, the same in every theme (docs/specs/2026-11-09-agent-kinds.md §11), or its role's name when it has no kind; a main's plan graph follows it (`協調者 · 分支匯流`). */
export const roleWord = (role: string, duty?: string, graph?: string): string => {
	const kind = duty && Object.hasOwn(KIND, duty) ? KIND[duty]!() : roleName(role);
	return role === "main" && graph && Object.hasOwn(GRAPH, graph) ? `${kind} · ${GRAPH[graph]!()}` : kind;
};
/** A wait's title, in the page's language: the unit's role and its place, once (the unit's raw name is English and says the same). Zen's card and the dialog share it. */
export const waitTitle = (role: string, place: string) => `${roleName(role)} · ${place}`;
/** Marks that ask for the user: a click on such a unit opens its alert instead of its route. */
export const urgent = (m: Mark) => m === "waiting" || m === "error";

/** Builds an element from one of the page's constant templates; data goes in afterwards through textContent and attributes only. */
export const html = (markup: string): HTMLElement => {
	const root = new DOMParser().parseFromString(markup.trim(), "text/html").body.firstElementChild;
	if (!(root instanceof HTMLElement)) throw new Error("bad template");
	const el = document.importNode(root, true);
	repoint(el); // a theme's icons, where it has them
	return el;
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
/** The activity line under the last transmission: empty while the session is not live, so an ended session shows no spinner. */
export const liveNote = (u: { note?: string; control?: boolean; ended?: boolean } | undefined, state: string | undefined, mk: Mark) => (closed(u, state) ? "" : mk === "working" || mk === "commanding" ? doing(u?.note, mk) : urgent(mk) ? LABEL[mk]() : "");
/** The mark a view of a unit draws: a session that is not live keeps no working or commanding mark (no spinner), whatever its last one was. */
export const liveMark = (u: { control?: boolean; ended?: boolean } | undefined, state: string | undefined, mk: Mark): Mark => (closed(u, state) && (mk === "working" || mk === "commanding") ? "done" : mk);
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
export const PLATE = `<div class="plate"><i class="ring"></i><svg><use data-icon="main"/></svg><b class="badge"></b></div>`;
/** `docs`: the unit's documents; those on screen in its terminal show as a scroll badge with their count. `duty`: the unit's kind, which picks its icon (a unit with none keeps its position's). */
export function fillPlate(plate: HTMLElement, role: string, m: Mark, docs?: { onScreen: boolean }[], duty?: string) {
	mark(plate, m);
	const use = plate.querySelector("use")!, icon = unitIcon(role, duty), href = iconRef(icon), n = docs?.filter((d) => d.onScreen).length;
	use.dataset.icon = icon;
	if (use.getAttribute("href") !== href) use.setAttribute("href", href);
	if (n) plate.dataset.docs = String(n);
	else delete plate.dataset.docs;
}

/** The theme's eight stable variations: FNV-1a over the key's UTF-8 bytes, never the item's position. */
const utf8 = new TextEncoder();
export function keyed(el: HTMLElement, key: string): HTMLElement {
	let hash = 0x811c9dc5;
	for (const byte of utf8.encode(key)) hash = Math.imul(hash ^ byte, 0x01000193);
	el.dataset.key = key;
	el.dataset.vary = String(hash & 7);
	return el;
}

/** Reconciles the children of `parent` with `items`: new ones enter, gone ones leave, the rest keep their element and move into order. */
export function sync<T extends { id: string }>(parent: Element, items: T[], make: (item: T) => HTMLElement, fill: (el: HTMLElement, item: T) => void) {
	const live = new Map<string, HTMLElement>();
	for (const el of parent.children) if (!el.classList.contains("leaving") && (el as HTMLElement).dataset.key) live.set((el as HTMLElement).dataset.key!, el as HTMLElement);
	let cursor = parent.firstElementChild;
	for (const item of items) {
		let el = live.get(item.id);
		if (!el) {
			el = keyed(make(item), item.id);
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

/** How long ago `since` was, in the page's language: 40s, 12m, 3h, 2d. */
export const ago = (since: number, n = Math.max(0, Date.now() - since) / 1000) => (n < 60 ? m.age_s({ n: String(Math.floor(n)) }) : n < 3600 ? m.age_m({ n: String(Math.floor(n / 60)) }) : n < 86_400 ? m.age_h({ n: String(Math.floor(n / 3600)) }) : m.age_d({ n: String(Math.floor(n / 86_400)) }));
/** How long a unit has been in its state, kept current by mountPage's clock; empty while the server has not seen it take that state. */
const age = (el: HTMLElement, since?: number) => ((since === undefined ? delete el.dataset.since : (el.dataset.since = String(since))), (el.textContent = since === undefined ? "" : ago(since)));
/** A unit's last steps (activity.ts ticks) as a row of marks along its card's foot, the newest brightest. */
function ticks(card: HTMLElement, list: Unit["ticks"] = []) {
	const row = card.querySelector<HTMLElement>(":scope > .ticks")!, sig = list.map((t) => `${t.at}${t.mark}`).join();
	if (row.dataset.sig === sig) return;
	row.dataset.sig = sig;
	card.classList.toggle("ticked", list.length > 0);
	row.replaceChildren(...list.map((t, i) => {
		const dot = document.createElement("i");
		dot.dataset.mark = t.mark;
		dot.style.setProperty("--o", ((i + 1) / list.length).toFixed(2));
		return dot;
	}));
}

/** The note line of each train's unit card and the integrators' unit keys with their project, from the net being drawn (trains.ts); set by `show` before the cards are filled. */
let trainNote = new Map<string, string>(), integrators = new Map<string, string>(), trainWait = new Set<string>();
export const useYards = (notes: Map<string, string>, owners: Map<string, string>, waits = new Set<string>()) => void ([trainNote, integrators, trainWait] = [notes, owners, waits]);
// The yards' model (trains.ts: the counts, the chips, the wait words) is a chunk of its own, fetched with the first snapshot that carries yards; until it is here the chips and notes wait, and the map is drawn again as it arrives.
let yardsModel: typeof import("./trains.ts") | undefined, loadingYards: Promise<void> | undefined;
export const unitEl = () => html(`<div class="unit"><div class="card"><a class="hit"></a>${PLATE}<div class="meta"><span class="name"></span><span class="line"><em class="role"></em><span class="note"></span><span class="age"></span></span><span class="todo" hidden><b></b><span></span></span><button type="button" class="yard-open" hidden></button></div><button type="button" class="quit-btn" data-close="unit" hidden></button><span class="ticks" aria-hidden="true"></span></div><div class="subs"></div></div>`);
/** A card draws what the chat's live line and the dossier draw: a unit that is not live (an ended subagent) keeps no working mark and no tool (liveMark, liveNote). */
export function fillUnit(el: HTMLElement, u: Omit<Unit, "id" | "key" | "control" | "role" | "subs"> & { key?: string; control?: boolean; role: Unit["role"] | "outpost"; subs?: Unit[] }) {
	const ws = el.closest<HTMLElement>(".base")?.dataset.key, hit = el.querySelector(".hit")!, mk = liveMark(u, undefined, u.mark), note = closed(u) ? undefined : u.note;
	aim(hit, u.key && ws ? { view: "session", ws, key: u.key } : undefined);
	hit.setAttribute("aria-label", `${u.name}: ${doing(note, mk)}`);
	hit.toggleAttribute("data-alert", urgent(mk));
	mark(el, mk);
	fillPlate(el.querySelector(".plate")!, u.role, mk, u.docs, u.duty);
	text(el, ".name", u.name);
	text(el, ".role", roleWord(u.role, u.duty, u.todo?.graph));
	const line = (u.key && !closed(u) && trainNote.get(u.key)) || undefined, noteEl = el.querySelector<HTMLElement>(".note")!;
	say(el, ".note", note, mk, line);
	// A train's note is the step and what it waits for: clipped to its card (two lines, style.css), so the whole line is its tooltip too; a train that waits says so whatever its pane's mark.
	el.toggleAttribute("data-train-note", !!line);
	el.toggleAttribute("data-train-wait", !!line && !!u.key && trainWait.has(u.key));
	if (line) noteEl.setAttribute("title", line);
	else noteEl.removeAttribute("title");
	const opens = u.key ? integrators.get(u.key) : undefined, yard = el.querySelector<HTMLElement>(":scope > .card .yard-open")!; // an integrator's card opens its project's yard (yard.ts)
	yard.hidden = !opens;
	if (opens) (yard.dataset.yard = opens, text(el, ":scope > .card .yard-open", m.yard_open()));
	age(el.querySelector(":scope > .card .age")!, u.since);
	const todo = el.querySelector<HTMLElement>(":scope > .card .todo")!;
	todo.hidden = !u.todo;
	if (u.todo) (text(todo, "b", `${u.todo.done < u.todo.total ? "◐" : "✓"} ${u.todo.done}/${u.todo.total}`), text(todo, "span", u.todo.now ?? ""));
	ticks(el.querySelector(":scope > .card")!, u.ticks);
	aimUnit(el.querySelector(":scope > .card > .quit-btn")!, u, (a) => canIn(el, a)); // a unit of a remote base has Quit and Dismiss only when its box lists them (boxmodel.ts)
	sync(el.querySelector(".subs")!, u.subs ?? [], unitEl, fillUnit);
}

/** Points an opening button at its base (main.ts opens the tile): a base with a tower takes mains, one without takes members, a squad only members. */
export function aimOpening(button: HTMLElement, b: Base, tab?: string) {
	const kind = b.tower ? "main" : "member";
	button.hidden = Boolean((tab && b.tower) || b.box); // a remote base is not opened into (decision 9)
	button.dataset.open = kind;
	button.dataset.ws = b.id;
	if (tab) button.dataset.tab = tab;
	if (button.textContent !== (kind === "main" ? m.open_main() : m.open_member())) button.textContent = kind === "main" ? m.open_main() : m.open_member();
}

const baseMarkup = () => html(`<section class="base"><header><div class="tower"><i class="sweep"></i><i class="pulse"></i><svg><use data-icon="tower"/></svg><b class="badge"></b></div><div class="title"><h2><a class="enter-base"></a></h2><p><span class="tstate"></span><span class="tqueue"></span><span class="age"></span></p><div class="allies" hidden></div><button type="button" class="pair-btn yard-chip-btn" hidden></button><p class="box-line" hidden><b class="box-dev"></b><span class="box-team"></span><span class="box-seen" hidden><span class="bs-state"></span><span class="bs-when"> · <span class="bs-pre"></span><span class="age"></span><span class="bs-post"></span></span></span></p><button type="button" class="quit-btn tower-quit" data-close="unit" hidden></button></div><button type="button" class="quit-btn" data-close="base"></button></header><div class="subs tower-subs"></div><div class="tower-notices"></div><div class="spawn-btns"><button type="button" class="pair-btn"></button><button type="button" class="pair-btn" data-close="stash"></button></div><div class="tabs"></div><div class="outposts" data-label="${noun("outposts")}"></div><p class="box-ended" role="status" hidden></p><details class="box-runs" hidden><summary></summary><ul class="box-run-list"></ul></details><details class="box-truns" hidden><summary></summary><ul class="box-run-list box-trun-list"></ul></details><button type="button" class="pair-btn box-more" hidden></button><details class="box-ally" hidden><summary></summary><div class="box-ally-in"></div></details></section>`);
/** A phone keeps a base's Quit behind a `⋯` in its header (style.css, "A phone's menus"); above 640 px the menu is `display: contents`, so the button stays where it was. */
const baseEl = () => {
	const el = baseMarkup();
	menuAround(el.querySelector<HTMLElement>("header > .quit-btn")!);
	return el;
};
/** The tower's state as the map says it: the service's own word (standing by, waking, held…) and how its last run ended, or the mark's word for a tower with no service. */
const towerLine = (t: NonNullable<Base["tower"]>) => statusLine(t.service, t.mark, (mk) => LABEL[mk]());
export { baseEl };
// A remote (operate) base's own parts (box.ts: the badge, the states, Earlier runs, the box's ally card) are a chunk of their own, loaded with the first remote base; a card that waits for it is drawn from its latest reading, and a load that failed is tried again at the next snapshot.
let boxes: typeof import("./box.ts") | undefined, loadingBox: Promise<void> | undefined;
const waitingBoxes = new Map<HTMLElement, [Base, AllyCard[] | undefined, LinkSummary | undefined]>();
export const loadBox = (): Promise<void> => (loadingBox ??= import("./box.ts").then((x) => ((boxes = x), waitingBoxes.forEach((args, card) => x.fillBox(card, ...args)), waitingBoxes.clear()), () => void (loadingBox = undefined)));
/** `under`: the ally cards a live remote base takes in (boxmodel.ts `arrange`), with the link summary they are drawn from. */
export function fillBase(el: HTMLElement, b: Base, { under, link, yard }: { under?: AllyCard[]; link?: LinkSummary; yard?: { projects: string[]; chip: string } } = {}) {
	mark(el, b.mark);
	el.classList.toggle("remote", Boolean(b.box));
	if (b.box) (el.dataset.box = b.box.state, (el.dataset.can = b.box.can.join(" "))); // before the units: they read it (boxmodel.ts `canIn`)
	else (delete el.dataset.box, delete el.dataset.can);
	el.querySelector<HTMLElement>("header > .menu")!.hidden = el.querySelector<HTMLElement>(".spawn-btns")!.hidden = Boolean(b.box); // a remote base is not closed, stashed or opened into from here (decision 9)
	if (b.box) (boxes ? boxes.fillBox(el, b, under, link) : (waitingBoxes.set(el, [b, under, link]), void loadBox()));
	const tower = el.querySelector<HTMLElement>(".tower")!;
	tower.classList.toggle("ghost", !b.tower);
	mark(tower, b.tower?.mark ?? "unknown");
	text(el, "h2 a", b.label);
	aim(el.querySelector("h2 a")!, { view: "workspace", ws: b.id });
	text(el, ".title .tstate", b.tower ? m.control_tower({ state: towerLine(b.tower) }) : m.no_tower());
	text(el, ".title .tqueue", queueChip(b.tower?.service) ?? "");
	age(el.querySelector(".title .age")!, b.tower?.since);
	aimOpening(el.querySelector(".spawn-btns button")!, b);
	aimBase(el.querySelector("header .menu-pop > .quit-btn")!, b);
	nameMenu(el.querySelector("header > .menu")!, b.label);
	aimStash(el.querySelector(".spawn-btns [data-close=stash]")!, b);
	aimTower(el.querySelector(".tower-quit")!, b.tower, (a) => can(b, a));
	sync(el.querySelector(".tower-subs")!, b.tower?.subs ?? [], unitEl, fillUnit);
	fillAllies(el.querySelector(".title .allies")!, b.id, b.tower?.service);
	const chip = el.querySelector<HTMLElement>(".yard-chip-btn")!; // the base's yard: the trains of the projects whose integrator or trains this base holds (trains.ts `yardMap`)
	chip.hidden = !yard;
	if (yard) (chip.dataset.yard = yard.projects.join(" "), chip.textContent !== yard.chip && (chip.textContent = yard.chip), chip.title = m.yard_chip_title());
	else delete chip.dataset.yard;
	fillNotices(el.querySelector(".tower-notices")!, b.id, b.tower?.service, b.tower?.key, undefined, Boolean(b.box));
	sync(el.querySelector(".tabs")!, b.tabs, () => {
		const tab = html(`<div class="tab"><h3><span></span><button type="button" class="tab-add"></button><button type="button" class="quit-btn" data-close="tab"></button></h3><div class="units"></div></div>`);
		menuAround(tab.querySelector<HTMLElement>("h3 > .quit-btn")!); // a squad's Quit is behind a `⋯` on a phone, as a base's is
		return tab;
	}, (tab, t) => {
		text(tab, "h3 span", m.tab_label({ label: t.label }));
		aimSquad(tab.querySelector(".menu-pop > .quit-btn")!, b, t);
		tab.querySelector<HTMLElement>("h3 > .menu")!.hidden = !can(b, "close-tab"); // no empty ⋯
		nameMenu(tab.querySelector("h3 > .menu")!, m.tab_label({ label: t.label }));
		aimOpening(tab.querySelector(".tab-add")!, b, t.id);
		sync(tab.querySelector(".units")!, t.units, unitEl, fillUnit);
	});
	el.querySelector<HTMLElement>(".outposts")!.dataset.label = noun("outposts"), sync(el.querySelector(".outposts")!, b.outposts.map((o) => ({ id: o.id, name: o.label, role: "outpost" as const, mark: o.mark, note: o.mark === "unknown" ? m.no_agent() : undefined, since: o.since, ticks: o.ticks })), unitEl, fillUnit);
}

// A teammate's workspace on a bound project (Straw Link, from its last presence), beside the local bases: a card of its own, not openable (its units are
// another computer's), with the device's label and short id, the team, whether it is online, its tower's state, and its tabs' states. No wire reaches it.
export const allyEl = () => html(`<section class="base ally"><header><div class="tower"><i class="pulse"></i><svg><use data-icon="tower"/></svg><b class="badge"></b></div><div class="title"><span class="crown"><svg><use data-icon="main"/></svg><em class="ally-tag"></em></span><h2></h2><p><span class="tstate"></span></p><p class="ally-teams" hidden></p></div></header><ul class="ally-tabs"></ul><ul class="ally-units"></ul></section>`);
// The questions an unattended device forwarded are answered on its card (allyasks.ts, with the question panel): loaded with the first one, so the page's start does not carry it; a load that failed is tried again at the next snapshot.
let allyAsks: ReturnType<typeof import("./allyasks.ts").mountAllyAsks> | undefined, loadingAsks = false;
const waitingAsks = new Map<HTMLElement, [AllyCard, LinkSummary]>();
function fillAsks(el: HTMLElement, a: AllyCard, link: LinkSummary | undefined) {
	a = { ...a, id: a.id.replace(/^ally\//, "") }; // the map keys a teammate's card `ally/<card id>`; the questions are by the card's id
	if (allyAsks) return void allyAsks.show(el, a, link);
	if (!link?.alerts.some((x) => x.kind === "dialog")) return void waitingAsks.delete(el);
	waitingAsks.set(el, [a, link]);
	if (loadingAsks) return;
	loadingAsks = true;
	void import("./allyasks.ts").then(({ mountAllyAsks }) => ((allyAsks = mountAllyAsks()), waitingAsks.forEach(([ally, l], card) => allyAsks!.show(card, ally, l)), waitingAsks.clear()), () => void (loadingAsks = false));
}
// The units an unattended device reported are drawn by allyunits.ts, loaded with the first unit (a computer with no such device never fetches it); a card that waits for the load is drawn from its latest reading, and a load that failed is tried again at the next snapshot.
let drawUnits: typeof import("./allyunits.ts").fillAllyUnits | undefined, loadingUnits = false;
const waitingUnits = new Map<HTMLElement, [UnitCard[], boolean, string]>();
function fillUnits(el: HTMLElement, cards: UnitCard[], named: boolean, box: string) {
	if (drawUnits) return void drawUnits(el.querySelector(".ally-units")!, cards, named, box);
	if (!cards.length) return void waitingUnits.delete(el);
	waitingUnits.set(el, [cards, named, box]);
	if (loadingUnits) return;
	loadingUnits = true;
	void import("./allyunits.ts").then(({ fillAllyUnits }) => ((drawUnits = fillAllyUnits), waitingUnits.forEach(([c, n, b], card) => fillAllyUnits(card.querySelector(".ally-units")!, c, n, b)), waitingUnits.clear()), () => void (loadingUnits = false));
}
/** When each unit of the ally bases was last seen running (`device/unit` to the time of that status): a run after a crash notice ends the crash (linkmodel.ts `unitCards`). Kept for the page's life. */
const unitsSeen = new Map<string, number>();
/** Draws the card of one device (`mergeAllies`): the same device in several teams is this one card, which names its teams on a quiet line under the title and keeps the questions and the crash notices of each in the team's own words. */
export function fillAlly(el: HTMLElement, a: AllyCard, link: LinkSummary | undefined) {
	const state = allyMark(a), reported: DeviceUnits[] | undefined = link?.units;
	mark(el, state);
	el.classList.toggle("offline", !a.online);
	mark(el.querySelector<HTMLElement>(".tower")!, state);
	const many = a.teams.length > 1, line = el.querySelector<HTMLElement>(".ally-teams")!;
	text(el, ".ally-tag", many ? m.ally_tag_many() : m.ally_tag({ team: a.teams[0]?.teamName ?? "" }));
	line.hidden = !many;
	line.textContent = many ? m.ally_teams({ teams: a.teams.map((t) => t.teamName).join(m.ally_teams_sep()) }) : "";
	text(el, "h2", a.workspace ?? a.label);
	// What an unattended device says about its units (unit-status) is drawn by allyunits.ts, and the units are the card's only state: the subtitle then names the base and whether it is there, not what its tower does (the two come from messages of their own cadence and could disagree).
	// While an unattended box says none (an older box, a team that shares presence only, the minute after this server restarted) the card says how many units are online in one line and never lists the box's mains and workers; a teammate's own computer lists its tabs.
	const cards = unitCards(reported, link?.alerts, { device: a.device, workspace: a.workspace, spare: a.spare, teams: a.teams.map((t) => t.team) }, Date.now(), unitsSeen);
	text(el, ".tstate", `${a.workspace ? `${a.label} · ` : ""}${a.short}${!a.online ? ` · ${m.link_offline()}` : cards.length ? "" : ` · ${stateName(a.tower)}`}`);
	const rows: { id: string; label: string; state: string; says?: string }[] = cards.length ? [] : a.unattended ? (a.online && a.tabs.length ? [{ id: "online", label: "", state: a.tower, says: m.link_unit_summary({ count: a.tabs.length }) }] : []) : a.tabs.map((t, i) => ({ id: `${i}`, ...t }));
	sync(el.querySelector(".ally-tabs")!, rows, () => html(`<li class="ally-tab"><b></b><span></span></li>`), (li, t) => {
		text(li, "b", t.says ?? t.label);
		text(li, "span", t.says !== undefined || !a.online ? "" : stateName(t.state));
		li.dataset.state = t.state; // a state that waits makes a row a way into the question panel, a unit's or the summary line's too
	});
	el.classList.toggle("has-units", cards.length > 0);
	fillUnits(el, cards, a.workspace === null, a.label);
	fillAsks(el, a, link);
}

/** The head band at the top of the map (docs/specs/2026-11-07-head-band.md): the crown, the name, the newest line, and the waits chip, all one link to the head page; faint and dashed while the head is not open, hidden (and no hub) when the net has no head. */
export function fillHeadNode(el: HTMLElement, head: HeadUnit | undefined, now = Date.now()) {
	el.hidden = !head;
	el.classList.toggle("off", !head);
	if (!head) return;
	const band = bandModel(head, now);
	el.classList.toggle("absent", band.absent);
	mark(el, head.mark);
	el.setAttribute("href", "head");
	el.setAttribute("aria-label", band.label);
	el.title = band.label; // the line is ellipsised in the band: a hover reads it whole
	text(el, ".head-name", band.name);
	text(el, ".head-line", band.line);
	const waits = el.querySelector<HTMLElement>(".head-waits")!;
	waits.hidden = !band.waits;
	text(el, ".head-waits", band.waits ? String(band.waits) : "");
}
type Spot = readonly [number, number];
/** Where a base's tower is on the map (the centre of its mark) and the x of the gutter on the left of its column. */
export interface WireEnd { x: number; y: number; gutter: number }
export interface Seg { x1: number; y1: number; x2: number; y2: number }
/**
 * The head band's wires, straight and orthogonal: from the band's bottom centre (`hub`) a drop to the bus (`bus`, a y in the gap above the grid), the bus along to the gutter on the left of each tower's column, down that gutter, and across into the tower's centre.
 * `routes` is each tower's path, corner by corner, for its packet; `segments` are the lines to draw, the stretches the routes share (the drop, the bus, a column's trunk) merged into one. None without a hub or without a tower to reach.
 */
export function headWires(hub: Spot | undefined, bus: number, ends: readonly WireEnd[]): { routes: Spot[][]; segments: Seg[] } {
	if (!hub || !ends.length) return { routes: [], segments: [] };
	const routes = ends.map((e): Spot[] => ([[hub[0], hub[1]], [hub[0], bus], [e.gutter, bus], [e.gutter, e.y], [e.x, e.y]] as Spot[]).filter((p, i, all) => i === 0 || p[0] !== all[i - 1]![0] || p[1] !== all[i - 1]![1]));
	// Each stretch lies on a line (a y for a horizontal, an x for a vertical); the stretches on one line that touch or overlap are one.
	const lines = new Map<string, [number, number][]>();
	for (const r of routes) for (let i = 1; i < r.length; i++) {
		const [a, b] = [r[i - 1]!, r[i]!], flat = a[1] === b[1], key = flat ? `h${a[1]}` : `v${a[0]}`, span: [number, number] = flat ? [Math.min(a[0], b[0]), Math.max(a[0], b[0])] : [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
		lines.set(key, [...(lines.get(key) ?? []), span]);
	}
	const segments = [...lines].flatMap(([key, spans]) => {
		const at = Number(key.slice(1)), merged: [number, number][] = [];
		for (const s of spans.sort((p, q) => p[0] - q[0])) {
			const last = merged.at(-1);
			if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
			else merged.push([...s]);
		}
		return merged.map(([from, to]): Seg => (key[0] === "h" ? { x1: from, y1: at, x2: to, y2: at } : { x1: at, y1: from, x2: at, y2: to }));
	});
	return { routes, segments: segments.sort((p, q) => p.y1 - q.y1 || p.x1 - q.x1 || p.y2 - q.y2 || p.x2 - q.x2) };
}

/** Draws the head band's wires to every base's tower, with a packet travelling along each while one end of it works, in the map's own coordinates. */
function wire(map: HTMLElement, bases: HTMLElement, svg: SVGSVGElement, dots: HTMLElement, still: boolean) {
	const cards = [...bases.querySelectorAll<HTMLElement>(":scope > .base:not(.leaving)")], band = map.querySelector<HTMLElement>(".head-node:not(.off)") ?? undefined;
	const box = map.getBoundingClientRect(), grid = bases.getBoundingClientRect(), style = getComputedStyle(bases);
	const [col, gap] = [parseFloat(style.gridTemplateColumns), parseFloat(style.columnGap) || 20];
	band?.style.setProperty("--col", Number.isFinite(col) ? `${col}px` : ""); // the band is one grid column wide: the width the masonry resolved for its tracks
	const left = (el: HTMLElement) => el.getBoundingClientRect().x - box.x, first = Math.min(...cards.map(left));
	const wired = cards.filter((c) => !c.classList.contains("ally") && !c.classList.contains("remote")).map((c) => ({ c, t: c.querySelector<HTMLElement>(".tower")! }));
	const r = band?.getBoundingClientRect(), hub = r ? ([Math.round(r.x + r.width / 2 - box.x), Math.round(r.bottom - box.y)] as const) : undefined;
	const ends = wired.map(({ c, t }) => {
		const q = t.getBoundingClientRect();
		return { x: Math.round(q.x + q.width / 2 - box.x), y: Math.round(q.y + q.height / 2 - box.y), gutter: gutter(left(c), first, gap) };
	});
	const { routes, segments } = headWires(hub, hub ? Math.round((hub[1] + grid.y - box.y) / 2) : 0, ends);
	const paths = segments.map(({ x1, y1, x2, y2 }) => (y1 === y2 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}V${y2}`));
	const sig = JSON.stringify(routes);
	if (svg.dataset.sig !== sig) {
		svg.dataset.sig = sig;
		svg.replaceChildren(...paths.map((d) => ((line) => (line.setAttribute("class", "wire"), line.setAttribute("d", d), line))(document.createElementNS("http://www.w3.org/2000/svg", "path"))));
		dots.replaceChildren(...routePackets(routes, still));
	}
	dots.querySelectorAll<HTMLElement>(".packet").forEach((dot, i) => dot.toggleAttribute("data-live", ["working", "commanding"].includes(band!.dataset.mark ?? "") || ["working", "commanding"].includes(wired[i]!.t.dataset.mark ?? "")));
}

export interface Page { show(net: Net): void; stats(net: Net): void; layout(): void; pause(paused: boolean): void }

// The bases pack like masonry: the grid's rows are ROW px, and each card spans the rows its height and the gap take, so a short base tucks in
// under its neighbour while the reading order stays the grid's. A ResizeObserver reports before paint, so a card never shows unpacked. The map is
// not observed itself: a span changes its height inside that observer's report, which the browser would defer with an error; the links and the
// overview are drawn again on the next frame instead, after every card's report and every resize of the window.
const ROW = 2, GAP = 20;

export function mountPage(): Page {
	const [map, bases, links, dots] = [byId("map", HTMLElement), byId("bases", HTMLElement), byId("links", SVGSVGElement), byId("packets", HTMLElement)];
	const still = matchMedia("(prefers-reduced-motion: reduce)").matches, packed = new Set<Element>();
	const minimap = mountMinimap(map, bases), layout = () => (minimap(), !map.hidden && wire(map, bases, links, dots, still));
	let queued = 0;
	const later = () => (queued ||= requestAnimationFrame(() => ((queued = 0), layout())));
	const pack = new ResizeObserver((all) => (all.forEach(({ target, borderBoxSize }) => ((target as HTMLElement).style.gridRowEnd = `span ${Math.ceil((borderBoxSize[0]!.blockSize + GAP) / ROW)}`)), later()));
	setInterval(() => document.querySelectorAll<HTMLElement>(".age[data-since]").forEach((el) => age(el, Number(el.dataset.since))), 15_000); // the cards' clocks
	addEventListener("resize", later);
	// The header's height, for what sits under it (the side column, the tiles, the dialogs, the comms' height): it wraps on a narrow window, and a theme's border or padding changes it (the border box is the one watched, as it is the one read).
	new ResizeObserver(([e]) => document.documentElement.style.setProperty("--hud", `${Math.ceil(e!.borderBoxSize[0]!.blockSize)}px`)).observe(document.querySelector(".hud")!, { box: "border-box" });
	mountCalm();
	let shown: Net | undefined;
	const api: Page = {
		layout,
		/** The totals in the header: drawn for every route, since the header is always in view. */
		stats(net) {
			const units = net.bases.flatMap((b) => [...(b.tower?.subs ?? []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs]))]);
			const count = (m?: Mark) => String(units.filter((u) => !m || u.mark === m).length);
			byId("s-commanding", HTMLElement).parentElement!.toggleAttribute("data-on", units.some((u) => u.mark === "commanding"));
			const T = net.yards ? yardsModel : undefined, loose = T?.yardMap(net).loose ?? [], chip = byId("yard-loose", HTMLElement); // projects no unit of the net places keep a chip of their own in the header
			chip.hidden = !T || !loose.length;
			if (T && loose.length) (chip.dataset.yard = loose.join(" "), (chip.textContent = T.chipWords(T.sumCounts(loose.map((p) => T.countsOf(net.yards!.projects.find((x) => x.project === p)!))))), (chip.title = m.yard_chip_title()));
			for (const [id, value] of [["s-bases", String(net.bases.length)], ["s-agents", count()], ["s-working", count("working")], ["s-commanding", count("commanding")], ["s-waiting", count("waiting")]] as const) byId(id, HTMLElement).textContent = value;
		},
		show(net) {
			const T = net.yards ? yardsModel : undefined, ctx = { now: Date.now(), ...(net.load ? { load: net.load } : {}) };
			if (net.yards && !yardsModel) loadingYards ??= import("./trains.ts").then((x) => ((yardsModel = x), shown && (api.show(shown), api.stats(shown))), () => void (loadingYards = undefined));
			shown = net;
			const map = T?.yardMap(net), counts = new Map((net.yards?.projects ?? []).map((p) => [p.project, T?.countsOf(p)]));
			useYards(T?.trainNotes(net, ctx) ?? new Map(), map?.integrators ?? new Map(), T?.trainWaits(net));
			const yardOf = (id: string) => ((projects) => (T && projects?.length ? { projects, chip: T.chipWords(T.sumCounts(projects.map((p) => counts.get(p)!))) } : undefined))(map?.byBase.get(id));
			const { bases: ordered, loose, under } = arrange(net, mergeAllies(net.link?.allies ?? [])), allies = loose.map((a) => ({ ...a, id: `ally/${a.id}`, ally: true as const })); // local bases, remote bases, then the ally cards no live remote base holds
			fillHeadNode(byId("head-node", HTMLElement), net.head);
			sync(bases, [...ordered, ...allies], (item) => ("ally" in item ? allyEl() : baseEl()), (el, item) => ("ally" in item ? fillAlly(el, item, net.link) : fillBase(el, item, { under: under.get(item.id), link: net.link, yard: yardOf(item.id) })));
			for (const el of bases.children) if (!packed.has(el)) (packed.add(el), pack.observe(el));
			for (const el of packed) if (!el.isConnected) (packed.delete(el), pack.unobserve(el));
			requestAnimationFrame(layout);
		},
		pause(paused) {
			document.documentElement.classList.toggle("paused", paused);
		},
	};
	return api;
}
