import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import type { Target } from "./targets.ts";

// The target button at the start of the head's input, and its list (docs/specs/2026-11-24-zen-f.md §5.1, §5.2, §6): the boss's 「@ 挑選這個可以做成放在 input 頭的按鈕，然後可以有一個選擇器，這樣 mobile 才好用」. The button is the chosen target's name and a chevron
// in small ash text, no fill, no frame; it opens a list over a veil (on a phone a column the width of the screen rising from the foot, with the keyboard put away). ↑ ↓ move, Enter picks, Esc closes with nothing changed and the focus back on the
// button, a tap on the veil closes. A filter field tops the list: focused on open on a desktop, shown on a phone only past eight rows and never focused there (it would raise the keyboard). Rows hold a label and at most one state word, never a count.
// Zen and the head page (Standard, Geek) draw the same parts; their stylesheets dress them (zen.css, style.css). The list fades by opacity only, and makes no sound.

export interface TargetIo {
	rows(): Target[];
	/** The chosen target's workspace (`HEAD_KEY` for the head). */
	chosen(): string;
	pick(target: Target): void;
	/** A phone's layout: the list is a column from the foot, the keyboard goes away, the filter is not focused. */
	phone?(): boolean;
	/** The chevron: `⌄`, or Geek's `v`. */
	chevron?: string;
}
const FILTER_ROWS = 8;
export const isPhone = () => Boolean(globalThis.matchMedia?.("(max-width: 600px), (pointer: coarse)").matches);

export function mountTarget(io: TargetIo) {
	const name = h("span", { class: "target-name" }), button = h("button", { type: "button", class: "target-btn", "aria-haspopup": "listbox", "aria-expanded": "false" }, name, h("span", { class: "target-chev", "aria-hidden": "true" }, io.chevron ?? "⌄")) as HTMLButtonElement;
	const find = h("input", { type: "search", class: "target-find", placeholder: m.target_find(), "aria-label": m.target_find(), autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
	const list = h("ul", { class: "target-rows", role: "listbox", tabindex: "-1", "aria-label": m.target_list() });
	const panel = h("div", { class: "target-list", role: "dialog", "aria-label": m.target_list() }, find, list), veil = h("div", { class: "target-veil" }, panel);
	veil.hidden = true;
	let open = false, active = 0, shown: Target[] = [];
	const phone = () => io.phone?.() ?? isPhone();
	function label() {
		const rows = io.rows(), at = rows.find((r) => r.ws === io.chosen()) ?? rows[0];
		const said = at?.label ?? "";
		if (name.textContent !== said) name.textContent = said;
		button.setAttribute("aria-label", m.target_aria({ name: said }));
		button.title = said;
	}
	function draw() {
		const words = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		shown = io.rows().filter((r) => words.every((w) => r.label.toLowerCase().includes(w) || r.ws.toLowerCase().includes(w)));
		active = Math.min(Math.max(0, active), Math.max(0, shown.length - 1));
		list.replaceChildren(...shown.map((r, i) => {
			const li = h("li", { class: "target-row", role: "option", id: `target-${i}`, "aria-selected": String(r.ws === io.chosen()), ...(i === active ? { "data-active": "" } : {}) }, h("span", { class: "target-dot", "aria-hidden": "true" }), h("span", { class: "target-label" }, r.label), ...(r.state ? [h("span", { class: "target-state" }, r.state === "talking" ? m.target_talking() : m.target_working())] : []));
			li.onclick = () => choose(r);
			return li;
		}));
		list.setAttribute("aria-activedescendant", shown.length ? `target-${active}` : "");
	}
	function choose(r: Target) {
		close(false);
		io.pick(r);
		label();
	}
	function show() {
		if (open) return;
		open = true;
		find.value = "";
		active = Math.max(0, io.rows().findIndex((r) => r.ws === io.chosen()));
		draw();
		const small = phone();
		veil.toggleAttribute("data-phone", small);
		find.hidden = small && io.rows().length <= FILTER_ROWS;
		veil.hidden = false;
		button.setAttribute("aria-expanded", "true");
		if (small) (globalThis.document?.activeElement as HTMLElement | null)?.blur?.(); // the keyboard goes away while the list is open
		(small || find.hidden ? list : find).focus?.();
	}
	function close(back = true) {
		if (!open) return false;
		open = false;
		veil.hidden = true;
		list.replaceChildren(); // its rows are drawn again from the net when it opens
		button.setAttribute("aria-expanded", "false");
		if (back) button.focus();
		return true;
	}
	button.onclick = () => (open ? close() : show());
	find.addEventListener("input", () => ((active = 0), draw()));
	veil.addEventListener("click", (e) => e.target === veil && close()); // a tap on the veil, outside the list, closes it
	veil.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.isComposing) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") (e.preventDefault(), (active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length)), draw());
		else if (e.key === "Enter" && shown[active]) (e.preventDefault(), choose(shown[active]!));
		else if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), e.stopPropagation(), close());
	});
	label();
	return {
		button, veil,
		/** The chosen target or the rows changed: the button's name follows. */
		sync: label,
		show, close,
		isOpen: () => open,
	};
}
export type TargetPicker = ReturnType<typeof mountTarget>;
