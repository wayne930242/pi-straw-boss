import type { DocCard } from "../src/documents.ts";
import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { mount, parse } from "./markdown.ts";
import { m } from "./paraglide/messages.js";

// The documents a session shows (show_doc, or a Mini SDD folder opening on its own), served by capability (src/docs.ts). An HTML document is a
// tile with a frame sandboxed twice, by its attribute here and by the server's policy: no scripts and an opaque origin, its CSS, images, and
// fonts from its own directory, links in a new tab, and its pi-answer form answered through the owner. A text document renders read only, as
// markdown for .md and as plain text otherwise. A new revision reloads a tile that shows and marks a hidden one until it shows. The page never
// sees a path: show_doc cards and the dossier find a document by its display name. `docHooks` is the dev fixture's stand-in for the server.

export const SANDBOX = "allow-forms allow-popups allow-popups-to-escape-sandbox";
export const docHooks: { src?(cap: string): string; load?(cap: string): Promise<{ text: string } | undefined> } = {};
type Open = { card: DocCard; tile: Tile; loaded: number; seq: number; failed?: boolean; shown: boolean; gone: boolean; body: HTMLElement; state: HTMLElement; off: HTMLElement; frame?: HTMLIFrameElement };
const open = new Map<string, Open>();

/** A path folded the way show_doc resolves it against the session's directory, so a call's path and a document's display compare. */
export function resolvePath(path: string, cwd = "") {
	const out: string[] = [];
	for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) if (part === "..") out.pop(); else if (part && part !== ".") out.push(part);
	return `/${out.join("/")}`;
}
/** The listed document a show_doc path names. */
export const docFor = (cards: DocCard[] | undefined, cwd: string | undefined, path: string) => cards?.find((c) => resolvePath(c.display, cwd) === resolvePath(path, cwd));
/** What arrived since the unit's last snapshot (none the first time a unit is seen); `seen` keeps each unit's display names, which outlive
 *  a capability a restarted server or bridge mints afresh. */
export function arrivals(seen: Map<string, Set<string>>, key: string, cards: DocCard[] = []) {
	const known = seen.get(key);
	seen.set(key, new Set(cards.map((c) => c.display)));
	return known ? cards.filter((c) => !known.has(c.display)) : [];
}

const say = (o: Open, text: string, tone = "") => ((o.state.dataset.tone = tone), (o.state.textContent = text));
const fail = (o: Open, text: string) => ((o.failed = true), say(o, text, "error")); // it loads again when it next shows
const src = (cap: string) => docHooks.src?.(cap) ?? `doc/${encodeURIComponent(cap)}/`;
function load(o: Open) {
	[o.loaded, o.failed] = [o.card.revision, false];
	say(o, "");
	if (o.frame) return void (o.frame.src = src(o.card.cap));
	const cap = o.card.cap, md = /\.(md|markdown)$/i.test(o.card.display), seq = ++o.seq; // only the latest load lands
	void (docHooks.load?.(cap) ?? fetch(`api/doc/${encodeURIComponent(cap)}`, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<{ text: string }>) : undefined))).then(
		(d) => o.seq !== seq || (d ? o.body.replaceChildren(md ? h("div", { class: "md" }, mount(parse(d.text))) : h("pre", { class: "doc-pre" }, d.text)) : fail(o, m.doc_gone())),
		() => o.seq !== seq || fail(o, m.unreachable()),
	);
}

/** The tile of a document (the open one when it is open already); `unit` names its session in the title. */
export function docTile(unit: string, card: DocCard): Tile {
	const had = open.get(card.cap);
	if (had) return had.tile;
	const name = card.display.split("/").pop() || card.display, frame = card.kind === "html" ? h("iframe", { class: "doc-frame", sandbox: SANDBOX, referrerpolicy: "no-referrer", title: m.shown_by({ display: card.display, unit }) }) : undefined;
	const reload = h("button", { type: "button", class: "cmp-link" }, m.reload()), tab = frame && h("a", { class: "cmp-link", href: src(card.cap), target: "_blank", rel: "noopener noreferrer" }, m.open_new_tab());
	const body = frame ?? h("div", { class: "doc-text" }, h("p", { class: "chat-empty" }, m.loading())), state = h("span", { class: "term-state", role: "status" }), off = h("em", { class: "doc-off" }, m.off_screen());
	const wrap = h("div", { class: "doc-tile" }, h("div", { class: "term-bar doc-bar" }, h("span", { class: "doc-why" }, card.reason), off, state, h("span", { class: "doc-acts" }, reload, tab)), body);
	const io = new IntersectionObserver(([e]) => ((o.shown = Boolean(e?.isIntersecting)), o.shown && !o.gone && (o.failed || o.loaded !== o.card.revision) && load(o)));
	const tile: Tile = { id: `doc:${card.cap}`, title: `${name} · ${unit}`, icon: "i-doc", body: () => wrap, closed: () => (open.delete(card.cap), io.disconnect()) };
	const o: Open = { card, tile, loaded: 0, seq: 0, shown: false, gone: false, body, state, off, ...(frame && { frame }) };
	reload.onclick = () => !o.gone && load(o);
	off.hidden = card.onScreen;
	// A revision that came while the tile was hidden (another tab of tiles, a narrow window) loads when it shows.
	io.observe(wrap);
	load(o);
	open.set(card.cap, o);
	return tile;
}

/** Every snapshot: a document that arrives for the unit whose comms are open (`at`) opens beside them without focus; elsewhere it only shows on the unit. */
export function shelve(net: Net, seen: Map<string, Set<string>>, at: string | undefined, arrive: (unit: string, card: DocCard) => void) {
	const cards = new Map<string, DocCard>(), keys = new Set<string>();
	for (const b of net.bases)
		for (const u of [...(b.tower ? [b.tower, ...b.tower.subs] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((x) => [x, ...x.subs])]) {
			for (const c of u.docs ?? []) cards.set(c.cap, c);
			for (const c of arrivals(seen, u.key, u.docs)) if (u.key === at) arrive(u.name, c);
			keys.add(u.key);
		}
	for (const k of seen.keys()) if (!keys.has(k)) seen.delete(k); // a unit that left: seen afresh when it comes back
	refreshDocs(cards);
}

/** Every listed document by capability: open tiles follow revisions and the terminal pane, and say when their document is gone. */
export function refreshDocs(cards: Map<string, DocCard>) {
	for (const o of open.values()) {
		const c = cards.get(o.card.cap);
		if (!c) {
			if (!o.gone) say(o, m.doc_unlisted(), "error");
			o.gone = true;
			continue;
		}
		const back = o.gone && (say(o, ""), o.failed); // listed again after a failed load: it loads again
		[o.card, o.gone, o.off.hidden] = [c, false, c.onScreen];
		if (c.revision === o.loaded && !back) continue;
		if (o.shown) load(o);
		else if (c.revision !== o.loaded) say(o, m.doc_updated());
	}
}

/** The dossier's list of a unit's documents; a click opens one beside the comms. */
export function docList(root: HTMLElement, cards: DocCard[] | undefined, cut: boolean | undefined, show: (card: DocCard) => void) {
	root.hidden = !cards?.length && !cut;
	root.querySelector(".d-doc-list")!.replaceChildren(...(cards ?? []).map((c) => {
		const b = h("button", { type: "button", class: "d-doc", title: c.reason }, h("b", null, c.display), h("small", null, c.onScreen ? c.reason : m.off_screen_short({ reason: c.reason })));
		b.onclick = () => show(c);
		return b;
	}));
	root.querySelector<HTMLElement>(".d-docs-cut")!.hidden = !cut;
}
