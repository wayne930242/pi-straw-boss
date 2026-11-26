import type { Net } from "../src/net.ts";
import { can } from "./boxmodel.ts";
import { type StepEvent, stepRule } from "./cardmodel.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import { locate } from "./scene.ts";
import type { StepOpen } from "./terminalthen.ts";
import { termHold } from "./towerturns.ts";
import { ESC_MS, termStep } from "./zenkeys.ts";
import { type Done, draw, type Layer, type Open } from "./zenhost.ts";
import type { Term, TermKit } from "./zentypes.ts";

// The terminal step inside Zen (docs/specs/2026-11-01-zen-view.md, A terminal in Zen; 2026-11-02-terminal-card.md): one layer over the screen that was there, holding the terminal card an accepted answer leaves or the full terminal (zenhost.ts); this file gives
// them ink and a host. The boss closes it with the button, or Esc Esc with the focus outside the terminal. When its step is over by its rule (cardmodel.ts `stepRule`: a prompt's own Enter taken, a pane gone, an armed terminal's unit at work; a mark alone never ends a prompt's) the bar says so, and after
// `DRIFT_MS` the layer fades for `FADE_MS` and Zen breathes again (boss 2026-11-26: 「輸入完指令，應該逐漸恢復到呼吸」). A tap, a key, or a wheel in the layer during that time keeps it until the boss goes back (Z-D20, 「永遠不要打斷」: never pulled from under his hands).

export interface ZenTermDeps {
	/** The page's terminals, behind the overlay chunk (fetched on the first call). */
	terminals(): Promise<TermKit>;
	now(): number;
	later(fn: () => void, ms: number): () => void;
	/** What lies under the layer takes no focus and no tab while it is on. */
	inert(on: boolean): void;
	/** The layer went away by the button, Esc Esc, or its own end: Zen has the page again. */
	closed(): void;
}
const isPane = (key: string) => key.startsWith("grant:");
/** How long the bar's line shows after the step is over, then how long the layer takes to fade back to Zen. */
export const DRIFT_MS = 2500, FADE_MS = 1500;

export function mountZenTerm(root: HTMLElement, deps: ZenTermDeps) {
	let cur: Open | undefined, escAt: number | undefined, stopEsc = () => {};
	const clearEsc = () => (stopEsc(), (stopEsc = () => {}), (escAt = undefined), cur && (delete cur.hint.dataset.on, (cur.hint.textContent = "")));
	const SAID: Record<Done, () => string> = { taken: m.zen_term_sent, working: m.zen_term_working, gone: m.zen_term_gone };
	/** The step is over: a quiet line in the bar, and a card in the layer is put out (its Enter would only send another); then the layer drifts back to Zen unless the boss touches it. */
	function finish(c: Open, why: Done) {
		if (c !== cur || c.done) return;
		c.done = why;
		c.note.textContent = SAID[why]();
		c.layer.dataset.done = why;
		if (c.card) (c.card.el.contains(document.activeElement) && c.back.focus(), c.card.el.setAttribute("inert", "")); // the keyboard is not left on a button that went inert
		let stop = deps.later(() => {
			if (c !== cur) return;
			c.layer.dataset.leaving = "";
			stop = deps.later(() => c === cur && close(), FADE_MS);
		}, DRIFT_MS);
		c.stay = () => (stop(), delete c.layer.dataset.leaving, (c.stay = undefined));
	}
	/** The layer goes and its terminal is let go; whether Zen is told is the caller's. */
	let last: Net | undefined; // the newest snapshot, for the card's box fact
	function drop() {
		if (!cur) return false;
		const c = cur;
		cur = undefined;
		clearEsc();
		c.stay?.();
		c.off?.();
		if (c.layer.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); // the button that was pressed goes with the layer: the focus is free for the card
		c.layer.remove();
		return true;
	}
	function close() {
		if (!drop()) return;
		deps.inert(false);
		deps.closed();
	}
	/** What the host's content asks of the layer. A step's rule (cardmodel.ts) says when the step is over; the layer then says so and stays. */
	const on: Layer = { live: (c) => c === cur, close, done: finish, step: (c: Open, e: StepEvent) => void (c === cur && c.kind !== "plain" && stepRule(c.kind, e) === "close" && finish(c, e.type === "taken" ? "taken" : e.type === "mark" ? "working" : "gone")) };
	/** A snapshot reached the layer: the unit's name, a tower's held sentence, and an armed terminal's first work. */
	function follow(net: Net | undefined) {
		last = net;
		const c = cur;
		if (!c) return;
		const hit = locate(net, c.asker ?? c.key);
		c.name = c.asker && hit ? hit.u.name : c.name;
		c.held = isPane(c.key) ? undefined : termHold(locate(net, c.key)?.u.service);
		draw(c, on);
		const mark = locate(net, c.key)?.u.mark;
		if (c.kind === "armed" && mark && !isPane(c.key)) on.step(c, { type: "mark", mark });
	}
	function mount(c: Open, net: Net | undefined) {
		last = net;
		drop();
		c.back.onclick = close;
		cur = c;
		root.append(c.layer);
		deps.inert(true);
		void deps.terminals().then((k) => c === cur && ((c.kit = k), follow(net)));
		if (!globalThis.matchMedia?.("(pointer: fine)").matches) c.back.focus(); // a phone's keyboard comes with the terminal's own button: the focus goes into the layer now, where the card's button it came from has gone inert
	}
	const fresh = (key: string, name: string, kind: Open["kind"], mode: Open["mode"], extra: Partial<Open> = {}): Open => {
		const back = h("button", { type: "button", class: "zen-term-back" }, m.zen_back_title()), host = h("div", { class: "zen-term-host" }), hint = h("p", { class: "zen-term-esc", role: "status", "aria-live": "polite" });
		const note = h("p", { class: "zen-term-note", role: "status", "aria-live": "polite" }); // the quiet line after the step is over
		const layer = h("section", { class: "zen-term", "data-mode": mode, "aria-label": m.terminal_title({ name }) }, h("header", { class: "zen-term-bar" }, h("h2", { class: "zen-who" }, name), back, note), host, hint);
		const c: Open = { name, key, kind, mode, layer, host, hint, note, back, ...extra };
		for (const type of ["pointerdown", "keydown", "wheel"]) layer.addEventListener(type, () => c.stay?.(), { capture: true, passive: true }); // the boss is using the layer: it stays (Z-D20)
		return c;
	};
	return {
		isOpen: () => cur !== undefined,
		/** The terminal card of a step an accepted answer left (a prompt's or a pane's), replacing the layer on show. */
		step(s: StepOpen, net: Net | undefined) {
			const name = locate(net, s.asker)?.u.name ?? s.asker;
			mount(fresh(s.key, name, s.kind, "card", { command: s.command, asker: s.asker, run: s.run, away: () => !can(locate(last, s.asker)?.base, "input") }), net);
		},
		/** The full terminal of `t.key` (a session's, or a pane an answer opened: `grant:<id>`), or the one on show brought forward. `armed`: the unit waits on this terminal now, so its next work ends the step. */
		terminal(t: Term, net: Net | undefined) {
			if (cur?.key === t.key && cur.mode === "full") return;
			const pane = isPane(t.key);
			mount(fresh(t.key, pane ? m.pane_name() : (locate(net, t.key)?.u.name ?? t.key), t.armed ? "armed" : pane ? "pane" : "plain", "full"), net);
		},
		/** A snapshot: the name, a tower's held sentence, and an armed terminal's first work. */
		follow,
		close,
		/**
		 * Escape while the layer is on: the terminal's own while its keyboard sink has the focus and its pad can take the key (false: not taken, not prevented, so pi and vim get it), else Zen's two-press return. Shift+Esc in the sink (mirror.ts) lets the sink go. True when the key was the layer's.
		 */
		escape(e: { preventDefault(): void; repeat?: boolean }) {
			if (!cur) return false;
			const at = document.activeElement as HTMLElement | null, sink = Boolean(at && cur.host.contains(at) && (at.getAttribute?.("class") ?? "").split(" ").includes("term-sink")), typing = sink && at?.dataset?.pad !== "off"; // a dead terminal (stale, ended, paused) takes no Esc: it is the layer's
			const step = termStep({ typing, armed: escAt !== undefined && deps.now() - escAt < ESC_MS, repeat: e.repeat });
			if (step === "pass") return false;
			e.preventDefault();
			if (step === "leave") close();
			else if (step === "hint") {
				clearEsc();
				escAt = deps.now();
				const { hint } = cur;
				hint.textContent = m.zen_term_esc_hint();
				hint.dataset.on = "";
				const fade = deps.later(() => delete hint.dataset.on, ESC_MS), gone = deps.later(clearEsc, ESC_MS + 400); // the line fades as the window closes (zen.css), and its words go after
				stopEsc = () => (fade(), gone());
			}
			return true;
		},
	};
}
