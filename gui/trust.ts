import type { TrustAsk, TrustChoice } from "../src/trust/types.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { roleName } from "./render.ts";

// The project trust question (src/trust/): what an agent that waits for it asks, in the alert's dialog and, for the opening that waits on it, inline in the deploy
// panel. Both send the same POST trust/answer. The text of the folder and of what it holds comes from the folder itself, so it only ever becomes text nodes; the server
// has already drawn Unicode format characters as U+FFFD and removed control characters.

export type TrustPost = (body: { id: string; digest: string; choice: TrustChoice; answerId: string }) => Promise<Answer>;
/** What the question carries: the folder and the groups of what trusting would load (the opening's progress carries the same). */
export type Question = Pick<TrustAsk, "id" | "digest" | "folder" | "found">;
const SHOWN = 5;
const CHOICES: [TrustChoice, () => string][] = [["trust", m.trust_trust], ["once", m.trust_once], ["no", m.trust_no]];

/** Where the agents run, for the dialog's line under the title: "member in Base", or how many wait. */
export const whereOf = (ask: TrustAsk) => ask.agents.length === 1
	? m.trust_where_one({ role: ask.agents[0]!.role === "none" ? roleName("session") : roleName(ask.agents[0]!.role), base: ask.agents[0]!.base || "?" })
	: m.trust_where_many({ count: ask.agents.length });

/** What the page says for the server's reply, whether the choices stay answerable (only after nothing was decided), and whether it may Check again. */
export function outcome(r: Answer | undefined): { tone: "ok" | "error"; text: string; done: boolean; again: boolean } {
	const o = r?.body.outcome;
	if (o === "accepted") return { tone: "ok", text: m.answered(), done: true, again: false };
	if (o === "stale") return { tone: "error", text: m.trust_stale(), done: true, again: false };
	if (o === "busy") return { tone: "error", text: m.answer_busy(), done: true, again: false };
	if (o === "unknown" || r?.status === 504 || !r) return { tone: "error", text: m.not_confirmed(), done: true, again: true };
	if (r.status === 409) return { tone: "error", text: m.trust_changed(), done: true, again: false };
	return { tone: "error", text: String(r.body.reason ?? m.refused({ status: r.status })), done: false, again: false };
}

/**
 * The question as a panel: the paragraph, the groups (folded past five items), the three choices, and a note for the outcome. `update` follows the net's reading: the question
 * (gone when it is undefined) and whether the stream is live. An answer that was not confirmed is never sent again as a new one: Check again resends the same.
 */
export function trustPanel(send: TrustPost, accepted?: () => void) {
	const note = h("p", { class: "ask-note", role: "status", "aria-live": "polite" }), found = h("div", { class: "trust-found" });
	const buttons = CHOICES.map(([choice, label]) => Object.assign(h("button", { type: "button", class: choice === "trust" ? "ask-send" : "later", "data-choice": choice }, label()), { choice }));
	const root = h("section", { class: "ask trust" }, h("p", { class: "ask-why" }, m.trust_body()), h("h4", null, m.trust_found()), found, h("div", { class: "ask-acts" }, ...buttons), h("p", { class: "ask-term" }, m.trust_terminal()), note);
	let current: Question | undefined, ready = true, done = false, sending = false;
	const draw = () => buttons.forEach((b) => (b.disabled = !current || !ready || done || sending));
	const say = (tone: string, text: string, ...kids: HTMLElement[]) => ((note.dataset.tone = tone), note.replaceChildren(text, ...kids));
	async function answer(choice: TrustChoice, answerId: string) {
		if (!current) return;
		[sending, done] = [true, false];
		draw();
		say("", m.sending());
		const r = await send({ id: current.id, digest: current.digest, choice, answerId }).catch(() => undefined), o = outcome(r);
		sending = false;
		done = o.done;
		const again = h("button", { type: "button", class: "cmp-link" }, m.check_again());
		again.onclick = () => void answer(choice, answerId); // the same answer, by the same id: never a second one
		say(o.tone, o.text, ...(o.again ? [again] : []));
		draw();
		if (accepted && r?.body.outcome === "accepted") setTimeout(accepted, 1200);
	}
	for (const b of buttons) b.onclick = () => void answer(b.choice, crypto.randomUUID().replaceAll("-", ""));
	/** The groups, each folded to its first five items. */
	const drawFound = (q: Question) => found.replaceChildren(...q.found.map((g) => {
		const rest = Math.max(0, g.items.length - SHOWN) + g.more;
		return h("div", { class: "trust-group" }, h("b", null, g.path), g.unreadable ? h("small", null, m.trust_unreadable()) : h("ul", null, ...g.items.slice(0, SHOWN).map((i) => h("li", null, i)), rest > 0 && h("li", { class: "trust-more" }, m.trust_more({ count: rest }))));
	}));
	return Object.assign(root, {
		update(q: Question | undefined, live = true) {
			ready = live;
			if (q && (q.id !== current?.id || q.digest !== current.digest)) (drawFound(q), (done = false), say("", ""));
			current = q ?? current;
			if (!q && !done) (say("error", m.trust_closed()), (done = true));
			draw();
		},
	});
}
