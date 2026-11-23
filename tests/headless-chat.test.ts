import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import { El, page } from "./fake-dom.ts";
import "./pbs-loader.ts";

// A tower's comms under headless runs (docs/specs/2026-11-23-lite-b2-d-e-f.md §4.4, The GUI): the message the live run writes now shows after the log's last entry as `live`, as plain text, until the session file
// has the message, which then takes its place. Red on 3d38d3b6: the stream had no `live` and the log showed a message only once it was written whole.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { mountChat } = await import("../gui/chat.ts");
const { whenDrawn } = await import("../gui/mdbody.ts");

test("the run's message under way is the log's last thing, as plain text, and goes when the message is in the session file or the run stops writing", async () => {
	const root = new El("div"), key = "sb-tower-wa";
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data as never, { who: () => ({ key, name: "tower · Alpha", role: "tower", mark: "working" as const }), link: () => undefined });
	const said = (id: string, text: string): Item => ({ id, kind: "assistant", text, model: "m" });
	chat.apply({ key, reset: true, items: [said("a1", "Earlier answer")] });
	await whenDrawn();
	const live = () => root.querySelector(".live");
	chat.apply({ key, items: [], live: "Looking at **the** ledger" });
	assert.ok(live(), "the message under way is shown");
	assert.equal(live()!.querySelector(".live-text")!.textContent, "Looking at **the** ledger", "as plain text, not markdown");
	const list = root.querySelector(".chat-list")!;
	assert.equal(list.kids.at(-1), live(), "after the last entry");
	chat.apply({ key, items: [], live: "Looking at **the** ledger now" });
	assert.equal(root.querySelectorAll(".live").length, 1, "one, updated in place");
	chat.apply({ key, items: [said("a2", "Looking at the ledger now. Done.")] });
	await whenDrawn();
	assert.equal(live(), null, "the session file's message takes its place");
	chat.apply({ key, items: [], live: "Next" });
	assert.ok(live());
	chat.apply({ key, items: [], live: "" });
	assert.equal(live(), null, "the run stopped writing");
});
