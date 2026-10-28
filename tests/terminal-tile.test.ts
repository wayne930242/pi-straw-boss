import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The terminal tile's life (gui/mirror.ts mountTerminals) as the page drives it: attach on open and on a new stream's hello, park while the
// tab is hidden, detach on close, and a refused or ended mirror that opening the terminal again retries; the pad follows its state.

/** The few DOM calls the tile makes. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	classes = new Set<string>();
	classList = { toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)), contains: (c: string) => this.classes.has(c), remove: (c: string) => this.classes.delete(c) };
	onclick: (() => void) | null = null;
	value = "";
	addEventListener() {}
	focus() {}
	blur() {}
	getBoundingClientRect() {
		return { left: 0, bottom: 0 };
	}
	scrollTop = 0;
	scrollHeight = 0;
	clientWidth = 400;
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	parent: El | undefined;
	append(...kids: (El | string)[]) {
		for (const kid of kids) if (kid instanceof El) kid.parent = this;
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	get children(): El[] {
		return this.kids.filter((k): k is El => k instanceof El);
	}
	get lastElementChild(): El | null {
		return this.children.at(-1) ?? null;
	}
	remove() {
		this.parent?.kids.splice(this.parent.kids.indexOf(this), 1);
	}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
}
const listeners: (() => void)[] = [];
const doc = { hidden: false, createElement: () => new El(), addEventListener: (_: string, f: () => void) => listeners.push(f) };
Object.assign(globalThis, { document: doc, ResizeObserver: class { observe() {} }, requestAnimationFrame: (f: () => void) => f() });
const { mountTerminals } = await import("../gui/mirror.ts");
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function page(answer: (body: Record<string, unknown>) => { ok: boolean; status: number; body: Record<string, unknown> } = () => ({ ok: true, status: 200, body: {} })) {
	const posts: [string, Record<string, unknown>][] = [], opened: { id: string; body(): El; closed?(): void }[] = [], states: string[] = [];
	let hello = JSON.stringify({ stream: "s1" });
	const m = mountTerminals({
		tiles: { open: (tile) => void opened.push(tile as never) },
		post: (key) => async (action, body) => (posts.push([`${action}:${key}`, body]), answer(body)),
		stream: () => hello,
		pad: ({ state }) => ({ el: new El() as never, update: () => void states.push(state()) }),
	});
	return { m, posts, opened, states, newStream: (s: string) => ((hello = JSON.stringify({ stream: s })), m.hello()) };
}

test("a tile attaches on open and on a new stream's hello, parks 5 s after the tab hides and attaches when it shows, and detaches when it closes", async () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const p = page();
		p.m.open("S", "billing");
		await settle();
		assert.deepEqual(p.posts, [["mirror:S", { stream: "s1", on: true }]]);
		p.m.open("S", "billing");
		await settle();
		assert.equal(p.posts.length, 1, "opening it again only brings it forward");
		p.newStream("s2");
		await settle();
		assert.deepEqual(p.posts.at(-1), ["mirror:S", { stream: "s2", on: true }]);
		doc.hidden = true;
		listeners.forEach((f) => f());
		mock.timers.tick(4999);
		await settle();
		assert.equal(p.posts.length, 2, "not before 5 s");
		mock.timers.tick(1);
		await settle();
		assert.deepEqual(p.posts.at(-1), ["mirror:S", { stream: "s2", on: false }]);
		p.newStream("s3");
		await settle();
		assert.equal(p.posts.length, 3, "a parked tile does not attach to a new stream while the tab is hidden");
		doc.hidden = false;
		listeners.forEach((f) => f());
		await settle();
		assert.deepEqual(p.posts.at(-1), ["mirror:S", { stream: "s3", on: true }]);
		p.opened[0]!.closed!();
		await settle();
		assert.deepEqual(p.posts.at(-1), ["mirror:S", { stream: "s3", on: false }]);
		p.newStream("s4");
		await settle();
		assert.equal(p.posts.length, 5, "a closed tile is gone");
	} finally {
		mock.timers.reset();
		doc.hidden = false;
	}
});

test("a refused attach or an ended mirror says so, turns the pad off, and opening the terminal again retries", async () => {
	let refuse = true;
	const p = page(() => (refuse ? { ok: false, status: 409, body: { error: "not_live", reason: "This session is no longer live in a pane." } } : { ok: true, status: 200, body: {} }));
	try {
		p.m.open("S", "billing");
		await settle();
		const tile = p.opened[0]!.body();
		assert.match(tile.textContent, /no longer live in a pane\. Open the terminal again to retry\./);
		assert.equal(p.states.at(-1), "off");
		refuse = false;
		p.m.open("S", "billing");
		await settle();
		assert.deepEqual(p.posts.map(([, b]) => b.on), [true, true], "reopening retried");
		p.m.frame(JSON.stringify({ key: "S", seq: 1, rows: 1, cols: 20, whole: true, set: [[0, "ROW-ONE"]] }));
		assert.equal(p.states.at(-1), "live");
		p.m.frame(JSON.stringify({ key: "S", hidden: true }));
		assert.equal(p.states.at(-1), "hidden", "a secret: Escape only");
		assert.ok(!tile.textContent.includes("ROW-ONE"), "and no rows");
		p.m.frame(JSON.stringify({ key: "S", ended: "The pane could not be read." }));
		assert.equal(p.states.at(-1), "off");
		p.m.open("S", "billing");
		await settle();
		assert.equal(p.posts.length, 3, "an ended mirror retries on open too");
	} finally {
		p.opened[0]?.closed?.(); // and its once-a-second check stops with it
	}
});
