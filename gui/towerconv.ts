import type { TowerService } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";
import { formatRoute } from "./router.ts";
import { conversationFacts, guarded } from "./towermodel.ts";

// The boss conversation of a tower the sb server runs (src/server/runs.ts `ConversationStatus`), in the tower's comms: how it began, what it does and when the boss's silence ends it, the Leave and New buttons, and a chip
// for each recent event run (a read-only unit of the net while its session file is known, with the note it left in the tooltip). Leave and New post to the routes whose pi twins are `/boss tower leave` and
// `/boss tower new`: the same server functions. Redrawn only when what it shows changes, so a click never lands on a button that was replaced.

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export function fillConversation(box: HTMLElement, ws: string, service: TowerService | undefined) {
	const c = service?.conversation, events = (service?.localRuns ?? []).filter((r) => r.kind === "event"), sig = JSON.stringify([ws, c, events.map((r) => [r.id, r.key, r.outcome, r.note])]);
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	box.hidden = !c && !events.length;
	if (box.hidden) return box.replaceChildren();
	const fail = h("small", { class: "tnote-fail", role: "alert" }), done = h("small", { class: "conv-done", role: "status" }), say = (text?: string) => ((fail.textContent = text ?? ""), (done.textContent = ""));
	const button = (label: string, title: string, path: "leave" | "new", ok: () => string) => {
		const b = h("button", { type: "button", class: "pair-btn", title }, label);
		b.onclick = () => void guarded(b, say, async () => { const r = await post(`tower/${encodeURIComponent(ws)}/${path}`, {}); if (r.ok) done.textContent = ok(); return r; }, 0);
		return b;
	};
	const rows: Node[] = [];
	if (c) {
		const facts = conversationFacts(c);
		rows.push(
			h("p", { class: "conv-line" }, h("b", null, m.conv_title()), " ", h("span", { class: "conv-began", ...(facts.why ? { title: facts.why } : {}) }, facts.began), " · ", h("span", { class: "conv-now" }, facts.now), " · ", h("span", { class: "conv-cap" }, facts.cap)),
			h("p", { class: "conv-acts" }, ...(c.closing ? [] : [button(m.conv_leave(), m.conv_leave_title(), "leave", m.conv_left)]), button(m.conv_new_button(), m.conv_new_title(), "new", m.conv_fresh), fail, done),
		);
	}
	if (events.length) {
		rows.push(h("p", { class: "conv-runs" }, ...events.map((r) => {
			const label = m.conv_event_run({ time: clock(r.startedAt) }), tip = r.note ? m.conv_event_run_note({ outcome: r.outcome ?? "…", note: r.note }) : (r.outcome ?? "");
			if (!r.key) return h("span", { class: "ally-chip", title: tip || m.conv_event_run_unseen() }, label);
			const route = formatRoute({ view: "session", ws, key: r.key });
			return h("a", { class: "ally-chip", href: route || "./", "data-route": route, title: tip || m.conv_event_run_open() }, label);
		})));
	}
	box.replaceChildren(...rows);
}
