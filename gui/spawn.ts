import { deployPanel } from "./deploy.ts";
import { h } from "./dom.ts";
import { child, leaf } from "./folders.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The opening tiles, their own small chunk. A new base (a folder picker from home, a name, a first message) opens with one member and no tower; a
// base without a tower takes members, one with a tower takes mains (spawn.ts on the server holds the same rules). A member added to a squad opens
// beside its main in that folder, so its tile has no picker; the others pick a folder that starts in the base's own and stays inside home; `enter` closes the tile and goes to the session that opened.

interface Listing { path: string; home: string; sep: string; parent: string | null; dirs: string[]; truncated: boolean }
interface Base { id: string; label: string }
export type Opening = { kind: "base" } | { kind: "main" | "member"; base: Base; tab?: { id: string; label: string } };

export function spawnTile(o: Opening, enter?: (ws: string, key: string, tile: string) => void, chime?: () => void): Tile {
	const base = o.kind === "base" ? undefined : o.base, tab = o.kind === "base" ? undefined : o.tab;
	const title = o.kind === "base" ? m.open_base_title() : o.kind === "main" ? m.open_main_title({ base: base!.label }) : tab ? m.open_member_tab_title({ tab: tab.label }) : m.open_member_title({ base: base!.label }), id = `open-${o.kind}-${base?.id ?? ""}-${tab?.id ?? ""}`;
	return { id, title, body: () => {
		const where = h("code", { class: "spawn-path" }), up = h("button", { type: "button", class: "later" }, m.folder_up());
		const list = h("div", { class: "spawn-dirs" }), made = h("input", { type: "text", maxlength: "255", placeholder: m.new_folder_name() }) as HTMLInputElement, make = h("button", { type: "button", class: "later" }, m.new_folder()), note = h("p", { class: "chat-empty" });
		const go = h("button", { type: "button", class: "go" }, o.kind === "base" ? m.open_base_go() : o.kind === "main" ? m.open_main_go() : m.open_member_go());
		const prompt = h("textarea", { rows: "3", placeholder: m.first_prompt() }) as HTMLTextAreaElement, name = h("input", { type: "text", maxlength: "64", placeholder: m.base_name() }) as HTMLInputElement;
		let at: Listing | undefined, named = false; // the base name follows the folder until it is typed
		name.addEventListener("input", () => (named = true));
		made.hidden = true;
		const say = (text: string) => (note.textContent = text);
		const show = (path?: string) => {
			say(m.asking_dirs());
			void post("dirs", path ? { path } : base ? { workspace: base.id, ...(tab && { tab: tab.id }) } : {}).then((r) => {
				if (!r.ok) return say(r.body.reason ?? m.refused({ status: r.status }));
				at = r.body as unknown as Listing;
				where.textContent = where.title = at.path; // the real folder, which is where the unit will work
				up.disabled = !at.parent;
				list.replaceChildren(...at.dirs.map((dir) => {
					const b = h("button", { type: "button", class: "spawn-dir" }, `${dir}/`);
					b.onclick = () => show(`${at!.path}/${dir}`);
					return b;
				}));
				if (!named) name.value = leaf(at.path, at.home);
				say(at.dirs.length ? (at.truncated ? m.folder_cut() : "") : m.folder_empty());
			}, () => say(m.no_answer()));
		};
		up.onclick = () => at?.parent && show(at.parent);
		// A new folder is made inside the one shown and shown at once: it becomes the folder the unit works in, and the base's name follows it.
		const create = () => {
			if (!at) return;
			if (made.hidden) return void ((made.hidden = false), made.focus());
			void post("dirs/new", { path: at.path, name: made.value }).then((r) => {
				if (!r.ok) return say(r.body.reason ?? m.refused({ status: r.status }));
				made.value = "";
				made.hidden = true;
				named = false;
				show(r.body.path as string);
			}, () => say(m.no_answer()));
		};
		make.onclick = create;
		made.addEventListener("keydown", (event) => event.key === "Enter" && (event.preventDefault(), create()));
		go.onclick = () => {
			if (!at) return;
			const dir = at.path, text = prompt.value, label = name.value.trim() || dir.slice(dir.lastIndexOf("/") + 1), body = o.kind === "base" ? { dir, label: name.value, prompt: text } : { workspace: base!.id, ...(tab && { tab: tab.id }), dir, prompt: text };
			// The form gives way to the deploy panel while the unit opens; a failure's Back brings the form back as it was.
			root.replaceChildren(deployPanel({
				kind: o.kind, split: o.kind === "member" && Boolean(tab), hasPrompt: Boolean(text.trim()), name: o.kind === "base" ? label : dir.slice(dir.lastIndexOf("/") + 1) || dir, chime,
				open: (deploy) => post(`open/${o.kind}`, { ...body, deploy }),
				progress: (deploy) => post("open/progress", { id: deploy }),
				back: () => root.replaceChildren(...form),
				ready: (opened) => {
					prompt.value = name.value = "";
					named = false;
					root.replaceChildren(...form);
					if (enter && typeof opened.session === "string") return enter(opened.workspace as string, opened.session, id);
					say(o.kind === "base" ? m.opened_base() : o.kind === "main" ? m.opened_main({ base: base!.label }) : m.opened_member({ base: base!.label }));
				},
			}));
		};
		show();
		const form = [h("p", { class: "spawn-at" }, m.folder_here(), " ", where, " ", up, " ", make), made, list, note, ...(o.kind === "base" ? [name] : []), prompt, go], root = h("div", { class: "spawn" }, ...form);
		return root;
	} };
}

/** Reads an opening button's data-open, data-ws, and data-tab against the bases on screen: undefined when its base or squad has gone. */
export function openingOf(el: HTMLElement, bases: { id: string; label: string; tabs: { id: string; label: string }[] }[]): Opening | undefined {
	const kind = el.dataset.open;
	if (kind === "base") return { kind };
	const base = bases.find((b) => b.id === el.dataset.ws), tab = el.dataset.tab ? base?.tabs.find((t) => t.id === el.dataset.tab) : undefined;
	if ((kind !== "main" && kind !== "member") || !base || (el.dataset.tab && !tab)) return;
	return { kind, base: { id: base.id, label: base.label }, ...(tab && { tab: { id: tab.id, label: tab.label } }) };
}
