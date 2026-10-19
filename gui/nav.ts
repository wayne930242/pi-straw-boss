import { m } from "./paraglide/messages.js";
import { aim } from "./render.ts";
import type { Route } from "./router.ts";
import { locate, type Scene } from "./scene.ts";

/** The location bar under the HUD: the net, the base, the unit, each a link one level up. */
export function crumbs(scene: Readonly<Scene>) {
	const part = (tag: "a" | "b" | "span", label: string, to?: Route) => {
		const node = document.createElement(tag);
		node.textContent = label;
		if (to) aim(node, to);
		return node;
	};
	const nav = document.getElementById("crumbs")!, { route: r, net, info } = scene;
	if (r.view === "map") return nav.replaceChildren(part("b", "Straw Net"), part("span", m.all_bases()));
	const label = net?.bases.find((b) => b.id === r.ws)?.label ?? r.ws, name = r.view === "session" ? (locate(net, r.key)?.u.name ?? info?.name ?? r.key) : "";
	// A subagent sits under the session that launched it, and that one under its own launcher.
	const chain: { key: string; name: string }[] = [];
	for (let f = r.view === "session" ? locate(net, r.key) : undefined, n = 0; f?.launcher && n < 8; f = locate(net, f.launcher.key), n++) chain.unshift(f.launcher);
	const parts = [part("a", "Straw Net", { view: "map" }), r.view === "workspace" ? part("b", label) : part("a", label, { view: "workspace", ws: r.ws }), ...chain.map((u) => part("a", u.name, { view: "session", ws: r.ws, key: u.key })), ...(name ? [part("b", name)] : [])];
	// On a narrow screen the levels between the net and the last two fold into "…", which unfolds them.
	parts.slice(1, -2).forEach((p) => p.classList.add("mid"));
	const more = parts.length > 3 ? [Object.assign(part("span", "…"), { className: "crumb-more", role: "button", tabIndex: 0, onclick: () => nav.classList.toggle("open") })] : [];
	nav.classList.remove("open");
	nav.replaceChildren(parts[0]!, ...more, ...parts.slice(1));
}

/** Into a base the view zooms out of the base's spot on the map; into a session it slides in; going up it settles back. */
export function entrance(next: Route, before: Route, from?: DOMRect) {
	const depth = (r: Route) => ["map", "workspace", "session"].indexOf(r.view);
	const kind = depth(next) < depth(before) ? "enter-back" : next.view === "workspace" && from ? "enter-zoom" : next.view === "session" && before.view !== "session" ? "enter-slide" : "";
	const view = document.getElementById({ map: "map", workspace: "ws-view", session: "session-view" }[next.view])!;
	if (!kind) return;
	if (from) {
		const box = view.getBoundingClientRect();
		view.style.setProperty("--ox", `${Math.round(from.x + from.width / 2 - box.x)}px`);
		view.style.setProperty("--oy", `${Math.round(from.y + from.height / 2 - box.y)}px`);
	}
	view.classList.remove("enter-zoom", "enter-slide", "enter-back");
	void view.offsetWidth;
	view.classList.add(kind);
	setTimeout(() => view.classList.remove(kind), 700);
}
