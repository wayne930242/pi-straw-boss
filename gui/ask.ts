import type { Ask, Pending } from "../src/ask.ts";
import type { Answerable, Reply } from "../src/owners.ts";
import { type Group, wire } from "./askkeys.ts";
import { h, nodes } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// The dialog a waiting unit has open, in the alert dialog and above the composer in the session view. A dialog its session's bridge relays
// (robot_hand's selector, an ask_user_question questionnaire, secret_drop's masked field) is answered here: the page sends which choice or words,
// never keys, and the owner in that session checks the answer against its own copy of the dialog. Anything else (two dialogs at once, a
// question the server cannot match) shows read-only, to answer in the terminal (Show terminal opens it here).
// A secret is typed into a masked field on this computer's page only (a text input drawn as dots by CSS, never type=password, so no browser offers to
// save or suggest a password): the value goes out in one request, the field is cleared the moment it is sent (before the reply), nothing keeps it,
// and it is never resent (no Check again); a remote page is told that entering it is unsupported there and sees only the terminal path. An answer that was not confirmed
// is never sent again as a new one: Check again resends the same answer, which the server and the bridge recognise by its id. A panel belongs
// to its dialog (its id and digest): the net's updates leave what the user picked, typed, and noted, even across a spell the server shows the
// dialog read-only (an answer on its way) or not at all, and only another dialog starts afresh.

export type AnswerPost = (action: "answer", body: Record<string, unknown>) => Promise<Answer>;
type Pick = { choice?: number; answers?: Reply[]; value?: string };
const how = (a: Ask) => (a.multiple ? m.ask_several() : a.freeform && a.options.length ? m.ask_own_words() : "");
/** One question, read-only: its header tag, the question, its context, its options, and (in a list of several) how it is answered. */
const block = (a: Ask, list: boolean) => h("div", { class: "ask-one" }, a.header && h("b", { class: "ask-head" }, a.header), h("p", { class: "ask-q" }, a.question), a.context && h("div", { class: "ask-ctx" }, a.context),
	a.options.length > 0 && h("ol", { class: "ask-opts", "aria-label": m.options() }, ...a.options.map((o) => h("li", { class: "ask-opt" }, h("b", null, o.title), o.description && h("small", null, o.description)))), list && how(a) && h("small", { class: "ask-how" }, how(a)));
/** C0 and C1 controls but tab and newline drawn as U+FFFD: the title is shown as text, and the digest covers the raw one. */
export const visible = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "\ufffd");
/** The choices a page offers, with their indexes: a local-only one (it acts on the GUI's computer) only on that computer's page. */
export const offered = (a: Answerable, remote: boolean) => (a.select?.choices ?? []).map((c, i) => ({ ...c, i })).filter((c) => !(remote && c.localOnly));
/** One question's answer from what is picked, typed, and noted. */
export const replyOf = (picks: Set<number>, text: string, note: string): Reply => ({ ...(picks.size ? { choices: [...picks].sort((a, b) => a - b) } : {}), ...(text.trim() ? { text } : {}), ...(note.trim() ? { note } : {}) });
export const bodyOf = (a: Answerable, pick: Pick, answerId: string) => ({ dialog: a.dialog, digest: a.digest, answerId, ...pick });
const REFUSED: Record<string, () => string> = { digest: m.refused_digest, "not-allowed": m.refused_not_allowed, malformed: m.refused_malformed };
/** What the page says for a reply, and whether it may Check again (only when the outcome is not known). */
export function said(r: Answer): [tone: string, text: string, again?: true] {
	const { outcome, reason, by } = r.body as { outcome?: string; reason?: string; by?: string };
	if (outcome === "accepted") return ["ok", m.answered()];
	if (outcome === "stale") return ["error", by === "local" ? m.stale_local() : by === "cancel" ? m.stale_cancel() : m.stale_closed()];
	if (outcome === "rejected") return ["error", (Object.hasOwn(REFUSED, String(reason)) ? REFUSED[String(reason)]! : m.rejected)()];
	if (outcome === "busy") return ["error", m.answer_busy()];
	if (outcome === "unknown" || r.status === 504) return ["error", m.not_confirmed(), true];
	return ["error", reason ?? m.refused({ status: r.status })];
}
/** Outcomes after which this dialog takes no further answer from here (a refusal, a 4xx, or nothing sent leaves it answerable). */
const final = (r: Answer) => ["accepted", "stale", "busy", "unknown"].includes(String(r.body.outcome)) || r.status === 504;
/** A panel drawn for a pending. `done`: it takes no further answer from here; `sending`: its answer is on its way; `focus`: what had the focus in it
 * when it left the page (it takes it back on coming back); `lost`: the control that lost the focus by being disabled here (it takes it back when enabled); `busy`: refused while another answer was on its way, and `spell` once the server showed
 * that answer (read-only): the dialog answerable after it means that answer was refused, so this panel answers again. */
interface Panel { first?: () => HTMLButtonElement | HTMLInputElement | undefined; key: string; el: HTMLElement; note: HTMLElement; send?: HTMLButtonElement; controls: (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement)[]; pick: () => Pick | undefined; clear?: () => void; done: boolean; sending: boolean; focus?: HTMLElement; lost?: HTMLButtonElement | HTMLInputElement; busy?: boolean; spell?: boolean }
/** A dialog the page may answer is known by its id and digest, under whichever call the server reads it; anything else by its call and why. */
const keyOf = (p: Pending) => (p.answer ? `d\n${p.answer.dialog}\n${p.answer.digest}` : `c\n${p.callId}\n${p.why ?? ""}`);

/** `terminal` opens the session's terminal tile: a read-only panel offers it (Show terminal), except for a secret, whose mirror stays hidden. */
export function mountAsk(root: HTMLElement, post: AnswerPost, remote = location.hostname !== "127.0.0.1", terminal?: () => void) {
	// `cur` is the panel on show, drawn for `shown`; `kept` is the newest one that answers, which comes back as it was when its dialog does.
	let shown: Pending | undefined, cur: Panel | undefined, kept: Panel | undefined, ready = false, busy = false, leave: ReturnType<typeof setTimeout> | undefined;
	for (const type of ["focusin", "pointerdown"]) document.addEventListener(type, (e) => cur && !cur.el.contains(e.target as Node) && (cur.lost = undefined)); // the user went elsewhere
	const say = (note: HTMLElement, tone: string, text: string, ...kids: HTMLElement[]) => ((note.dataset.tone = tone), note.replaceChildren(text, ...kids));
	const draw = () => {
		if (!cur) return;
		const had = document.activeElement as HTMLButtonElement | null, idle = !had || had === document.body;
		if (!idle && had !== cur.lost) cur.lost = undefined; // the user took the focus elsewhere
		cur.controls.forEach((c) => (c.disabled = !ready || busy || cur!.done));
		if (cur.send) cur.send.disabled = !ready || busy || cur.done || !cur.pick();
		if (had && cur.el.contains(had) && had.disabled) cur.lost = had; // a browser moves the focus off a disabled control, to the body
		const back = cur.lost;
		if (back && !back.disabled && cur.el.contains(back) && (!document.activeElement || document.activeElement === document.body)) (back.focus(), (cur.lost = undefined));
	};
	/** `once`: the body holds a secret, which leaves with the request (the post has built its JSON) and is dropped from here and from the field before the reply; so it cannot be sent again. */
	async function answer(x: Panel, body: Record<string, unknown>, once = false) {
		[x.sending, busy, x.spell] = [true, true, false];
		draw();
		say(x.note, "", m.sending());
		const sent = post("answer", body).catch(() => undefined);
		if (once) (delete body.value, x.clear?.());
		const r = await sent, again = h("button", { type: "button", class: "cmp-link" }, m.check_again());
		again.onclick = () => void answer(x, body); // the same answer, by the same id: never a second one
		const [tone, text, retry] = r ? said(r) : (["error", m.not_confirmed(), true] as const);
		[x.done, x.sending, busy, x.busy] = [!r || final(r), false, false, r?.body.outcome === "busy"];
		say(x.note, tone, text, ...(retry && !once ? [again] : []));
		draw();
		x.note.scrollIntoView?.({ block: "nearest" }); // a long panel scrolls: its outcome must be read
	}
	const option = (role: string, title: string, small: (string | undefined)[], on: () => void, n?: number) => {
		const b = h("button", { type: "button", class: "ask-opt", role, "aria-checked": "false" }, h("b", n ? { "data-n": String(n) } : null, title), ...small.filter(Boolean).map((s) => h("small", null, s!)));
		b.onclick = on;
		return b;
	};
	/** A select: its title as written, one choice per row with where it acts, Copy command (the browser's clipboard; it answers nothing). */
	function select(x: Panel, a: Answerable) {
		let chosen: number | undefined;
		const opts = offered(a, remote).map((c) => option("radio", c.label, [c.note], () => ((chosen = c.i), opts.forEach((o, k) => o.setAttribute("aria-checked", String(offered(a, remote)[k]!.i === c.i))), draw()), c.i + 1)); // the terminal's numbers, also when a local-only choice is hidden
		const copy = a.select?.copy !== undefined && h("button", { type: "button", class: "cmp-link" }, m.copy_command());
		if (copy) (copy.disabled = !navigator.clipboard), (copy.onclick = () => void navigator.clipboard.writeText(a.select!.copy!).then(() => say(x.note, "ok", m.copied()), () => say(x.note, "error", m.clipboard_refused())));
		x.pick = () => (chosen === undefined ? undefined : { choice: chosen });
		x.first = wire(x.el, [{ opts, multiple: false, answered: () => chosen !== undefined }], () => x.send);
		x.controls = opts;
		return [h("pre", { class: "ask-title" }, visible(a.select!.title)), h("div", { class: "ask-opts", role: "radiogroup", "aria-label": m.choices() }, ...opts), h("div", { class: "ask-acts" }, x.send!, copy)];
	}
	/** A questionnaire: per question its options (one, or several), its own words, and a note; it goes when every question has an answer. */
	function questions(x: Panel, a: Answerable) {
		const state = a.questions!.map(() => ({ picks: new Set<number>(), text: h("textarea", { rows: "1", maxlength: "8192", class: "ask-own", placeholder: m.own_answer_placeholder(), "aria-label": m.own_answer() }), note: h("input", { type: "text", maxlength: "2048", class: "ask-own ask-memo", placeholder: m.note_placeholder(), "aria-label": m.note() }) }));
		const groups: Group[] = [], blocks = a.questions!.map((q, i) => {
			const s = state[i]!, role = q.multiple ? "checkbox" : "radio";
			const opts = q.options.map((o, k) => option(role, o.title, [o.description, o.preview && m.has_preview()], () => {
				if (!q.multiple) (s.picks.clear(), (s.text.value = ""));
				s.picks.has(k) ? s.picks.delete(k) : s.picks.add(k);
				opts.forEach((b, n) => b.setAttribute("aria-checked", String(s.picks.has(n))));
				draw();
			}));
			s.text.oninput = () => (q.multiple || (s.picks.clear(), opts.forEach((b) => b.setAttribute("aria-checked", "false"))), draw());
			x.controls.push(...opts, s.text, s.note);
			groups.push({ opts, multiple: Boolean(q.multiple), own: s.text, note: s.note, answered: () => s.picks.size > 0 || s.text.value.trim() !== "" });
			return h("div", { class: "ask-one" }, q.header && h("b", { class: "ask-head" }, q.header), h("p", { class: "ask-q" }, q.question), h("div", { class: "ask-opts", role: q.multiple ? "group" : "radiogroup", "aria-label": m.options() }, ...opts), s.text, s.note);
		});
		x.pick = () => (state.every((s) => s.picks.size || s.text.value.trim()) ? { answers: state.map((s) => replyOf(s.picks, s.text.value, s.note.value)) } : undefined);
		x.first = wire(x.el, groups, () => x.send);
		return [...blocks, h("div", { class: "ask-acts" }, x.send!)];
	}
	/** An http(s) address as an external link, anything else as plain text. */
	const link = (url: string) => {
		const ok = (() => { try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; } })();
		return ok ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "cmp-link ask-url" }, visible(url)) : h("small", { class: "ask-url" }, visible(url));
	};
	/** A secret: what it is for, the steps, where it goes, and a masked field (shown only on request) with Submit and a way back to the terminal. */
	function secret(x: Panel, a: Answerable) {
		const s = a.secret!, field = h("input", { type: "text", class: "ask-own ask-secret", "data-masked": "true", maxlength: "8192", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "data-1p-ignore": "true", "data-lpignore": "true", "aria-label": m.secret_label() });
		const toggle = h("button", { type: "button", class: "cmp-link", "aria-pressed": "false" }, m.secret_show()), cancel = h("button", { type: "button", class: "cmp-link" }, m.secret_cancel());
		let masked = true;
		x.first = () => field; // a card opens on the masked field, as a question's opens on its first option
		const mask = (on: boolean) => ((masked = on), field.setAttribute("data-masked", String(on)), toggle.setAttribute("aria-pressed", String(!on)), toggle.replaceChildren(on ? m.secret_show() : m.secret_hide()));
		toggle.onclick = () => mask(!masked);
		field.oninput = () => draw();
		field.onkeydown = (e) => e.key === "Enter" && !e.isComposing && !x.send!.disabled && x.send!.click();
		x.clear = () => ((field.value = ""), mask(true));
		cancel.onclick = () => (x.clear!(), (x.done = true), say(x.note, "", m.secret_cancelled()), draw());
		x.pick = () => (field.value.trim() ? { value: field.value } : undefined);
		x.controls = [field, toggle, cancel];
		return nodes(h("p", { class: "ask-q" }, visible(s.label)), s.instructions.length > 0 && h("ol", { class: "ask-steps" }, ...s.instructions.map((i) => h("li", null, visible(i)))), s.url ? link(s.url) : null,
			h("p", { class: "ask-dest" }, h("small", null, m.secret_goes_to()), h("code", null, visible(s.destination))), h("div", { class: "ask-secret-row" }, field, toggle), h("small", { class: "ask-how" }, m.secret_private()), h("div", { class: "ask-acts" }, x.send!, cancel));
	}
	function build(p: Pending): Panel {
		const asks = p.asks ?? (p.ask ? [p.ask] : []), list = asks.length > 1, a = p.answer;
		const x: Panel = { key: keyOf(p), el: h("section", { class: "ask" }), note: h("p", { class: "ask-note", role: "status", "aria-live": "polite" }), controls: [], pick: () => undefined, done: false, sending: false };
		if (a) (x.send = h("button", { type: "button", class: "ask-send" }, a.secret ? m.secret_submit() : m.send_answer())).onclick = () => void (x.pick() && answer(x, bodyOf(a, x.pick()!, crypto.randomUUID()), Boolean(a.secret)));
		const noSecret = remote && p.tool === "secret_drop"; // never an answerable secret on a remote page, whatever it was sent
		const term = h("p", { class: "ask-term" }, p.why && asks.length ? p.why : `${list ? m.answer_them() : m.answer_it()} ${list || !asks[0] ? "" : how(asks[0])}`.trim());
		const show = terminal && p.tool !== "secret_drop" && h("button", { type: "button", class: "cmp-link" }, m.show_terminal());
		if (show) show.onclick = terminal;
		x.el.append(...(a && !noSecret ? (a.select ? select(x, a) : a.secret ? secret(x, a) : questions(x, a)) : [...(asks.length ? asks.map((y) => block(y, list)) : [h("p", { class: "ask-why" }, noSecret ? m.secret_remote() : (p.why ?? m.waits_dialog()))]), h("div", { class: "ask-acts" }, noSecret ? h("p", { class: "ask-term" }, m.answer_it()) : term, show)]), x.note);
		return x;
	}
	/** Puts a panel on the page, or none. The one leaving notes what had the focus in it, and on coming back takes it again (scrolled into view) if nothing else has it. */
	const show = (p?: Pending, x?: Panel) => {
		const had = document.activeElement as HTMLElement | null;
		if (cur && cur !== x) cur.focus = cur.el.contains(had) ? had! : undefined;
		[shown, cur, kept] = [p, x, x?.send ? x : kept];
		root.replaceChildren(...(x ? [x.el] : []));
		draw();
		if (x?.focus && (!document.activeElement || document.activeElement === document.body)) x.focus.focus();
	};
	return {
		/** Puts the focus on the form's first question's chosen option (or its first), when the panel on show answers and takes it; false when it has nothing to answer. */
		enter() {
			const to = cur && !cur.done ? cur.first?.() : undefined;
			return Boolean(to && !to.disabled && (to.focus(), true));
		},
		/** The unit's pending dialog now, and whether it can be answered or its pane brought forward (it waits and the stream is up). */
		update(next: Pending | undefined, can: boolean) {
			ready = can;
			if (next) leave = void clearTimeout(leave);
			// An answer sent from here stays on show for its dialog, and for six seconds after the unit moved on (from the first update without it), so its outcome can be read.
			if (!next && (cur?.done || cur?.sending)) leave ??= setTimeout(() => ((leave = undefined), show()), 6000);
			else if (!next) show();
			// The same dialog keeps its panel, under whichever call it is read; so does the call the server shows read-only while an answer from here
			// is on its way or settled. The dialog back from a read-only spell gets its panel back as the user left it; another dialog starts afresh.
			else if (cur && (keyOf(next) === cur.key || (!next.answer && (cur.done || cur.sending) && next.callId === shown?.callId))) {
				if ((cur.busy || cur.sending) && !next.answer) cur.spell = true; // while its own answer is on its way, a read-only echo may be the other one
				else if (cur.busy && cur.spell && next.answer) [cur.done, cur.busy] = [false, false], say(cur.note, "", m.other_answer());
				shown = next;
			}
			else show(next, kept?.key === keyOf(next) && !kept.done ? kept : build(next));
			draw();
		},
	};
}
