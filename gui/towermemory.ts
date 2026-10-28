import type { MemorySummary } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";
import { MEMORY_CAP, type MemoryEntry, type MemoryView, memoryChip, memoryGroups, memoryMeta, memoryWhy } from "./towermodel.ts";

// The tower's memory in its comms (src/server/towermemory.ts): the boss's standing instructions and decisions, verbatim, and the tower's waits. The boss adds, edits, and deletes here; every change names the rev it
// read, and a memory that moved on is shown again with a line saying so. All text is set as text: no Markdown, no links, no HTML.

interface Panel { ws: string; details: HTMLDetailsElement; label: HTMLElement; body: HTMLElement; view?: MemoryView; seen?: number; note: string; edit?: string }
const panels = new WeakMap<HTMLElement, Panel>();

/** Draws the panel's closed line from the snapshot's summary and, while it is open, reads the memory again when its rev moved. */
export function fillMemory(box: HTMLElement, ws: string, summary: MemorySummary | undefined) {
	box.hidden = !summary;
	if (!summary) return;
	let p = panels.get(box);
	if (!p || p.ws !== ws) {
		const label = h("span", { class: "tmem-counts" }), body = h("div", { class: "tmem-body" }), details = h("details", { class: "tmem" }, h("summary", null, h("b", null, m.memory_title()), label), body);
		p = { ws, details, label, body, note: "" };
		const panel = p;
		details.addEventListener("toggle", () => details.open && void load(panel));
		box.replaceChildren(details);
		panels.set(box, p);
	}
	p.label.textContent = memoryChip(summary);
	if (p.details.open && p.seen !== summary.rev) void load(p);
}

async function load(p: Panel, answer?: { ok: boolean; status: number; body: Record<string, unknown> }) {
	try {
		const r = answer ?? (await post(`tower/${encodeURIComponent(p.ws)}/memory`, { op: "read" }));
		// SAFETY: a body with `entries` is the memory route's view (towermemory.ts `view`), which a refusal for a moved rev carries as well.
		if (r.body.entries) (p.view = r.body as unknown as MemoryView), (p.seen = p.view.rev);
		if (!r.ok) p.note = m.memory_failed({ reason: memoryWhy(r) });
	} catch {
		p.note = m.memory_failed({ reason: m.unreachable() });
	}
	draw(p);
}
const change = async (p: Panel, body: Record<string, unknown>) => {
	p.note = "";
	p.edit = undefined;
	const r = await post(`tower/${encodeURIComponent(p.ws)}/memory`, { ...body, rev: p.view?.rev ?? 0 }).catch(() => undefined);
	return load(p, r ?? { ok: false, status: 0, body: { reason: m.unreachable() } });
};

function draw(p: Panel) {
	const view = p.view;
	if (!view) return;
	const groups = memoryGroups(view.entries), line = (text: string, ...kids: Node[]) => h("p", { class: "tmem-note" }, h("span", null, text), ...kids);
	const button = (label: string, run: () => void) => Object.assign(h("button", { type: "button", class: "pair-btn" }, label), { onclick: run });
	const row = (e: MemoryEntry) => {
		const ended = e.state === "resolved" || e.state === "expired", li = h("li", { class: ended ? "tmem-ended" : "" });
		if (p.edit === e.id) {
			const input = Object.assign(h("input", { type: "text", maxlength: e.kind === "wait" ? "200" : "300" }), { value: e.text });
			li.append(input, button(m.memory_save(), () => void change(p, { op: "edit", id: e.id, text: input.value })), button(m.memory_cancel(), () => ((p.edit = undefined), draw(p))));
			return li;
		}
		li.append(h("span", { class: "tmem-text" }, e.text), h("small", null, memoryMeta(e)));
		if (e.kind === "wait" && !ended) li.append(button(m.memory_resolve(), () => void change(p, { op: "resolve", id: e.id })));
		li.append(button(m.memory_edit(), () => ((p.edit = e.id), draw(p))), button(m.memory_delete(), () => void change(p, { op: "delete", id: e.id })));
		return li;
	};
	const add = (kind: "standing" | "decision") => {
		const input = Object.assign(h("input", { type: "text", maxlength: "300", placeholder: kind === "standing" ? m.memory_add_standing() : m.memory_add_decision() }), {});
		return h("div", { class: "tmem-add" }, input, button(m.memory_add(), () => input.value.trim() && void change(p, { op: "add", kind, text: input.value })));
	};
	const section = (title: string, rows: MemoryEntry[], more: Node[], cap?: string) => h("section", null, h("h4", null, title, cap && h("small", null, cap)), rows.length ? h("ul", null, ...rows.map(row)) : h("p", { class: "tmem-empty" }, m.memory_empty()), ...more);
	p.body.replaceChildren(
		...view.notices.map((n) => line(n.text)),
		...(view.notices.length ? [button(m.memory_ack(), () => void change(p, { op: "ack" }))] : []),
		section(m.memory_standing(), groups.standing, [add("standing")], `${groups.standing.length}/${MEMORY_CAP.standing}`),
		section(m.memory_decisions(), groups.decisions, [add("decision")], `${groups.decisions.length}/${MEMORY_CAP.decision}`),
		section(m.memory_waits(), groups.waits, []),
		h("small", { class: "tnote-fail", role: "alert" }, p.note),
	);
}
