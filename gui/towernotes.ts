import type { TowerService } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";
import { formatRoute } from "./router.ts";
import { type Act, guarded, noticeRows } from "./towermodel.ts";

// The tower service's notices and parked events with their buttons, drawn in the map's base card and again in the tower's comms, so a held tower shows its Retry wherever the boss looks.

const LABEL: Record<Act, () => string> = { retry: m.tower_notice_retry, deliver: m.tower_deliver, drop: m.tower_drop, answer: m.tower_answer, confirm: m.memory_confirm, reject: m.memory_reject };

/** Redrawn only when the rows change, so a click never lands on a button that was replaced. */
export function fillNotices(box: HTMLElement, ws: string, service: TowerService | undefined, key?: string) {
	const rows = noticeRows(service), sig = JSON.stringify([ws, rows]);
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	box.replaceChildren(...rows.map((r) => {
		const fail = h("small", { class: "tnote-fail", role: "alert" }), row = h("p", { class: `tnote ${r.level}` }, h("span", null, r.text));
		for (const action of r.actions) {
			// A wait for the boss is answered in the composer: the tower's comms have it, and the map's card links to them.
			if (action === "answer") {
				const route = key ? formatRoute({ view: "session", ws, key }) : "", link = h("a", { class: "pair-btn", href: route || "./", "data-route": route }, LABEL[action]());
				link.addEventListener("click", () => document.querySelector<HTMLElement>(".composer-root textarea")?.focus());
				row.append(link);
				continue;
			}
			const button = h("button", { type: "button", class: "pair-btn" }, LABEL[action]());
			// A run's proposal is answered at the memory route, by its id (a confirm names the rev the snapshot carried).
			const [path, body] = r.proposal && (action === "confirm" || action === "reject") ? ["memory", action === "confirm" ? { op: "confirm", proposal: r.proposal, rev: r.rev } : { op: "reject", proposal: r.proposal }] : [action, r.event ? { id: r.event } : {}];
			button.onclick = () => void guarded(button, (text) => (fail.textContent = text ?? ""), () => post(`tower/${encodeURIComponent(ws)}/${path}`, body));
			row.append(button);
		}
		row.append(fail);
		return row;
	}));
}
