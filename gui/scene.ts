import type { Mark } from "../src/dashboard.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import type { HistoryEvent, Who } from "./chat.ts";
import type { Route } from "./router.ts";

// What the focus views draw from. views.ts owns the one Scene and is its only writer; the views (workspace, session, dossier, location bar) are
// handed it read-only and draw whatever it holds when views.ts calls them.

export interface Scene { route: Route; net?: Net; cards: Record<string, string>; info?: HistoryEvent; model?: string; ctx?: number }
export const wsOf = (scene: Readonly<Scene>) => (scene.route.view === "map" ? "" : scene.route.ws);

export type Found = { u: Who & { subs: Unit[] }; base: Base; squad?: string; launcher?: Unit };

export function locate(net: Net | undefined, key: string): Found | undefined {
	for (const base of net?.bases ?? []) {
		if (base.tower?.key === key) return { u: { key, name: base.tower.name, role: "tower", mark: base.tower.mark, control: base.tower.control, pending: base.tower.pending, docs: base.tower.docs, docsCut: base.tower.docsCut, subs: [] }, base };
		for (const [squad, units] of [...base.tabs.map((t) => [t.label, t.units] as const), [undefined, base.outside] as const])
			for (const u of units) {
				if (u.key === key) return { u, base, squad };
				const sub = u.subs.find((s) => s.key === key);
				if (sub) return { u: sub, base, squad, launcher: u };
			}
	}
}

/** The unit a session route is about, as the net describes it, else as the history's header does: the same facts the comms header and the dossier both show. */
export function subject(scene: Readonly<Scene>) {
	if (scene.route.view !== "session") return;
	const key = scene.route.key, hit = locate(scene.net, key), u = hit?.u;
	return { key, hit, u, mk: u?.mark ?? ("unknown" as Mark), state: scene.info?.state, name: u?.name ?? scene.info?.name ?? key };
}
export type Subject = NonNullable<ReturnType<typeof subject>>;
