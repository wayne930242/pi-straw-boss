import type { Base, Net, Unit } from "../src/net.ts";
import { m } from "./paraglide/messages.js";
import type { Route } from "./router.ts";

// Quit: the buttons on the map that close a unit, a tower, a squad, or a base, and what a click on one does; a finished subagent's Dismiss, and the HUD's Dismiss finished (every one at once). A button's data-close names what it closes and its data
// the rest (key, name, role, ws, tab); the click asks first in the page's own dialog (a browser confirm can be dismissed by an attached tool before it is seen), then
// posts close/unit, close/tab, or (for a base, checked first) close/all; Stash posts close/stash and the HUD's Stashed list Pop posts close/pop. The net shows what went, and a refusal says why in the same dialog.

/** Aims a `.quit-btn` at what it closes. `hidden` is for one that may not quit. */
function aim(button: HTMLElement, data: Record<string, string>, label: string, aria?: string, hidden = false) {
	Object.assign(button.dataset, data);
	[button.hidden, button.textContent] = [hidden, label];
	if (aria) button.setAttribute("aria-label", aria);
}
/** A unit's own; quitting is the map's alone, and a subagent is its launcher's to quit. A finished subagent is dismissed instead, on every page. */
export const aimUnit = (button: HTMLElement, u: { key?: string; name: string; role: string; control?: boolean; ended?: boolean }) =>
	u.role === "subagent" && u.ended && u.key ? aim(button, { close: "dismiss", key: u.key, name: u.name, role: u.role }, m.dismiss(), m.dismiss_unit({ name: u.name }))
		: aim(button, { close: "unit", key: u.key ?? "", name: u.name, role: u.role }, m.quit(), m.close_unit({ name: u.name }), !(u.control && u.key) || u.role === "subagent");
/** The base's tower alone, its mains back to members. */
export const aimTower = (button: HTMLElement, tower: Base["tower"]) => aim(button, { key: tower?.key ?? "", name: tower?.name ?? "", role: "tower" }, m.quit_tower(), undefined, !tower?.control);
export const aimBase = (button: HTMLElement, b: Base) => aim(button, { ws: b.id, name: b.label }, m.quit(), m.close_base({ name: b.label }));
/** The base's Stash: its tower, mains, and members quit, to come back with Pop (the server names the stash after the base). */
export const aimStash = (button: HTMLElement, b: Base) => aim(button, { ws: b.id, name: b.label }, m.stash(), m.stash_base({ name: b.label }));
export const aimSquad = (button: HTMLElement, b: Base, t: { id: string; label: string }) => aim(button, { ws: b.id, name: t.label, tab: t.id }, m.quit(), m.close_squad({ name: t.label }));

const sheet = (text: string, yes?: string): Promise<boolean> => new Promise((done) => {
	const d = document.createElement("dialog"), p = document.createElement("p"), row = document.createElement("div");
	const button = (label: string, cls: string, answer: boolean) => Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: label, onclick: () => (d.close(), done(answer)) });
	[d.className, p.textContent, row.className] = ["sheet", text, "sheet-row"];
	row.append(...(yes ? [button(m.cancel(), "later", false), button(yes, "sheet-yes", true)] : [button(m.close(), "later", false)]));
	d.append(p, row);
	d.addEventListener("close", () => (d.remove(), done(false)));
	document.body.append(d);
	d.showModal();
});

/** The keys of the finished subagents on the net, as the server counts them (net.ts: the subagents of the tower, of each tab's units, and of the outside units). */
export const endedSubs = (net: Net): string[] => net.bases.flatMap((b) => [...(b.tower ? [b.tower] : []), ...b.tabs.flatMap((t) => t.units), ...b.outside]).flatMap((u) => u.subs).filter((c) => c.ended).map((c) => c.key);

/** The HUD's Dismiss finished button: shown only while a finished subagent is on the net, and says how many. */
export function showDismissAll(button: HTMLElement, net: Net) {
	const n = endedSubs(net).length;
	button.hidden = !n;
	if (n) button.textContent = m.dismiss_all({ count: n });
}

/** The HUD's Stashed button and its list, each stash with its Pop: shown only while something is stashed. */
export function showStashed(button: HTMLElement, list: HTMLElement, net: Net) {
	const all = net.stashed ?? [], key = JSON.stringify(all);
	button.hidden = !all.length;
	const box = list.closest<HTMLElement>("[popover]");
	if (!all.length && box?.matches(":popover-open")) box.hidePopover();
	if (all.length) button.textContent = m.stashed_button({ count: all.length });
	if (list.dataset.key === key) return;
	list.dataset.key = key;
	list.replaceChildren(...all.map((st) => {
		const li = document.createElement("li"), name = document.createElement("span"), pop = document.createElement("button");
		name.textContent = st.name === st.label ? st.label : `${st.name} (${st.label})`;
		[pop.type, pop.className] = ["button", "pair-btn"];
		aim(pop, { close: "pop", name: st.name }, m.pop(), m.pop_base({ name: st.name }));
		li.append(name, pop);
		return li;
	}));
}

/** Dismisses finished subagents, one by key or all; a refusal or no answer says why in the page's dialog. Resolves whether it went. */
export const dismiss = (body: { key: string } | { all: true }) => import("./post.ts").then(({ post }) => post("dismiss", body)).then((r) => r.ok || (sheet(r.body.reason ?? m.refused({ status: r.status })), false), () => (sheet(m.no_answer()), false));

export interface QuitDeps { route(): Route; net(): Net | undefined; go(route: Route): void }

/** A view of what was just closed goes up to what is left: a closed base to the map, a closed squad or unit to its base. */
function leave(d: DOMStringMap, { route, net, go }: QuitDeps) {
	const current = route();
	if (current.view === "map") return;
	if (d.close === "base" || d.close === "stash") return void (current.ws === d.ws && go({ view: "map" }));
	const keys = (units: Unit[]): string[] => units.flatMap((u) => [u.key, ...keys(u.subs)]);
	const tab = d.close === "tab" && current.ws === d.ws ? net()?.bases.find((x) => x.id === d.ws)?.tabs.find((t) => t.id === d.tab) : undefined;
	if (current.view === "session" && (d.close === "unit" ? current.key === d.key : tab && keys(tab.units).includes(current.key))) go({ view: "workspace", ws: current.ws });
}

export function mountQuit(deps: QuitDeps) {
	document.addEventListener("click", (event) => {
		const b = (event.target as Element | null)?.closest?.<HTMLElement>("button[data-close]"), d = b?.dataset;
		if (!b || !d) return;
		event.preventDefault();
		if (d.close === "dismiss" || d.close === "dismiss-all") return void dismiss(d.close === "dismiss" ? { key: d.key! } : { all: true });
		if (d.close === "pop") return void (b.toggleAttribute("disabled", true), import("./post.ts").then(({ post }) => post("close/pop", { name: d.name })).then((r) => r.ok || sheet(r.body.reason ?? m.refused({ status: r.status })), () => sheet(m.no_answer())).finally(() => b.toggleAttribute("disabled", false)));
		const ask = d.close === "stash" ? m.stash_base_ask : d.close === "base" ? m.close_base_ask : d.close === "tab" ? m.close_squad_ask : d.role === "tower" ? m.close_tower_ask : m.close_unit_ask;
		void sheet(ask({ name: d.name ?? "" }), d.close === "stash" ? m.stash() : m.quit()).then((yes) => {
			if (!yes) return;
			b.toggleAttribute("disabled", true);
			void import("./post.ts").then(({ post }) => post(`close/${d.close === "base" ? "all" : d.close}`, d.close === "unit" ? { key: d.key } : { workspace: d.ws, ...(d.tab && { tab: d.tab }), }))
				.then((r) => (r.ok ? leave(d, deps) : sheet(r.body.reason ?? m.refused({ status: r.status }))), () => sheet(m.no_answer())).finally(() => b.toggleAttribute("disabled", false));
		});
	});
}
