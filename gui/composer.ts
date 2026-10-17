import type { Mark } from "../src/dashboard.ts";
import { h } from "./dom.ts";
import { type Answer, post } from "./post.ts";

// The composer under a unit's comms log. What is typed goes to the unit's terminal through Herdr, as if typed there: Enter sends it (a
// prompt when idle, a steering message while it works), Alt+Enter queues it as a follow-up while it works, Shift+Enter adds a line, and a
// leading / or ! runs a pi or shell command. It lands after any unsent text in that terminal's editor and is submitted with it (D2). Commands
// that end or replace the session ask first, and so does Stop; the server refuses them unconfirmed as well. Only text the server confirmed
// Herdr took leaves the box (edits made meanwhile stay), and a send Herdr did not confirm is never retried. An IME's composing Enter is the
// IME's; on a touch screen Enter adds a line and the Send button sends. The draft is kept per session for this tab, and so is what the page could
// not say when the answer came (the route had left, or the page reloaded): a refusal's reason, an unconfirmed send, an edit of text that already went.

export const MAX_TEXT = 16_384;
const UNSURE = "Not confirmed. Check the terminal before sending again.";
const WENT = "The original already went to the session; what is here is your edited copy, unsent.";
type Note = [tone: string, text: string];
export const ENDING = /^\s*\/(quit|exit|new|resume|fork|clone|import|reload)(?=\s|$)/;
export type Post = (action: "input" | "keys" | "focus" | "answer", body: Record<string, unknown>) => Promise<Answer>;
type Flight = { sent?: string; answer: Promise<Answer> };
// Sends on their way, by session key. They outlive a composer replaced meanwhile (the route left and came back), whose successor waits for
// them before it sends again and settles its own box, so text is neither shown as unsent after it went nor sent twice.
const flights = new Map<string, Flight>();
/** `asking`: its question panel is on the page and carries Focus terminal, so the composer does not; `answerable`: that panel answers it. */
export interface Unit { name: string; control: boolean; live: boolean; mark: Mark; online: boolean; asking?: boolean; answerable?: boolean }

/** The server's input API for one session. */
export const postTo = (key: string): Post => (action, body) => post(`sessions/${encodeURIComponent(key)}/${action}`, body);
/** The note an answer leaves for a composer that is not there to say it: a refusal's reason, an unconfirmed send, or an edit of text that already went. */
export function aftermath(r: Answer, stored: string | undefined, sent: string): Note | undefined {
	if (!r.ok) return ["error", r.status === 504 ? UNSURE : (r.body.reason ?? `Refused (${r.status}).`)];
	if (stored && !stored.startsWith(sent)) return ["ok", WENT];
}
/** A stored note: ours is JSON [tone, text]; 0.5.0 stored the plain text of its note, shown as it is. */
export const recall = (raw: string | null): Note | undefined => {
	try {
		return raw?.startsWith("[") ? (JSON.parse(raw) as Note) : raw ? ["error", raw] : undefined;
	} catch {
		return ["error", raw!];
	}
};
/** What a mounted composer says once Herdr took `sent`; an empty box (the draft could not be stored) holds no edits. */
export const confirmed = (box: string, sent: string) => (box !== "" && !box.startsWith(sent) ? "Sent as it was; your edits stayed here, unsent." : "Sent. It shows in the log once pi writes it.");
/** Focus terminal: hidden when nothing live backs it or the question panel carries one, and not clickable while a request is on its way or the stream is down. */
export const focusButton = (u: Unit, busy: boolean) => ({ hidden: !u.live || !u.control || Boolean(u.asking), disabled: busy || !u.online });
/** What stays in the box once `sent` was accepted: what was typed after it, or everything when the sent part was edited meanwhile. */
export const settle = (now: string, sent: string) => (now.startsWith(sent) ? now.slice(sent.length).replace(/^\n/, "") : now);
/** Why nothing can be sent right now, or undefined. */
export function blocked(u: Unit): string | undefined {
	if (!u.online) return "The stream is down; sending waits for it to come back.";
	if (!u.live) return "This session is no longer live; its history stays readable.";
	if (!u.control) return "No live pi pane backs this unit, so there is nothing to type into.";
	if (u.mark === "waiting") return u.answerable ? "It waits on a dialog: answer it above, or in its terminal." : "It waits on a dialog; answer it in its terminal.";
}

export function mountComposer(root: HTMLElement, key: string, post: Post) {
	const store = `sb-draft:${key}`, touch = matchMedia("(pointer: coarse)").matches;
	const box = h("textarea", { rows: "1", maxlength: String(MAX_TEXT), "aria-label": "Message", enterkeyhint: touch ? "enter" : "send" });
	const send = h("button", { type: "submit", class: "cmp-send" }, "Send"), follow = h("button", { type: "button", class: "cmp-alt", title: "Alt+Enter" }, "Follow-up"), stop = h("button", { type: "button", class: "cmp-alt cmp-stop" }, "Stop");
	const note = h("p", { class: "cmp-note", role: "status", "aria-live": "polite" }), focus = h("button", { type: "button", class: "cmp-link" }, "Focus terminal");
	const form = h("form", { class: "composer" }, h("div", { class: "cmp-row" }, box, h("div", { class: "cmp-acts" }, send, follow, stop)), h("div", { class: "cmp-foot" }, note, focus));
	root.replaceChildren(form);
	let unit: Unit = { name: "", control: false, live: false, mark: "unknown", online: false }, busy = false, asking = false;
	const keep = (use: () => void) => {
		try {
			use();
		} catch {} // storage refused: the draft lives in the box only
	};
	keep(() => (box.value = sessionStorage.getItem(store) ?? ""));
	const save = () => keep(() => (box.value ? sessionStorage.setItem(store, box.value) : sessionStorage.removeItem(store)));
	const grow = () => ((box.style.height = "auto"), (box.style.height = `${Math.min(box.scrollHeight, 220)}px`));
	const say = (text: string, tone = "", ...kids: HTMLElement[]) => ((note.dataset.tone = tone), note.replaceChildren(text, ...kids));
	/** An inline confirm in the note line: the action runs only on its button. */
	const ask = (question: string, label: string, run: () => void) => {
		const yes = h("button", { type: "button", class: "cmp-yes" }, label), no = h("button", { type: "button", class: "cmp-link" }, "Cancel");
		asking = true;
		yes.onclick = () => ((asking = false), run());
		no.onclick = () => ((asking = false), say(""), box.focus());
		say(question, "ask", yes, no);
		yes.focus();
	};
	const [noteKey, read] = [`${store}:note`, () => { try { return sessionStorage.getItem(store) ?? ""; } catch { return undefined; } }];
	const stash = (n?: Note) => keep(() => (n ? sessionStorage.setItem(noteKey, JSON.stringify(n)) : sessionStorage.removeItem(noteKey)));
	function call(action: "input" | "keys" | "focus", body: Record<string, unknown>, sent?: string) {
		const flight = { sent, answer: post(action, body) };
		// The send settles the stored draft once, mounted composer or not. Its note is written before the answer (a page reloaded before Herdr
		// answered must warn) and after it (a refusal's reason, or an edit of the sent text, for a composer that is not there to say it).
		if (sent !== undefined) {
			stash(["error", UNSURE]), flights.set(key, flight);
			void flight.answer.then((r) => {
				const now = read();
				if (r.ok && now !== undefined) keep(() => sessionStorage.setItem(store, settle(now, sent)));
				stash(aftermath(r, now, sent));
			}, () => stash(["error", UNSURE]));
		}
		return land(flight);
	}
	/** Waits for a send, this composer's or one a replaced composer started, and settles the box; a detached composer touches nothing. */
	async function land(flight: Flight, { sent } = flight) {
		(busy = true), (asking = false), draw(), say(sent === undefined ? "" : "Sending…"); // a request replaces an open confirm
		try {
			const r = await flight.answer;
			if (!form.isConnected) return;
			if (!r.ok) return (r.status === 504 || stash(), say(r.body.reason ?? `Refused (${r.status}).`, "error")); // shown here, so only an unconfirmed send keeps its note
			if (sent === undefined) return say("");
			stash();
			const said = confirmed(box.value, sent);
			(box.value = settle(box.value, sent)), save(), grow();
			say(said, "ok");
		} catch {
			say(UNSURE, "error");
		} finally {
			if (flights.get(key) === flight) flights.delete(key);
			(busy = false), draw();
		}
	}
	/** `sure` is the text the user confirmed; a confirm holds only for that exact text. */
	function submit(as: "send" | "followUp", sure?: string) {
		const text = box.value, why = blocked(unit), confirmed = sure === text;
		if (busy || asking || !text.trim()) return;
		if (why) return say(why, "error");
		if (new TextEncoder().encode(text).length > MAX_TEXT) return say("The text is longer than 16 KB; shorten it.", "error");
		const command = !confirmed && text.match(ENDING)?.[0].trim();
		if (command) return ask(`${command} ends this session or switches its pane to another one.`, `Send ${command}`, () => submit(as, text));
		void call("input", { text, as, confirmed }, text);
	}
	function draw() {
		const why = blocked(unit), working = unit.mark === "working";
		box.placeholder = why ?? `Message ${unit.name} · ${touch ? "" : "Enter sends, Shift+Enter adds a line · "}lands after any unsent text in its terminal`;
		send.disabled = busy || Boolean(why);
		follow.hidden = stop.hidden = !working || Boolean(why);
		follow.disabled = stop.disabled = busy;
		Object.assign(focus, focusButton(unit, busy));
	}
	form.addEventListener("submit", (event) => (event.preventDefault(), submit("send")));
	follow.onclick = () => submit("followUp");
	stop.onclick = () => ask("Stop the current task? Queued messages go back to its terminal editor.", "Stop", () => void (busy || call("keys", { keys: ["esc"] })));
	focus.onclick = () => void (busy || call("focus", {})); // one request per session at a time: a pending send keeps the others off
	box.addEventListener("input", () => (save(), grow()));
	// Escape anywhere in the composer cancels an open question, and in a box with text stays here instead of leaving the route.
	form.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.isComposing || !(asking || (event.target === box && box.value))) return;
		event.preventDefault();
		if (asking) (asking = false), say(""), box.focus();
	});
	box.addEventListener("keydown", (event) => {
		if (event.isComposing || event.keyCode === 229 || event.key !== "Enter" || event.shiftKey || (touch && !event.altKey)) return;
		event.preventDefault();
		submit(event.altKey ? "followUp" : "send");
	});
	// On a phone the on-screen keyboard shrinks the visual viewport: the comms panel follows it, so the composer stays above the keyboard.
	const vv = window.visualViewport, fit = () => document.documentElement.style.setProperty("--vvh", `${vv!.height}px`);
	if (vv) (vv.addEventListener("resize", fit), fit());
	grow();
	if (flights.has(key)) void land(flights.get(key)!);
	else keep(() => {
		const kept = recall(sessionStorage.getItem(noteKey));
		sessionStorage.removeItem(noteKey);
		if (kept) say(kept[1], kept[0]);
	});
	return { box, update: (next: Unit) => ((unit = next), draw()), ready: () => !blocked(unit) };
}
