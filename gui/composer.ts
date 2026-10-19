import type { Mark } from "../src/dashboard.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { type Answer, post, sendFile } from "./post.ts";
import { mountSlash } from "./slash.ts";

// The composer under a unit's comms log. What is typed goes to the unit's terminal through Herdr, as if typed there: Enter sends it (a
// prompt when idle, a steering message while it works), Alt+Enter queues it as a follow-up while it works, Shift+Enter adds a line, and a
// leading / or ! runs a pi or shell command; while a `/name` is typed, a menu lists the session's matching commands (slash.ts). It lands after any unsent text in that terminal's editor and is submitted with it (D2). Commands
// that end or replace the session ask first, and so does Stop; the server refuses them unconfirmed as well. Only text the server confirmed
// Herdr took leaves the box (edits made meanwhile stay), and a send Herdr did not confirm is never retried. An IME's composing Enter is the
// IME's; on a touch screen Enter adds a line and the Send button sends. The draft is kept per session for this tab, and so is what the page could
// not say when the answer came (the route had left, or the page reloaded): a refusal's reason, an unconfirmed send, an edit of text that already went.

export const MAX_TEXT = 16_384;
type Note = [tone: string, text: string];
export const ENDING = /^\s*\/(quit|exit|new|resume|fork|clone|import|reload)(?=\s|$)/;
export type Post = (action: "input" | "keys" | "focus" | "answer" | "mirror" | "commands", body: Record<string, unknown>) => Promise<Answer>;
type Flight = { sent?: string; answer: Promise<Answer> };
// Sends on their way, by session key. They outlive a composer replaced meanwhile (the route left and came back), whose successor waits for
// them before it sends again and settles its own box, so text is neither shown as unsent after it went nor sent twice.
const flights = new Map<string, Flight>();
/** `answerable`: its question panel on the page answers it. */
export interface Unit { name: string; control: boolean; live: boolean; mark: Mark; online: boolean; answerable?: boolean }

/** The server's input API for one session. */
export const postTo = (key: string): Post => (action, body) => post(`sessions/${encodeURIComponent(key)}/${action}`, body);
/** A file pasted, dropped, or picked: stored by the server, its path goes into the message (upload.ts). */
export const MAX_FILE = 20 * 1024 * 1024;
/** The note an answer leaves for a composer that is not there to say it: a refusal's reason, an unconfirmed send, or an edit of text that already went. */
export function aftermath(r: Answer, stored: string | undefined, sent: string): Note | undefined {
	if (!r.ok) return ["error", r.status === 504 ? m.unsure() : (r.body.reason ?? m.refused({ status: r.status }))];
	if (stored && !stored.startsWith(sent)) return ["ok", m.went()];
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
export const confirmed = (box: string, sent: string) => (box !== "" && !box.startsWith(sent) ? m.sent_edited() : "");
/** What stays in the box once `sent` was accepted: what was typed after it, or everything when the sent part was edited meanwhile. */
export const settle = (now: string, sent: string) => (now.startsWith(sent) ? now.slice(sent.length).replace(/^\n/, "") : now);
/** Why nothing can be sent right now, or undefined. */
export function blocked(u: Unit): string | undefined {
	if (!u.online) return m.blocked_offline();
	if (!u.live) return m.blocked_ended();
	if (!u.control) return m.blocked_no_pane();
	if (u.mark === "waiting") return u.answerable ? m.blocked_answer_above() : m.blocked_answer_terminal();
}

export function mountComposer(root: HTMLElement, key: string, post: Post, upload = (file: File) => sendFile(`sessions/${encodeURIComponent(key)}/upload`, file)) {
	const store = `sb-draft:${key}`, touch = matchMedia("(pointer: coarse)").matches;
	const box = h("textarea", { rows: "1", maxlength: String(MAX_TEXT), "aria-label": m.message(), enterkeyhint: touch ? "enter" : "send" });
	const send = h("button", { type: "submit", class: "cmp-send" }, m.send()), follow = h("button", { type: "button", class: "cmp-alt" }, m.follow_up()), stop = h("button", { type: "button", class: "cmp-alt cmp-stop" }, m.stop());
	const picker = h("input", { type: "file", multiple: "", hidden: "" }) as HTMLInputElement, attach = h("button", { type: "button", class: "cmp-alt", "aria-label": m.attach() }, "+");
	const note = h("p", { class: "cmp-note", role: "status", "aria-live": "polite" });
	const menu = mountSlash(box, (prefix) => post("commands", { prefix })); // before the composer's own keys, so Enter on the menu picks
	const form = h("form", { class: "composer" }, menu, h("div", { class: "cmp-row" }, attach, picker, box, h("div", { class: "cmp-acts" }, send, follow, stop)), h("div", { class: "cmp-foot" }, note));
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
		const yes = h("button", { type: "button", class: "cmp-yes" }, label), no = h("button", { type: "button", class: "cmp-link" }, m.cancel());
		asking = true;
		yes.onclick = () => ((asking = false), run());
		no.onclick = () => ((asking = false), say(""), box.focus());
		say(question, "ask", yes, no);
		yes.focus();
	};
	const [noteKey, read] = [`${store}:note`, () => { try { return sessionStorage.getItem(store) ?? ""; } catch { return undefined; } }];
	const stash = (n?: Note) => keep(() => (n ? sessionStorage.setItem(noteKey, JSON.stringify(n)) : sessionStorage.removeItem(noteKey)));
	function call(action: "input" | "keys", body: Record<string, unknown>, sent?: string) {
		const flight = { sent, answer: post(action, body) };
		// The send settles the stored draft once, mounted composer or not. Its note is written before the answer (a page reloaded before Herdr
		// answered must warn) and after it (a refusal's reason, or an edit of the sent text, for a composer that is not there to say it).
		if (sent !== undefined) {
			stash(["error", m.unsure()]), flights.set(key, flight);
			void flight.answer.then((r) => {
				const now = read();
				if (r.ok && now !== undefined) keep(() => sessionStorage.setItem(store, settle(now, sent)));
				stash(aftermath(r, now, sent));
			}, () => stash(["error", m.unsure()]));
		}
		return land(flight);
	}
	/** Waits for a send, this composer's or one a replaced composer started, and settles the box; a detached composer touches nothing. */
	async function land(flight: Flight, { sent } = flight) {
		(busy = true), (asking = false), draw(), say(sent === undefined ? "" : m.sending()); // a request replaces an open confirm
		try {
			const r = await flight.answer;
			if (!form.isConnected) return;
			if (!r.ok) return (r.status === 504 || stash(), say(r.body.reason ?? m.refused({ status: r.status }), "error")); // shown here, so only an unconfirmed send keeps its note
			if (sent === undefined) return say("");
			stash();
			const said = confirmed(box.value, sent);
			(box.value = settle(box.value, sent)), save(), grow();
			say(said, "ok");
		} catch {
			say(m.unsure(), "error");
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
		if (new TextEncoder().encode(text).length > MAX_TEXT) return say(m.too_long(), "error");
		const command = !confirmed && text.match(ENDING)?.[0].trim();
		if (command) return ask(m.ends_session({ command }), m.send_command({ command }), () => submit(as, text));
		void call("input", { text, as, confirmed }, text);
	}
	function draw() {
		const why = blocked(unit), working = unit.mark === "working";
		box.placeholder = why ?? m.placeholder({ name: unit.name });
		send.disabled = busy || Boolean(why) || !box.value.trim(); // nothing typed, nothing to send
		follow.hidden = stop.hidden = !working || Boolean(why);
		[follow.disabled, stop.disabled] = [send.disabled, busy]; // a follow-up needs a message too
	}
	/** Uploads the files one by one and puts each stored path where the cursor is, as a word of its own. */
	async function attachAll(files: File[]) {
		if (!files.length || busy) return;
		const why = blocked(unit);
		if (why) return say(why, "error");
		say(m.uploading(), "");
		for (const file of files) {
			if (file.size > MAX_FILE) return say(m.file_too_large({ name: file.name }), "error");
			const r = await upload(file).catch(() => undefined);
			if (!r?.ok || typeof r.body.path !== "string") return say(r?.body.reason ?? m.no_answer(), "error");
			const at = box.selectionStart ?? box.value.length, before = box.value.slice(0, at), after = box.value.slice(box.selectionEnd ?? at);
			const word = `${before && !/\s$/.test(before) ? " " : ""}${r.body.path}${/^\s/.test(after) ? "" : " "}`;
			box.value = before + word + after;
			box.selectionStart = box.selectionEnd = at + word.length;
		}
		say("");
		save(), grow(), draw(), box.focus();
	}
	attach.onclick = () => picker.click();
	picker.onchange = () => void attachAll([...(picker.files ?? [])]).finally(() => (picker.value = ""));
	box.addEventListener("paste", (event) => {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length) (event.preventDefault(), void attachAll(files)); // text pastes as text
	});
	form.addEventListener("dragover", (event) => event.dataTransfer?.types.includes("Files") && event.preventDefault());
	form.addEventListener("drop", (event) => {
		const files = [...(event.dataTransfer?.files ?? [])];
		if (files.length) (event.preventDefault(), void attachAll(files));
	});
	form.addEventListener("submit", (event) => (event.preventDefault(), submit("send")));
	follow.onclick = () => submit("followUp");
	stop.onclick = () => ask(m.stop_ask(), m.stop(), () => void (busy || call("keys", { keys: ["esc"] })));
	box.addEventListener("input", () => (save(), grow(), draw()));
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
	// On a phone the on-screen keyboard shrinks and shifts the visual viewport: the full-screen comms follow it, so the composer stays above the keyboard.
	const vv = window.visualViewport, fit = () => [["--vvh", vv!.height], ["--vvt", vv!.offsetTop]].forEach(([k, v]) => document.documentElement.style.setProperty(k as string, `${v}px`));
	if (vv) (vv.addEventListener("resize", fit), vv.addEventListener("scroll", fit), fit());
	grow();
	if (flights.has(key)) void land(flights.get(key)!);
	else keep(() => {
		const kept = recall(sessionStorage.getItem(noteKey));
		sessionStorage.removeItem(noteKey);
		if (kept) say(kept[1], kept[0]);
	});
	return { box, update: (next: Unit) => ((unit = next), draw()), ready: () => !blocked(unit) };
}
