import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// The composer's `/` menu. While the box holds only `/` and a name being typed (no space yet), it asks the server for the session's commands
// that match (control.ts, which asks the session's bridge, src/commands.ts) and lists them above the box. ↑ and ↓ move, Enter or Tab puts
// `/name ` in the box, Escape closes, and a click picks one too. An answer for text the box no longer holds is dropped, and a session that did
// not answer shows no menu. Its keys are taken before the composer's own, so Enter on an open menu picks instead of sending.

export interface Cmd { name: string; source: string; description?: string }
/** The name start the box asks about, or undefined when it holds anything but one `/word` being typed. */
export const slashPrefix = (text: string) => /^\/(\S{0,64})$/.exec(text)?.[1];
/** The entry the arrow keys reach from `at` among `n`, wrapping around. */
export const step = (at: number, n: number, by: 1 | -1) => (at + by + n) % n;

export function mountSlash(box: HTMLTextAreaElement, ask: (prefix: string) => Promise<Answer>) {
	const list = h("ul", { class: "slash", id: "slash", role: "listbox", "aria-label": m.commands() });
	let items: Cmd[] = [], at = 0, timer: ReturnType<typeof setTimeout> | undefined;
	box.setAttribute("aria-controls", "slash");
	const open = () => !list.hidden && items.length > 0;
	const close = () => ((items = []), (list.hidden = true), box.removeAttribute("aria-activedescendant"));
	const draw = () => {
		list.replaceChildren(...items.map((c, i) => {
			const li = h("li", { id: `slash-${i}`, role: "option", "aria-selected": String(i === at) }, h("b", null, `/${c.name}`), c.description && h("span", null, c.description));
			li.onmousedown = (e) => e.preventDefault(); // the box keeps the focus
			li.onclick = () => pick(c);
			return li;
		}));
		list.hidden = !items.length;
		if (items.length) (box.setAttribute("aria-activedescendant", `slash-${at}`), list.children[at]?.scrollIntoView({ block: "nearest" }));
	};
	const pick = (c: Cmd) => {
		box.value = `/${c.name} `;
		close();
		box.focus();
		box.dispatchEvent(new Event("input")); // the composer saves, grows, and redraws as for typing
	};
	close();
	box.addEventListener("input", () => {
		const prefix = slashPrefix(box.value), asked = box.value;
		clearTimeout(timer);
		if (prefix === undefined) return close();
		timer = setTimeout(async () => {
			const r = await ask(prefix).catch(() => undefined);
			if (box.value !== asked) return; // typed on meanwhile: the next answer draws
			const got = r?.ok && Array.isArray(r.body.commands) ? (r.body.commands as Cmd[]) : [];
			[items, at] = [got, 0];
			draw();
		}, 120);
	});
	box.addEventListener("blur", close);
	box.addEventListener("keydown", (event) => {
		if (!open() || event.isComposing || event.keyCode === 229) return;
		const k = event.key;
		if (k === "ArrowDown" || k === "ArrowUp") (at = step(at, items.length, k === "ArrowDown" ? 1 : -1)), draw();
		else if ((k === "Enter" && !event.shiftKey) || k === "Tab") pick(items[at]!);
		else if (k === "Escape") close();
		else return;
		event.preventDefault();
		event.stopImmediatePropagation(); // not the composer's Enter, nor its Escape
	});
	return list;
}
