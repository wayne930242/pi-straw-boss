import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import type { Switch } from "./notify.ts";

// Zen's corner menu: one quiet button that opens a small panel of the settings a page in Zen would otherwise have to leave for (language, sound effects, background sound, the way out of Zen). Every row
// calls what the settings page calls, so the two never disagree. The theme is the settings page's alone: one picked here would show only after leaving, which reads as a broken pick (docs/specs/2026-11-26-storybook-theme/spec.md O4).
// It opens only on a press of its button (a click, a tap, Enter, or Space), never on hover, and takes the focus inside. It closes on Esc,
// a second press of the button, a press outside, and a choice of language or the way out (the sound switches and volumes stay, so a volume can be set after its switch).

export interface MenuDeps {
	language?: { get(): string; names(): { id: string; name: string }[]; set(id: string): void };
	/** The two sound classes as the settings page has them (notify.ts). `all` is the effects' Try button: Zen's three effects in turn. */
	sound?: { effects: Switch & { all?(): void }; background: Switch };
}
export function mountMenu(deps: MenuDeps, leave: () => void) {
	const button = h("button", { type: "button", class: "zen-menubtn", "aria-haspopup": "true", "aria-expanded": "false", "aria-label": m.zen_menu(), title: m.zen_menu() }, "…");
	const panel = h("div", { class: "zen-menu", role: "group", "aria-label": m.zen_menu(), hidden: "" }), host = h("div", { class: "zen-menuhost" }, button, panel);
	const redraw: (() => void)[] = [], controls: HTMLElement[] = [];
	const row = (label: string, ...ctl: HTMLElement[]) => (controls.push(...ctl), h("div", { class: "zen-row" }, h("span", { class: "zen-rowlab" }, label), h("span", { class: "zen-ctl" }, ...ctl)));
	const pick = (text: string, pressed: () => boolean, run: () => void) => {
		const b = h("button", { type: "button", class: "zen-opt" }, text);
		b.onclick = () => (run(), close()); // a choice is made: the menu has done its work
		redraw.push(() => b.setAttribute("aria-pressed", String(pressed())));
		return b;
	};
	const { language, sound } = deps;
	if (language) panel.append(row(m.language(), ...language.names().map((l) => pick(l.name, () => language.get() === l.id, () => language.set(l.id)))));
	if (sound) {
		// One class: its switch, then its volume. A volume's release plays the class's sample (the effects' bowl; Background has none), the switch of another tab redraws an open panel.
		const strip = (label: string, cls: Switch, extra: HTMLElement[] = []) => {
			const on = h("button", { type: "button", class: "zen-opt" }), vol = h("input", { type: "range", min: "0", max: "100", step: "5", "aria-label": `${label}: ${m.sound_volume()}` }) as HTMLInputElement;
			const draw = () => ((on.textContent = cls.on() ? m.state_on() : m.state_off()), on.setAttribute("aria-pressed", String(cls.on())), (vol.value = String(cls.volume())));
			on.onclick = () => (cls.set(!cls.on()), draw());
			vol.oninput = () => cls.setVolume(Number(vol.value));
			vol.onchange = () => cls.try();
			redraw.push(draw), cls.onChange(() => open && draw());
			panel.append(row(label, on, ...extra), row(m.sound_volume(), vol));
		};
		const eff = sound.effects.all, tryBtn = eff && h("button", { type: "button", class: "zen-opt" }, m.zen_try());
		if (tryBtn) tryBtn.onclick = () => eff();
		strip(m.sound_effects(), sound.effects, tryBtn ? [tryBtn] : []);
		strip(m.sound_background(), sound.background);
	}
	const away = h("button", { type: "button", class: "zen-leave" }, m.zen_leave_title());
	away.onclick = () => (leave(), close());
	controls.push(away);
	panel.append(h("div", { class: "zen-row" }, away), h("div", { class: "zen-music", hidden: "" })); // the music rows (on or off, track, the catalogue) take this slot in Z6
	let open = false;
	const show = () => {
		[open, panel.hidden] = [true, false];
		button.setAttribute("aria-expanded", "true");
		redraw.forEach((r) => r());
		controls[0]?.focus();
	};
	function close() {
		if (!open) return false;
		const inside = host.contains(document.activeElement);
		[open, panel.hidden] = [false, true];
		button.setAttribute("aria-expanded", "false");
		if (inside) button.focus();
		return true;
	}
	button.onclick = () => (open ? close() : show());
	host.addEventListener("keydown", (e) => {
		const k = e as unknown as KeyboardEvent;
		if (k.key === "Escape" && open) (k.preventDefault(), k.stopPropagation?.(), close());
		else if (k.key === "Tab" && open && controls.length) {
			const at = controls.indexOf(document.activeElement as HTMLElement), to = k.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : at < 0 || at === controls.length - 1 ? 0 : at + 1;
			k.preventDefault();
			controls[to]!.focus();
		}
	});
	document.addEventListener("pointerdown", (e) => open && (e.target === host || !host.contains(e.target as Node | null)) && close()); // the host itself is the veil it draws (zen.css), which takes the press
	return { el: host, button, isOpen: () => open, close };
}
