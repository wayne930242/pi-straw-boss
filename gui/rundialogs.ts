import type { RunDialog } from "../src/net.ts";
import { h } from "./dom.ts";
import { post } from "./post.ts";
import { m } from "./sentences.ts";
import { towerRoute } from "./towermodel.ts";

// The dialogs a tower's headless runs wait on (docs/specs/2026-11-23-f-entry.md §2.6, §2.8), on this computer's own page: pi's own select, confirm, or input of an extension the run loads, and the approvals the server raised
// itself (a `link_request`, a teammate's gated call, pi's project-trust question). The server sends them only to this computer's page, never to a paired device (`NO_RELAY`); a press answers it with
// `POST api/tower/<workspace>/dialog` (the head's page: `api/head/dialog`), which the server refuses from a paired device as well. Its text is data: it becomes text nodes only.

const shown = new WeakMap<HTMLElement, string>();

/** Draws the dialogs under the comms (`ws`: the page's workspace, or the head's key), redrawn only when they change, so a half-typed answer is not wiped by a snapshot. */
export function fillRunDialogs(box: HTMLElement, ws: string, dialogs: RunDialog[] | undefined, send: typeof post = post) {
	const list = dialogs ?? [], sig = JSON.stringify(list);
	box.hidden = !list.length;
	if (shown.get(box) === sig) return;
	shown.set(box, sig);
	box.setAttribute("aria-label", m.run_dialogs_label());
	const note = h("p", { class: "run-dialog-note", role: "status" });
	const answer = async (d: RunDialog, reply: Record<string, unknown>, row: HTMLElement) => {
		row.querySelectorAll("button, input").forEach((el) => el.setAttribute("disabled", ""));
		const r = await send(`${towerRoute(ws)}/dialog`, { key: d.key, ...reply });
		note.textContent = r.ok ? m.run_dialog_answered() : String(r.body.reason ?? m.refused({ status: r.status }));
		if (!r.ok) row.querySelectorAll("button, input").forEach((el) => el.removeAttribute("disabled"));
	};
	const button = (label: string, run: () => void, cls = "cmp-alt") => { const b = h("button", { type: "button", class: cls }, label); b.onclick = run; return b; };
	const row = (d: RunDialog): HTMLElement => {
		const el = h("article", { class: "run-dialog", "data-method": d.method, ...(d.approval ? { "data-approval": "" } : {}) },
			h("header", null, ...(d.approval ? [h("b", { class: "run-dialog-tag" }, m.run_dialog_approval())] : []), h("b", { class: "run-dialog-title" }, d.title)),
			...(d.message ? [h("p", { class: "run-dialog-text" }, d.message)] : []));
		const acts = h("div", { class: "run-dialog-acts" });
		if (d.method === "confirm") acts.append(button(m.run_dialog_yes(), () => void answer(d, { confirmed: true }, el), "cmp-yes"), button(m.run_dialog_no(), () => void answer(d, { confirmed: false }, el)));
		else if (d.method === "select") acts.append(...(d.options ?? []).map((o) => button(o, () => void answer(d, { value: o }, el))), button(m.run_dialog_cancel(), () => void answer(d, { cancelled: true }, el), "cmp-link"));
		else {
			const input = h("input", { type: "text", class: "run-dialog-input", "aria-label": d.title });
			acts.append(input, button(m.run_dialog_send(), () => void answer(d, { value: input.value }, el), "cmp-yes"), button(m.run_dialog_cancel(), () => void answer(d, { cancelled: true }, el), "cmp-link"));
		}
		el.append(acts);
		return el;
	};
	box.replaceChildren(...list.map(row), note);
}
