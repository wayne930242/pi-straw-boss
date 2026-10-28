import assert from "node:assert/strict";
import { test } from "node:test";

// The folder picker's Choose… button (gui/picker.ts, desk-mode spec S10): present only when the desk shell's preload exposes `globalThis.strawBossDesk.pickFolder`. A chosen folder is
// listed through the page's own POST api/dirs, so the server stays the judge of it (home only, nothing hidden); null changes nothing; a refusal shows the picker's note.

/** The few DOM calls the picker makes. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	style = { setProperty() {} };
	listeners = new Map<string, (event: unknown) => void>();
	onclick: (() => void) | null = null;
	hidden = false;
	title = "";
	value = "";
	disabled = false;
	clientWidth = 0;
	scrollLeft = 0;
	scrollWidth = 0;
	tag: string;
	constructor(tag: string) {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	addEventListener(type: string, run: (event: unknown) => void) {
		this.listeners.set(type, run);
	}
	focus() {}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
	find(pred: (el: El) => boolean): El[] {
		return [this, ...this.kids.flatMap((k) => (typeof k === "string" ? [] : k.find(pred)))].filter(pred);
	}
}

/** The server's folders: home `/h` with play/{alpha,beta}; /etc is outside home and refused as the server refuses it. */
const tree = new Map<string, string[]>([["/h", ["play"]], ["/h/play", ["alpha", "beta"]], ["/h/play/alpha", []]]);
const REFUSED = "This folder is outside your home folder.";
const posts: { path: string; body: Record<string, unknown> }[] = [];
const fetchFake = async (url: string, init: { body: string }) => {
	const path = String(url).replace(/^api\//, ""), body = JSON.parse(init.body) as Record<string, unknown>;
	posts.push({ path, body });
	const reply = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json });
	if (path === "dirs/places") return reply(200, { home: "/h", places: [], recent: [] });
	const where = typeof body.path === "string" ? body.path : "/h";
	if (where === "/etc") return reply(403, { error: "outside_home", reason: REFUSED });
	const dirs = tree.get(where);
	return dirs ? reply(200, { path: where, home: "/h", sep: "/", parent: where === "/h" ? null : where.slice(0, where.lastIndexOf("/")), dirs, truncated: false }) : reply(404, { reason: "This folder cannot be read." });
};
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag), querySelector: () => null }, fetch: fetchFake, requestAnimationFrame: () => 0 });
const { folderPicker } = await import("../gui/picker.ts");

const settle = async (check: () => boolean) => {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
	assert.ok(check(), "the picker settled");
};
const open = async () => {
	const heard: string[] = [], made = folderPicker({}, (path) => heard.push(path), () => {}), root = made.el as unknown as El;
	await settle(() => made.picker.state().path === "/h");
	posts.length = 0;
	return { made, root, heard, choose: root.find((el) => el.tag === "button" && el.textContent === "Choose…")[0] };
};
const hook = (answers: (string | null | Error)[]) => {
	const asked: { defaultPath?: string; title?: string }[] = [];
	Object.assign(globalThis, { strawBossDesk: { pickFolder: async (options: { defaultPath?: string; title?: string }) => {
		asked.push(options);
		const next = answers.shift();
		if (next instanceof Error) throw next;
		return next ?? null;
	} } });
	return asked;
};
const gone = () => void delete (globalThis as { strawBossDesk?: unknown }).strawBossDesk;

test("without the desk shell's hook there is no Choose… button", async () => {
	gone();
	const { choose } = await open();
	assert.equal(choose, undefined);
});

test("a hook that is not a function adds no button either", async () => {
	Object.assign(globalThis, { strawBossDesk: { pickFolder: "yes" } });
	const { choose } = await open();
	assert.equal(choose, undefined);
	gone();
});

test("Choose… opens the native dialog at the picker's folder; the folder it returns is listed through POST api/dirs and selected", async () => {
	const asked = hook(["/h/play"]);
	const { made, choose, heard } = await open();
	assert.ok(choose, "the button shows");
	choose.onclick!();
	await settle(() => made.picker.state().path === "/h/play");
	assert.equal(asked.length, 1);
	assert.equal(asked[0]!.defaultPath, "/h", "at the picker's current folder");
	assert.equal(typeof asked[0]!.title, "string");
	assert.deepEqual(posts.filter((p) => p.path === "dirs").map((p) => p.body), [{ path: "/h/play" }], "the page's own call lists it");
	assert.equal(heard.at(-1), "/h/play", "and the unit's folder follows");
	gone();
});

test("null from the dialog (cancelled) changes nothing and asks the server nothing", async () => {
	const asked = hook([null]);
	const { made, choose, heard } = await open();
	choose.onclick!();
	await settle(() => asked.length === 1);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(made.picker.state().path, "/h");
	assert.deepEqual(posts, []);
	assert.deepEqual(heard, ["/h"]);
	gone();
});

test("a folder the server refuses leaves the picker where it was and shows the server's reason", async () => {
	hook(["/etc"]);
	const { made, root, choose } = await open();
	choose.onclick!();
	await settle(() => made.picker.state().error === REFUSED);
	assert.equal(made.picker.state().path, "/h");
	assert.equal(root.find((el) => el.attrs.get("role") === "status")[0]!.textContent, REFUSED, "in the note under the columns");
	gone();
});

test("a dialog that fails says so in the note and changes nothing", async () => {
	hook([new Error("the dialog could not open")]);
	const { made, root, choose } = await open();
	choose.onclick!();
	await settle(() => root.find((el) => el.attrs.get("role") === "status")[0]!.textContent === "the dialog could not open");
	assert.equal(made.picker.state().path, "/h");
	gone();
});
