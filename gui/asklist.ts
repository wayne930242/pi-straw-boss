import type { AskView } from "../src/asktypes.ts";
import { m } from "./sentences.ts";
import { ago, html, sync, text } from "./render.ts";

// The open questions to the boss (docs/specs/2026-11-28-boss-asks.md, The GUI): one list on the head page (every one) and on a workspace's page (its own), `Q3 · subject · asker · where · 5m`. A tap opens its card
// (the unit's dialog, or the wait card) through main.ts, else the asker's comms; Terminal opens the asker's pane. The plates' count is render.ts `asksBadge`.

const KIND: Record<AskView["kind"], () => string> = { boss: m.ask_kind_boss, dialog: m.ask_kind_dialog, wait: m.ask_kind_wait, link: m.ask_kind_link };
const rowEl = () => html(`<li class="ask-row"><a class="ask-open"><b class="ask-id"></b><em class="ask-kind"></em><span class="ask-subject"></span><span class="ask-who"></span><span class="ask-blocks"></span><span class="age"></span></a><button type="button" class="ask-term"></button></li>`);
/** The alert a row opens: a wait card's is the card (gui/waits.ts), a dialog's or a boss question's is its unit's. */
export const askAlert = (a: AskView) => (a.wait && a.ws ? `wait\u001f${a.ws}\u001f${a.wait}` : a.unit);

function fill(el: HTMLElement, a: AskView) {
	el.dataset.kind = a.kind;
	const open = el.querySelector<HTMLAnchorElement>(".ask-open")!, term = el.querySelector<HTMLButtonElement>(".ask-term")!, alert = askAlert(a);
	Object.assign(open.dataset, { askWs: a.ws ?? "", askUnit: a.unit ?? "" });
	if (alert) open.dataset.askAlert = alert;
	else delete open.dataset.askAlert;
	open.title = m.asks_open_title();
	text(el, ".ask-id", `Q${a.n}`);
	text(el, ".ask-kind", KIND[a.kind]());
	text(el, ".ask-subject", a.subject);
	text(el, ".ask-who", a.where && a.where !== a.asker ? `${a.asker} · ${a.where}` : a.asker);
	text(el, ".ask-blocks", a.item ? m.asks_blocks({ id: String(a.item.id) }) : "");
	const age = el.querySelector<HTMLElement>(".age")!;
	age.dataset.since = String(a.since);
	age.textContent = ago(a.since);
	term.hidden = !a.pane || !a.unit;
	[term.textContent, term.title] = [m.asks_terminal(), m.asks_terminal_title()];
	Object.assign(term.dataset, { askWs: a.ws ?? "", askTerm: a.unit ?? "" });
}

/** Draws `asks` into its `<section class="boss-asks">`; hidden with none. */
export function fillAskList(box: HTMLElement, asks: AskView[] | undefined) {
	box.hidden = !asks?.length;
	if (!asks?.length) return;
	if (!box.firstElementChild) box.append(html(`<h3><b></b><span></span></h3>`), html(`<ul class="ask-rows"></ul>`));
	text(box, "h3 b", m.asks_title());
	text(box, "h3 span", m.asks_count({ n: String(asks.length) }));
	sync(box.querySelector("ul")!, asks, rowEl, fill);
}
