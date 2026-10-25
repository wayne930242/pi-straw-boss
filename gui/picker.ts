import { createPicker, type Key, type Listing } from "./folders.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The folder picker the opening tiles share (spawn.ts): Finder's column view over the server's folders (folders.ts holds its state). A toolbar with back and
// forward, the breadcrumb, and New folder; shortcuts on the left (home, Desktop, Documents, and the folders the open bases work in); one column per level
// of the selected folder, scrolling sideways when it is deep, with the arrow keys moving between them; and the selected folder's real path below. A narrow
// window shows the last column only, with the breadcrumb and shortcuts to go up (style.css).

const KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]);
interface Places { home: string; places: { name: string; path: string }[]; recent: string[] }
const refusal = (r: { status: number; body: { reason?: string } }) => new Error(r.body.reason ?? m.refused({ status: r.status }));

/** `start` names where the picker opens (a base's own folder, by `workspace` and `tab`; home when empty). `changed` hears each selected folder, `chosen` an Enter on one. */
export function folderPicker(start: Record<string, unknown>, changed: (path: string, home: string) => void, chosen: () => void) {
	const picker = createPicker({
		list: async (path) => {
			const r = await post("dirs", path ? { path } : start).catch(() => Promise.reject(new Error(m.no_answer())));
			return r.ok ? (r.body as unknown as Listing) : Promise.reject(refusal(r));
		},
		make: async (path, name) => {
			const r = await post("dirs/new", { path, name }).catch(() => Promise.reject(new Error(m.no_answer())));
			return r.ok ? (r.body.path as string) : Promise.reject(refusal(r));
		},
	});
	const back = h("button", { type: "button", class: "later", "aria-label": m.picker_back(), title: m.picker_back() }, "←"), forward = h("button", { type: "button", class: "later", "aria-label": m.picker_forward(), title: m.picker_forward() }, "→");
	const crumbs = h("nav", { class: "picker-crumbs", "aria-label": m.picker_path() }), make = h("button", { type: "button", class: "later" }, `＋ ${m.new_folder()}`);
	const made = h("input", { type: "text", maxlength: "255", placeholder: m.new_folder_name(), "aria-label": m.new_folder_name() }) as HTMLInputElement;
	const places = h("div", { class: "picker-places", role: "group", "aria-label": m.picker_places() }), cols = h("div", { class: "picker-cols", tabindex: "0", role: "group", "aria-label": m.picker_label() });
	const where = h("code", { class: "spawn-path" }), note = h("p", { class: "chat-empty", role: "status" });
	made.hidden = true;
	let shown: string | undefined;
	const draw = () => {
		const s = picker.state();
		[back.disabled, forward.disabled] = [!s.back, !s.forward];
		crumbs.replaceChildren(...s.crumbs.map((c, i) => {
			const b = h("button", { type: "button", "aria-current": String(i === s.crumbs.length - 1) }, c.name || m.picker_home());
			[b.title, b.onclick] = [c.name || c.path, () => void picker.go(c.path)];
			return b;
		}));
		cols.replaceChildren(...s.cols.map((col, i) => {
			const items = col.dirs.map((name) => {
				const b = h("button", { type: "button", class: "pitem", role: "option", tabindex: "-1", "aria-selected": String(col.pick === name), title: name }, name);
				b.onclick = () => (cols.focus(), void picker.pick(i, name));
				return b;
			});
			const el = h("div", { class: "pcol", role: "listbox", "data-focus": String(i === s.focus) }, ...items, !col.dirs.length && h("p", { class: "pempty" }, m.folder_empty()), col.truncated && h("p", { class: "pempty" }, m.folder_cut()));
			const lit = items.find((b) => b.getAttribute("aria-selected") === "true");
			if (lit) requestAnimationFrame(() => (el.scrollTop = Math.max(0, lit.offsetTop - el.clientHeight / 2)));
			return el;
		}));
		requestAnimationFrame(() => ([cols.scrollLeft, crumbs.scrollLeft] = [cols.scrollWidth, crumbs.scrollWidth])); // the newest column in view; the scroll itself is CSS's (smooth, unless motion is reduced)
		where.textContent = where.title = s.path ?? "";
		note.textContent = s.error ?? "";
		if (s.path !== undefined && s.path !== shown) changed((shown = s.path), s.home);
	};
	picker.on(draw);
	back.onclick = () => void picker.back();
	forward.onclick = () => void picker.forward();
	// A new folder is made inside the selected one and selected at once: the folder the unit will work in, named in the line below.
	const create = () => {
		if (made.hidden) return void ((made.hidden = false), made.focus());
		void picker.make(made.value).then(() => {
			if (picker.state().error) return;
			made.value = "";
			made.hidden = true;
			cols.focus();
		});
	};
	make.onclick = create;
	made.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), create()));
	made.addEventListener("keydown", (event) => event.key === "Escape" && made.value === "" && !made.hidden && (event.stopPropagation(), (made.hidden = true), cols.focus()));
	cols.addEventListener("keydown", (event) => {
		if (!KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		event.preventDefault();
		void picker.key(event.key as Key).then((r) => r === "chosen" && chosen());
	});
	void post("dirs/places", {}).then((r) => {
		if (!r.ok) return;
		const found = r.body as unknown as Places, button = (label: string, path: string) => {
			const b = h("button", { type: "button", title: path }, label);
			b.onclick = () => void picker.go(path);
			return b;
		};
		const named = (n: string) => found.places.find((p) => p.name === n);
		places.replaceChildren(button(m.picker_home(), found.home), ...(["Desktop", "Documents"] as const).flatMap((n) => ((p) => (p ? [button(n === "Desktop" ? m.picker_desktop() : m.picker_documents(), p.path)] : []))(named(n))), ...(found.recent.length ? [h("b", null, m.picker_recent()), ...found.recent.map((path) => button(path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1), path))] : []));
	}, () => {});
	void picker.start();
	return { picker, el: h("div", { class: "picker" }, h("div", { class: "picker-bar" }, back, forward, crumbs, make), made, h("div", { class: "picker-body" }, places, cols), h("p", { class: "spawn-at" }, m.folder_here(), " ", where), note) };
}
