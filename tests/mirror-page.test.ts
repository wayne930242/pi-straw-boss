import assert from "node:assert/strict";
import { test } from "node:test";

// The terminal tile's renderer (gui/mirror.ts): rows into spans of text nodes, and frames into the rows of the tile.

/** The few DOM calls the renderer makes: elements with attributes, a style, element children, and text. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	parent: El | undefined;
	style: Record<string, string> = {};
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
	}
	append(...kids: (El | string)[]) {
		for (const kid of kids) {
			if (kid instanceof El) kid.parent = this;
			this.kids.push(kid);
		}
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [];
		this.append(...kids);
	}
	remove() {
		this.parent?.kids.splice(this.parent.kids.indexOf(this), 1);
	}
	get children(): El[] {
		return this.kids.filter((k): k is El => k instanceof El);
	}
	get lastElementChild(): El | null {
		return this.children.at(-1) ?? null;
	}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(value: string) {
		this.kids = [value];
	}
}
Object.assign(globalThis, { document: { createElement: () => new El() } });
const { applyFrame, rowSpans, sgr } = await import("../gui/mirror.ts");
const box = () => new El() as unknown as HTMLElement & El;

test("SGR becomes classes for the 16 colours and the attributes, and checked rgb() colours for 256 and truecolor", () => {
	assert.deepEqual(rowSpans("plain"), [{ text: "plain", cls: "" }]);
	assert.deepEqual(rowSpans("\x1b[31mred\x1b[0m \x1b[1;4;92mbold\x1b[22mthin\x1b[24m\x1b[39m"), [{ text: "red", cls: "c1" }, { text: " ", cls: "" }, { text: "bold", cls: "c10 tb tu" }, { text: "thin", cls: "c10 tu" }]);
	assert.deepEqual(rowSpans("\x1b[44;3;9mx"), [{ text: "x", cls: "k4 ti ts" }]);
	assert.deepEqual(rowSpans("\x1b[2;104mx\x1b[49my"), [{ text: "x", cls: "k12 td" }, { text: "y", cls: "td" }]);
	assert.deepEqual(rowSpans("\x1b[38;5;196mx\x1b[38;5;3my\x1b[38;5;244mz"), [{ text: "x", cls: "", fg: "rgb(255,0,0)" }, { text: "y", cls: "c3" }, { text: "z", cls: "", fg: "rgb(128,128,128)" }]);
	assert.deepEqual(rowSpans("\x1b[38;2;249;226;175m│\x1b[48;2;1;2;3mx"), [{ text: "│", cls: "", fg: "rgb(249,226,175)" }, { text: "x", cls: "", fg: "rgb(249,226,175)", bg: "rgb(1,2,3)" }]);
	assert.deepEqual(rowSpans("\x1b[38:2::10:20:30mx\x1b[48:5:2my"), [{ text: "x", cls: "", fg: "rgb(10,20,30)" }, { text: "y", cls: "k2", fg: "rgb(10,20,30)" }], "the colon forms");
	assert.deepEqual(rowSpans("\x1b[7mx\x1b[31;7my\x1b[27mz"), [{ text: "x", cls: "cz kz" }, { text: "y", cls: "cz k1" }, { text: "z", cls: "c1" }], "inverse swaps, the terminal's own colours too");
	assert.deepEqual(rowSpans("\x1b[1;31mx\x1b[my"), [{ text: "x", cls: "c1 tb" }, { text: "y", cls: "" }], "an empty SGR resets");
});

test("unknown codes and malformed colours change nothing, and malformed sequences never make an element", () => {
	assert.deepEqual(sgr({ fg: 1 }, "5;6;8;53;73;200"), { fg: 1 }, "blink, hidden, overline, superscript, unknown");
	assert.deepEqual(sgr({}, "38;5;300"), {}, "a 256-colour index out of range");
	assert.deepEqual(sgr({}, "38;2;1;2"), {}, "truecolor with a part missing");
	assert.deepEqual(sgr({}, "38;2;1;2;999;31"), { fg: 1 }, "a part out of range is dropped, and the codes after it still apply");
	assert.deepEqual(sgr({}, "58;5;3;1"), { b: true }, "an underline colour is read and dropped");
	assert.deepEqual(rowSpans("a\x1b[38;5"), [{ text: "a", cls: "" }], "a sequence cut off at the end of the row");
	assert.deepEqual(rowSpans("a\x1b[3Gb\x1b]8;;x\x07c\x07\u009b31m"), [{ text: "ab]8;;xc31m", cls: "" }], "anything but SGR stays text without its escapes and controls");
	assert.deepEqual(rowSpans("<b>x</b>&amp;"), [{ text: "<b>x</b>&amp;", cls: "" }], "markup is text");
});

test("a frame sets the row count first, then the rows it names; a whole frame sets them all; nothing outside the rows is touched", () => {
	const b = box();
	applyFrame(b, { key: "k", rows: 3, cols: 10, whole: true, set: [[0, "one"], [1, "\x1b[31mtwo"], [2, "three"]] });
	assert.deepEqual(b.children.map((r) => r.textContent), ["one", "two", "three"]);
	assert.equal((b.children[1]!.kids[0] as El).attrs.get("class"), "c1");
	assert.equal(typeof b.children[0]!.kids[0], "string", "a plain run is a text node, not a span");
	applyFrame(b, { key: "k", rows: 3, set: [[1, "\x1b[38;2;1;2;3mTWO"]] });
	assert.deepEqual(b.children.map((r) => r.textContent), ["one", "TWO", "three"]);
	assert.equal((b.children[1]!.kids[0] as El).style.color, "rgb(1,2,3)");
	applyFrame(b, { key: "k", rows: 2, set: [[5, "out"], [-1, "out"], [0.5 as number, "out"], [0, 7 as unknown as string]] });
	assert.deepEqual(b.children.map((r) => r.textContent), ["one", "TWO"], "fewer rows, and set entries outside them or of the wrong type are ignored");
	applyFrame(b, { key: "k", rows: 500, set: [] });
	assert.equal(b.children.length, 120, "at most 120 rows");
	applyFrame(b, { key: "k", rows: "x" as unknown as number, set: "x" as unknown as [number, string][] });
	assert.equal(b.children.length, 0);
});

test("a 60 × 200 frame applies within the page's budget", () => {
	const b = box(), row = Array.from({ length: 40 }, (_, i) => `\x1b[38;5;${i}m${"x".repeat(5)}`).join("");
	const set = Array.from({ length: 60 }, (_, i): [number, string] => [i, row]);
	// The fastest of ten, so other suites running beside it (the machine's load) do not count: about 3 ms alone, 30 under the full suite.
	const runs = Array.from({ length: 10 }, (_, i) => { const start = performance.now(); applyFrame(b, { key: "k", rows: 60, set: set.map(([n, r]): [number, string] => [n, `${r}${i}`]) }); return performance.now() - start; });
	assert.ok(Math.min(...runs) < 20, `a few ms per frame (20 ms here; the plan's 4 ms is for a browser); fastest ${Math.min(...runs).toFixed(1)} ms`);
});
