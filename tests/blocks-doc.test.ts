import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { DocCard } from "../src/documents.ts";
import { El, page, stored } from "./fake-dom.ts";
import "./pbs-loader.ts";

// A document card's Markdown document draws its blocks with pi-better-show's elements in the page itself (no frame), at the comfortable density; an HTML document keeps its sandboxed frame. An answer from a block goes to the
// document's answer route as the package's Answer, and the element locks once the owner took it; what the server recorded as answered comes with the text and locks the blocks. A review's image resolves only through the document's own capability route.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { INTERACTIVE_KINDS } = await import("pi-better-show");
const { docHooks, docTile } = await import("../gui/doc.ts");
const { whenDrawn } = await import("../gui/mdbody.ts");
const { forgetLocks } = await import("../gui/blocklock.ts");
const { DEMO_BLOCKS_DOC } = await import("../gui/demo-blocks.ts");
type Posted = { ok: boolean; status: number; body: Record<string, unknown> };
type Locked = El & { answered?: unknown; data?: { items?: { image?: string }[] } };

const card = (display: string, extra: Partial<DocCard> = {}): DocCard => ({ cap: "c".repeat(32), display, kind: display.endsWith(".html") ? "html" : display.endsWith(".txt") ? "text" : "blocks", reason: "Plan ready", revision: 1, onScreen: true, ...extra });
const REV = "0123456789abcdef";
const posts: [string, Record<string, unknown>][] = [];
let reply: Posted = { ok: true, status: 200, body: { accepted: true } };
beforeEach(() => {
	stored.clear();
	forgetLocks();
	posts.length = 0;
	reply = { ok: true, status: 200, body: { accepted: true } };
	docHooks.load = async () => ({ text: DEMO_BLOCKS_DOC, rev: REV });
	docHooks.post = async (path, body) => (posts.push([path, body]), reply);
});
const tiles: { closed?(): void }[] = [];
afterEach(() => tiles.splice(0).forEach((t) => t.closed?.())); // a tile stays open by its capability until it is closed
const open = async (c: DocCard) => {
	const tile = docTile("billing-main", c), root = tile.body() as unknown as El;
	tiles.push(tile);
	await whenDrawn();
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await whenDrawn();
	return root;
};
const fire = (el: El, answer: unknown) => {
	for (const on of el.handlers["pbs-answer"] ?? []) on({ type: "pbs-answer", detail: answer, preventDefault() {} });
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await whenDrawn(); };

test("a Markdown document draws every block kind with its element, in the page, at the comfortable density, and with no frame", async () => {
	const root = await open(card("docs/plan.md"));
	assert.deepEqual(root.find((el) => el.tagName.startsWith("pbs-")).map((el) => el.tagName), ["pbs-callout", "pbs-callout", "pbs-cards", "pbs-options", "pbs-form", "pbs-review", "pbs-mindmap", "pbs-suggest", "pbs-checklist", "pbs-table", "pbs-steps", "pbs-stats", "pbs-diff", "pbs-diagram", "pbs-tree", "pbs-review", "pbs-review"]);
	for (const el of root.find((el) => el.tagName.startsWith("pbs-"))) assert.equal(el.getAttribute("density"), "comfortable", el.tagName);
	assert.equal(root.find((el) => el.tagName === "iframe").length, 0);
});

test("a document with no block is the page's own Markdown as before, and a plain-text document stays text", async () => {
	docHooks.load = async () => ({ text: "# Notes\n\nplain **text**" });
	const md = await open(card("docs/notes.md"));
	assert.equal(md.find((el) => el.tagName.startsWith("pbs-")).length, 0);
	assert.equal(md.find((el) => el.tagName === "h1")[0]?.textContent, "Notes");
	docHooks.load = async () => ({ text: "```form\nquestions: []\n```" });
	const txt = await open(card("docs/notes.txt", { cap: "d".repeat(32) }));
	assert.equal(txt.find((el) => el.tagName.startsWith("pbs-")).length, 0, "a .txt document is not Markdown");
	assert.equal(txt.find((el) => el.className === "doc-pre").length, 1);
});

test("an HTML document keeps its sandboxed frame", async () => {
	const root = await open(card("docs/review.html"));
	const frame = root.find((el) => el.tagName === "iframe")[0]!;
	assert.match(frame.getAttribute("sandbox") ?? "", /allow-forms/);
	assert.ok(!/allow-scripts/.test(frame.getAttribute("sandbox") ?? ""));
	assert.equal(root.find((el) => el.tagName.startsWith("pbs-")).length, 0);
});

test("an answer from a block goes to the document's answer route as the Answer with the hash of the text drawn, and the element locks once the owner took it", async () => {
	const root = await open(card("docs/plan.md"));
	const form = root.find((el) => el.tagName === "pbs-form")[0] as Locked;
	const detail = { kind: "form", title: "Decide the store", fields: [["store", "SQLite"], ["why", "simple"]], ref: { block: 4 } };
	fire(form, detail);
	await settle();
	assert.equal(posts.length, 1);
	assert.equal(posts[0]![0], `doc/${"c".repeat(32)}/answer`);
	assert.deepEqual([posts[0]![1].answer, posts[0]![1].rev], [detail, REV]);
	assert.match(String(posts[0]![1].answerId), /^[A-Za-z0-9_-]{16,64}$/);
	assert.ok(!("fields" in posts[0]![1]), "the v1 fields are the server's to make, for the owner that wants them");
	assert.deepEqual(form.answered, [["store", "SQLite"], ["why", "simple"]]);
	const review = root.find((el) => el.tagName === "pbs-review")[0] as Locked;
	fire(review, { kind: "review", fields: [["title", "Landing page"], ["picked", "A"], ["item", "A"], ["comment", "ok"]], ref: { block: 5 } });
	await settle();
	assert.equal((posts[1]![1].answer as { kind: string }).kind, "review");
});

test("grouped and multi reviews send ordered fields to the document and lock with every pick", async () => {
	const root = await open(card("docs/plan.md"));
	const reviews = root.find((el) => el.tagName === "pbs-review").slice(1) as Locked[];
	const choices = [[["picked:Header", "Compact"], ["picked:Changelog", "Timeline"]], [["picked", "Desktop"], ["picked", "Phone"]]];
	for (const [i, fields] of choices.entries()) {
		const review = reviews[i]!;
		fire(review, { kind: "review", fields });
		await settle();
		assert.deepEqual(posts[i]![1].answer, { kind: "review", fields, ref: { block: 15 + i } });
		assert.deepEqual(review.answered, fields);
	}
});

test("what the server recorded comes with the text: an answered block opens locked with the fields that went, a pending one locked, in any tile of that document; an edited text (another hash) opens them again", async () => {
	docHooks.load = async () => ({ text: DEMO_BLOCKS_DOC, rev: REV, answered: { done: [[7, [["text", "Go ahead"]]]], pending: [4] } });
	const root = await open(card("docs/plan.md"));
	const chips = root.find((el) => el.tagName === "pbs-suggest")[0] as Locked;
	assert.deepEqual(chips.answered, [["text", "Go ahead"]]);
	const form = root.find((el) => el.tagName === "pbs-form")[0] as Locked;
	assert.equal(form.answered, undefined);
	assert.equal(root.find((el) => el.getAttribute("class") === "pbs-block" && el.hasAttribute("inert")).length, 1, "the pending one");
	tiles.splice(0).forEach((t) => t.closed?.());
	docHooks.load = async () => ({ text: DEMO_BLOCKS_DOC, rev: "fedcba9876543210" });
	const edited = await open(card("docs/plan.md"));
	assert.equal((edited.find((el) => el.tagName === "pbs-suggest")[0] as Locked).answered, undefined, "another hash, another scope");
	assert.equal(edited.find((el) => el.hasAttribute("inert")).length, 0);
});

test("a record the server could not read says so under the blocks", async () => {
	docHooks.load = async () => ({ text: DEMO_BLOCKS_DOC, rev: REV, answered: { done: [], pending: [], unreadable: true } });
	const root = await open(card("docs/plan.md"));
	unsureNotes(root);
});

test("a document the session no longer shows refuses the answer, the element stays open, and the reason is under it", async () => {
	reply = { ok: false, status: 409, body: { error: "closed", reason: "The document is no longer open in its session." } };
	const root = await open(card("docs/plan.md"));
	const chips = root.find((el) => el.tagName === "pbs-suggest")[0] as Locked;
	fire(chips, { kind: "suggest", fields: [["text", "Go ahead"]] });
	await settle();
	assert.equal(chips.answered, undefined);
	assert.ok(root.find((el) => el.className === "pbs-note").some((el) => /no longer open/.test(el.textContent)));
});

test("a review item's image resolves only through the document's own capability route, never as a URL the author wrote", async () => {
	const root = await open(card("docs/plan.md"));
	const review = root.find((el) => el.tagName === "pbs-review")[0] as Locked;
	assert.deepEqual(review.data!.items!.map((i) => i.image), [`doc/${"c".repeat(32)}/a.svg`, `doc/${"c".repeat(32)}/b.svg`, undefined]);
	docHooks.load = async () => ({ text: "```review\nitems:\n  - {name: A, image: 'https://evil.example/x.png'}\n  - {name: B, image: '../secret.png'}\n  - {name: C, image: 'data:image/svg+xml;base64,AAAA'}\n  - {name: D, image: 'sub/dir/ok.png'}\n```" });
	const other = await open(card("docs/other.md", { cap: "e".repeat(32) }));
	assert.deepEqual((other.find((el) => el.tagName === "pbs-review")[0] as Locked).data!.items!.map((i) => i.image), [undefined, undefined, undefined, `doc/${"e".repeat(32)}/sub/dir/ok.png`]);
	docHooks.load = async () => ({ text: "```review\nitems:\n  - {name: A, image: '圖/截圖 1.png'}\n  - {name: B, image: 'é/../x.png'}\n  - {name: C, image: 'a\\\\b.png'}\n  - {name: D, image: '/abs.png'}\n```", rev: REV });
	const names = await open(card("docs/names.md", { cap: "f".repeat(32) }));
	assert.deepEqual((names.find((el) => el.tagName === "pbs-review")[0] as Locked).data!.items!.map((i) => i.image), [`doc/${"f".repeat(32)}/%E5%9C%96/%E6%88%AA%E5%9C%96%201.png`, undefined, undefined, undefined], "BS-F006: the names the server serves (any letter or digit) are accepted, no separator or traversal");
});

/** With the record unreadable, the note under each answerable block says so and a display block's says nothing (PT-F002). */
function unsureNotes(root: El) {
	const blocks = root.find((el) => el.getAttribute("class") === "pbs-block"), notes = root.find((el) => el.getAttribute("class") === "pbs-note");
	assert.equal(notes.length, blocks.length);
	assert.ok(blocks.some((b) => (INTERACTIVE_KINDS as readonly string[]).includes(b.getAttribute("data-kind") ?? "")), "an answerable block is in the fixture");
	blocks.forEach((b, i) => assert.equal(/could not be read/i.test(notes[i]!.textContent), (INTERACTIVE_KINDS as readonly string[]).includes(b.getAttribute("data-kind") ?? ""), `the note under ${b.getAttribute("data-kind")}`));
}

test("pi-better-show 0.5.0: a document block answered with the reserved `pi-note` field sends it to the owner and the locked element shows it", async () => {
	const root = await open(card("docs/plan.md"));
	const form = root.find((el) => el.tagName === "pbs-form")[0] as Locked;
	const fields = [["store", "SQLite"], ["pi-note", "check the backup first"]];
	fire(form, { kind: "form", fields, ref: { block: 4 } });
	await settle();
	assert.deepEqual((posts[0]![1].answer as { fields: unknown }).fields, fields, "the note reaches the owner in the Answer");
	assert.deepEqual(form.answered, fields, "the locked view is given the note");
});
