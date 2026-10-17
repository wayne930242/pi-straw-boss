import type { Ask, Pending } from "../src/ask.ts";
import { h } from "./dom.ts";
import type { Answer } from "./post.ts";

// The question a waiting unit asks (ask_user, or one to four from ask_user_question), shown read-only in the alert dialog and the session view: each
// question with its header, context, and options, with a note to answer it in the terminal and a Focus terminal button that brings the pane forward in Herdr. Other dialogs
// show what they wait on. Nothing here answers: answering from the browser is deferred (see the spec, "Pending dialogs").

export type FocusPost = () => Promise<Answer>;
const how = (a: Ask) => (a.multiple ? "It takes several choices." : a.freeform && a.options.length ? "It also takes your own words." : "");
/** One question: its header tag, the question, its context, its options, and (in a list of several) how it is answered. */
const block = (a: Ask, list: boolean) => h("div", { class: "ask-one" }, ...(a.header ? [h("b", { class: "ask-head" }, a.header)] : []), h("p", { class: "ask-q" }, a.question), ...(a.context ? [h("div", { class: "ask-ctx" }, a.context)] : []),
	...(a.options.length ? [h("ol", { class: "ask-opts", "aria-label": "Options" }, ...a.options.map((o) => h("li", { class: "ask-opt" }, h("b", null, o.title), ...(o.description ? [h("small", null, o.description)] : []))))] : []), ...(list && how(a) ? [h("small", { class: "ask-how" }, how(a))] : []));

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
		const asks = p.asks ?? (p.ask ? [p.ask] : []), list = asks.length > 1;
		const body = asks.length ? asks.map((a) => block(a, list)) : [h("p", { class: "ask-why" }, p.why ?? "It waits on a dialog.")];
		root.replaceChildren(h("section", { class: "ask" }, ...body, h("div", { class: "ask-acts" }, h("p", { class: "ask-term" }, `${list ? "Answer them" : "Answer it"} in the terminal. ${list || !asks[0] ? "" : how(asks[0])}`.trim()), go), note));
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
