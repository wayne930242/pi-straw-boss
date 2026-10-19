import type { Mark } from "../src/dashboard.ts";
import type { Route } from "./router.ts";
import { aim, doing, fillPlate, html, mark, PLATE, roleName, text, urgent } from "./render.ts";

// The unit token of the focus views (the workspace's squads and camps, the dossier's dispatched subagents) and the link that goes with it.

export const tokenEl = () => html(`<a class="token">${PLATE}<span class="name"></span><span class="line"><em class="role"></em><span class="note"></span></span></a>`);
export function fillToken(el: HTMLElement, u: { key?: string; name: string; role: string; mark: Mark; note?: string; docs?: { onScreen: boolean }[] }, ws: string) {
	aim(el, u.key ? { view: "session", ws, key: u.key } : undefined);
	el.toggleAttribute("hidden", false);
	el.toggleAttribute("data-alert", Boolean(u.key) && urgent(u.mark));
	mark(el, u.mark);
	fillPlate(el.querySelector(".plate")!, u.role, u.mark, u.docs);
	text(el, ".name", u.name);
	text(el, ".role", roleName(u.role));
	text(el, ".note", doing(u.note, u.mark));
}
export const linkTo = (r: Route, label: string) => {
	const a = document.createElement("a");
	aim(a, r);
	a.textContent = label;
	return a;
};
