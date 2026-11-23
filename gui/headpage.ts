import type { MemorySummary, Net } from "../src/net.ts";
import type { HeadAskRow, HeadUnit } from "../src/nethead.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts"; import { iconRef } from "./icons.ts"; import { noun } from "./nouns.ts";
import { LABEL } from "./render.ts";
import { formatRoute } from "./router.ts";
import { statusLine } from "./towermodel.ts";

// What the head tower's page and its entries show of the net's `head` (docs/specs/2026-11-04-head-tower.md, Standard: the head page and its entries): the header's crown button with its dot, the title and state line,
// the asks as chips under the conversation box, and the line for a head that is not open yet. The page itself is the session view on the head's key (session.ts); this file fills what differs.

type Opts = { locale?: "en" | "zh-TW" };
/** The key of this device's record of how far the head's words were read: the time (ms) of the newest assistant text the head page showed. */
export const SEEN = "sb.head.seen";

/** The time this device has read the head up to; none (0) for a device that never opened the page. */
export function seenAt(): number {
	try {
		const n = Number(localStorage.getItem(SEEN));
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}
/** The head page showed the head's newest words: this device has read up to `said` (never back). */
export function remember(said: number) {
	try {
		if (said > seenAt()) localStorage.setItem(SEEN, String(said));
	} catch {} // a device that cannot store it shows the dot again: harmless
}
/** Whether the head said something this device has not read. */
export const headDot = (head: HeadUnit | undefined, seen: number) => Boolean(head?.said && head.said > seen);

/** The header's crown button: there while the net has a head (its page opens even before the head exists), with the head's state for its colour and a dot (no number) while there is news and the head page is not the page. */
export function fillHeadButton(button: HTMLElement, head: HeadUnit | undefined, seen: number, here: boolean) {
	button.hidden = !head;
	if (!head) return;
	button.dataset.mark = head.mark;
	button.dataset.state = head.state;
	button.title = noun("head_tower");
	button.setAttribute("aria-label", head.said && headDot(head, seen) && !here ? `${noun("head_tower")}: ${m.head_new()}` : noun("head_tower"));
	button.toggleAttribute("aria-current", here);
	if (here) button.setAttribute("aria-current", "page");
	const dot = button.querySelector<HTMLElement>(".dot");
	if (dot) dot.hidden = here || !headDot(head, seen);
}

/** The head's memory as its footer shows it: only when it holds a standing instruction, a decision, or a pending proposal (or cannot be read); waits alone, or nothing, leave no footer. */
export const headMemory = (memory: MemorySummary | undefined) => (memory && (memory.standing || memory.decisions || memory.proposals.length || memory.problem) ? memory : undefined);

/** The state line under the title: the service's own word as a workspace tower's, or that the head is not open. */
export const headLine = (head: HeadUnit, o?: Opts) => (head.state === "absent" ? m.head_state_absent({}, o) : statusLine(head.service, head.mark, (mk) => LABEL[mk](), o));
/** The page header: the crown where the comms logo is, the title, the state line, and the one line a head that is not open shows. */
export function fillHeadTitle(root: HTMLElement, head: HeadUnit) {
	const set = (sel: string, text: string) => { const el = root.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
	const icon = root.querySelector<SVGUseElement>(".head-icon");
	if (icon) (icon.dataset.icon = "crown", icon.setAttribute("href", iconRef("crown")));
	const kicker = root.querySelector<HTMLElement>(".head-kicker"); if (kicker) delete kicker.dataset.m; set(".head-kicker", ""); // the comms template's word: retranslate() would write it back
	set(".head-title", noun("head_tower"));
	set(".head-line", headLine(head));
	const absent = root.querySelector<HTMLElement>(".head-absent");
	if (absent) (absent.hidden = head.state !== "absent", set(".head-absent", m.head_absent()));
}

/** One tower's line in a broadcast: the newest word it gave (visible text, not a tooltip), the route to its comms when the net knows the tower, and the message the head sent it. */
export interface AskTower { workspace: string; label: string; state: HeadAskRow["state"]; said?: string; route?: string; sent?: string; missed?: true }
/**
 * One broadcast as a card (docs/specs/2026-11-07-head-log-cards.md): what the boss said (`boss`, when the server kept it), what the head sent (`sent`, whole; `first` its first line), the towers it went to, when it began and when
 * anything last happened. `supersedes` is the earlier ask or group the head named as the one this corrects; `replaces` the groups of the chain folded under this card, newest first, and `replacedBy` the group that folded this one.
 */
export interface AskGroup { id: string; first: string; sent: string; boss?: string; towers: AskTower[]; handled: number; since: number; active: number; supersedes?: string; replaces: AskGroup[]; replacedBy?: string }
const DAY = 86_400_000, RANK = { answered: 4, handled: 3, received: 2, waiting: 1, parked: 1, silent: 0 } as const;
/** A tower that answered, or acted on the message and answered someone else, has handled it (an answer is a handling). */
const handled = (state: HeadAskRow["state"]) => state === "answered" || state === "handled";
const num = (id: string) => Number(id.slice(1));

/**
 * The asks as broadcasts (docs/specs/2026-11-06-head-page-minimal.md): one group per `group` the server wrote, newest first; its towers are the distinct workspaces (a workspace asked twice shows its best state and its newest answer).
 * A group the head named as replaced by a later one is folded under that one's card (`replaces`) and has no place of its own; a group is folded once, under its newest correction. A group with no activity for 24 hours is `older`
 * (a card's place is its own activity, not its folded orders').
 */
export function askGroups(asks: HeadAskRow[], now: number, net: Net | undefined): { recent: AskGroup[]; older: AskGroup[] } {
	const by = new Map<string, HeadAskRow[]>();
	for (const a of asks) by.set(a.group ?? a.id, [...(by.get(a.group ?? a.id) ?? []), a]);
	const groups = [...by].map(([id, rows]): AskGroup => {
		const lead = rows[0]!, list = [...new Set(rows.map((a) => a.workspace))].map((workspace): AskTower => {
			const mine = rows.filter((a) => a.workspace === workspace), best = mine.reduce((x, y) => (RANK[y.state] > RANK[x.state] ? y : x)), said = mine.filter((a) => a.last).sort((x, y) => y.at - x.at)[0]?.last, key = net?.bases.find((b) => b.id === workspace)?.tower?.key, sent = mine.at(-1)!.sent ?? lead.sent ?? mine.at(-1)!.first;
			return { workspace, label: mine.at(-1)!.label, state: best.state, ...(said ? { said } : {}), ...(key ? { route: formatRoute({ view: "session", ws: workspace, key }) } : {}), sent, ...(best.missed ? { missed: true as const } : {}) };
		});
		const boss = rows.find((a) => a.boss)?.boss, supersedes = rows.find((a) => a.supersedes && a.supersedes !== id)?.supersedes;
		return { id, first: lead.first, sent: lead.sent ?? lead.first, ...(boss ? { boss } : {}), towers: list, handled: list.filter((t) => handled(t.state)).length, since: Math.min(...rows.map((a) => a.since)), active: Math.max(...rows.map((a) => a.at)), ...(supersedes ? { supersedes } : {}), replaces: [] };
	}).sort((a, b) => b.since - a.since);
	// A named order folds under its newest correction; a name that points at itself, forward, or at an order the snapshot does not hold folds nothing.
	const byId = new Map(groups.map((g) => [g.id, g]));
	for (const g of groups) {
		const target = g.supersedes ? byId.get(g.supersedes) : undefined;
		if (!target || !(num(target.id) < num(g.id))) continue;
		const held = target.replacedBy ? byId.get(target.replacedBy) : undefined;
		if (!held || held.since < g.since) target.replacedBy = g.id;
	}
	for (const g of groups) {
		if (g.replacedBy) continue;
		for (let cur = g, seen = new Set([g.id]); cur.supersedes; ) {
			const t = byId.get(cur.supersedes);
			if (!t || t.replacedBy !== cur.id || seen.has(t.id)) break;
			g.replaces.push(t);
			seen.add(t.id);
			cur = t;
		}
	}
	const top = groups.filter((g) => !g.replacedBy);
	return { recent: top.filter((g) => now - g.active < DAY), older: top.filter((g) => now - g.active >= DAY) };
}
/** A card's line of when and how many towers handled it (answered, or acted and answered someone else): `1h ago · 1/4 handled`. Who it went to is a part of its own. */
export function groupLine(g: AskGroup, now: number, o?: Opts) {
	const n = Math.max(0, now - g.since) / 1000, age = n < 60 ? m.age_s({ n: String(Math.floor(n)) }, o) : n < 3600 ? m.age_m({ n: String(Math.floor(n / 60)) }, o) : n < 86_400 ? m.age_h({ n: String(Math.floor(n / 3600)) }, o) : m.age_d({ n: String(Math.floor(n / 86_400)) }, o);
	return (g.towers.length === 1 ? m.head_group_one : m.head_group)({ age, handled: g.handled, count: g.towers.length }, o);
}
const QUOTES: Record<string, string> = { "「": "」", "『": "』", "“": "”", "\"": "\"", "'": "'", "‘": "’" };
/**
 * The head's message as the card's one line: its first line with words in it, the boss's own words left out of it when it copies them exactly (they have a part of their own; a paraphrase is the head's words and stays). When the copy sits
 * in one pair of quotation marks the pair goes with it, and so does a full stop right after the pair, so no `「…」` or `「」.` is left; a copy with no quotation marks around it is marked `…`. When nothing else is left the whole message is the line,
 * and so for an ask from before the whole text was kept (its first line). Nothing is made of the boss's words as a pattern: only the characters next to the exact copy are looked at.
 */
export function sentLine(g: { sent?: string; boss?: string; first: string }): string {
	if (!g.sent) return g.first;
	const at = g.boss ? g.sent.indexOf(g.boss) : -1;
	let text = g.sent;
	if (at >= 0) {
		let before = g.sent.slice(0, at), after = g.sent.slice(at + g.boss!.length), mark = "…";
		const open = before.at(-1);
		if (open && QUOTES[open] !== undefined && after.startsWith(QUOTES[open]!)) (before = before.slice(0, -1), after = after.slice(1), (mark = ""), /^[.。]/.test(after) && (after = after.slice(1)));
		if ((before + after).trim()) text = before + mark + after;
	}
	return text.split("\n").map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()).find(Boolean) ?? g.first;
}
const STATE: Record<HeadAskRow["state"], (o?: Opts) => string> = { waiting: (o) => m.head_ask_waiting({}, o), answered: (o) => m.head_ask_answered({}, o), handled: (o) => m.head_ask_handled({}, o), received: (o) => m.head_ask_received({}, o), silent: (o) => m.head_ask_silent({}, o), parked: (o) => m.head_ask_parked({}, o) };
/** Whether nothing can come of this row: the net has no tower of the workspace and it never handled it, so waiting is a word it cannot keep. */
export const gone = (t: AskTower) => !t.route && !handled(t.state) && t.state !== "parked"; // a parked notice waits in a workspace with no tower yet: it says parked, not that there is none
/** A tower's state word; for a workspace the net has no tower of and that never handled it, that there is none (muted, no wait). */
export const towerState = (t: AskTower, o?: Opts) => (gone(t) ? m.head_ask_no_tower({}, o) : STATE[t.state](o));

/**
 * The log's fold around the cards (`<details class="head-log">`, session.ts): closed it is one line, the title with how many orders there are and the newest order's own line, so the conversation keeps the page; the boss opens it
 * to the cards, which then scroll in a box of their own (style.css). Hidden with no orders. The open state is the element's, so a redraw leaves it as the boss left it.
 */
export function fillHeadLog(log: HTMLElement, head: HeadUnit | undefined, net: Net | undefined, now = Date.now(), o?: Opts) {
	const { recent, older } = head ? askGroups(head.asks, now, net) : { recent: [], older: [] }, newest = recent[0] ?? older[0];
	log.hidden = !newest;
	if (!newest) return;
	const set = (sel: string, text: string) => { const el = log.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
	set("summary b", m.head_log_title({ count: recent.length + older.length }, o));
	set("summary span", sentLine(newest));
}

const opened = new WeakMap<HTMLElement, Set<string>>();
/**
 * The broadcasts under the conversation box (docs/specs/2026-11-07-head-log-cards.md): a card each, whose closed line is its parts (what the boss said, what the head sent, to whom) and when with how many replied, and which unfolds to the whole texts,
 * each tower's state and answer, and the orders it replaced. Redrawn only when they change, so a click never lands on a row that was replaced, and a card or fold the boss unfolded stays unfolded across a redraw.
 */
export function fillHeadAsks(box: HTMLElement, head: HeadUnit | undefined, net: Net | undefined, now = Date.now()) {
	const { recent, older } = head ? askGroups(head.asks, now, net) : { recent: [], older: [] }, lines = new Map([...recent, ...older].flatMap((g) => [g, ...g.replaces]).map((g) => [g.id, groupLine(g, now)])), sig = JSON.stringify([recent, older, [...lines]]);
	box.hidden = !recent.length && !older.length;
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	const keep = opened.get(box) ?? opened.set(box, new Set()).get(box)!;
	box.setAttribute("aria-label", m.head_asks_label());
	const unfold = (el: HTMLElement, id: string) => (keep.has(id) && el.setAttribute("open", ""), el.addEventListener("toggle", () => void (el.hasAttribute("open") ? keep.add(id) : keep.delete(id))), el);
	const part = (name: string, tag: string, text: string) => h("span", { class: "ask-part", "data-part": name }, h("b", { class: "ask-tag" }, tag), h("span", { class: "ask-text" }, text));
	const section = (name: string, tag: string, text: string) => h("section", { "data-part": name }, h("b", { class: "ask-tag" }, tag), h("p", null, text));
	const tower = (g: AskGroup) => (t: AskTower) => h("li", { class: "ask-tower", "data-state": gone(t) ? "none" : t.state },
		h("span", { class: "ask-line" }, t.route ? h("a", { class: "ask-name", href: t.route || "./", "data-route": t.route }, t.label) : h("b", { class: "ask-name" }, t.label), h("span", { class: gone(t) ? "ask-none" : "ask-state" }, towerState(t)), ...(t.route || gone(t) ? [] : [h("span", { class: "ask-none" }, m.head_ask_no_tower())])),
		...(t.said ? [h("p", { class: "ask-said" }, t.said)] : []),
		...(t.state === "handled" ? [h("p", { class: "ask-note" }, (t.missed ? m.head_ask_missed_note : m.head_ask_handled_note)())] : []),
		...(t.sent && t.sent !== g.sent ? [h("p", { class: "ask-sent", "data-tag": m.head_part_sent() }, t.sent)] : []));
	const group = (g: AskGroup): HTMLElement => {
		// What the boss reads says how many orders and in which direction; the ids are the tooltip's (and the card's `data-id`).
		const chain = g.replacedBy ? m.head_replaced_by() : g.supersedes ? m.head_replaces({ count: Math.max(1, g.replaces.length) }) : "", ids = g.replacedBy ?? (g.replaces.length ? g.replaces.map((r) => r.id) : [g.supersedes]).join(", ");
		const card = h("details", { class: "ask-group", "data-id": g.id, ...(g.replacedBy ? { "data-superseded": "" } : {}) },
			h("summary", null,
				...(g.boss ? [part("boss", m.head_part_boss(), g.boss)] : []),
				part("sent", m.head_part_sent(), sentLine(g)),
				part("to", m.head_part_to(), g.towers.map((t) => t.label).join(m.head_sep())),
				h("span", { class: "ask-foot" }, h("span", { class: "ask-meta" }, lines.get(g.id)!), ...(chain ? [h("span", { class: "ask-chain", title: ids }, chain)] : []))),
			h("div", { class: "ask-full" }, ...(g.boss ? [section("boss", m.head_part_boss(), g.boss)] : []), section("sent", m.head_part_sent(), g.sent)),
			h("ul", { class: "ask-towers" }, ...g.towers.map(tower(g))),
			...(g.replaces.length ? [unfold(h("details", { class: "ask-replaced", "data-id": `replaced-${g.id}` }, h("summary", null, m.head_replaced_fold({ count: g.replaces.length })), ...g.replaces.map(group)), `replaced-${g.id}`)] : []));
		return unfold(card, g.id);
	};
	box.replaceChildren(...recent.map(group), ...(older.length ? [unfold(h("details", { class: "ask-older", "data-id": "older" }, h("summary", null, m.head_older({ count: older.length })), ...older.map(group)), "older")] : []));
}
