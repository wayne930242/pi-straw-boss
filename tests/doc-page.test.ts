import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocCard } from "../src/documents.ts";
import type { Net, Unit } from "../src/net.ts";

// The document tiles and their rules (gui/doc.ts) as the page drives them: which show_doc path names a listed document, what arrives where,
// the sandboxed frame, and a new revision that reloads a tile that shows and waits in one that does not.

/** The few DOM calls a document tile makes. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	hidden = false;
	onclick: (() => void) | null = null;
	src = "";
	tag: string;
	constructor(tag: string) {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
	find(pred: (e: El) => boolean): El | undefined {
		for (const k of this.kids) if (k instanceof El) { const hit = pred(k) ? k : k.find(pred); if (hit) return hit; }
	}
}
const seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
const observers = { disconnected: 0 };
Object.assign(globalThis, {
	document: { createElement: (tag: string) => new El(tag), createTextNode: (t: string) => t, createDocumentFragment: () => new El("#fragment") },
	IntersectionObserver: class { constructor(f: (entries: { isIntersecting: boolean }[]) => void) { seen.push(f); } observe() {} disconnect() { observers.disconnected++; } },
});
const { arrivals, docFor, docHooks, docTile, refreshDocs, resolvePath, shelve, SANDBOX } = await import("../gui/doc.ts");
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const card = (cap: string, display: string, extra: Partial<DocCard> = {}): DocCard => ({ cap, display, kind: display.endsWith(".html") ? "html" : "text", reason: "Plan ready", revision: 1, onScreen: true, ...extra });

test("a show_doc path names a listed document when it resolves, against the session's directory, to the document's display", () => {
	assert.equal(resolvePath("docs/./a/../plan.md", "/work/app"), "/work/app/docs/plan.md");
	assert.equal(resolvePath("/elsewhere//x.html", "/work"), "/elsewhere/x.html");
	const cards = [card("c1", "docs/plan.md"), card("c2", "/tmp/out.html")];
	for (const path of ["docs/plan.md", "./docs/plan.md", "/work/app/docs/plan.md", "docs/sub/../plan.md"]) assert.equal(docFor(cards, "/work/app", path)?.cap, "c1", path);
	assert.equal(docFor(cards, "/work/app", "/tmp/out.html")?.cap, "c2", "a document outside the directory is listed by its absolute path");
	for (const path of ["plan.md", "docs/plan.md.bak", "/work/other/docs/plan.md"]) assert.equal(docFor(cards, "/work/app", path), undefined, path);
	assert.equal(docFor(undefined, "/work/app", "docs/plan.md"), undefined, "a unit that lists nothing");
});

test("arrivals: nothing the first time a unit is seen, then each capability it did not list before, again after it left and came back", () => {
	const known = new Map<string, Set<string>>(), a = card("a", "a.md"), b = card("b", "b.md"), b2 = card("b2", "b.md");
	assert.deepEqual(arrivals(known, "S", [a]), [], "a page that opens on a unit with documents opens none");
	assert.deepEqual(arrivals(known, "S", [a, b]), [b]);
	assert.deepEqual(arrivals(known, "S", [a, { ...b, revision: 2 }]), [], "a new revision is not an arrival");
	assert.deepEqual(arrivals(known, "S", [a]), []);
	assert.deepEqual(arrivals(known, "S", [a, b2]), [b2], "listed again under a new capability: it arrives again");
	assert.deepEqual(arrivals(known, "S", [{ ...a, cap: "a2" }, b2]), [], "a capability minted afresh (a restarted server or bridge) is not an arrival");
	assert.deepEqual(arrivals(known, "T", []), []);
	assert.deepEqual(arrivals(known, "T", undefined), []);
});

test("a document arrives as a tile only on its own unit's comms; elsewhere nothing opens (towers and subagents included)", () => {
	const u = (key: string, docs: DocCard[] = [], subs: Unit[] = []): Unit => ({ id: key, key, control: true, name: `n-${key}`, role: "main", mark: "idle", subs, docs });
	const net = (extra: DocCard[]): Net => ({ bases: [{ id: "w", label: "w", mark: "idle", head: true, tower: { name: "tw", mark: "idle", key: "T", control: true, docs: extra.filter((c) => c.cap.startsWith("t")), subs: [] }, outposts: [], outside: [], tabs: [{ id: "t", label: "t", units: [u("S", extra.filter((c) => c.cap.startsWith("s"))), u("M", extra.filter((c) => c.cap.startsWith("m")), [u("C", extra.filter((c) => c.cap.startsWith("c")))])] }] }] });
	const known = new Map<string, Set<string>>(), opened: [string, string][] = [];
	shelve(net([]), known, "S", (unit, c) => opened.push([unit, c.cap]));
	shelve(net([card("s1", "a.md"), card("m1", "b.md"), card("t1", "c.md"), card("c1", "d.md")]), known, "S", (unit, c) => opened.push([unit, c.cap]));
	assert.deepEqual(opened, [["n-S", "s1"]]);
	shelve(net([card("s1", "a.md"), card("m1", "b.md"), card("t1", "c.md"), card("c1", "d.md"), card("t2", "e.md"), card("c2", "f.md")]), known, "T", (unit, c) => opened.push([unit, c.cap]));
	shelve(net([card("s1", "a.md"), card("m1", "b.md"), card("t1", "c.md"), card("c1", "d.md"), card("t2", "e.md"), card("c2", "f.md"), card("c3", "g.md")]), known, "C", (unit, c) => opened.push([unit, c.cap]));
	assert.deepEqual(opened.slice(1), [["tw", "t2"], ["n-C", "c3"]], "on a tower's and a subagent's comms too");
	shelve(net([card("s1", "a.md"), card("s2", "h.md")]), known, undefined, (unit, c) => opened.push([unit, c.cap]));
	assert.equal(opened.length, 3, "on the map or a base, nothing opens");
	shelve({ bases: [] }, known, "S", (unit, c) => opened.push([unit, c.cap]));
	assert.equal(known.size, 0, "units that left the net are forgotten");
});

test("an HTML tile is a frame sandboxed without scripts, loading the document by its capability; a new revision reloads it while it shows and waits while it does not", () => {
	const t = docTile("billing-main", card("cap1", "docs/plan.html", { onScreen: false }));
	assert.equal(t.id, "doc:cap1");
	assert.equal(t.title, "plan.html · billing-main");
	const wrap = t.body() as unknown as El, frame = wrap.find((e) => e.tag === "iframe")!;
	assert.equal(frame.attrs.get("sandbox"), SANDBOX);
	assert.equal(SANDBOX, "allow-forms allow-popups allow-popups-to-escape-sandbox", "never allow-scripts or allow-same-origin");
	assert.equal(frame.attrs.get("referrerpolicy"), "no-referrer");
	assert.equal(frame.src, "doc/cap1/");
	assert.equal(wrap.find((e) => e.tag === "a")?.attrs.get("href"), "doc/cap1/", "Open in a new tab: the same sandboxed page");
	assert.equal(wrap.find((e) => e.tag === "a")?.attrs.get("rel"), "noopener noreferrer");
	assert.equal(wrap.find((e) => e.tag === "em")?.hidden, false, "off screen in the terminal");
	assert.equal(docTile("billing-main", card("cap1", "docs/plan.html")), t, "opening it again brings the same tile");
	const show = seen.at(-1)!;
	frame.src = "";
	show([{ isIntersecting: true }]);
	assert.equal(frame.src, "", "showing it again at the same revision does not reload");
	refreshDocs(new Map([["cap1", card("cap1", "docs/plan.html", { revision: 2 })]]));
	assert.equal(frame.src, "doc/cap1/", "revision 2 while it shows: reloaded");
	assert.equal(wrap.find((e) => e.tag === "em")?.hidden, true, "back on screen in the terminal");
	show([{ isIntersecting: false }]);
	frame.src = "";
	refreshDocs(new Map([["cap1", card("cap1", "docs/plan.html", { revision: 3 })]]));
	assert.equal(frame.src, "", "hidden (another tab of tiles): not reloaded");
	assert.match(wrap.textContent, /Updated: the new version loads when this tile shows/);
	show([{ isIntersecting: true }]);
	assert.equal(frame.src, "doc/cap1/", "it loads when it shows");
	refreshDocs(new Map());
	assert.match(wrap.textContent, /No longer listed/);
	refreshDocs(new Map([["cap1", card("cap1", "docs/plan.html", { revision: 3 })]]));
	assert.doesNotMatch(wrap.textContent, /No longer listed/, "listed again: the note goes");
	refreshDocs(new Map());
	frame.src = "";
	(wrap.find((e) => e.tag === "button") as El).onclick!();
	assert.equal(frame.src, "", "Reload does nothing for a document no longer listed");
	t.closed!();
	assert.equal(observers.disconnected, 1, "a closed tile stops watching whether it shows");
	assert.notEqual(docTile("billing-main", card("cap1", "docs/plan.html")), t, "a closed tile is made afresh");
});

test("a text tile renders read only: markdown for .md, plain text otherwise, from the API (the fixture's hook here)", async () => {
	docHooks.load = async (cap) => (cap === "gone" ? undefined : { text: "# Title\n\n<b>raw</b>" });
	const md = docTile("u", card("md1", "notes.md")).body() as unknown as El, txt = docTile("u", card("tx1", "log.txt")).body() as unknown as El, gone = docTile("u", card("gone", "x.md")).body() as unknown as El;
	await settle();
	assert.ok(md.find((e) => e.attrs.get("class") === "md")?.find((e) => e.tag === "h1"), "markdown, built as elements");
	assert.equal(md.find((e) => e.tag === "iframe"), undefined, "no frame for a text document");
	assert.equal(txt.find((e) => e.tag === "pre")?.textContent, "# Title\n\n<b>raw</b>", "plain text stays text");
	assert.match(gone.textContent, /Unavailable/);
	docHooks.load = async () => ({ text: "back" });
	refreshDocs(new Map([["gone", card("gone", "x.md")]]));
	await settle();
	assert.match(gone.textContent, /Unavailable/, "a snapshot at the same revision does not load it again");
	assert.doesNotMatch(gone.textContent, /Updated/);
	seen.at(-1)!([{ isIntersecting: true }]);
	await settle();
	assert.match(gone.textContent, /back/, "a failed load loads again when the tile shows");
	docHooks.load = async () => undefined;
	refreshDocs(new Map([["gone", card("gone", "x.md", { revision: 2 })]]));
	await settle();
	refreshDocs(new Map());
	docHooks.load = async () => ({ text: "relisted" });
	refreshDocs(new Map([["gone", card("gone", "x.md", { revision: 2 })]]));
	await settle();
	assert.match(gone.textContent, /relisted/, "a failed tile listed again at the same revision loads, not left blank");
	let finish: (d: { text: string }) => void = () => {};
	docHooks.load = (cap) => (cap === "slow" ? new Promise((r) => (finish = r)) : Promise.resolve({ text: "new" }));
	const slow = docTile("u", card("slow", "s.txt")), sb = slow.body() as unknown as El;
	docHooks.load = async () => ({ text: "revision 2" });
	refreshDocs(new Map([["slow", card("slow", "s.txt", { revision: 2 })]]));
	seen.at(-1)!([{ isIntersecting: true }]);
	await settle();
	finish({ text: "revision 1, late" });
	await settle();
	assert.equal(sb.find((e) => e.tag === "pre")?.textContent, "revision 2", "a slower load of an older revision does not win");
	docHooks.load = undefined;
});
