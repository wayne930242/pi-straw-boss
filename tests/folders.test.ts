import assert from "node:assert/strict";
import { test } from "node:test";
import { child, createPicker, leaf, type Listing } from "../gui/folders.ts";

// The folder picker's model (gui/folders.ts) as the page drives it: the columns of the selected folder's levels, the arrow keys between them, back and
// forward, a new folder, and the base's default name from the folder's own, whichever separator the server's paths use.

test("a base is named after the picked folder by default, and home gives no name", () => {
	assert.equal(leaf("/home/me/sbd-playground/hello-test2", "/home/me"), "hello-test2");
	assert.equal(leaf("C:\\Users\\測試PM\\sbd-playground\\hello-test2", "C:\\Users\\測試PM"), "hello-test2", "a Windows path is cut at its backslash");
	assert.equal(leaf("C:\\Users\\測試PM\\中文專案", "C:\\Users\\測試PM"), "中文專案");
	assert.equal(leaf("/home/me", "/home/me"), "", "home is no name");
	assert.equal(leaf("C:\\Users\\測試PM", "C:\\Users\\測試PM"), "");
});

test("a child's path joins with the separator the server's paths use", () => {
	assert.equal(child("/home/me", "work", "/"), "/home/me/work");
	assert.equal(child("C:\\Users\\me", "work", "\\"), "C:\\Users\\me\\work");
	assert.equal(child("C:\\", "work", "\\"), "C:\\work", "a root already ends in its separator");
});

/** A folder tree behind the server's listing: `home` and, per folder, its folders. */
function world(sep = "/", home = sep === "/" ? "/h" : "C:\\Users\\pm") {
	const p = (...parts: string[]) => [home, ...parts].join(sep);
	const tree = new Map<string, string[]>([[p(), ["Desktop", "play", "中文專案"]], [p("Desktop"), []], [p("play"), ["alpha", "beta", "gamma"]], [p("play", "alpha"), ["deep"]], [p("play", "alpha", "deep"), []], [p("play", "beta"), []], [p("play", "gamma"), []], [p("中文專案"), []]]);
	const links = new Map<string, string>();
	const asked: (string | undefined)[] = [];
	const picker = createPicker({
		list: async (path = home) => {
			asked.push(path);
			const real = links.get(path) ?? path, dirs = tree.get(real);
			if (!dirs) throw new Error("This folder cannot be read.");
			return { path: real, home, sep, parent: real === home ? null : real.slice(0, real.lastIndexOf(sep)), dirs, truncated: false } satisfies Listing;
		},
		make: async (path, name) => {
			if (/[/\\]|^\.\.?$/.test(name)) throw new Error("A folder name has no separators in it.");
			const made = `${path}${sep}${name}`;
			if (!tree.has(made)) (tree.set(path, [...tree.get(path)!, name]), tree.set(made, []));
			return made;
		},
	});
	const names = () => picker.state().cols.map((c) => `${leaf(c.path, home) || "~"}:${c.pick ?? "-"}`);
	return { p, picker, tree, links, asked, names };
}

test("the picker starts at home as one column, and a pick opens the folder's own column to its right", async () => {
	const w = world();
	await w.picker.start();
	assert.deepEqual([w.names(), w.picker.state().path, w.picker.state().focus], [["~:-"], "/h", 0]);
	await w.picker.pick(0, "play");
	assert.deepEqual([w.names(), w.picker.state().path], [["~:play", "play:-"], "/h/play"]);
	await w.picker.pick(1, "alpha");
	await w.picker.pick(2, "deep");
	assert.deepEqual([w.names(), w.picker.state().path], [["~:play", "play:alpha", "alpha:deep", "deep:-"], "/h/play/alpha/deep"]);
	assert.deepEqual(w.picker.state().crumbs.map((c) => c.name), ["", "play", "alpha", "deep"], "the breadcrumb names each level, home first");
	await w.picker.pick(1, "beta");
	assert.deepEqual([w.names(), w.picker.state().path], [["~:play", "play:beta", "beta:-"], "/h/play/beta"], "a pick in an earlier column drops the columns after it");
});

test("a shortcut or the breadcrumb goes straight to a folder deep in the tree, with every level's column", async () => {
	const w = world();
	await w.picker.start();
	await w.picker.go("/h/play/alpha");
	assert.deepEqual([w.names(), w.picker.state().path, w.picker.state().focus], [["~:play", "play:alpha", "alpha:-"], "/h/play/alpha", 1]);
	await w.picker.go("/h");
	assert.deepEqual(w.names(), ["~:-"]);
	await w.picker.go("/h/nowhere");
	assert.equal(w.picker.state().error, "This folder cannot be read.");
	assert.equal(w.picker.state().path, "/h", "a folder that cannot be listed leaves the selection where it was");
});

test("the arrow keys: up and down pick in the column, right goes into the folder's column, left comes back out, Enter chooses", async () => {
	const w = world();
	await w.picker.start();
	const key = (k: Parameters<typeof w.picker.key>[0]) => w.picker.key(k);
	await key("ArrowDown");
	assert.deepEqual([w.picker.state().path, w.names()], ["/h/Desktop", ["~:Desktop", "Desktop:-"]], "down from nothing picks the first folder");
	await key("ArrowDown");
	await key("ArrowDown");
	await key("ArrowDown");
	assert.equal(w.picker.state().path, "/h/中文專案", "down stops at the last folder");
	await key("ArrowUp");
	assert.equal(w.picker.state().path, "/h/play");
	await key("ArrowRight");
	assert.deepEqual([w.picker.state().path, w.picker.state().focus, w.names()], ["/h/play/alpha", 1, ["~:play", "play:alpha", "alpha:-"]], "right enters the column and picks its first folder");
	await key("ArrowDown");
	assert.equal(w.picker.state().path, "/h/play/beta");
	await key("ArrowUp");
	await key("ArrowUp");
	assert.equal(w.picker.state().path, "/h/play/alpha", "up stops at the first folder");
	await key("ArrowRight");
	assert.deepEqual([w.picker.state().path, w.picker.state().focus], ["/h/play/alpha/deep", 2]);
	await key("ArrowRight");
	assert.deepEqual([w.picker.state().path, w.picker.state().focus], ["/h/play/alpha/deep", 2], "right at an empty folder stays");
	await key("ArrowLeft");
	assert.deepEqual([w.picker.state().path, w.picker.state().focus, w.names()], ["/h/play/alpha", 1, ["~:play", "play:alpha", "alpha:-"]], "left selects the folder the column belongs to");
	await key("ArrowLeft");
	assert.deepEqual([w.picker.state().path, w.picker.state().focus, w.names()], ["/h/play", 0, ["~:play", "play:-"]], "left reaches the first column");
	assert.equal(await key("ArrowLeft"), true, "left in the first column is still the picker's key");
	assert.deepEqual([w.picker.state().path, w.picker.state().focus], ["/h/play", 0], "and moves nothing");
	assert.equal(await key("Enter"), "chosen");
});

test("back and forward walk the folders chosen, and a new choice drops what was forward", async () => {
	const w = world();
	await w.picker.start();
	assert.deepEqual([w.picker.state().back, w.picker.state().forward], [false, false]);
	await w.picker.go("/h/play");
	await w.picker.go("/h/play/alpha");
	assert.deepEqual([w.picker.state().back, w.picker.state().forward], [true, false]);
	await w.picker.back();
	assert.deepEqual([w.picker.state().path, w.picker.state().forward], ["/h/play", true]);
	await w.picker.back();
	assert.deepEqual([w.picker.state().path, w.picker.state().back], ["/h", false]);
	await w.picker.forward();
	await w.picker.forward();
	assert.equal(w.picker.state().path, "/h/play/alpha");
	await w.picker.back();
	await w.picker.pick(0, "Desktop");
	assert.deepEqual([w.picker.state().path, w.picker.state().forward], ["/h/Desktop", false], "a new choice drops the way forward");
	await w.picker.back();
	assert.equal(w.picker.state().path, "/h/play");
});

test("a new folder is made in the selected one and selected, an existing one is just selected, and a refusal shows its reason", async () => {
	const w = world();
	await w.picker.start();
	await w.picker.go("/h/play");
	await w.picker.make("hello-test2");
	assert.deepEqual([w.picker.state().path, w.names()], ["/h/play/hello-test2", ["~:play", "play:hello-test2", "hello-test2:-"]]);
	assert.ok(w.picker.state().cols[1]!.dirs.includes("hello-test2"), "its parent's column lists it now");
	assert.equal(leaf(w.picker.state().path!, "/h"), "hello-test2", "so the base's default name is the new folder's");
	await w.picker.go("/h/play");
	await w.picker.make("hello-test2");
	assert.deepEqual([w.picker.state().path, w.picker.state().cols[1]!.dirs.filter((d) => d === "hello-test2").length], ["/h/play/hello-test2", 1]);
	await w.picker.make("../escape");
	assert.equal(w.picker.state().error, "A folder name has no separators in it.");
	assert.equal(w.picker.state().path, "/h/play/hello-test2", "the selection stays");
});

test("a folder that is a link shows as the real folder it leads to, and a Windows path is cut and joined with backslashes", async () => {
	const w = world();
	w.links.set("/h/shortcut", "/h/play/beta");
	w.tree.set("/h", ["shortcut", ...w.tree.get("/h")!]);
	await w.picker.start();
	await w.picker.pick(0, "shortcut");
	assert.deepEqual([w.picker.state().path, w.names()], ["/h/play/beta", ["~:play", "play:beta", "beta:-"]]);
	const win = world("\\");
	await win.picker.start();
	await win.picker.key("ArrowDown");
	await win.picker.key("ArrowDown");
	await win.picker.key("ArrowRight");
	assert.equal(win.picker.state().path, "C:\\Users\\pm\\play\\alpha");
	assert.deepEqual(win.picker.state().crumbs.map((c) => c.name), ["", "play", "alpha"]);
	await win.picker.make("中文專案2");
	assert.equal(win.picker.state().path, "C:\\Users\\pm\\play\\alpha\\中文專案2");
});
