import { h } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The opening tiles, their own small chunk: a folder picker that starts in the base's own folder and moves up and down inside home (the server
// refuses anything else, spawn.ts), under it either a new main for this base with an optional first message, or a new base with its tower.

interface Listing { path: string; home: string; parent: string | null; dirs: string[]; truncated: boolean }
interface Base { id: string; label: string }

export function spawnTile(kind: "main" | "tower", base: Base): Tile {
	return { id: kind === "main" ? `open-main-${base.id}` : "open-tower", title: kind === "main" ? m.open_main_title({ base: base.label }) : m.open_tower_title(), body: () => {
		const where = h("code", { class: "spawn-path" }), up = h("button", { type: "button", class: "later" }, m.folder_up());
		const list = h("div", { class: "spawn-dirs" }), note = h("p", { class: "chat-empty" }), go = h("button", { type: "button", class: "go" }, kind === "main" ? m.open_main_go() : m.open_tower_go());
		const field = kind === "main" ? h("textarea", { rows: "3", placeholder: m.first_prompt() }) : h("input", { type: "text", maxlength: "64", placeholder: m.base_name() });
		let at: Listing | undefined, named = false; // the base name follows the folder until it is typed
		field.addEventListener("input", () => (named = true));
		const say = (text: string) => (note.textContent = text);
		const show = (path?: string) => {
			say(m.asking_dirs());
			void post("dirs", path ? { path } : { workspace: base.id }).then((r) => {
				if (!r.ok) return say(r.body.reason ?? m.refused({ status: r.status }));
				at = r.body as unknown as Listing;
				const rel = at.path === at.home ? "~" : at.path.startsWith(`${at.home}/`) ? `~/${at.path.slice(at.home.length + 1)}` : at.path;
				where.textContent = rel;
				up.disabled = !at.parent;
				list.replaceChildren(...at.dirs.map((name) => {
					const b = h("button", { type: "button", class: "spawn-dir" }, `${name}/`);
					b.onclick = () => show(`${at!.path}/${name}`);
					return b;
				}));
				if (kind === "tower" && !named) (field as HTMLInputElement).value = at.path === at.home ? "" : at.path.slice(at.path.lastIndexOf("/") + 1);
				say(at.dirs.length ? (at.truncated ? m.folder_cut() : "") : m.folder_empty());
			}, () => say(m.no_answer()));
		};
		up.onclick = () => at?.parent && show(at.parent);
		go.onclick = () => {
			if (!at) return;
			const value = (field as HTMLInputElement).value;
			go.disabled = true;
			say(m.opening());
			void post(`open/${kind}`, kind === "main" ? { workspace: base.id, dir: at.path, prompt: value } : { dir: at.path, label: value }).then((r) => {
				if (!r.ok) return say(r.body.reason ?? m.refused({ status: r.status }));
				(field as HTMLInputElement).value = "";
				named = false;
				say(kind === "main" ? m.opened_main({ base: base.label }) : m.opened_tower());
			}, () => say(m.no_answer())).finally(() => (go.disabled = false));
		};
		show();
		return h("div", { class: "spawn" }, h("p", { class: "spawn-at" }, m.folder_here(), " ", where, " ", up), list, note, field, go);
	} };
}
