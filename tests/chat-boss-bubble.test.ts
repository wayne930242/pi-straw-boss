import assert from "node:assert/strict";
import { test } from "node:test";
import { BOSS_MARK, CRASH_FLAG } from "../src/eventmarks.ts";
import type { TowerService } from "../src/net.ts";

// The session view's wiring for a service tower's boss turn (gui/chat.ts `render`, towerturns.ts `bossTurn`; review RV2-F001): the bubble shows what the boss wrote without the server's marker line,
// a crash flag as a note (`.boss-flag`), and the raw text as its `title`. A tower without a service, and any other turn, are drawn as they were.

/** The few DOM calls the chat makes. */
class El {
	tag: string;
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	listeners = new Map<string, unknown>();
	classes = new Set<string>();
	classList = { add: (c: string) => void this.classes.add(c), remove: (c: string) => void this.classes.delete(c), contains: (c: string) => this.classes.has(c), toggle: (c: string) => (this.classes.has(c) ? !this.classes.delete(c) : !!this.classes.add(c)) };
	hidden = false;
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	constructor(tag: string) {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name === "class") this.classes = new Set(value.split(" "));
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	prepend(...kids: (El | string)[]) {
		this.kids.unshift(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	addEventListener(type: string, run: unknown) {
		this.listeners.set(type, run);
	}
	remove() {}
	querySelector(selector: string) {
		return this.find((el) => el.tag === selector)[0] ?? null;
	}
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
/** html() parses a constant template; the fake answers each with a bare element that has a <use>. */
class Parser {
	parseFromString() {
		const root = new El("span");
		root.append(new El("use"));
		return { body: { firstElementChild: root } };
	}
}
class Watcher {
	observe() {}
	disconnect() {}
}
Object.assign(globalThis, {
	document: { createElement: (tag: string) => new El(tag), importNode: (el: El) => el },
	DOMParser: Parser, HTMLElement: El, IntersectionObserver: Watcher, ResizeObserver: Watcher,
});
const { mountChat } = await import("../gui/chat.ts");
const { m } = await import("../gui/paraglide/messages.js");

const SERVICE = { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] } as TowerService;
const who = (service?: TowerService) => ({ key: "t1", name: "tower", role: "tower", mark: "idle" as const, ...(service ? { service } : {}) });
const bubbleOf = (text: string, service?: TowerService) => {
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => who(service), link: () => undefined });
	chat.apply({ key: "t1", reset: true, items: [{ id: "u1", kind: "user", text }] });
	return root.find((el) => el.attrs.get("class") === "bubble")[0]!;
};

test("a service tower's boss turn shows the boss's words without the server's marker, and the raw text in the title", () => {
	const raw = `${BOSS_MARK}\nship the release`, bubble = bubbleOf(raw, SERVICE);
	assert.equal(bubble.textContent, "ship the release");
	assert.equal(bubble.attrs.get("title"), raw);
	assert.equal(bubble.find((el) => el.attrs.get("class") === "boss-flag").length, 0, "no crash flag, no note");
});

test("a crash flag after the marker shows as a .boss-flag note with the page's words, and neither line is part of the body", () => {
	const raw = `${BOSS_MARK}\n${CRASH_FLAG}\nship the release`, bubble = bubbleOf(raw, SERVICE);
	const [flag] = bubble.find((el) => el.attrs.get("class") === "boss-flag");
	assert.equal(flag?.tag, "small");
	assert.equal(flag?.textContent, m.boss_crash_flag());
	assert.equal(bubble.textContent, `${m.boss_crash_flag()}ship the release`);
	assert.equal(bubble.attrs.get("title"), raw);
	assert.ok(!bubble.textContent.includes(BOSS_MARK) && !bubble.textContent.includes(CRASH_FLAG));
});

test("a tower without a service, and a turn that does not open with the marker, are drawn as they were: raw text, no title, no note", () => {
	const raw = `${BOSS_MARK}\n${CRASH_FLAG}\nship the release`, plain = bubbleOf(raw);
	assert.equal(plain.textContent, raw);
	assert.equal(plain.attrs.get("title"), "");
	assert.equal(plain.find((el) => el.attrs.get("class") === "boss-flag").length, 0);
	const other = bubbleOf("just a user turn", SERVICE);
	assert.equal(other.textContent, "just a user turn");
	assert.equal(other.attrs.get("title"), "");
});
