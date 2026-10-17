import type { Ask, Pending } from "../src/ask.ts";
import type { Answerable, Reply } from "../src/owners.ts";
import { h } from "./dom.ts";
import type { Answer } from "./post.ts";

// The dialog a waiting unit has open, in the alert dialog and above the composer in the session view. A dialog its session's bridge relays
// (robot_hand's selector, an ask_user_question questionnaire) is answered here: the page sends which choice or words, never keys, and the
// owner in that session checks the answer against its own copy of the dialog. Anything else (a secret, two dialogs at once, a question the
// server cannot match) shows read-only, to answer in the terminal (Focus terminal brings its pane forward). An answer that was not confirmed
// is never sent again as a new one: Check again resends the same answer, which the server and the bridge recognise by its id.

export type AnswerPost = (action: "answer" | "focus", body: Record<string, unknown>) => Promise<Answer>;
type Pick = { choice?: number; answers?: Reply[] };
const how = (a: Ask) => (a.multiple ? "It takes several choices." : a.freeform && a.options.length ? "It also takes your own words." : "");
/** One question, read-only: its header tag, the question, its context, its options, and (in a list of several) how it is answered. */
const block = (a: Ask, list: boolean) => h("div", { class: "ask-one" }, a.header && h("b", { class: "ask-head" }, a.header), h("p", { class: "ask-q" }, a.question), a.context && h("div", { class: "ask-ctx" }, a.context),
	a.options.length > 0 && h("ol", { class: "ask-opts", "aria-label": "Options" }, ...a.options.map((o) => h("li", { class: "ask-opt" }, h("b", null, o.title), o.description && h("small", null, o.description)))), list && how(a) && h("small", { class: "ask-how" }, how(a)));
/** C0 and C1 controls but tab and newline drawn as U+FFFD: the title is shown as text, and the digest covers the raw one. */
export const visible = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "\ufffd");
/** The choices a page offers, with their indexes: a local-only one (it acts on the GUI's computer) only on that computer's page. */
export const offered = (a: Answerable, remote: boolean) => (a.select?.choices ?? []).map((c, i) => ({ ...c, i })).filter((c) => !(remote && c.localOnly));
/** One question's answer from what is picked, typed, and noted. */
export const replyOf = (picks: Set<number>, text: string, note: string): Reply => ({ ...(picks.size ? { choices: [...picks].sort((a, b) => a - b) } : {}), ...(text.trim() ? { text } : {}), ...(note.trim() ? { note } : {}) });
export const bodyOf = (a: Answerable, pick: Pick, answerId: string) => ({ dialog: a.dialog, digest: a.digest, answerId, ...pick });
const REFUSED: Record<string, string> = { digest: "The question changed; read it again.", "not-allowed": "That answer does not fit the question.", malformed: "The session could not read that answer." };
/** What the page says for a reply, and whether it may Check again (only when the outcome is not known). */
export function said(r: Answer): [tone: string, text: string, again?: true] {
	const { outcome, reason, by } = r.body as { outcome?: string; reason?: string; by?: string };
	if (outcome === "accepted") return ["ok", "Answered."];
	if (outcome === "stale") return ["error", by === "local" ? "It was already answered in the terminal." : by === "cancel" ? "It was dismissed in the terminal." : "It is no longer open."];
	if (outcome === "rejected") return ["error", REFUSED[String(reason)] ?? "The session refused that answer."];
	if (outcome === "busy") return ["error", "Another answer is on its way; check the terminal."];
	if (outcome === "unknown" || r.status === 504) return ["error", "Not confirmed. Check the terminal.", true];
	return ["error", reason ?? `Refused (${r.status}).`];
}
/** Outcomes after which this dialog takes no further answer from here (a refusal, a 4xx, or nothing sent leaves it answerable). */
const final = (r: Answer) => ["accepted", "stale", "busy", "unknown"].includes(String(r.body.outcome)) || r.status === 504;

export function mountAsk(root: HTMLElement, post: AnswerPost, remote = location.hostname !== "127.0.0.1") {
	let shown: Pending | undefined, ready = false, busy = false, done = false, last: Record<string, unknown> | undefined, leave: ReturnType<typeof setTimeout> | undefined;
	let controls: (HTMLButtonElement | HTMLInputElement)[] = [], pick: () => Pick | undefined = () => undefined, send: HTMLButtonElement | undefined;
	const note = h("p", { class: "ask-note", role: "status", "aria-live": "polite" });
	const say = (tone: string, text: string, ...kids: HTMLElement[]) => ((note.dataset.tone = tone), note.replaceChildren(text, ...kids));
	const go = h("button", { type: "button", class: "cmp-link" }, "Focus terminal");
	const draw = () => {
		go.disabled = !ready || busy;
		controls.forEach((c) => (c.disabled = !ready || busy || done));
		if (send) send.disabled = !ready || busy || done || !pick();
	};
	go.onclick = async () => {
		busy = true;
		draw();
		const r = await post("focus", {}).catch(() => undefined);
		say(r?.ok ? "" : "error", r?.ok ? "" : (r?.body.reason ?? "Herdr could not be reached."));
		busy = false;
		draw();
	};
	async function answer(body: Record<string, unknown>) {
		[last, busy] = [body, true];
		draw();
		say("", "Sending…");
		const r = await post("answer", body).catch(() => undefined), again = h("button", { type: "button", class: "cmp-link" }, "Check again");
		again.onclick = () => void answer(body); // the same answer, by the same id: never a second one
		const [tone, text, retry] = r ? said(r) : (["error", "Not confirmed. Check the terminal.", true] as const);
		[done, busy] = [!r || final(r), false];
		say(tone, text, ...(retry ? [again] : []));
		draw();
		note.scrollIntoView?.({ block: "nearest" }); // a long panel scrolls: its outcome must be read
	}
	const option = (role: string, title: string, small: (string | undefined)[], on: () => void, n?: number) => {
		const b = h("button", { type: "button", class: "ask-opt", role, "aria-checked": "false" }, h("b", n ? { "data-n": String(n) } : null, title), ...small.filter(Boolean).map((s) => h("small", null, s!)));
		b.onclick = on;
		return b;
	};
	/** A select: its title as written, one choice per row with where it acts, Copy command (the browser's clipboard; it answers nothing). */
	function select(a: Answerable) {
		let chosen: number | undefined;
		const opts = offered(a, remote).map((c) => option("radio", c.label, [c.note], () => ((chosen = c.i), opts.forEach((o, k) => o.setAttribute("aria-checked", String(offered(a, remote)[k]!.i === c.i))), draw()), c.i + 1)); // the terminal's numbers, also when a local-only choice is hidden
		const copy = a.select?.copy !== undefined && h("button", { type: "button", class: "cmp-link" }, "Copy command");
		if (copy) (copy.disabled = !navigator.clipboard), (copy.onclick = () => void navigator.clipboard.writeText(a.select!.copy!).then(() => say("ok", "Copied to this device's clipboard."), () => say("error", "The browser refused the clipboard.")));
		pick = () => (chosen === undefined ? undefined : { choice: chosen });
		controls = opts;
		return [h("pre", { class: "ask-title" }, visible(a.select!.title)), h("div", { class: "ask-opts", role: "radiogroup", "aria-label": "Choices" }, ...opts), h("div", { class: "ask-acts" }, send!, copy, go)];
	}
	/** A questionnaire: per question its options (one, or several), its own words, and a note; it goes when every question has an answer. */
	function questions(a: Answerable) {
		const state = a.questions!.map(() => ({ picks: new Set<number>(), text: h("input", { type: "text", maxlength: "8192", class: "ask-own", placeholder: "Or type your own answer", "aria-label": "Your own answer" }), note: h("input", { type: "text", maxlength: "2048", class: "ask-own ask-memo", placeholder: "Note (optional)", "aria-label": "Note" }) }));
		const blocks = a.questions!.map((q, i) => {
			const s = state[i]!, role = q.multiple ? "checkbox" : "radio";
			const opts = q.options.map((o, k) => option(role, o.title, [o.description, o.preview && "It has a preview; see it in the terminal."], () => {
				if (!q.multiple) (s.picks.clear(), (s.text.value = ""));
				s.picks.has(k) ? s.picks.delete(k) : s.picks.add(k);
				opts.forEach((b, n) => b.setAttribute("aria-checked", String(s.picks.has(n))));
				draw();
			}));
			s.text.oninput = () => (q.multiple || (s.picks.clear(), opts.forEach((b) => b.setAttribute("aria-checked", "false"))), draw());
			controls.push(...opts, s.text, s.note);
			return h("div", { class: "ask-one" }, q.header && h("b", { class: "ask-head" }, q.header), h("p", { class: "ask-q" }, q.question), h("div", { class: "ask-opts", role: q.multiple ? "group" : "radiogroup", "aria-label": "Options" }, ...opts), s.text, s.note);
		});
		pick = () => (state.every((s) => s.picks.size || s.text.value.trim()) ? { answers: state.map((s) => replyOf(s.picks, s.text.value, s.note.value)) } : undefined);
		return [...blocks, h("div", { class: "ask-acts" }, send!, go)];
	}
	function build(p: Pending) {
		[done, last, controls, pick] = [false, undefined, [], () => undefined];
		say("", "");
		const asks = p.asks ?? (p.ask ? [p.ask] : []), list = asks.length > 1, a = p.answer;
		send = h("button", { type: "button", class: "ask-send" }, "Send answer");
		send.onclick = () => void (pick() && answer(bodyOf(a!, pick()!, crypto.randomUUID())));
		const term = h("p", { class: "ask-term" }, p.why && asks.length ? p.why : `${list ? "Answer them" : "Answer it"} in the terminal. ${list || !asks[0] ? "" : how(asks[0])}`.trim());
		const body = a ? (a.select ? select(a) : questions(a)) : [...(asks.length ? asks.map((x) => block(x, list)) : [h("p", { class: "ask-why" }, p.why ?? "It waits on a dialog.")]), h("div", { class: "ask-acts" }, term, go)];
		root.replaceChildren(h("section", { class: "ask" }, ...body, note));
	}
	return {
		/** The unit's pending dialog now, and whether it can be answered or its pane brought forward (it waits and the stream is up). */
		update(next: Pending | undefined, can: boolean) {
			ready = can;
			const id = (p?: Pending) => p && `${p.callId}\n${p.answer?.dialog ?? p.why ?? ""}`;
			clearTimeout(leave);
			// An answer sent from here stays on show for its dialog, and for a moment after the unit moved on, so its outcome can be read.
			if (!next && shown && done) leave = setTimeout(() => (root.replaceChildren(), (shown = undefined)), 6000);
			else if (!next) root.replaceChildren(), (shown = undefined);
			else if (!(done && next.callId === shown?.callId) && id(next) !== id(shown)) build((shown = next));
			draw();
		},
	};
}
