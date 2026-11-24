import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { BoardViewRow, CapView } from "../src/boardview.ts";
import type { Net } from "../src/net.ts";
import { rulesOf } from "./css-rules.ts";
import { El, sessionGlobals } from "./fake-dom.ts";

// The supply board on the head page (docs/specs/2026-11-24-capacity-supply/spec.md): the tray of 1-point slots with the deployed units spanning their points, the empty slots and their pulse only while under capacity,
// the barracks with the ready work, the fold's mini slots, each main's units and ready count, the teammate devices, and what Geek and Zen leave out.

sessionGlobals();
const { fillBoard, io } = await import("../gui/board.ts");
const { trayOf } = await import("../gui/supply.ts");
const { m } = await import("../gui/paraglide/messages.js");
const { SENTENCES: GEEK } = await import("../gui/themes/geek/sentences.ts");

const NOW = Date.parse("2026-11-24T10:00:00Z"), MIN = 60_000;
const CAP: CapView = { points: 6, budget: 20, load1: 0.24, cores: 8, ready: 5, underMinutes: 12, paused: 1 };
const row = (over: Partial<BoardViewRow> & Pick<BoardViewRow, "session">): BoardViewRow => ({ workspace: "Alpha", tab: "api", main: over.session, state: "working", items: [], ...over });
const ROWS: BoardViewRow[] = [
	row({ session: "api-fix", now: "refund tests", updated: NOW - 3 * MIN, points: 6, ready: 5, units: [{ name: "api-build", points: 2 }, { name: "web-test", points: 2 }, { name: "db-check", points: 2 }] }),
	row({ session: "docs-pass", state: "idle", points: 0, ready: 0, units: [], paused: "quota · resumes 16:02", pausedUntil: NOW + 90 * MIN }),
	row({ session: "web-polish", state: "idle", points: 0, ready: 0, units: [], stale: true, clearable: true, updated: NOW - 120 * MIN }),
];
const unit = (key: string) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "idle" as const, subs: [] });
const ally = { id: "a1", team: "t", teamName: "Team", device: "d1", short: "d1", label: "Box 01", online: false, workspace: null, tower: "unknown", tabs: [] };
const net = (cap: CapView | undefined = CAP, rows = ROWS): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "idle", tower: null, tabs: [{ id: "t1", label: "api", units: rows.map((r) => unit(r.session)) }], outposts: [], outside: [] }], board: rows, ...(cap ? { capacity: cap } : {}), link: { allies: [ally, { ...ally, id: "a2" }], alerts: [], confirms: [], units: [] } } as Net);
const box = () => {
	const b = new El("details"), summary = new El("summary"), t = new El("b"), mini = new El("i"), s = new El("span"), body = new El("div");
	mini.className = "board-mini";
	body.className = "board-rows";
	summary.append(t, mini, s);
	b.append(summary, body);
	return b;
};
const drawn = (n: Net) => (io.now = () => NOW, ((b) => (fillBoard(b as never, n), b))(box()));
const texts = (b: El, sel: string) => b.querySelectorAll(sel).map((e) => e.textContent);

test("trayOf: each unit spans its points in whole slots in order, points no unit names fill used slots, the rest of the budget is free, and the pulse is only while under capacity", () => {
	const t = trayOf(CAP, ROWS);
	assert.deepEqual(t.chips.map((c) => [c.name, c.cells, c.start]), [["api-build", 2, 0], ["web-test", 2, 2], ["db-check", 2, 4]]);
	assert.deepEqual([t.filler, t.free, t.budget, t.under], [0, 14, 20, true]);
	assert.equal(trayOf({ ...CAP, underMinutes: undefined }, ROWS).under, false, "room not yet held 10 minutes: no pulse");
	assert.deepEqual(((x) => [x.filler, x.free, x.budget, x.under])(trayOf({ ...CAP, budget: undefined }, ROWS)), [0, 0, undefined, false], "no budget: no free slot, no pulse");
	assert.deepEqual(((x) => [x.chips.map((c) => c.cells), x.filler, x.free])(trayOf({ ...CAP, points: 3.5 }, [row({ session: "a", units: [{ name: "w", points: 0.5 }] })])), [[1], 3, 16], "half a point takes a slot; a train no todo names fills one");
	assert.deepEqual(((x) => [x.free, x.under])(trayOf({ ...CAP, points: 24 }, ROWS)), [0, false], "over the budget: nothing free");
	assert.equal(trayOf({ ...CAP, points: 0 }, [row({ session: "gone", state: "ended", units: [{ name: "x", points: 1 }] })]).chips.length, 0, "an ended row deploys nothing");
});

test("expanded: the tray's header, a chip per unit spanning its slots with accessible text, the numbered free slots pulsing while under capacity, the free count, and the barracks with the ready work", () => {
	const b = drawn(net());
	const tray = b.querySelector(".board-supply")!;
	assert.equal(tray.hidden, false);
	assert.equal(tray.querySelector("h4")!.textContent, m.supply_title());
	assert.match(tray.querySelector(".supply-points")!.textContent, /6 \/ 20 pts/);
	assert.equal(tray.querySelector(".supply-load")!.textContent, "load 0.24 / 8 cores");
	const chips = tray.querySelectorAll(".supply-chip");
	assert.deepEqual(chips.map((c) => [c.querySelector("b")!.textContent, c.style.gridColumn, c.getAttribute("aria-label")]), [["api-build", "span 2", "api-build · 2 pts"], ["web-test", "span 2", "web-test · 2 pts"], ["db-check", "span 2", "db-check · 2 pts"]]);
	assert.deepEqual(chips[0]!.querySelectorAll(".supply-cell i").map((i) => i.textContent), ["01", "02"]);
	const slots = tray.querySelectorAll(".supply-slot");
	assert.equal(slots.length, 14);
	assert.deepEqual([slots[0]!.getAttribute("aria-label"), slots.at(-1)!.getAttribute("aria-label")], [m.supply_slot_free({ n: "07" }), m.supply_slot_free({ n: "20" })]);
	assert.equal(tray.querySelector(".supply-tray")!.hasAttribute("data-under"), true);
	assert.equal(tray.querySelector(".supply-free")!.textContent, m.supply_free({ count: 14 }));
	assert.equal(tray.querySelector(".supply-units")!.textContent, m.supply_units_same({ count: 3, points: "2" }));
	assert.equal(tray.querySelector(".supply-barracks h5")!.textContent, m.supply_barracks());
	assert.equal(tray.querySelector(".supply-ready")!.textContent, m.supply_ready({ count: 5 }));
	assert.equal(tray.querySelectorAll(".supply-waiting svg").length, 5);
	assert.equal(drawn(net({ ...CAP, underMinutes: undefined })).querySelector(".supply-tray")!.hasAttribute("data-under"), false, "no pulse while not under capacity");
});

test("no budget: the deployed units only, no empty slot and no free count, and the tray says the budget is not set", () => {
	const tray = drawn(net({ ...CAP, budget: undefined })).querySelector(".board-supply")!;
	assert.equal(tray.querySelectorAll(".supply-chip").length, 3);
	assert.equal(tray.querySelectorAll(".supply-slot").length, 0);
	assert.equal(tray.querySelector(".supply-free"), null);
	assert.equal(tray.querySelector(".supply-unset")!.textContent, m.supply_unset());
	assert.match(tray.querySelector(".supply-points")!.textContent, new RegExp(m.supply_used({ points: "6" })));
});

test("folded: the summary's mini slots, used ones lit; no budget lights only the used ones; no capacity, none", () => {
	const mini = (n: Net) => drawn(n).querySelector(".board-mini")!;
	assert.deepEqual([mini(net()).querySelectorAll("i").length, mini(net()).querySelectorAll("i[data-on]").length], [20, 6]);
	assert.deepEqual([mini(net({ ...CAP, budget: undefined })).querySelectorAll("i").length, mini(net({ ...CAP, budget: undefined })).querySelectorAll("i[data-on]").length], [6, 6]);
	assert.equal(mini(net(null as never)).querySelectorAll("i").length, 0);
	assert.equal(drawn(net(null as never)).querySelector(".board-supply")?.hidden ?? true, true, "no capacity, no tray");
});

test("each main: its insignia, its unit chips and ready count, the phone's one line, a pause with the moon and its time, a stale main with the hourglass; the commanders' head names the columns", () => {
	const b = drawn(net()), r = (s: string) => b.querySelector(`.board-row[data-session="${s}"]`)!;
	assert.deepEqual(texts(b, ".supply-cols span"), [m.supply_mains(), m.supply_col_units(), m.supply_col_ready()]);
	assert.equal(r("api-fix").querySelector(".board-mark use")!.dataset.icon, "main");
	assert.deepEqual(texts(r("api-fix"), ".board-unit"), ["api-build", "web-test", "db-check"]);
	assert.equal(r("api-fix").querySelector(".board-ready")!.textContent, m.supply_row_ready({ count: 5 }));
	assert.equal(r("api-fix").querySelector(".board-cap-phone")!.textContent, m.supply_row_phone({ points: "6", count: 5 }));
	assert.equal(r("docs-pass").querySelector(".board-units")!.textContent, m.supply_none({ points: "0" }));
	assert.equal(r("docs-pass").querySelector(".board-pause use")!.dataset.icon, "paused");
	assert.match(r("docs-pass").querySelector(".board-pause")!.textContent, /16:02|\d\d:\d\d/);
	assert.equal(r("web-polish").querySelector(".board-state use")!.dataset.icon, "stale");
	assert.equal(r("web-polish").querySelector(".board-state")!.textContent, m.board_idle_word(), "the status word stays");
	assert.equal(r("api-fix").querySelector(".board-state use"), null);
	assert.equal(r("api-fix").querySelector(".board-cap")!.textContent, "6 pts · 5 ready", "Geek's plain line is still there");
});

test("teammate devices: one row each from what crosses (label, online), never a unit name or a capacity figure", () => {
	const b = drawn(net());
	const rows = b.querySelectorAll(".board-ally");
	assert.equal(rows.length, 1, "one device in two teams is one row");
	assert.equal(rows[0]!.querySelector("b")!.textContent, "Box 01");
	assert.match(rows[0]!.textContent, new RegExp(m.supply_ally_off()));
	assert.equal(rows[0]!.hasAttribute("data-online"), false);
	assert.equal(drawn({ ...net(), link: undefined }).querySelector(".board-ally"), null);
});

const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), geek = readFileSync(new URL("../gui/themes/geek/geek.css", import.meta.url), "utf8"), raven = readFileSync(new URL("../gui/themes/raven/raven.css", import.meta.url), "utf8");
const animated = (sheet: string) => rulesOf(sheet).filter((r) => /supply|board-mini/.test(r.selector) && /animation:\s*[a-z]/.test(r.body) && !/animation:\s*none/.test(r.body));

test("motion: the pulse and the mist run only under prefers-reduced-motion: no-preference, and calm stills them", () => {
	for (const [name, sheet] of [["style.css", css], ["raven.css", raven]] as const) {
		assert.ok(animated(sheet).length > 0, `${name} animates the free slots`);
		const outside = sheet.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
		assert.equal(animated(outside).length, 0, `${name}: no supply animation outside the no-preference block`);
	}
	assert.match(css, /\[data-calm\][^{]*\.supply-tray[^{]*\{[^}]*animation: none/);
});

test("Geek keeps the plain text: no tray, mini slots, chips, or icons; the row's capacity line shows. Zen shows no capacity at all", () => {
	for (const sel of [".board-supply", ".board-mini", ".supply-cols", ".board-supply-row", ".board-pause", ".board-mark", ".board-state svg", ".board-allies"]) assert.ok(rulesOf(geek).some((r) => r.parts.some((p) => p.startsWith('[data-view="geek"]') && p.includes(sel)) && /display:\s*none/.test(r.body)), `Geek hides ${sel}`);
	assert.ok(rulesOf(geek).some((r) => r.parts.some((p) => p.includes(".board-line .board-cap")) && /display:\s*inline/.test(r.body)), "Geek shows the row's capacity text");
	assert.deepEqual(GEEK, { "zh-TW": { board_title: "工作板", board_label: "工作板", board_ask: "問進度" }, en: { board_title: "Work board", board_label: "Work board", board_ask: "Ask progress" } }, "Geek keeps the board's words; 戰況板 and 詢問戰況 are Standard's");
	assert.match(css, /html\[data-view="zen"\] :is\(\.shell, \.dock\) \{ display: none; \}/, "Zen hides the page that carries the board");
	for (const name of readdirSync(new URL("../gui/", import.meta.url)).filter((n) => /^zen.*\.ts$/.test(n))) assert.ok(!/capacity|\.board\b|supply/.test(readFileSync(new URL(`../gui/${name}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "")), `${name} reads no capacity`);
});

test("a row's status keeps its icon and word on one line (the note and the age wrap instead), and a phone's free slot centres its +", () => {
	const rule = (sel: string) => rulesOf(css).filter((r) => r.parts.includes(sel)).map((r) => r.body).join(";");
	for (const sel of [".board-state", ".board-pause"]) assert.match(rule(sel), /white-space:\s*nowrap/, `${sel} does not break`);
	const phone = /@media \(max-width: 640px\) \{[\s\S]*?\n\}/g, inPhone = [...css.matchAll(phone)].map((x) => x[0]).join("\n");
	assert.ok(rulesOf(inPhone).some((r) => r.parts.includes(".supply-slot") && /place-items:\s*center/.test(r.body) && /grid-template-rows:\s*1fr/.test(r.body)), "the phone's slot centres its +");
});
