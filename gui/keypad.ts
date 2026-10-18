import { h } from "./dom.ts";
import type { Post, TermState } from "./mirror.ts";

// The key pad under a terminal mirror: one key per tap or keyboard press of its own button, never a sequence and never a repeat, and
// nothing while a key is on its way. The server checks every key again (src/keys.ts) and names the confirm it needs: for Enter when the
// editor holds a command that ends the session, a slash command, or could not be read, and for a second Escape on an idle session.
// While the mirror is hidden for a secret only Escape works; while it is stale, ended, or paused, nothing does.

const ROWS: [string, string, string][][] = [
	[["esc", "esc", "Escape"], ["tab", "tab", "Tab"], ["up", "↑", "Up"], ["enter", "enter", "Enter"]],
	[["shift+tab", "⇧tab", "Shift+Tab"], ["left", "←", "Left"], ["down", "↓", "Down"], ["right", "→", "Right"]],
	[["space", "space", "Space"], ["backspace", "⌫", "Backspace"], ["home", "home", "Home"], ["end", "end", "End"], ["pageup", "pgup", "Page up"], ["pagedown", "pgdn", "Page down"]],
];
const DIGITS = "123456789".split("");

/** The pad of one terminal tile; `update` follows the mirror's state. */
export function keypad({ name, state, post, stream }: { name: string; state(): TermState; post: Post; stream(): string }) {
	const buttons: HTMLButtonElement[] = [], note = h("p", { class: "pad-note", role: "status" });
	let busy = false;
	const button = ([key, label, spoken]: [string, string, string]) => {
		const b = h("button", { type: "button", class: "pad-key", "data-key": key, "aria-label": spoken }, label);
		b.onclick = (e) => e.isTrusted && !busy && void send(key);
		buttons.push(b);
		return b;
	};
	const digits = h("details", { class: "pad-digits" }, h("summary", null, "1–9"), h("div", { class: "pad-row" }, ...DIGITS.map((d) => button([d, d, d]))));
	const el = h("div", { class: "pad", role: "group", "aria-label": `Keys for ${name}` }, ...ROWS.map((row) => h("div", { class: "pad-row" }, ...row.map(button))), digits, note);
	const say = (text: string, tone = "") => ((note.dataset.tone = tone), note.replaceChildren(text));
	/** The server's confirm, inline: its reason, then the same key again with the token it named, or nothing. */
	const ask = (key: string, reason: string, token: string) => {
		const yes = h("button", { type: "button", class: "pad-yes" }, key === "enter" ? "Send Enter" : "Send Escape"), not = h("button", { type: "button", class: "cmp-link" }, "Cancel");
		yes.onclick = (e) => e.isTrusted && !busy && void send(key, token);
		not.onclick = () => say("");
		note.dataset.tone = "ask";
		note.replaceChildren(h("span", null, reason), yes, not);
		not.focus(); // never the confirm: a second Enter, or a held one, on the key that asked must not confirm it
	};
	async function send(key: string, confirmed?: string) {
		busy = true;
		update();
		say("");
		try {
			const r = await post("keys", { key, stream: stream(), ...(confirmed ? { confirmed } : {}) });
			if (r.status === 409 && r.body.error === "confirm" && typeof r.body.confirm === "string") ask(key, String(r.body.reason ?? ""), r.body.confirm);
			else if (!r.ok) say(r.body.reason ?? `Refused (${r.status}).`, "error");
		} catch {
			say("The server could not be reached.", "error");
		} finally {
			busy = false;
			update();
		}
	}
	function update() {
		const s = state();
		for (const b of buttons) b.disabled = busy || s === "off" || (s === "hidden" && b.dataset.key !== "esc");
	}
	update();
	return { el, update };
}
