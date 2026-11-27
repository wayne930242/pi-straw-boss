import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Base, Unit } from "../src/net.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { overwriteGetLocale } from "../gui/paraglide/runtime.js";

// Task 7 of the train workers: a train's unit card (the locomotive, the word 火車, a note that is the step and its wait), the base's chip, and an integrator's card that opens its yard, on the fake document.

sessionGlobals();
overwriteGetLocale(() => "zh-TW");
Object.assign(document, { createComment: () => new El("#comment") });
Object.assign(El.prototype, { replaceWith(this: El, node: El) { this.before(node); this.remove(); } });
const { baseEl, fillBase, ICON, roleName, useYards } = await import("../gui/render.ts");
void page;

const unit = (key: string, role: Unit["role"], over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role, mark: "working", note: "thinking", subs: [], ...over });
const base = (units: Unit[]): Base => ({ id: "w1", label: "Harbor", mark: "working", tower: null, tabs: [{ id: "w1:t1", label: "trains", units }], outposts: [], outside: [] });
const draw = (b: Base, yard?: { projects: string[]; chip: string }) => {
	const el = baseEl() as unknown as El;
	fillBase(el as unknown as HTMLElement, b, yard ? { yard } : {});
	return el;
};
const card = (el: El, name: string) => el.find((x) => x.classes.has("unit") && x.find((y) => y.classes.has("name"))[0]?.textContent === name)[0]!;

test("a train's card draws the locomotive and says 火車; its note line is the step and its wait, in place of the mark's word", () => {
	assert.equal(ICON.train, "train");
	assert.equal(roleName("train"), "火車");
	assert.ok(readFileSync(new URL("../gui/index.html", import.meta.url), "utf8").includes('<symbol id="i-train" viewBox="0 0 512 512" fill="currentColor"'), "the locomotive is in the sprite");
	useYards(new Map([["tr", "全檢查 · unit：等負載 ≤30（現在 42）"]]), new Map());
	const el = draw(base([unit("tr", "train"), unit("m", "main")]));
	const train = card(el, "tr");
	assert.equal(train.find((x) => x.classes.has("role"))[0]!.textContent, "火車");
	assert.equal(train.find((x) => x.tag === "use")[0]!.dataset.icon, "train");
	assert.equal(train.find((x) => x.classes.has("note"))[0]!.textContent, "全檢查 · unit：等負載 ≤30（現在 42）");
	assert.notEqual(card(el, "m").find((x) => x.classes.has("note"))[0]!.textContent, "全檢查 · unit：等負載 ≤30（現在 42）", "another unit keeps its own note");
	assert.equal(train.find((x) => x.classes.has("note"))[0]!.getAttribute("title"), "全檢查 · unit：等負載 ≤30（現在 42）", "V-F004: the note is clipped to its card, so the whole line (the load number, the lock holder) is its tooltip too");
	assert.equal(train.hasAttribute("data-train-note"), true, "and a train's note may take three lines (style.css), which this flags");
	assert.equal(card(el, "m").find((x) => x.classes.has("note"))[0]!.getAttribute("title"), null, "another unit's note has no tooltip");
	assert.equal(card(el, "m").hasAttribute("data-train-note"), false);
	useYards(new Map(), new Map());
	const plain = card(draw(base([unit("tr", "train")])), "tr");
	assert.equal(plain.find((x) => x.classes.has("note"))[0]!.textContent, "思考中", "no yard line: the mark's word as any unit");
	assert.equal(plain.find((x) => x.classes.has("note"))[0]!.getAttribute("title"), null);
	assert.equal(plain.hasAttribute("data-train-note"), false);
});

test("V-F005: a train that waits for a load or a lock says so on its card, whatever its mark; one that runs does not", () => {
	useYards(new Map([["a", "全檢查：等負載"], ["b", "合併（進行中）"]]), new Map(), new Set(["a"]));
	const el = draw(base([unit("a", "train", { mark: "idle" }), unit("b", "train", { mark: "idle" }), unit("c", "main", { mark: "idle" })]));
	assert.deepEqual(["a", "b", "c"].map((k) => card(el, k).hasAttribute("data-train-wait")), [true, false, false]);
	useYards(new Map(), new Map());
	assert.equal(card(draw(base([unit("a", "train", { mark: "idle" })])), "a").hasAttribute("data-train-wait"), false, "no yard line, no wait");
});

test("an integrator's card has a Yard button that carries its project; a unit that is not one has none", () => {
	useYards(new Map(), new Map([["m", "acme"]]));
	const el = draw(base([unit("m", "main"), unit("x", "main")]));
	const open = (name: string) => card(el, name).find((x) => x.classes.has("yard-open"))[0]!;
	assert.equal(open("m").hidden, false);
	assert.equal(open("m").dataset.yard, "acme");
	assert.equal(open("m").textContent, "調車場");
	assert.equal(open("x").hidden, true);
	useYards(new Map(), new Map());
});

test("a base's header chip carries the projects whose yard it holds and says the counts; with none it stays hidden", () => {
	const chip = (el: El) => el.find((x) => x.classes.has("yard-chip-btn"))[0]!;
	const withYard = draw(base([]), { projects: ["acme", "beta"], chip: "火車 3（等待 2）" });
	assert.equal(chip(withYard).hidden, false);
	assert.equal(chip(withYard).textContent, "火車 3（等待 2）");
	assert.equal(chip(withYard).dataset.yard, "acme beta");
	assert.equal(chip(draw(base([]))).hidden, true);
});

test("the yard sheet opens modal on the projects it is given, follows the net only when what it shows changed, and closes before a link to a comms is followed", async () => {
	Object.assign(El.prototype, {
		open: false,
		showModal(this: El & { open: boolean }) { this.open = true; },
		close(this: El & { open: boolean }) { this.open = false; this.dispatchEvent({ type: "close" }); },
	});
	const { mountYard } = await import("../gui/yard.ts");
	const yards = (round: number) => ({ projects: [{ project: "acme", forming: [], waiting: [], trains: [{ code: "2026-11-06-m", app: "web", state: "live" as const, key: "tr", round, cars: [], steps: [] }] }] });
	const net = (round: number) => ({ bases: [base([unit("tr", "train")])], yards: yards(round), load: { now: 42, cores: 14 } });
	const sheet = mountYard();
	const dialog = page.body.find((x) => x.tag === "dialog")[0] as El & { open: boolean; close(): void };
	assert.equal(sheet.isOpen(), false);
	sheet.net(net(1) as never);
	assert.equal(dialog.open, false, "a snapshot alone opens nothing");
	sheet.open(["acme"]);
	assert.equal(sheet.isOpen(), true);
	assert.ok(dialog.textContent.includes("調車場 · acme") && dialog.textContent.includes("第 1 次組裝") && dialog.textContent.includes("負載 42／14 核"));
	const body = dialog.find((x) => x.classes.has("yard-body"))[0]!, first = body.children[0];
	sheet.net(net(1) as never);
	assert.equal(body.children[0], first, "the same reading draws nothing again");
	sheet.net(net(2) as never);
	assert.ok(dialog.textContent.includes("第 2 次組裝") && body.children[0] !== first, "a changed one does");
	sheet.open(["gone"]);
	assert.ok(dialog.textContent.includes("還沒有火車"), "a project the net no longer has is an empty yard");
	sheet.open(["acme"]);
	const link = dialog.find((x) => x.tag === "a" && x.classes.has("yard-code"))[0]!;
	assert.match(link.getAttribute("href")!, /^w\/w1\/s\/tr$/);
	dialog.handlers.click![0]!({ target: link });
	assert.equal(dialog.open, false, "a click on a train's link closes the sheet; the router follows the link");
	sheet.net(net(3) as never);
	assert.ok(!dialog.textContent.includes("第 3 次組裝"), "a closed sheet draws nothing");
});

test("closing the yard sheet returns the focus to the control that opened it, even where a click does not focus a button (TPG-F003)", async () => {
	const { mountYard } = await import("../gui/yard.ts");
	const sheet = mountYard();
	const dialog = page.body.find((x) => x.tag === "dialog").at(-1) as El & { open: boolean; close(): void };
	const chip = new El("button");
	page.body.append(chip);
	chip.focus();
	sheet.open(["acme"]);
	assert.notEqual(page.focused, chip, "the sheet takes the focus while it is open");
	dialog.close();
	assert.equal(page.focused, chip, "the chip that opened the sheet has the focus again");
	const gone = new El("button");
	page.body.append(gone);
	gone.focus();
	sheet.open(["acme"]);
	gone.remove();
	dialog.close();
	assert.notEqual(page.focused, gone, "a control that left the page is not focused");
});

test("the style sheets: Raven's yard sheet is opaque, the phone's code link keeps its 44 px by padding (no empty band), a train's note takes three lines, and a waiting train's idle card shows waiting", () => {
	const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
	const style = css("../gui/style.css"), raven = css("../gui/themes/raven/raven.css");
	const sheet = /\[data-view="raven"\] dialog\.sheet\.yard\s*\{([^}]*)\}/.exec(raven)?.[1] ?? "";
	assert.match(sheet, /background:\s*(#[0-9a-f]{6}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))\s*;/i, "V-F003: a colour with no alpha, or the page ghosts through the keep's panel");
	const hit = /^\s*a\.yard-code, a\.yard-integrator \{([^}]*)\}/m.exec(style)?.[1] ?? "";
	assert.match(hit, /padding-block:\s*\d+px/);
	assert.match(hit, /margin-block:\s*-\d+px/, "V-F007: the padding is taken back, so the row does not grow");
	assert.doesNotMatch(hit, /min-height|inline-flex/);
	assert.match(style, /\.plate:has\(use\[data-icon="train"\]\) svg \{[^}]*\* 0\.68/, "V-F006: the locomotive is drawn larger than the other glyphs");
	assert.match(style, /use\[data-icon="train"\] \{[^}]*stroke-width:\s*9px/, "and with a heavier outline");
	assert.match(style, /\.unit\[data-train-note\] \.note \{[^}]*-webkit-line-clamp:\s*3/, "V-F004");
	assert.match(style, /\.unit\[data-train-wait\]\[data-mark="idle"\][^{]*\.badge::after \{[^}]*content:\s*"[^"z]+"/, "V-F005: not the idle z");
	assert.match(style, /\.unit\[data-train-wait\]\[data-mark="idle"\] > \.card \{[^}]*opacity:\s*1/, "and not dimmed as an idle card");
	const geek = css("../gui/themes/geek/geek.css");
	assert.match(geek, /\[data-view="geek"\] \.unit\[data-train-wait\]\[data-mark="idle"\] \{[^}]*--tag:\s*"\[waiting\]"/, "V2-F001 (boss 11-08): Geek tags a waiting train [waiting] on the map, the word its yard row shows, not a parked main's [IDLE]");
});

test("the yard sheet returns the focus to the control that was clicked even when it never had the focus, as in Safari (TPG2-F001)", async () => {
	const { mountYard } = await import("../gui/yard.ts");
	const sheet = mountYard();
	const dialog = page.body.find((x) => x.tag === "dialog").at(-1) as El & { open: boolean; close(): void };
	const chip = new El("button");
	page.body.append(chip);
	sheet.open(["acme"], chip as unknown as HTMLElement);
	assert.notEqual(page.focused, chip);
	dialog.close();
	assert.equal(page.focused, chip, "the chip that was clicked, never focused, has the focus after the sheet closes");
	const main = readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8");
	assert.match(main, /yard\.open\(.*, opener(?:, opener\.dataset\.yardCode)?\)/, "main.ts hands the clicked element to the sheet (and a car card's train code)");
});

test("the phone's yard header keeps each count with its word, and the map's wait note does not break inside a name (V2-F002, V2-F003)", async () => {
	const { mountYard } = await import("../gui/yard.ts");
	const sheet = mountYard();
	const dialog = page.body.find((x) => x.tag === "dialog").at(-1) as El & { open: boolean };
	useYards(new Map(), new Map());
	sheet.net({ bases: [], yards: { projects: [{ project: "acme", trains: [], waiting: [], forming: [{ code: "2026-11-08-f", app: "api", status: "refused", cars: [] }] }] } } as never);
	sheet.open(["acme"]);
	const others = dialog.find((x) => x.classes.has("yard-others"))[0]!;
	assert.ok(others.find((x) => x.classes.has("yard-other")).length >= 1, "each count with its word is a piece of its own");
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
	assert.match(css, /\.yard-other\s*\{[^}]*white-space:\s*nowrap/, "a piece never breaks inside");
	const { waitWords } = await import("../gui/trains.ts");
	const words = waitWords({ target: { holder: "2026-11-08-b", target: "target-a", why: "live" } } as never);
	assert.ok(!/target-(?!\u2060)a/.test(words) && words.includes("target-\u2060a"), "a hyphen in a name has a word joiner after it, so the line does not break there");
});
