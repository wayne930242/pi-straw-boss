import type { Base, Net, Unit } from "../src/net.ts";
import { m } from "./paraglide/messages.js";
import type { Route } from "./router.ts";

// Quit: the buttons on the map that close a unit, a tower, a squad, or a base, and what a click on one does. A button's data-close names what it closes and its data
// the rest (key, name, role, ws, tab); the click asks first in the page's own dialog (a browser confirm can be dismissed by an attached tool before it is seen), then
// posts close/unit, close/tab, or close/base; the net shows what went, and a refusal says why in the same dialog.

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

export interface QuitDeps { route(): Route; net(): Net | undefined; go(route: Route): void }

/** A view of what was just closed goes up to what is left: a closed base to the map, a closed squad or unit to its base. */
function leave(d: DOMStringMap, { route, net, go }: QuitDeps) {
	const current = route();
	if (current.view === "map") return;
	if (d.close === "base") return void (current.ws === d.ws && go({ view: "map" }));
	const keys = (units: Unit[]): string[] => units.flatMap((u) => [u.key, ...keys(u.subs)]);
	const tab = d.close === "tab" && current.ws === d.ws ? net()?.bases.find((x) => x.id === d.ws)?.tabs.find((t) => t.id === d.tab) : undefined;
	if (current.view === "session" && (d.close === "unit" ? current.key === d.key : tab && keys(tab.units).includes(current.key))) go({ view: "workspace", ws: current.ws });
}

export function mountQuit(deps: QuitDeps) {
	document.addEventListener("click", (event) => {
		const b = (event.target as Element | null)?.closest?.<HTMLElement>("button[data-close]"), d = b?.dataset;
		if (!b || !d) return;
		event.preventDefault();
		if (d.close === "dismiss") return void import("./post.ts").then(({ post }) => post("dismiss", { key: d.key })).then((r) => r.ok || sheet(r.body.reason ?? m.refused({ status: r.status })), () => sheet(m.no_answer()));
		const ask = d.close === "base" ? m.close_base_ask : d.close === "tab" ? m.close_squad_ask : d.role === "tower" ? m.close_tower_ask : m.close_unit_ask;
		void sheet(ask({ name: d.name ?? "" }), m.quit()).then((yes) => {
			if (!yes) return;
			b.toggleAttribute("disabled", true);
			void import("./post.ts").then(({ post }) => post(`close/${d.close}`, d.close === "unit" ? { key: d.key } : { workspace: d.ws, ...(d.tab && { tab: d.tab }) }))
				.then((r) => (r.ok ? leave(d, deps) : sheet(r.body.reason ?? m.refused({ status: r.status }))), () => sheet(m.no_answer())).finally(() => b.toggleAttribute("disabled", false));
		});
	});
}
