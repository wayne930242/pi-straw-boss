import type { ConfirmView, LinkSummary } from "../src/link/holder.ts";
import { h, nodes } from "./dom.ts";
import { alertLine, urgentFirst } from "./linkmodel.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";
import { byId, hang } from "./render.ts";

// The header's Link button and the notices under it (spec, GUI, Notices): a join request waiting, a roster mismatch or fork, a confirm a teammate's tower
// asked of this computer (`forward`), the relay unreachable, and a message waiting in the inbox for a tower. The button appears only while there is
// something to say, tinted by the worst of it, and opens a list; a forwarded confirm is answered right there (Allow or Deny, with the tool's full
// arguments), and a join request is reviewed in the team settings tile, where its words are.

/** `open` shows the team settings tile; `news` hears how many notices that need the boss (a confirm or a join request) are new since the last snapshot. */
export function mountLinkBar(open: () => void, news: (count: number) => void) {
	const btn = byId("link-alerts", HTMLButtonElement), pop = byId("link-alerts-pop", HTMLElement), list = byId("link-alerts-list", HTMLElement);
	let sig = "", known = new Set<string>(), first = true;
	pop.addEventListener("toggle", (event) => (event as ToggleEvent).newState === "open" && hang(pop, btn));
	pop.setAttribute("aria-label", m.link_alerts_title());
	btn.title = m.link_alerts_title();
	const answer = (c: ConfirmView, allow: boolean, row: HTMLElement) => {
		const note = row.querySelector<HTMLElement>(".link-note")!;
		for (const b of row.querySelectorAll("button")) b.disabled = true;
		void post("link/confirm-answer", { dialogId: c.dialogId, allow }).then((r) => {
			if (!r.ok) note.textContent = r.body.reason ?? m.refused({ status: r.status });
			for (const b of row.querySelectorAll("button")) b.disabled = false;
		}, () => {
			note.textContent = m.no_answer();
			for (const b of row.querySelectorAll("button")) b.disabled = false;
		});
	};
	const confirmRow = (c: ConfirmView) => {
		const row = h("li", { class: "link-alert", "data-level": "warning" });
		const allow = h("button", { type: "button", class: "pair-btn" }, m.link_allow()), deny = h("button", { type: "button", class: "pair-btn" }, m.link_deny());
		allow.onclick = () => answer(c, true, row);
		deny.onclick = () => answer(c, false, row);
		row.append(h("b", null, alertLine({ id: "", kind: "confirm", level: "warning", team: c.team, teamName: "", data: { label: c.fromLabel, short: c.fromShort, tool: c.tool } })), h("pre", { class: "link-args" }, c.args), h("div", { class: "devices-acts" }, allow, deny), h("small", { class: "link-note", role: "status" }));
		return row;
	};
	return {
		net(summary: LinkSummary | undefined) {
			const alerts = urgentFirst((summary?.alerts ?? []).filter((a) => a.kind !== "confirm")), confirms = summary?.confirms ?? [];
			const next = JSON.stringify([alerts, confirms]);
			if (next === sig) return;
			sig = next;
			const need = new Set([...confirms.map((c) => `c/${c.dialogId}`), ...alerts.filter((a) => a.kind === "join-request").map((a) => a.id)]);
			if (!first) news([...need].filter((k) => !known.has(k)).length);
			[known, first] = [need, false];
			const count = alerts.length + confirms.length;
			btn.hidden = count === 0;
			btn.textContent = m.link_alerts_button({ count: String(count) });
			btn.dataset.state = confirms.length || alerts.some((a) => a.level === "error") ? "error" : alerts.some((a) => a.level === "warning") ? "waiting" : "done";
			if (!count && pop.matches(":popover-open")) pop.hidePopover();
			list.replaceChildren(...nodes(...confirms.map(confirmRow), ...alerts.map((a) => {
				const row = h("li", { class: "link-alert", "data-level": a.level }, h("span", null, alertLine(a)));
				if (a.kind === "join-request" || a.kind === "fork" || a.kind === "mismatch") {
					const go = h("button", { type: "button", class: "later" }, a.kind === "join-request" ? m.link_review() : m.link_open_teams());
					go.onclick = () => (pop.hidePopover(), open());
					row.append(go);
				}
				return row;
			})));
		},
	};
}
