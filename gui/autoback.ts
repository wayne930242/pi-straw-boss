import { HEAD_KEY } from "../src/headkey.ts";
import type { BossWait, Net } from "../src/net.ts";
import { clockOf } from "./auto.ts";
import { h, nodes } from "./dom.ts";
import { type Answer, post } from "./post.ts";
import { m } from "./sentences.ts";

// The return panel (docs/specs/2026-11-09-auto-mode.md, section 8, point 3): when the boss is back, one panel with what auto mode left. The parked waits come first: since 2026-11-21 (docs/specs/2026-11-21-auto-return.md, AR-D3) as
// lines that say where each went back to, to be asked again there; a list written before draws them as the same cards the tower's rows draw (pressable). Then the rest folded:
// what was cancelled or refused, what a tower answered on its own, what still waits, the boss's other computers' asks. Closing it leaves the cards as open waits. The list is the server's (`auto/report`); the panel opens once per report on
// each device, on the next page load or when this page's own switch ends auto mode.

/** One parked wait of the list, as the server wrote it (src/server/autotower.ts `ParkedRow`). */
export interface BackRow { workspace: string; head?: true; tower: string; id: string; text: string; type: string; from?: string; at: string; /** Where the card went when auto mode ended (docs/specs/2026-11-21-auto-return.md, AR-D3, AR-D4); absent in a list written before. */ returned?: "raiser" | "tower" | "gone" }
export interface BackLine { session: string; tool: string; kind: string; count: number; first: string; gist: string }
/** The last period's return list, the fields the panel reads (src/server/autotower.ts `Report`). */
export interface BackReport {
	v: 1; since: string; until: string; on: string; off: string; parked: BackRow[]; lines: BackLine[];
	decided: { at: string; run: string; to: string; gist: string; basis: string }[]; stillWaiting: BackLine[]; boxes: { box: string; gist: string }[]; foreign: { at: string; why: string }[];
}
/** A report older than this is not news (the boss was away that long and the cards stand as open waits anyway). */
export const BACK_DAYS = 3;
export const BACK_KEY = "sb.auto.back";
type Opts = { locale?: "en" | "zh-TW" };
export interface BackDeps {
	net(): Net | undefined;
	/** The last list this device was shown (its `until`). */
	store: { get(): string | null; set(value: string): void };
	now(): number;
	post?(path: string, body: Record<string, unknown>): Promise<Answer>;
	locale?: Opts["locale"];
}

type Kit = { waitCard: typeof import("./waitcard.ts").waitCard; waitActions: typeof import("./asks.ts").waitActions; answerPost: typeof import("./answer.ts").answerPost };
let loading: Promise<Kit> | undefined;
const load = () => (loading ??= Promise.all([import("./waitcard.ts"), import("./asks.ts"), import("./answer.ts")]).then(([w, a, r]) => ({ waitCard: w.waitCard, waitActions: a.waitActions, answerPost: r.answerPost })));

/** The wait a parked row is about, still open in the snapshot, with where its presses go: a tower's base by its workspace, else the head's own memory. */
export function openWait(net: Net | undefined, row: BackRow): { ws: string; key: string; wait: BossWait } | undefined {
	const open = (w: BossWait) => !w.state && !w.answered;
	if (!row.head) {
		for (const b of net?.bases ?? []) {
			if (b.id !== row.workspace || !b.tower) continue;
			const w = b.tower.service?.memory?.bossWaits.find((x) => x.id === row.id);
			return w && open(w) ? { ws: b.id, key: b.tower.key, wait: w } : undefined;
		}
		return undefined;
	}
	const head = net?.head, w = head?.service?.memory?.bossWaits.find((x) => x.id === row.id);
	return head && w && open(w) ? { ws: HEAD_KEY, key: head.key, wait: w } : undefined;
}

const KIND: Record<string, (i: object, o?: Opts) => string> = { refused: m.back_kind_refused, cancelled: m.back_kind_cancelled, escaped: m.back_kind_escaped, trust: m.back_kind_trust, "still-waiting": m.back_kind_stillwaiting, "re-asked": m.back_kind_reasked, backstop: m.back_kind_backstop };
const lineText = (l: BackLine, o: Opts) => `${l.session || "?"}: ${l.tool} ${(KIND[l.kind] ?? (() => l.kind))({}, o)}${l.count > 1 ? ` ×${l.count}` : ""}${l.gist ? ` “${l.gist}”` : ""} (${clockOf(l.first)})`;
const list = (title: string, rows: string[]) => (rows.length ? h("section", { class: "auto-back-sec" }, h("h4", null, title), h("ul", null, ...rows.map((r) => h("li", null, r)))) : null);

export function mountBack(host: HTMLElement, d: BackDeps) {
	const o: Opts = d.locale ? { locale: d.locale } : {};
	const send = d.post ?? post;
	let shown: BackReport | undefined, cards = new Map<string, { update(w: BossWait, on?: boolean): void }>(), find = new Map<string, BackRow>();
	host.classList.add("auto-back");
	host.setAttribute("aria-labelledby", "auto-back-title");
	host.setAttribute("tabindex", "-1");
	host.hidden = true;

	async function open(report: BackReport): Promise<void> {
		shown = report;
		const net = d.net(), kit = await load(), said = h("p", { class: "auto-back-said", role: "status" });
		cards = new Map();
		find = new Map();
		let settled = 0;
		// Since AR-D3 a parked card is closed and goes back to whoever raised it: the list says where, and nothing is left here to press.
		const returned = report.parked.filter((row) => row.returned);
		const wentTo = (row: BackRow) => (row.returned === "tower" ? m.back_to_tower({}, o) : row.returned === "gone" ? m.back_gone({ name: row.from ?? "?" }, o) : m.back_to_raiser({ name: row.from ?? "?" }, o));
		const drawn = report.parked.filter((row) => !row.returned).flatMap((row) => {
			const at = openWait(net, row);
			if (!at) return (settled++, []);
			const key = `${at.ws}\u001f${row.id}`, card = kit.waitCard({ host: "row", wait: at.wait, ...(at.ws === HEAD_KEY ? { head: true } : {}), actions: kit.waitActions({ ws: at.ws, id: row.id, tower: at.key }, kit.answerPost(at.key)), done: (line) => (said.textContent = line) });
			card.update(at.wait, document.body?.dataset?.stale !== "true");
			cards.set(key, card);
			find.set(key, row);
			return [h("li", { class: "auto-back-card" }, h("small", { class: "auto-back-from" }, row.tower), card.el)];
		});
		const close = h("button", { type: "button", class: "pair-btn auto-back-close" }, m.back_close({}, o));
		close.onclick = () => closePanel();
		const rest = h("details", { class: "auto-back-rest" }, h("summary", null, m.back_rest({}, o)),
			list(m.back_cancelled({ n: String(report.lines.reduce((n, l) => n + (l.kind === "re-asked" ? 0 : l.count), 0)) }, o), report.lines.map((l) => lineText(l, o))),
			list(m.back_decided({ n: String(report.decided.length) }, o), report.decided.map((x) => `${clockOf(x.at)} → ${x.to}${x.gist ? `: ${x.gist}` : ""} (${m.back_basis({ basis: x.basis }, o)})`)),
			list(m.back_still({ n: String(report.stillWaiting.length) }, o), report.stillWaiting.map((l) => lineText(l, o))),
			list(m.back_boxes({ n: String(report.boxes.length) }, o), report.boxes.map((b) => `${b.box}: ${b.gist}`)),
			report.foreign.length ? h("p", { class: "auto-back-foreign" }, m.back_foreign({ n: String(report.foreign.length) }, o)) : null);
		host.replaceChildren(...nodes(
			h("h2", { class: "auto-back-title", id: "auto-back-title" }, m.back_title({}, o)),
			h("p", { class: "auto-back-when" }, m.back_when({ from: clockOf(report.since), until: clockOf(report.until) }, o)),
			returned.length ? h("section", { class: "auto-back-returned" }, h("h3", null, m.back_returned({ n: String(returned.length) }, o)), h("ul", null, ...returned.map((row) => h("li", null, `${row.id} · ${row.tower}: ${row.text} — ${wentTo(row)}`)))) : null,
			drawn.length ? h("section", { class: "auto-back-parked" }, h("h3", null, m.back_parked({ n: String(drawn.length) }, o)), h("ul", { class: "auto-back-cards" }, ...drawn), said) : returned.length ? null : h("p", { class: "auto-back-none" }, m.back_none({}, o)),
			settled ? h("p", { class: "auto-back-settled" }, m.back_settled({ n: String(settled) }, o)) : null,
			rest, h("div", { class: "auto-back-acts" }, close)));
		host.hidden = false;
		(host as HTMLDialogElement).showModal?.();
		host.focus(); // the panel itself takes the focus when it opens, not its first card
	}
	function closePanel() {
		seen();
		host.hidden = true;
		(host as HTMLDialogElement).close?.();
	}
	/** This device has been shown the list: the close button, and Esc (the dialog's own `close`), both record it. */
	function seen() { if (shown) d.store.set(shown.until); }
	host.addEventListener("close", seen);
	/** Reads the last list and opens it when this device has not been shown it, it is recent, and auto mode is not on again (`force`: this page just ended it, and its snapshot has not said so yet). */
	async function check(force = false): Promise<void> {
		if (!force && d.net()?.auto?.on) return;
		const r = await send("auto/report", {}).catch(() => undefined);
		const report = r?.ok ? (r.body.report as BackReport | null | undefined) : undefined;
		if (!report || report.v !== 1 || typeof report.until !== "string" || !Array.isArray(report.parked)) return;
		const until = Date.parse(report.until);
		const seen = d.store.get();
		if ((seen && until <= Date.parse(seen)) || d.now() - until > BACK_DAYS * 86_400_000) return;
		await open(report);
	}
	return {
		open, check, close: closePanel,
		/** Each snapshot: a card still open follows its wait; one that was answered stays as it ended. */
		net(net: Net | undefined) {
			for (const [key, row] of find) {
				const at = openWait(net, row);
				if (at) cards.get(key)?.update(at.wait, document.body?.dataset?.stale !== "true");
			}
		},
	};
}
