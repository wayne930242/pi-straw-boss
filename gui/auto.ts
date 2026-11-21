import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import { type Answer, post } from "./post.ts";

// A staged request to start auto mode (`/boss auto on` or any `auto-on` over the socket; the head's `boss_auto` switches at once since docs/specs/2026-11-21-auto-return.md, AR-D1), as the page shows it (docs/specs/2026-11-09-auto-mode.md, sections 2 and 7; D9): while the net snapshot carries a pending record (`net.auto.pending`), the head page and Zen's strip show one
// button, 「確認進入自動模式」, that confirms it by its id. The id and the words are the server's; the page decides nothing: a tap on a record that lapsed or was replaced gets the server's refusal. Nothing here switches auto mode on by itself.
// Phase 2 (task 5b): the header chip that holds the switch (`mountAutoSwitch`). Off, one tap arms it and says what starting does (the sentence is the confirm); the second tap posts `on`. On, one tap posts `off`, and the page is told so the
// return panel (autoback.ts) can open. The state is the snapshot's: the chip draws what `net.auto` says, and the answer of a post only moves it a moment earlier.

/** How long the second tap of an arming chip may wait before the chip goes back to off. */
export const ARM_MS = 6000;
/** The seam a test replaces: the page's post. */
export const io = { post: (path: string, body: Record<string, unknown>): Promise<Answer> => post(path, body) };

type Opts = { locale?: "en" | "zh-TW" };
/** The request waiting for the boss in this snapshot; the server leaves a lapsed one out. */
export const pendingOf = (net: Net | undefined) => net?.auto?.pending;

const failure = (r: Answer, o?: Opts) => (r.body.error === "stale" ? m.auto_stale({}, o) : r.body.reason ?? (r.status ? m.refused({ status: r.status }, o) : m.no_answer({}, o)));

/** Fills `box` (a `div` the page keeps for it): hidden with no pending request, else the words the boss said, the button, and the line a refusal reads in. Rebuilt only when the request changes, so a tap in flight keeps its button. */
export function fillAuto(box: HTMLElement, net: Net | undefined, o?: Opts): void {
	const pending = pendingOf(net);
	box.hidden = !pending;
	if (!pending) return void (delete box.dataset.id, box.replaceChildren());
	if (box.dataset.id === pending.id) return;
	box.dataset.id = pending.id;
	const note = h("p", { class: "auto-note", role: "alert" }), button = h("button", { type: "button", class: "auto-confirm" }, m.auto_confirm_button({}, o));
	button.onclick = async () => {
		button.disabled = true;
		note.textContent = "";
		const r = await io.post("auto/confirm", { id: pending.id }).catch(() => ({ ok: false, status: 0, body: {} }) as Answer);
		if (r.ok) return void (note.textContent = m.auto_confirmed({}, o));
		button.disabled = false;
		note.textContent = failure(r, o);
	};
	box.replaceChildren(h("p", { class: "auto-title" }, m.auto_confirm_title({}, o)), h("p", { class: "auto-said" }, m.auto_confirm_said({ said: pending.said }, o)), button, note);
}

/** The clock time of an ISO moment on this device, `23:10`: the chip says since when auto mode runs. */
export const clockOf = (iso: string | undefined): string => {
	const at = iso ? new Date(iso) : undefined;
	return at && !Number.isNaN(at.getTime()) ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "?";
};

interface SwitchOpts extends Opts {
	/** Told after an `off` the server took: the page is back, and its return list is ready. */
	after?(off: boolean): void;
	/** The page's timers; a test brings its own clock. */
	timers?: { set(run: () => void, ms: number): unknown; clear(id: unknown): void };
}
/** The header chip and its switch, in `box` (the page's `#auto-sw`). Returns what the page calls with each snapshot. */
export function mountAutoSwitch(box: HTMLElement, o: SwitchOpts = {}): { net(net: Net | undefined): void } {
	const timers = o.timers ?? { set: (run, ms) => globalThis.setTimeout(run, ms), clear: (id) => globalThis.clearTimeout(id as number) };
	// `data-menu-keep`: a tap on the chip in a phone's ⋯ drawer arms it, and the drawer stays open to show the sentence it asks the second tap to confirm (menu.ts).
	const chip = h("button", { type: "button", class: "pair-btn tog auto-chip", "data-state": "off", "data-menu-keep": "" }), note = h("small", { class: "auto-sw-note", role: "alert" });
	let on: { since?: string } | undefined, arming: unknown, busy = false;
	const disarm = () => (arming !== undefined && timers.clear(arming), (arming = undefined));
	const draw = () => {
		const state = on ? "on" : arming !== undefined ? "arming" : "off";
		chip.dataset.state = state;
		chip.setAttribute("aria-pressed", String(Boolean(on)));
		chip.title = on ? m.auto_chip_title_on({}, o) : m.auto_chip_title_off({}, o);
		chip.textContent = on ? m.auto_chip_on({ time: clockOf(on.since) }, o) : arming !== undefined ? m.auto_arm({}, o) : m.auto_chip_off({}, o);
		chip.disabled = busy;
	};
	const send = async (want: boolean) => {
		busy = true;
		note.textContent = "";
		draw();
		const r = await io.post("auto", { on: want }).catch(() => ({ ok: false, status: 0, body: {} }) as Answer);
		busy = false;
		if (!r.ok) return (note.textContent = failure(r, o), draw());
		on = want ? { since: typeof r.body.since === "string" ? r.body.since : new Date().toISOString() } : undefined;
		draw();
		if (!want) o.after?.(true);
	};
	chip.onclick = () => {
		if (busy) return;
		if (on) return void send(false);
		if (arming === undefined) {
			note.textContent = "";
			arming = timers.set(() => ((arming = undefined), draw()), ARM_MS);
			return draw();
		}
		disarm();
		void send(true);
	};
	chip.addEventListener("keydown", (e: KeyboardEvent) => e.key === "Escape" && arming !== undefined && (disarm(), draw()));
	box.replaceChildren(chip, note);
	box.hidden = true; // until a snapshot says this server can switch auto mode (a secondary slot's or an unattended device's cannot)
	draw();
	return { net(net) { box.hidden = !net?.auto && !net?.autoable; on = net?.auto?.on ? { ...(net.auto.since ? { since: net.auto.since } : {}) } : undefined; if (on) disarm(); draw(); } };
}
