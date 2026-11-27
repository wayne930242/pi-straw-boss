import { HEAD_KEY } from "../src/headkey.ts";
import type { BossWait, WaitCardView, WaitPressView } from "../src/net.ts";
import { type Alert, unitOf } from "./alerts.ts";
import type { SessionPost } from "./answer.ts";
import { joined, outcome, type WaitActions, waitActions } from "./asks.ts";
import { actions, choices, LONG_Q, mark, option, say, sendButton, statusLine, wire } from "./askview.ts";
import { selectText } from "./copy.ts";
import { h, nodes } from "./dom.ts";
import { m } from "./sentences.ts";
import type { Answer } from "./post.ts";
import { aim, text, waitTitle } from "./render.ts";
import { formatRoute, type NetRoute } from "./router.ts";
import { waitSubject } from "../src/waitbudget.ts";
import { type ButtonId, type CardModel, cardModel, type Phase, pressedLine } from "./waitcardmodel.ts";
import { replyBox } from "./waitpanel.ts";
import { towerWhy } from "./towerturns.ts";

// The card of a wait for the boss, drawn wherever one is drawn (docs/specs/2026-11-07-wait-cards.md, The card in the GUI; docs/specs/2026-11-10-wait-cards-tui.md, section 4: it is the question panel's own parts, askview.ts, so every view wears the confirm card's look): the dock's dialog, the tower card's rows and comms, the head page's rows, and Zen's card. What it shows and says is waitcardmodel.ts's;
// this file holds the DOM and the calls: a press goes to the memory route (asks.ts `waitActions`), a URL is text that a click opens, a command is text that a click copies, and nothing here runs, fetches, or opens anything by itself.

/** A text part longer than this is clamped to three lines with a More toggle (outside the dock's dialog, which shows every part whole). A card's fields are at most 160 characters; three lines of a phone's width hold about 90. */
const CLAMP_AT = 90;
const REASON_MAX = 120; // the server's cap on a decline's reason

type Host = "dialog" | "zen" | "row";
export interface WaitCardOptions {
	host: Host;
	actions: WaitActions;
	/** The wait as the snapshot carries it; `update` brings the next one. */
	wait: BossWait;
	/** A paired device cannot start a secret card (WC-D4): by the page's host name unless the host says. */
	remote?: boolean;
	/** The wait is a box's (operate): nothing in it is a link, its URL is text only. */
	box?: boolean;
	/** The route of the raiser's session, when the page can open it: the card then offers Open <name>. */
	main?(key: string): NetRoute | undefined;
	/** A host that is not a page of routes (Zen leaves its layer for the session) takes the click of Open <raiser> itself; the router never sees it. */
	go?(route: NetRoute): void;
	/** The raiser's unit has a `secret_drop` dialog pending now (a host that has the net says so). */
	secretOpen?(): boolean;
	/** Zen wraps an ending press, so the card's outcome (the knock, the low bowl) follows it. */
	send?(reply: Promise<Answer>): Promise<Answer>;
	/** A press or an answer the server took, in words, for the host that shows it beside the card or closes its dialog. */
	done?(said: string): void;
	/** The wait is the head tower's: its words name the head tower (docs/specs/2026-11-10-wait-cards-tui.md, Q3). */
	head?: boolean;
	now?(): number;
}

/** A paired device reaches the page by another host name than this computer's own (as `mountAsk`'s default). */
export const isRemote = () => Boolean(globalThis.location?.hostname) && globalThis.location.hostname !== "127.0.0.1";
/** The URL as text for the card, `URL.href` (an IDN host shows in punycode and cannot pose as another host), only when it is an `http(s)` address without a user name or password. */
export function safeHref(url: string): string | undefined {
	try {
		const u = new URL(url);
		return (u.protocol === "http:" || u.protocol === "https:") && u.host && !u.username && !u.password ? u.href : undefined;
	} catch {
		return undefined;
	}
}

type Pick = { id: ButtonId; option?: number };
/** The press a row sends, by the row's id: the memory route's act (asks.ts `waitActions`). */
const ACT = { done: "done", entered: "done", choose: "choose", secret: "secret", restate: "restate", skip: "decline" } as const;

export function waitCard(o: WaitCardOptions) {
	const wrap = o.send ?? ((reply: Promise<Answer>) => reply);
	const reply = replyBox({ actions: o.actions, ...(o.send ? { send: o.send } : {}), ...(o.head ? { head: true } : {}) });
	let cur = o.wait, live = true, blocked: string | undefined, over = false, inflight: Pick | undefined, refusal = "", folded = o.host === "row", local: WaitPressView | undefined, full: { card?: WaitCardView; press?: WaitPressView } | undefined, read = false, last = "", rowsSig = "", linkSig = "", pick: Pick | undefined;
	let lastAnswer: string | undefined;
	const expanded = new Set<string>();
	const remote = () => o.remote ?? isRemote();
	// The persistent parts: the question panel's own (askview.ts) — Send, the status line, the radiogroup, and the boxes a picked row reveals, which keep their state across a redraw of the rest.
	const send = sendButton(m.send()), note = statusLine();
	const tells = h("p", { class: "ask-why wc-skip-tells" }), reason = h("textarea", { class: "ask-own wc-skip-reason", rows: "1", maxlength: String(REASON_MAX), "aria-label": m.wc_skip_reason(), placeholder: m.wc_skip_reason() }) as HTMLTextAreaElement;
	const skipBox = h("div", { class: "wc-skip-box" }, tells, reason), reveal = h("div", { class: "wc-reveal" }, skipBox, reply.box);
	const head = h("div", { class: "ask-head wc-head" }), parts = h("div", { class: "ask-ctx wc-parts" }), hint = h("p", { class: "ask-why wc-remote" });
	const rows: HTMLButtonElement[] = [], opts = choices("radiogroup", m.options());
	const acts = actions(send);
	const root = h("section", { class: "ask wait-card", "data-host": o.host }, head, parts, hint, opts, reveal, acts, note);
	let link: HTMLElement | undefined;
	reveal.hidden = true;

	/** The wait with what the page learned beyond the snapshot: the whole card of a cut one, and the press a reply carried before the snapshot brings it. */
	const effective = (): BossWait => {
		const press = local ?? cur.press ?? full?.press;
		return { ...cur, ...(full?.card ? { card: full.card } : {}), ...(press ? { press } : {}), ...(full?.card ? { cut: undefined } : {}) } as BossWait;
	};
	const phase = (): Phase => (over || cur.state === "resolved" ? "ended" : inflight ? "sending" : !live ? "stale" : refusal ? "refused" : "open");
	const model = (): CardModel => cardModel({ wait: effective(), phase: phase(), remote: remote(), ...(inflight ? { sending: inflight } : {}), open: Boolean(o.main?.(effective().card?.from?.key ?? "")), ...(blocked ? { blocked } : {}), ...(o.secretOpen ? { secretOpen: o.secretOpen() } : {}), ...(o.head ? { head: true } : {}), now: (o.now ?? Date.now)() });
	const same = (a: Pick | undefined, b: Pick) => a?.id === b.id && a.option === b.option;

	/** The press of the picked row: Send's act. The first step of a secret card ends nothing, so the card stays for the second. */
	async function press(p: Pick) {
		if (inflight) return;
		const act = ACT[p.id as keyof typeof ACT];
		const extra = p.id === "choose" ? { option: p.option } : p.id === "skip" && reason.value.trim() ? { reason: reason.value.trim() } : undefined;
		[inflight, refusal] = [p, ""];
		render();
		try {
			const r = await (act === "secret" ? o.actions.press(act, extra) : wrap(o.actions.press(act, extra)));
			inflight = undefined;
			if (outcome(r) === "accepted") {
				local = (r.body.press as WaitPressView | undefined) ?? { act, at: new Date().toISOString(), ...(extra?.option !== undefined ? { option: extra.option } : {}) };
				[pick, reason.value] = [undefined, ""];
				render();
				if (act !== "secret") o.done?.(pressedLine(effective(), o.head ? { head: true } : undefined));
			} else (refusal = m.wc_refused({ reason: joined(towerWhy(r) ?? r.body.reason ?? r.body.error ?? String(r.status)) }), render());
		} catch {
			inflight = undefined;
			refusal = m.unreachable();
			render();
		}
	}
	/** The words of the reply row go to the tower's session input; no press. */
	async function tell() {
		if (inflight || !reply.ready()) return;
		[inflight, refusal] = [{ id: "reply" }, ""];
		render();
		const r = await reply.send();
		inflight = undefined;
		if (r.taken) {
			pick = undefined;
			render();
			o.done?.(o.head ? m.wait_sent_head() : m.wait_sent());
		} else (refusal = r.why ?? "", render(), reply.box.focus());
	}
	const choose = (b: CardModel["buttons"][number]) => {
		pick = { id: b.id, ...(b.option !== undefined ? { option: b.option } : {}) };
		refusal = "";
		render();
		// The reply's box takes the focus (the words are what comes next). Skip's reason is optional, so the focus stays on the row: a phone's keyboard would open over the confirm, and Enter goes on to Send (askkeys.ts).
		if (b.id === "reply") reply.box.focus();
		else if (b.id === "skip") reveal.scrollIntoView?.({ block: "nearest" });
	};
	send.onclick = () => void (pick && (pick.id === "reply" ? tell() : press(pick)));
	/** Enter in a box: the reply's words are sent; Skip's reason only moves on to Send, as the alert card's own words do (askkeys.ts), since a decline is not undone. */
	const onEnter = (act: () => void) => (e: KeyboardEvent) => {
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		render(); // words set without an input event (autofill, an IME) are read as they stand
		if (!send.disabled) act();
	};
	reply.box.addEventListener("keydown", onEnter(() => send.click()) as EventListener);
	reason.addEventListener("keydown", onEnter(() => send.focus()) as EventListener);
	reply.box.addEventListener("input", () => ((refusal = ""), render()));
	const keys = wire(opts, [{ opts: rows, multiple: false, answered: () => pick !== undefined }], () => send);

	function partEl(p: CardModel["parts"][number], lang: string): HTMLElement {
		const body: (HTMLElement | string)[] = [];
		const asked = p.id === "do" || p.id === "words"; // what you do (a choice: what you decide) is the panel's question: read whole, at the size a long question has (wg-F003)
		const clampable = o.host !== "dialog" && !asked && !p.url && !p.command && p.text.length > CLAMP_AT, clamped = clampable && !expanded.has(p.id);
		if (p.url) {
			const href = safeHref(p.url);
			body.push(h("span", { class: "wc-text wc-url", lang }, href ?? p.url));
			if (href && !o.box) body.push(h("a", { class: "pair-btn wc-open", href, target: "_blank", rel: "noopener noreferrer" }, m.wc_b_link()));
		}
		if (p.command !== undefined) {
			const pre = h("pre", { class: "wc-cmd", lang }, p.command), said = h("small", { class: "wc-copied", role: "status" }), copy = h("button", { type: "button", class: "pair-btn wc-copy" }, m.wc_b_copy());
			copy.onclick = async () => {
				try {
					await navigator.clipboard.writeText(p.command!);
					said.textContent = m.wc_copied();
				} catch {
					selectText(pre); // a page that may not write the clipboard (a phone on plain http) selects the text instead
					said.textContent = m.wc_copy_select();
				}
			};
			body.push(pre, copy, h("small", { class: "wc-norun" }, m.wc_not_run()), said);
		}
		const words = !p.url && p.command === undefined ? h(asked ? "p" : "span", { class: `wc-text${asked ? " ask-q" : ""}${clamped ? " wc-clamp" : ""}`, lang, ...(asked && p.text.length > LONG_Q ? { "data-long": "" } : {}) }, p.text) : undefined;
		if (words) body.push(words);
		if (clampable && words) {
			const more = h("button", { type: "button", class: "wc-more", "aria-expanded": String(!clamped) }, clamped ? m.wc_more() : m.wc_less());
			more.onclick = () => (expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id), render());
			body.push(more);
			// The three-line clamp is only for text that needs it: once the part is laid out and fits, the toggle is not offered (a card in a wide window shows 90 characters on one line).
			if (clamped) globalThis.requestAnimationFrame?.(() => words.clientHeight > 0 && words.scrollHeight <= words.clientHeight + 1 && ((more.hidden = true), words.classList.remove("wc-clamp")));
		}
		return h("div", { class: "wc-part", "data-part": p.id }, h("b", { class: "wc-label" }, p.label), ...body);
	}
	/** The raiser's link: Open <name>, quiet beside Send. */
	function linkEl(b: CardModel["buttons"][number]): HTMLElement {
		const route = o.main?.(effective().card?.from?.key ?? "");
		const el = h("a", { class: "cmp-link wc-main", href: route ? formatRoute(route) || "./" : "./", ...(route ? { "data-route": formatRoute(route) } : {}) }, b.label);
		if (route && o.go) el.onclick = (e: Event) => (e.preventDefault(), e.stopPropagation(), o.go!(route));
		return el;
	}

	function render() {
		const w = effective(), md = model(), lang = w.card?.lang ?? "", ph = phase();
		const doText = w.card && w.card.from?.role !== "device" ? w.card.do : waitSubject(w);
		// Fold once per answer, not on every snapshot: the boss can reopen it to reply or skip.
		const answer = o.host === "row" && ph !== "ended" && w.press?.act !== "secret" ? w.press?.at ?? w.answered : undefined;
		if (answer && answer !== lastAnswer) { folded = true; pick = undefined; }
		lastAnswer = answer;
		const summary = answer && folded ? pressedLine(w, { head: o.head }, true) || m.memory_wait_answered_boss() : "";
		const rowOf = md.buttons.filter((b) => b.id !== "main");
		if (pick && !rowOf.some((b) => same(pick, b) && !(b.disabled && ph === "open"))) pick = undefined; // the row is gone, or was pressed elsewhere (the wait was pressed or ended)
		root.dataset.kind = md.kind;
		root.dataset.phase = ph;
		root.dataset.folded = String(folded);
		root.dataset.pressed = String(Boolean(w.press && w.press.act !== "secret"));
		root.dataset.parked = String(Boolean(md.parked));
		root.dataset.step = String(md.step ?? "");
		// The head: a row's folded line (tag, what to do, who raised it; a tap unfolds the rest), else the tag, the parked mark, and the raiser.
		const sig = JSON.stringify([md.tag, md.parked, md.raised, md.parts, md.remote, folded, [...expanded], o.host, doText, summary]);
		if (sig !== last) {
			last = sig;
			if (o.host === "row") {
				const fold = h("button", { type: "button", class: "wc-fold", "aria-expanded": String(!folded) }, h("b", { class: "wc-tag" }, md.tag), md.parked ? h("small", { class: "wc-parked" }, md.parked) : null, h("span", { class: "wc-do", lang }, doText), h("small", { class: "wc-raised" }, md.raised));
				if (summary) fold.replaceChildren(h("span", { class: "wc-summary", title: summary }, summary));
				fold.onclick = () => ((folded = !folded), folded && (pick = undefined), render()); // folding drops the pick: nothing is preselected when it is unfolded again
				head.replaceChildren(fold);
			} else head.replaceChildren(...nodes(h("b", { class: "wc-tag" }, md.tag), md.parked ? h("small", { class: "wc-parked" }, md.parked) : null, h("small", { class: "wc-raised" }, md.raised)));
			parts.replaceChildren(...md.parts.map((p) => partEl(p, lang)));
			hint.textContent = md.remote ?? "";
		}
		for (const el of [parts, hint, opts, reveal, acts]) el.hidden = folded;
		acts.hidden = folded || ph === "ended"; // an ended wait answers nothing: no dead Send
		hint.hidden = !md.remote || folded;
		// The rows: rebuilt only when the acts change, so the key presses that move and pick (askkeys.ts) keep the element they are on.
		const held = globalThis.document.activeElement as HTMLElement | null, keep = held && opts.contains(held) ? `${held.dataset.act}:${held.dataset.option ?? ""}` : undefined;
		const nextRows = JSON.stringify(rowOf.map((b) => [b.id, b.option, b.label, b.then]));
		if (nextRows !== rowsSig) {
			rowsSig = nextRows;
			const made = rowOf.map((b) => {
				const el = option("radio", b.label, [b.then], () => choose(b));
				el.dataset.act = b.id;
				if (b.option !== undefined) el.dataset.option = String(b.option);
				return el;
			});
			rows.splice(0, rows.length, ...made);
			opts.replaceChildren(...made);
			if (keep) rows.find((el) => `${el.dataset.act}:${el.dataset.option ?? ""}` === keep)?.focus();
		}
		const stop = rowOf.findIndex((b) => !b.disabled); // the tab stop of the group without a pick: the first row that can be pressed
		rowOf.forEach((b, i) => {
			const el = rows[i]!;
			mark(el, same(pick, b) || Boolean(b.picked)); // a pressed choice stays marked
			el.disabled = Boolean(b.disabled);
			el.setAttribute("tabindex", String(pick ? (same(pick, b) ? 0 : -1) : i === stop ? 0 : -1));
		});
		// What the picked row reveals: Skip says who is told and takes a reason, Reply takes the words.
		const skipping = pick?.id === "skip", replying = pick?.id === "reply";
		reveal.hidden = folded || !(skipping || replying);
		skipBox.hidden = !skipping;
		reply.box.hidden = !replying;
		tells.textContent = w.card?.from && !w.card.from.gone ? (o.head ? m.wc_skip_tells_head : m.wc_skip_tells)({ name: w.card.from.name }) : (o.head ? m.wc_skip_tells_tower_head : m.wc_skip_tells_tower)();
		send.disabled = !pick || !live || Boolean(inflight) || (ph !== "open" && ph !== "refused") || (replying && !reply.ready());
		// The raiser's link beside Send, rebuilt only when it changes.
		const main = md.buttons.find((b) => b.id === "main"), nextLink = main ? `${main.label}\n${main.disabled}\n${formatRoute(o.main?.(w.card?.from?.key ?? "") ?? { view: "session", ws: "", key: "" })}` : "";
		if (nextLink !== linkSig) {
			linkSig = nextLink;
			link?.remove();
			link = main ? linkEl(main) : undefined;
			if (link) acts.append(link);
		}
		// The status line: sending, a refusal, or what the wait says of itself (what was pressed and who was told, the secret's second step, a stream that is down or a tower that closed it).
		note.hidden = Boolean(summary) && live && !refusal;
		say(note, inflight ? "" : refusal ? "error" : root.dataset.pressed === "true" ? "ok" : "", inflight ? m.wc_sending() : refusal || md.line);
	}

	/** A card the snapshot cut is read whole from the memory route, once. */
	function fetchWhole() {
		if (!cur.cut || full || read) return;
		read = true;
		void o.actions.read().then((r) => {
			const e = (r.body.entries as (BossWait & { card?: WaitCardView })[] | undefined)?.find((x) => x.id === cur.id);
			if (e?.card) (full = { card: { ...e.card, ...(e.card.from ? { from: { ...e.card.from, id: undefined } } : {}) } as WaitCardView, ...(e.press ? { press: e.press } : {}) }), render();
		}, () => {});
	}
	/** `why`: the card is off because its unit's box is away (the reason), not because the stream is down. */
	function update(next: BossWait, on = true, ended = false, why?: string) {
		cur = next;
		[live, over, blocked] = [on, ended, on ? undefined : why];
		if (cur.press && local && cur.press.at >= local.at) local = undefined; // the snapshot caught up
		fetchWhole();
		render();
	}
	fetchWhole();
	render();
	return {
		el: root,
		/** The tag of the card's kind (Needs you / Your choice / Needs a secret), which the dock's badge repeats. */
		tag: () => model().tag,
		update,
		sending: () => Boolean(inflight) || reply.sending(),
		/** The reply row is picked: its box is open. */
		isOpen: () => pick?.id === "reply",
		/** The Skip row is picked: its reason box and its tells line are open, and Send confirms. */
		confirming: () => pick?.id === "skip",
		/** The host's reading of whether the raiser's `secret_drop` dialog is pending; it changes with each snapshot, so the host sets it again. */
		secretWhen(fn: (() => boolean) | undefined) {
			o.secretOpen = fn;
		},
		/** Puts the reply row back unpicked, the draft kept (Esc); false when it was not picked. */
		foldReply(): boolean {
			if (pick?.id !== "reply") return false;
			pick = undefined;
			render();
			rows.find((el) => el.dataset.act === "reply")?.focus();
			return true;
		},
		/** The chosen row takes the focus when the card is taken (Z-D20), else the first one that can be pressed; false when there is none to take. */
		enter(): boolean {
			const to = keys(), take = to && !to.disabled ? to : rows.find((el) => !el.disabled); // the chosen row of a pressed choice is off: the first row that can still be pressed
			return Boolean(take && (take.focus(), true));
		},
	};
}

/** The wait the alert is about: the snapshot's entry, else (an alert built without one) its id and words. */
const entryOf = (a: Alert): BossWait => a.wait!.entry ?? { id: a.wait!.id, text: a.wait!.text, at: new Date(a.since ?? a.at).toISOString() };

const cards = new WeakMap<HTMLElement, ReturnType<typeof waitCard>>();
/** The dock's dialog of a wait takes the focus on its card's primary button (else its first option); false when it has none. */
export const enterWait = (el: HTMLElement) => cards.get(el)?.enter() ?? false;
/** A wait's dialog in the dock: the card in the answer slot (Skip is one of its rows), the link to the comms and Later in the footer's row, and none of the tower's old transmission; a wait that is over says so. */
export function waitDialog(el: HTMLElement, a: Alert, place: string, close: () => void, send: SessionPost, more: { remote?: boolean; box?: boolean; /** The tower is a remote base's and its box takes no input now: the card answers nothing. */ away?: boolean; secretOpen?(): boolean; /** The workspace of the raiser's unit, found by its key (a head wait's alert is on the head's base, not the raiser's). */ where?(key: string): string | undefined } = {}) {
	const over = Boolean(a.gone), go = el.querySelector<HTMLElement>(".go")!;
	el.dataset.wait = ""; // the footer's link is the secondary act here (style.css): the card's buttons answer
	el.querySelector<HTMLElement>(".intel")!.hidden = true;
	text(el, "h3", waitTitle(a.role, place)); // the title says the role and the place once, so the header's place and the role under the title would repeat it
	for (const dup of [".where", ".role"]) el.querySelector<HTMLElement>(dup)!.hidden = true;
	go.textContent = m.wait_goto(); // the card is on the dialog; the footer's link is the way to the tower's comms
	aim(go, over ? undefined : { view: "session", ws: a.ws, key: unitOf(a) });
	text(el, ".state", over ? m.tower_wait_over() : m.memory_wait_boss());
	let card = cards.get(el);
	const entry = entryOf(a);
	if (!card) cards.set(el, (card = waitCard({ host: "dialog", wait: entry, actions: waitActions({ ws: a.ws, id: entry.id, tower: unitOf(a) }, send), ...(a.ws === HEAD_KEY ? { head: true } : {}), main: (key) => ((ws) => (key && ws ? { view: "session", ws, key } : undefined))(more.where?.(key) ?? (a.ws === HEAD_KEY ? undefined : a.ws)), done: close, ...(more.remote !== undefined ? { remote: more.remote } : {}), ...(more.box ? { box: true } : {}) })));
	card.secretWhen(more.secretOpen);
	if (!el.querySelector(".wait-card")) el.querySelector(".ask-root")!.replaceChildren(card.el);
	card.update(entry, !over && !more.away && document.body.dataset.stale !== "true", over, more.away && document.body.dataset.stale !== "true" ? m.box_answer_blocked() : undefined);
	text(el, ".tag", card.tag()); // the card's own word, not QUESTION (and not the stack's GONE: the tower did not leave, the wait ended)
}
