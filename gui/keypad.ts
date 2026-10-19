import { h } from "./dom.ts";
import type { Post, TermState } from "./mirror.ts";
import { m } from "./paraglide/messages.js";

// The key pad under a terminal mirror: one key per tap or keyboard press of its own button, never a sequence and never a repeat, and
// nothing while a key is on its way. The server checks every key again (src/keys.ts) and names the confirm it needs: for Enter when the
// editor holds a command that ends the session, a slash command, or could not be read, and for a second Escape on an idle session.
// While the mirror is hidden for a secret only Escape works; while it is stale, ended, or paused, nothing does.
// On a desktop the keyboard also goes straight to the pane while the terminal has focus (`type`, called by mirror.ts): the pad's keys by
// their own key, and printable characters as typed text. Writes go one at a time, at most one every 130 ms (the server takes 8 a second
// per session), and characters typed meanwhile join the next write. A refusal or a confirm drops what was still queued.

const ROWS: [string, string, () => string][][] = [
	[["esc", "esc", m.key_escape], ["tab", "tab", m.key_tab], ["up", "↑", m.key_up], ["enter", "enter", m.key_enter]],
	[["shift+tab", "⇧tab", m.key_shift_tab], ["left", "←", m.key_left], ["down", "↓", m.key_down], ["right", "→", m.key_right]],
	[["space", "space", m.key_space], ["backspace", "⌫", m.key_backspace], ["home", "home", m.key_home], ["end", "end", m.key_end], ["pageup", "pgup", m.key_page_up], ["pagedown", "pgdn", m.key_page_down]],
];
const DIGITS = "123456789".split("");
/** The keyboard's keys that are pad keys, by KeyboardEvent.key; Tab is tab or shift+tab. */
const KEYBOARD: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "enter", Escape: "esc", Backspace: "backspace", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown" };
const GAP = 130, MAX_TYPED = 64;
type Write = { key: string } | { text: string };

/** The pad of one terminal tile; `update` follows the mirror's state. */
export function keypad({ name, state, post, stream }: { name: string; state(): TermState; post: Post; stream(): string }) {
	const buttons: HTMLButtonElement[] = [], note = h("p", { class: "pad-note", role: "status" });
	let busy = false;
	const button = ([key, label, spoken]: [string, string, () => string]) => {
		const b = h("button", { type: "button", class: "pad-key", "data-key": key, "aria-label": spoken() }, label);
		b.onclick = (e) => e.isTrusted && !busy && void send({ key });
		buttons.push(b);
		return b;
	};
	const digits = h("details", { class: "pad-digits" }, h("summary", null, "1–9"), h("div", { class: "pad-row" }, ...DIGITS.map((d) => button([d, d, () => d]))));
	const el = h("div", { class: "pad", role: "group", "aria-label": m.keys_for({ name }) }, ...ROWS.map((row) => h("div", { class: "pad-row" }, ...row.map(button))), digits, note);
	const say = (text: string, tone = "") => ((note.dataset.tone = tone), note.replaceChildren(text));
	/** The server's confirm, inline: its reason, then the same key again with the token it named, or nothing. */
	const ask = (key: string, reason: string, token: string) => {
		const yes = h("button", { type: "button", class: "pad-yes" }, key === "enter" ? m.send_enter() : m.send_escape()), not = h("button", { type: "button", class: "cmp-link" }, m.cancel());
		yes.onclick = (e) => e.isTrusted && !busy && void send({ key }, token);
		not.onclick = () => say("");
		note.dataset.tone = "ask";
		note.replaceChildren(h("span", null, reason), yes, not);
		not.focus(); // never the confirm: a second Enter, or a held one, on the key that asked must not confirm it
	};
	async function send(write: Write, confirmed?: string) {
		busy = true;
		update();
		say("");
		last = Date.now();
		try {
			const r = await post("keys", { ...write, stream: stream(), ...(confirmed ? { confirmed } : {}) });
			if (r.status === 409 && r.body.error === "confirm" && typeof r.body.confirm === "string" && "key" in write) (queue = []), ask(write.key, String(r.body.reason ?? ""), r.body.confirm);
			else if (!r.ok) (queue = []), say(r.body.reason ?? m.refused({ status: r.status }), "error");
		} catch {
			queue = [];
			say(m.unreachable(), "error");
		} finally {
			busy = false;
			update();
			pump();
		}
	}
	// What the keyboard typed and has not gone yet, in order; the next write waits for the one before and for the gap.
	let queue: Write[] = [], last = 0, wait: ReturnType<typeof setTimeout> | undefined;
	function pump() {
		if (busy || wait || !queue.length) return;
		const due = last + GAP - Date.now();
		if (due > 0) return void (wait = setTimeout(() => ((wait = undefined), pump()), due));
		void send(queue.shift()!);
	}
	/** A keydown in the focused terminal: true when it is the pane's (the caller prevents the browser's default), false for the browser's own. */
	function type(e: KeyboardEvent): boolean {
		if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
		const key = e.key === "Tab" ? (e.shiftKey ? "shift+tab" : "tab") : KEYBOARD[e.key], text = !key && [...e.key].length === 1 ? e.key : undefined;
		if (!key && !text) return false;
		const s = state();
		if (s === "off" || (s === "hidden" && key !== "esc")) return true; // nothing reaches the pane now, and the key does not leak to the page
		if (e.repeat && (queue.length || !["up", "down", "left", "right", "backspace", undefined].includes(key))) return true; // a held key repeats only into an empty queue, and never Enter, Escape, or Tab
		const tail = queue.at(-1);
		if (text && tail && "text" in tail && [...tail.text].length < MAX_TYPED) tail.text += text;
		else queue.push(key ? { key } : { text: text! });
		pump();
		return true;
	}
	function update() {
		const s = state();
		for (const b of buttons) b.disabled = busy || s === "off" || (s === "hidden" && b.dataset.key !== "esc");
	}
	update();
	return { el, update, type };
}
