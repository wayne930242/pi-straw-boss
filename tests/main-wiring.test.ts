import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// gui/main.ts builds the page and cannot be imported (a document, the stream, lazy chunks, a top-level await), so its one-line bindings to the page core (gui/pagecore.ts) are read as text: a mutation of any of them
// passes the type check and every behaviour test of the core, which runs against fakes (VC3-F003). Each line is the binding as written, and the order in `report()` is the one the connect overlay needs (VC3-F002).
const main = readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8");
const body = (name: string) => {
	const at = main.indexOf(`function ${name}(`), end = main.indexOf("\n}\n", at);
	assert.ok(at >= 0 && end > at, `${name} is in main.ts`);
	return main.slice(at, end);
};

test("an overlay's Show terminal and the step an answer left go to the core: the session's terminal mode, and the step's registration", () => {
	assert.match(main, /showTerminal: \(ws, key\) => core\.openSession\(ws, key, \{ mode: "term" \}\)/);
	assert.match(main, /^onStep\(core\.openStep\);/m);
	assert.match(main, /withPanels\(\(p\) => p\.alerts\(fresh, now, net\)\)/, "the dock's card follows each snapshot");
});

test("the demo fixture's routes reach both overlays: the dock's answer and trust and Zen's answer and trust go to the fixture, never to the server (VC4-F003, M42)", () => {
	const dock = main.slice(main.indexOf("const withPanels"), main.indexOf("showTerminal:")), zen = main.slice(main.indexOf("mountZen(el(\"zen\")"), main.indexOf("leave: core.leaveZen"));
	assert.ok(dock.includes("post: (key) => fixture && ((action, body) => fixture.data(key).post!(action as Parameters<Post>[0], body)), trust: fixture && fixture.trust,"), "the dock");
	assert.ok(zen.includes("post: (key) => fixture && ((action, body) => fixture.data(key).post!(action, body)), trust: fixture && fixture.trust,"), "Zen");
});

test("Escape reaches the core twice: the capture phase with its flag true (Zen takes the key first), the bubble phase with false", () => {
	assert.match(main, /addEventListener\("keydown", \(event\) => core\.escape\(event, true\), true\)/);
	assert.match(main, /addEventListener\("keydown", \(event\) => core\.escape\(event, false\)\);/);
});

test("the header's Zen button enters through the core, the view's face reads the core's zenOn, and the Zen layer's exits and watch are the core's and its terminals the overlay chunk's", () => {
	assert.match(main, /mountZenEnter\(el\("zen-enter"\), \(\) => core\.enterZen\(\)\)/);
	assert.match(main, /^zenShown = core\.zenOn;$/m);
	assert.match(main, /leave: core\.leaveZen, terminals, watch: core\.watchLog/);
	assert.match(main, /embedTerminal: \(key, name, host\) => embed\(key, name, host, \{ keys: false \}\)/, "the session view's terminal mode keeps its own focus rule");
	assert.ok(main.includes("done(p.terminal.embed(key, name, host, o))"), "the one embed hands the options (keys, end) to the terminals");
	assert.ok(main.includes("withPanels((p) => done(p.kit))"), "Zen's card and full terminal are the overlay chunk's terminals");
});

test("main.ts hands the keymap the core's face reader, so Zen reads its own rows (VC8R-F002)", () => {
	assert.match(main, /^mountHotkeys\(core\.hotkey, core\.modal, window, core\.keys\);/m);
});

test("report() opens or closes the connect overlay before the core tells Zen the state (the overlay notes and restores the focus Zen's card moves)", () => {
	const report = body("report");
	const connect = report.indexOf("connect(next)"), status = report.indexOf("core.status(next)");
	assert.ok(connect >= 0 && status > connect, "connect(next) comes first");
});

test("the overlay layer's dock holds the terminal card through the step slot, and a dialog that sent the user to a terminal gives the focus to the card it opened, not back to where the closing dialog was", () => {
	const layer = readFileSync(new URL("../gui/layer.ts", import.meta.url), "utf8");
	assert.match(layer, /mountStepSlot\(\{ dock, kit, showTerminal: deps\.showTerminal, openPane: \(key, name\) => terminal\.open\(key, name, true\) \}\)/);
	assert.match(layer, /stack\.close\(opened \? "go" : "close"\), opened && slot\.focus\(\)\)/);
	assert.match(layer, /step: slot\.step,/);
	assert.match(layer, /if \(net\) slot\.follow\(net\);/);
});

test("Zen's visit starts at the circle in the page: only the demo fixture names a start (Z-D16)", () => {
	assert.equal((main.match(/\bstart:/g) ?? []).length, 1, "one start in main.ts");
	assert.match(main, /\bstart: fixture\?\.start\b/, "and it is the fixture's, undefined in the live build");
});
