import type { RunDialog } from "../src/net.ts";
import { outcome, runDialogActions } from "./asks.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import type { Answer } from "./post.ts";

// The answer of Zen's run card (docs/specs/2026-11-24-zen-f.md §2.3): a dialog a headless run waits on, on this computer's page only. An approval or a confirm is two buttons (Allow / Deny, Yes / No), a select its options as Zen's choice rows (a hollow
// dot, filled when chosen) and Send, an input a hairline field and Send; every one has Cancel (the run gets `cancelled`; for an approval it is Deny). Each press is `runDialogActions` (asks.ts), the call Standard's row makes, and Zen's `wrap` turns the
// reply into the knock or the low bowl. The dialog's words are data: text nodes only. An approval's arguments are the confirm card's style: every line shown, dim monospace on the tint, no box.

export interface RunPanel { el: HTMLElement; sending(): boolean; update(live: boolean): void; /** The primary control takes the focus (Allow, Yes, the first option, the field), so the next fresh Enter presses it; false when none can. */ enter(): boolean; /** The card's Cancel; false while it cannot be pressed. */ cancel(): boolean }

export function runPanel(d: RunDialog, wrap: (reply: Promise<Answer>) => Promise<Answer>, send?: Parameters<typeof runDialogActions>[2]): RunPanel {
	const acts = runDialogActions(d, undefined, send), note = h("p", { class: "zen-head-note", role: "alert" });
	let live = true, busy = false, done = false, chosen: string | undefined;
	const lead: HTMLElement[] = [];
	if (d.message) lead.push(d.approval ? h("pre", { class: "link-args zen-args", "aria-label": m.zen_run_args() }, d.message) : h("p", { class: "zen-run-text" }, d.message));
	const button = (label: string, run: () => Promise<Answer>, cls = "pair-btn") => Object.assign(h("button", { type: "button", class: cls }, label) as HTMLButtonElement, { run });
	const cancel = button(m.run_dialog_cancel(), acts.cancel, "cmp-link zen-run-cancel");
	let field: HTMLTextAreaElement | undefined, options: HTMLButtonElement[] = [], primary: (HTMLButtonElement & { run(): Promise<Answer> })[] = [];
	if (d.method === "confirm") primary = d.approval ? [button(m.zen_run_allow(), acts.yes), button(m.zen_run_deny(), acts.no)] : [button(m.run_dialog_yes(), acts.yes), button(m.run_dialog_no(), acts.no)];
	else if (d.method === "select") {
		options = (d.options ?? []).map((o) => {
			const b = h("button", { type: "button", class: "ask-opt zen-run-opt", role: "radio", "aria-checked": "false" }, h("span", { class: "ask-opt-label" }, o)) as HTMLButtonElement;
			b.onclick = () => ((chosen = o), options.forEach((x) => x.setAttribute("aria-checked", String(x === b))), draw(), primary[0]?.focus()); // chosen: Send has the focus, so the next Enter sends it
			return b;
		});
		primary = [button(m.run_dialog_send(), () => acts.value(chosen!))];
	} else {
		field = h("textarea", { class: "zen-head-box zen-run-input", rows: "1", maxlength: "4000", "aria-label": d.title, enterkeyhint: "send" }) as HTMLTextAreaElement;
		field.addEventListener("input", () => (say(""), draw()));
		field.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return; // Shift+Enter is a new line, the IME's Enter is the IME's
			e.preventDefault();
			void press(primary[0]!);
		});
		primary = [button(m.run_dialog_send(), () => acts.value(field!.value))];
	}
	const say = (text: string, tone = "error") => ((note.textContent = text), (note.dataset.tone = text ? tone : ""));
	const ready = (b: HTMLButtonElement) => (d.method === "select" && b === primary[0] ? chosen !== undefined : d.method !== "confirm" && b === primary[0] ? Boolean(field?.value.trim()) : true);
	function draw() {
		for (const b of [...primary, cancel]) b.disabled = !live || busy || done || !ready(b);
		for (const o of options) o.disabled = !live || busy || done;
		if (field) field.disabled = !live || done;
	}
	async function press(b: HTMLButtonElement & { run(): Promise<Answer> }) {
		if (busy || done || !live || !ready(b)) return;
		busy = true;
		say("");
		draw();
		try {
			const r = await wrap(b.run());
			if (outcome(r) === "accepted") (done = true), say(m.answered(), "ok");
			else say(String(r.body.reason ?? r.body.error ?? m.refused({ status: r.status })));
		} catch {
			say(m.zen_head_unreachable());
		}
		busy = false;
		draw();
	}
	for (const b of [...primary, cancel]) b.onclick = () => void press(b);
	draw();
	const el = h("div", { class: "wait-panel zen-decide zen-run", "data-method": d.method, ...(d.approval ? { "data-approval": "" } : {}) }, ...lead, ...(options.length ? [h("div", { class: "ask-opts zen-run-opts", role: "radiogroup", "aria-label": d.title }, ...options)] : []), ...(field ? [field] : []), h("div", { class: "zen-decide-acts" }, ...primary, cancel), note);
	return {
		el,
		sending: () => busy,
		update: (on) => ((live = on), draw()),
		enter: () => {
			const first = field && !field.disabled ? field : options.find((o) => !o.disabled) ?? primary.find((b) => !b.disabled);
			return Boolean(first && (first.focus(), true));
		},
		cancel: () => (cancel.disabled ? false : (cancel.click(), true)),
	};
}
