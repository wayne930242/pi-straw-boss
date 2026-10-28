import type { TowerService } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { formatRoute } from "./router.ts";

// The ally runs of a tower the sb server runs (a teammate's message drives each; one per device): one chip per run, on the map's card, the workspace view and the tower's comms. A chip opens the run's comms
// (a read-only unit of the net, src/net.ts) while its session file is known, and says so when it is not; with more than one run a count comes first.

/** Redrawn only when the runs change, so a click never lands on a chip that was replaced. */
export function fillAllies(box: HTMLElement, ws: string, service: TowerService | undefined) {
	const runs = service?.allyRuns ?? [], sig = JSON.stringify([ws, runs.map((r) => [r.id, r.label, r.key])]);
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	box.hidden = !runs.length;
	box.replaceChildren(...(runs.length > 1 ? [h("b", null, m.ally_runs({ count: runs.length }))] : []), ...runs.map((r) => {
		const label = m.ally_run({ device: r.label });
		if (!r.key) return h("span", { class: "ally-chip", title: m.ally_run_unseen() }, label);
		const route = formatRoute({ view: "session", ws, key: r.key });
		return h("a", { class: "ally-chip", href: route || "./", "data-route": route, title: m.ally_run_open() }, label);
	}));
}
