import type { TowerService } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";
import { type Act, guarded, noticeRows } from "./towermodel.ts";

// The tower service's notices and parked events with their buttons, drawn in the map's base card and again in the tower's comms, so a held tower shows its Retry wherever the boss looks.

const LABEL: Record<Act, () => string> = { retry: m.tower_notice_retry, deliver: m.tower_deliver, drop: m.tower_drop };

/** Redrawn only when the rows change, so a click never lands on a button that was replaced. */
export function fillNotices(box: HTMLElement, ws: string, service: TowerService | undefined) {
	const rows = noticeRows(service), sig = JSON.stringify([ws, rows]);
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	box.replaceChildren(...rows.map((r) => {
		const fail = h("small", { class: "tnote-fail", role: "alert" }), row = h("p", { class: `tnote ${r.level}` }, h("span", null, r.text));
		for (const action of r.actions) {
			const button = h("button", { type: "button", class: "pair-btn" }, LABEL[action]());
			button.onclick = () => void guarded(button, (text) => (fail.textContent = text ?? ""), () => post(`tower/${encodeURIComponent(ws)}/${action}`, r.event ? { id: r.event } : {}));
			row.append(button);
		}
		row.append(fail);
		return row;
	}));
}
