import assert from "node:assert/strict";
import { test } from "node:test";

// The composer's `/` menu is hidden until the server answers with a match, and hidden again when it closes. The composer's own redraw must not
// show it: a live session's update once set `hidden = false` on every part of the form, which left an empty bordered list above the box.
const { El } = await import("./chat-dom.ts");
Object.assign(globalThis, { matchMedia: () => ({ matches: false }), CSS: { supports: () => true }, window: {} });
const { mountComposer } = await import("../gui/composer.ts");

// The fake keeps one listener per type; the menu and the composer both listen on the box, so keep every one.
const all = new WeakMap<object, Map<string, ((e: object) => void)[]>>();
El.prototype.addEventListener = function (this: InstanceType<typeof El>, type: string, run: unknown) {
	const by = all.get(this) ?? new Map<string, ((e: object) => void)[]>();
	all.set(this, by);
	by.set(type, [...(by.get(type) ?? []), run as (e: object) => void]);
};
const fire = (el: InstanceType<typeof El>, type: string) => { for (const run of all.get(el)?.get(type) ?? []) run({}); };
Object.defineProperty(El.prototype, "children", { get(this: InstanceType<typeof El>) { return this.kids.map((k) => (typeof k === "string" ? k : Object.assign(k, { scrollIntoView() {} }))); } });
const unit = { name: "kid", control: true, live: true, mark: "done" as const, online: true };
const boxOf = (root: InstanceType<typeof El>) => Object.assign(root.find((el) => el.tag === "textarea")[0]!, { value: "" });
const listOf = (root: InstanceType<typeof El>) => root.find((el) => el.classes.has("slash"))[0]!;

test("the menu is hidden when the composer mounts and after each update, ended session or live", () => {
	const root = new El("div"), composer = mountComposer(root as never, "k", (() => Promise.resolve({ ok: true })) as never);
	const list = listOf(root);
	boxOf(root);
	assert.equal(list.hidden, true, "hidden at mount");
	composer.update(unit);
	assert.equal(list.hidden, true, "a live session's update leaves it hidden");
	composer.update({ ...unit, control: false, live: false });
	assert.equal(list.hidden, true, "an ended one too");
	composer.update(unit);
	assert.equal(list.hidden, true, "and back to live");
});

test("the menu shows for a match and hides again when the box no longer holds a `/word`", async () => {
	const post = () => Promise.resolve({ ok: true, status: 200, body: { commands: [{ name: "review", source: "skill" }] } });
	const root = new El("div");
	const composer = mountComposer(root as never, "k2", post as never), box = boxOf(root);
	composer.update(unit);
	const list = listOf(root);
	box.value = "/re";
	fire(box, "input");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(list.hidden, false, "shown for a match");
	box.value = "/review done";
	fire(box, "input");
	assert.equal(list.hidden, true, "hidden once it closes");
});
