import assert from "node:assert/strict";
import { test } from "node:test";
import { El } from "./fake-dom.ts";
import "./pbs-loader.ts";
const { sync } = await import("../gui/render.ts");
const { mountChat } = await import("../gui/chat.ts");

test("inserting and moving keyed cards preserves their UTF-8 FNV-1a variation", () => {
	const list = new El("div");
	const draw = (...keys: string[]) => sync(list as unknown as Element, keys.map(id => ({ id })), () => new El("article") as unknown as HTMLElement, () => {});
	draw("hello", "雪");
	const original = list.children[0];
	draw("w2", "雪", "hello");
	assert.deepEqual(list.children.map(el => [el.dataset.key, el.dataset.vary]), [["w2", "4"], ["雪", "5"], ["hello", "3"]]);
	assert.equal(list.children[2], original);
});

test("the chat's separate renderer keys its transmissions and live placeholder too", () => {
	const root = new El("div"), key = "tower";
	const page = async () => ({ items: [] });
	const chat = mountChat(root as unknown as HTMLElement, { latest: page, older: page, entry: async () => undefined }, { who: () => ({ key, name: "tower", role: "tower", mark: "idle" }), link: () => undefined });
	chat.apply({ key, reset: true, items: [{ id: "hello", kind: "user", text: "hi" }] });
	chat.apply({ key, live: "writing" });
	assert.equal(root.querySelector(".you")!.dataset.vary, "3");
	assert.match(root.querySelector(".live")!.dataset.vary ?? "", /^[0-7]$/);
});
