import type { Pending } from "../src/ask.ts";
import { h } from "./dom.ts";
import type { Answer } from "./post.ts";

// The question a waiting unit asks (ask_user), shown read-only in the alert dialog and the session view: the question, its context, and
// its options, with a note to answer it in the terminal and a Focus terminal button that brings the pane forward in Herdr. Other dialogs
// show what they wait on. Nothing here answers: answering from the browser is deferred (see the spec, "Pending dialogs").

export type FocusPost = () => Promise<Answer>;

export function mountAsk(root: HTMLElement, focus: FocusPost) {
	let shown: string | undefined, ready = false, busy = false;
	const note = h("p", { class: "ask-note", role: "status", "aria-live": "polite" });
	const go = h("button", { type: "button", class: "cmp-link" }, "Focus terminal");
	const draw = () => (go.disabled = !ready || busy);
	go.onclick = async () => {
		busy = true;
		draw();
		try {
			const r = await focus();
			(note.dataset.tone = r.ok ? "" : "error"), (note.textContent = r.ok ? "" : (r.body.reason ?? `Refused (${r.status}).`));
		} catch {
			(note.dataset.tone = "error"), (note.textContent = "Herdr could not be reached.");
		} finally {
			busy = false;
			draw();
		}
	};
	function build(p: Pending) {
		note.textContent = "";
		const ask = p.ask, how = ask?.multiple ? "It takes several choices." : ask?.freeform && ask.options.length ? "It also takes your own words." : "";
		const opts = ask?.options.length ? [h("ol", { class: "ask-opts", "aria-label": "Options" }, ...ask.options.map((o) => h("li", { class: "ask-opt" }, h("b", null, o.title), ...(o.description ? [h("small", null, o.description)] : []))))] : [];
		const body = ask ? [h("p", { class: "ask-q" }, ask.question), ...(ask.context ? [h("div", { class: "ask-ctx" }, ask.context)] : []), ...opts] : [h("p", { class: "ask-why" }, p.why ?? "It waits on a dialog.")];
		root.replaceChildren(h("section", { class: "ask" }, ...body, h("div", { class: "ask-acts" }, h("p", { class: "ask-term" }, `Answer it in the terminal. ${how}`.trim()), go), note));
	}
	return {
		/** The unit's pending dialog now, and whether its pane can be brought forward (it waits and the stream is up). */
		update(next: Pending | undefined, can: boolean) {
			ready = can;
			if (next && next.callId !== shown) build(next);
			else if (!next && shown) root.replaceChildren();
			shown = next?.callId;
			draw();
		},
	};
}
