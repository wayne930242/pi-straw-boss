import { h } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The opening tiles, their own small chunk. A new base (a folder picker from home, a name, a first message) opens with one member and no tower; a
// base without a tower takes members, one with a tower takes mains (spawn.ts on the server holds the same rules). A member added to a squad opens
// beside its main in that folder, so its tile has no picker; the others pick a folder that starts in the base's own and stays inside home.

interface Listing { path: string; home: string; parent: string | null; dirs: string[]; truncated: boolean }
interface Base { id: string; label: string }
export type Opening = { kind: "base" } | { kind: "main" | "member"; base: Base; tab?: { id: string; label: string } };

export function spawnTile(o: Opening): Tile {
	const base = o.kind === "base" ? undefined : o.base, tab = o.kind === "base" ? undefined : o.tab;
	const title = o.kind === "base" ? m.open_base_title() : o.kind === "main" ? m.open_main_title({ base: base!.label }) : tab ? m.open_member_tab_title({ tab: tab.label }) : m.open_member_title({ base: base!.label });
	return { id: `open-${o.kind}-${base?.id ?? ""}-${tab?.id ?? ""}`, title, body: () => {
		const where = h("code", { class: "spawn-path" }), up = h("button", { type: "button", class: "later" }, m.folder_up());
		const list = h("div", { class: "spawn-dirs" }), note = h("p", { class: "chat-empty" });
		const go = h("button", { type: "button", class: "go" }, o.kind === "base" ? m.open_base_go() : o.kind === "main" ? m.open_main_go() : m.open_member_go());
		const prompt = h("textarea", { rows: "3", placeholder: m.first_prompt() }) as HTMLTextAreaElement, name = h("input", { type: "text", maxlength: "64", placeholder: m.base_name() }) as HTMLInputElement;
		let at: Listing | undefined, named = false; // the base name follows the folder until it is typed
		name.addEventListener("input", () => (named = true));
		const say = (text: string) => (note.textContent = text);
		const show = (path?: string) => {
			say(m.asking_dirs());
			void post("dirs", path ? { path } : base ? { workspace: base.id, ...(tab && { tab: tab.id }) } : {}).then((r) => {
				if (!r.ok) return say(r.body.reason ?? m.refused({ status: r.status }));
				at = r.body as unknown as Listing;
				const rel = at.path === at.home ? "~" : at.path.startsWith(`${at.home}/`) ? `~/${at.path.slice(at.home.length + 1)}` : at.path;
				where.textContent = rel;
				up.disabled = !at.parent;
				list.replaceChildren(...at.dirs.map((dir) => {
					const b = h("button", { type: "button", class: "spawn-dir" }, `${dir}/`);
					b.onclick = () => show(`${at!.path}/${dir}`);
					return b;
				}));
				if (!named) name.value = at.path === at.home ? "" : at.path.slice(at.path.lastIndexOf("/") + 1);
				say(at.dirs.length ? (at.truncated ? m.folder_cut() : "") : m.folder_empty());
			}, () => say(m.no_answer()));
		};
		up.onclick = () => at?.parent && show(at.parent);
		go.onclick = () => {
			if (!at) return;
			const dir = at.path, text = prompt.value, body = o.kind === "base" ? { dir, label: name.value, prompt: text } : { workspace: base!.id, ...(tab && { tab: tab.id }), dir, prompt: text };
			go.disabled = true;
			say(m.opening());
			void post(`open/${o.kind}`, body).then((r) => {
				if (!r.ok) return say(r.body.reason ?? m.refused({ status: r.status }));
				prompt.value = name.value = "";
				named = false;
				say(o.kind === "base" ? m.opened_base() : o.kind === "main" ? m.opened_main({ base: base!.label }) : m.opened_member({ base: base!.label }));
			}, () => say(m.no_answer())).finally(() => (go.disabled = false));
		};
		show();
		return h("div", { class: "spawn" }, h("p", { class: "spawn-at" }, m.folder_here(), " ", where, " ", up), list, note, ...(o.kind === "base" ? [name] : []), prompt, go);
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
