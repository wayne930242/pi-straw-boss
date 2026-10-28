import assert from "node:assert/strict";
import { test } from "node:test";
import { El } from "./chat-dom.ts";
import "./session-dom.ts";

// Switching the session view to its terminal (gui/session.ts): the composer's box lets go of the keyboard, and only a desktop gives the terminal's text box the focus by itself.

const fine = { on: false };
Object.assign(globalThis, { matchMedia: () => ({ matches: fine.on }) });
/** An element that notes its blur. */
class Box extends El {
	blurred: string[];
	constructor(tag: string, blurred: string[]) {
		super(tag);
		this.blurred = blurred;
	}
	blur() {
		this.blurred.push("blur");
		focus(undefined);
	}
}
const focus = (el: El | undefined) => Object.assign(document, { activeElement: el });
const scene = { route: { view: "session", ws: "w1", key: "k" }, net: { bases: [{ id: "w1", label: "w1", tabs: [], outside: [{ key: "k", name: "billing", role: "session", mark: "idle", subs: [], control: true }] }] }, cards: {}, info: { name: "billing", role: "session", state: "live" } } as never;

async function mounted() {
	const { mountSession } = await import("../gui/session.ts");
	const view = new El("div"), sink = new El("textarea"), sinkFocus: string[] = [];
	sink.setAttribute("class", "term-sink");
	sink.focus = () => void sinkFocus.push("focus");
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async () => ({ ok: true }) };
	const session = mountSession(scene, { view: view as never, data: () => data as never, openTile() {}, embedTerminal: async (_k, _n, host) => (host.append(sink as never), () => host.replaceChildren()), online: () => true, fullScreen() {}, opened() {} });
	session.open("k");
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	const part = (cls: string) => view.find((el) => el.classes.has(cls))[0]!;
	const blurred: string[] = [], box = new Box("textarea", blurred);
	part("composer-root").append(box);
	return { session, part, box, blurred, sinkFocus, term: () => new Promise((r) => setImmediate(r)) };
}

test("switching to the terminal makes the composer's box let go of the focus, so keys typed there go to the terminal and not to the hidden chat box", async () => {
	fine.on = false;
	const { session, part, box, blurred, term } = await mounted();
	focus(box);
	session.terminal("k");
	await term();
	assert.deepEqual(blurred, ["blur"]);
	assert.equal(part("composer-root").hidden, true);
	assert.equal(part("term-root").hidden, false);
});

test("a focus outside the parts that hide (the mode buttons) is left alone", async () => {
	fine.on = false;
	const { session, part, blurred, term } = await mounted();
	const tab = new Box("button", blurred);
	part("comms-in").append(tab);
	focus(tab);
	session.terminal("k");
	await term();
	assert.deepEqual(blurred, []);
});

test("a phone's terminal text box does not take the focus by itself (its Keyboard button does); a desktop's does", async () => {
	fine.on = false;
	let w = await mounted();
	w.session.terminal("k");
	await w.term();
	assert.deepEqual(w.sinkFocus, []);
	fine.on = true;
	w = await mounted();
	w.session.terminal("k");
	await w.term();
	assert.deepEqual(w.sinkFocus, ["focus"]);
	fine.on = false;
});
