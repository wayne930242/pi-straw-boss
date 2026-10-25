import { deployPanel } from "./deploy.ts";
import { h } from "./dom.ts";
import { leaf } from "./folders.ts";
import { folderPicker } from "./picker.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The opening tiles, their own small chunk. A new base (a folder picker from home, a name, a first message) opens with one member and no tower; a
// base without a tower takes members, one with a tower takes mains (spawn.ts on the server holds the same rules). A member added to a squad opens
// beside its main in that folder, so its tile has no picker; the others pick a folder that starts in the base's own and stays inside home; `enter` closes the tile and goes to the session that opened.

interface Base { id: string; label: string }
export type Opening = { kind: "base" } | { kind: "main" | "member"; base: Base; tab?: { id: string; label: string } };

export function spawnTile(o: Opening, enter?: (ws: string, key: string, tile: string) => void, chime?: () => void): Tile {
	const base = o.kind === "base" ? undefined : o.base, tab = o.kind === "base" ? undefined : o.tab;
	const title = o.kind === "base" ? m.open_base_title() : o.kind === "main" ? m.open_main_title({ base: base!.label }) : tab ? m.open_member_tab_title({ tab: tab.label }) : m.open_member_title({ base: base!.label }), id = `open-${o.kind}-${base?.id ?? ""}-${tab?.id ?? ""}`;
	let panel: { close(): void } | undefined;
	return { id, title, closed: () => panel?.close(), body: () => {
		const go = h("button", { type: "button", class: "go", disabled: "" }, o.kind === "base" ? m.open_base_go() : o.kind === "main" ? m.open_main_go() : m.open_member_go());
		const prompt = h("textarea", { rows: "3", placeholder: m.first_prompt() }) as HTMLTextAreaElement, name = h("input", { type: "text", maxlength: "64", placeholder: m.base_name(), "aria-label": m.base_name() }) as HTMLInputElement;
		let dir: string | undefined, home = "", named = false; // the base name follows the folder until it is typed
		name.addEventListener("input", () => (named = true));
		const picked = folderPicker(base ? { workspace: base.id, ...(tab && { tab: tab.id }) } : {}, (path, root) => {
			[dir, home, go.disabled] = [path, root, false];
			if (!named) name.value = leaf(path, root);
		}, () => (o.kind === "base" ? name : prompt).focus());
		go.onclick = () => {
			if (dir === undefined) return;
			const at = dir, text = prompt.value, label = name.value.trim() || leaf(at, home), body = o.kind === "base" ? { dir: at, label: name.value, prompt: text } : { workspace: base!.id, ...(tab && { tab: tab.id }), dir: at, prompt: text };
			// The form gives way to the deploy panel while the unit opens; a failure's Back brings the form back as it was.
			root.replaceChildren((panel = deployPanel({
				kind: o.kind, split: o.kind === "member" && Boolean(tab), hasPrompt: Boolean(text.trim()), name: o.kind === "base" ? label : leaf(at, home) || at, chime,
				open: (deploy) => post(`open/${o.kind}`, { ...body, deploy }),
				progress: (deploy) => post("open/progress", { id: deploy }),
				back: () => root.replaceChildren(...form),
				ready: (opened) => {
					prompt.value = name.value = "";
					named = false;
					root.replaceChildren(...form);
					if (enter && typeof opened.session === "string") return enter(opened.workspace as string, opened.session, id);
					note.textContent = o.kind === "base" ? m.opened_base() : o.kind === "main" ? m.opened_main({ base: base!.label }) : m.opened_member({ base: base!.label });
				},
			})));
		};
		const note = h("p", { class: "chat-empty" }), form = [picked.el, ...(o.kind === "base" ? [h("label", { class: "spawn-name" }, m.base_name(), name)] : []), prompt, note, go], root = h("div", { class: "spawn" }, ...form);
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
