import { h } from "./dom.ts";
import type { Post, TermState } from "./mirror.ts";
import { m } from "./paraglide/messages.js";

// The key pad under a terminal mirror: one key per tap or keyboard press of its own button, never a sequence and never a repeat, and
// nothing while a key is on its way. The server checks every key again (src/keys.ts) and names the confirm it needs: for Enter when the
// editor holds a command that ends the session, a slash command, or could not be read, and for a second Escape on an idle session.
// While the mirror is hidden for a secret only Escape works; while it is stale, ended, or paused, nothing does.
// On a desktop the keyboard also goes straight to the pane while the terminal has focus (mirror.ts feeds `type`, `text`, and `paste`): the
// pad's keys, Delete, and Ctrl or Alt chords by their key (⌘ stays the browser's, and so do copy and paste off a Mac), characters as typed
// text from an input event (so an input method and dead keys work), and a paste as one paste. Writes go one at a time, at most one every
// 130 ms (the server takes 8 a second per session), and characters typed meanwhile join the next write. A refusal or a confirm drops what
// was still queued. `blip` runs for each thing the keyboard handed the pane, so the terminal can light up.

const ROWS: [string, string, () => string][][] = [
	[["esc", "esc", m.key_escape], ["tab", "tab", m.key_tab], ["up", "↑", m.key_up], ["enter", "enter", m.key_enter]],
	[["shift+tab", "⇧tab", m.key_shift_tab], ["left", "←", m.key_left], ["down", "↓", m.key_down], ["right", "→", m.key_right]],
	[["space", "space", m.key_space], ["backspace", "⌫", m.key_backspace], ["home", "home", m.key_home], ["end", "end", m.key_end], ["pageup", "pgup", m.key_page_up], ["pagedown", "pgdn", m.key_page_down]],
];
const DIGITS = "123456789".split("");
/** The keyboard's keys that are pad keys, by KeyboardEvent.key; Tab is tab or shift+tab. */
const KEYBOARD: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "enter", Escape: "esc", Backspace: "backspace", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown" };
const GAP = 130, MAX_TYPED = 64, MAX_PASTE = 4000;
type Write = { key: string } | { text: string } | { paste: string };
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** "ctrl+d" reads as Ctrl+D. */
const spoken = (key: string) => key.split("+").map((part) => (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))).join("+");

/** The pad of one terminal tile; `update` follows the mirror's state. */
export function keypad({ name, state, post, stream, blip }: { name: string; state(): TermState; post: Post; stream(): string; blip?(): void }) {
	const buttons: HTMLButtonElement[] = [], note = h("p", { class: "pad-note", role: "status" });
	let busy = false;
	const button = ([key, label, spoken]: [string, string, () => string]) => {
		const b = h("button", { type: "button", class: "pad-key", "data-key": key, "aria-label": spoken() }, label);
		b.onclick = (e) => e.isTrusted && (queue.push({ key }), pump()); // a key pressed while one is on its way waits its turn
		buttons.push(b);
		return b;
	};
	const digits = h("details", { class: "pad-digits" }, h("summary", null, "1–9"), h("div", { class: "pad-row" }, ...DIGITS.map((d) => button([d, d, () => d]))));
	const el = h("div", { class: "pad", role: "group", "aria-label": m.keys_for({ name }) }, ...ROWS.map((row) => h("div", { class: "pad-row" }, ...row.map(button))), digits, note);
	const say = (text: string, tone = "") => ((note.dataset.tone = tone), note.replaceChildren(text));
	/** The server's confirm, inline: its reason, then the same key again with the token it named, or nothing. */
	const ask = (key: string, reason: string, token: string) => {
		const yes = h("button", { type: "button", class: "pad-yes" }, key === "enter" ? m.send_enter() : key === "esc" ? m.send_escape() : m.send_key({ key: spoken(key) })), not = h("button", { type: "button", class: "cmp-link" }, m.cancel());
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
	/** A Ctrl or Alt chord as the server names it, or undefined for one that stays the browser's. */
	const chord = (e: KeyboardEvent) => {
		if (e.ctrlKey === e.altKey || e.shiftKey) return undefined; // both, or with Shift: the browser's or the system's
		const mod = e.ctrlKey ? "ctrl" : "alt", letter = /^Key([A-Z])$/.exec(e.code)?.[1]!.toLowerCase(); // the key's letter: Alt on a Mac types å for A
		if (!MAC && mod === "ctrl" && (letter === "v" || (letter === "c" && !getSelection()?.isCollapsed))) return undefined; // paste, and copy of a selection, off a Mac
		return letter ? `${mod}+${letter}` : { Enter: mod === "alt" ? "alt+enter" : undefined, Backspace: mod === "alt" ? "alt+backspace" : undefined, ArrowLeft: `${mod}+left`, ArrowRight: `${mod}+right` }[e.key];
	};
	/** True when the pane may take what the keyboard sends now; a key that cannot go is still kept from the page. */
	const open = (key?: string) => ((s) => s === "live" || (s === "hidden" && key === "esc"))(state());
	/** A keydown in the focused terminal: true when it is the pane's (the caller prevents the browser's default), false for the browser's own. Characters come through `text`. */
	function type(e: KeyboardEvent): boolean {
		if (e.metaKey || e.isComposing || e.key === "Process") return false; // ⌘ is the browser's; an input method is composing
		const key = e.ctrlKey || e.altKey ? chord(e) : e.key === "Tab" ? (e.shiftKey ? "shift+tab" : "tab") : e.key === "Delete" ? "delete" : KEYBOARD[e.key];
		if (!key) return false;
		if (!open(key)) return true; // nothing reaches the pane now, and the key does not leak to the page
		if (e.repeat && (queue.length || !["up", "down", "left", "right", "backspace", "delete"].includes(key))) return true; // a held key repeats only into an empty queue, and never Enter, Escape, Tab, or a chord
		queue.push({ key });
		blip?.();
		pump();
		return true;
	}
	/** A pad key the keyboard names (Backspace or Enter from a soft keyboard's beforeinput), under the same rules as a keydown. */
	function key(name: string) {
		if (!open(name)) return;
		queue.push({ key: name });
		blip?.();
		pump();
	}
	/** Characters the keyboard typed (an input method's too): joined to typed text still queued, in pieces the server takes. */
	function text(typed: string) {
		const chars = [...typed.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")];
		if (!chars.length || !open()) return;
		for (const c of chars) {
			const last = queue.at(-1);
			if (last && "text" in last && [...last.text].length < MAX_TYPED) last.text += c;
			else queue.push({ text: c });
		}
		blip?.();
		pump();
	}
	/** A paste, as one paste (several when it is long). */
	function paste(pasted: string) {
		const chars = [...pasted.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")];
		if (!chars.length || !open()) return;
		for (let i = 0; i < chars.length; i += MAX_PASTE) queue.push({ paste: chars.slice(i, i + MAX_PASTE).join("") });
		blip?.();
		pump();
	}
	function update() {
		const s = state();
		for (const b of buttons) b.disabled = s === "off" || (s === "hidden" && b.dataset.key !== "esc"); // not while a write is on its way: the keys would flicker as you type
	}
	update();
	return { el, update, type, key, text, paste };
}
