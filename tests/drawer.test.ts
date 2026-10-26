import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import { groupUnits, quitable, shortState } from "../gui/drawer.ts";
import { m } from "../gui/paraglide/messages.js";
import { aimUnit } from "../gui/quit.ts";
import { aimOpening } from "../gui/render.ts";
import { FLICK, HALF, ignored, intent, type Probe, settles, SLOP } from "../gui/swipe.ts";

// The phone drawer: when a swipe is a drag (direction, threshold, and what it must not start on), when a released drawer stays, and the list it shows.

test("a swipe is read after SLOP px, and is a drag only when it is mostly horizontal and goes the drawer's way", () => {
	assert.equal(intent(SLOP - 1, 0, false), "wait", "too early to say");
	assert.equal(intent(0, SLOP - 1, false), "wait");
	assert.equal(intent(30, 4, false), "drag", "rightwards, flat: pulls the drawer out");
	assert.equal(intent(-30, 4, false), "pass", "leftwards on the page opens nothing");
	assert.equal(intent(-30, 4, true), "drag", "leftwards on the open drawer pushes it in");
	assert.equal(intent(30, 4, true), "pass", "rightwards on the open drawer has nothing to do");
	assert.equal(intent(30, 30, false), "pass", "a diagonal belongs to the page");
	assert.equal(intent(12, 40, false), "pass", "vertical scrolling is never taken");
	assert.equal(intent(17, 10, false), "drag", "just inside the ratio");
	assert.equal(intent(16, 10, false), "pass", "just outside it");
	assert.equal(intent(5, 40, false), "pass", "the decision comes from the longer axis even before the other passes SLOP");
});

test("a released drawer stays open when pulled past 40% of its width or flicked open, and shuts when flicked shut", () => {
	const width = 300;
	assert.equal(settles(width * HALF, width, 0), true, "pulled past the threshold");
	assert.equal(settles(width * HALF - 1, width, 0), false, "short of it");
	assert.equal(settles(10, width, FLICK), true, "a flick rightwards opens it however far it went");
	assert.equal(settles(290, width, -FLICK), false, "a flick leftwards shuts it however far it was");
	assert.equal(settles(100, width, FLICK - 0.01), false, "a slow release is judged by the distance");
});

test("a touch that starts in a text box, the composer, the terminal's key sink, something that scrolls sideways, or selected text is not the drawer's", () => {
	const div: Probe = { tag: "div" }, page: Probe[] = [div, { tag: "section" }, { tag: "body" }];
	assert.equal(ignored(page, false), false, "plain page");
	for (const bad of [{ tag: "textarea" }, { tag: "input" }, { tag: "select" }, { tag: "div", editable: true }, { tag: "form", sink: true }, { tag: "pre", scrollsX: true }, { tag: "div", scrollsX: true }]) assert.equal(ignored([div, bad, { tag: "body" }], false), true, JSON.stringify(bad));
	assert.equal(ignored(page, true), true, "text is selected: the finger is moving the selection's handles");
	assert.equal(ignored([{ tag: "pre", scrollsX: false }, { tag: "body" }], false), false, "a code block that fits scrolls nowhere");
});

const unit = (key: string, name: string, role: Unit["role"], mark: Unit["mark"], subs: Unit[] = [], extra: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role, mark, subs, ...extra });

test("the list is every unit of every base, grouped as the map groups them: the tower with its subagents, each tab's units with theirs, then the units outside the net", () => {
	const net: Net = { bases: [
		{ id: "w1", label: "Harbor", mark: "working", head: true, tower: { name: "tower · Harbor", mark: "idle", key: "t1", control: true, subs: [unit("t1/scout", "scout", "subagent", "working", [], { note: "tool:read" })] },
			tabs: [{ id: "w1:t1", label: "billing", units: [unit("a1", "billing-main", "main", "commanding", [unit("a1/docs", "docs", "subagent", "done", [], { ended: true })], { note: "watching a monitor" }), unit("a2", "billing-tests", "member", "waiting")] }],
			outposts: [{ id: "w1-fix", label: "hotfix", mark: "working" }], outside: [unit("o1", "scratch", "outside", "idle")] },
		{ id: "w2", label: "Empty", mark: "idle", head: false, tower: null, tabs: [], outposts: [], outside: [] },
	] };
	const list = groupUnits(net);
	assert.deepEqual(list.map((b) => [b.id, b.label, b.groups.map((g) => [g.id, g.label])]), [["w1", "Harbor", [["tower", undefined], ["w1:t1", m.tab_label({ label: "billing" })], ["outside", m.outside_net()]]]], "a base with nothing in it is left out, and so is an outpost (it has no comms)");
	assert.deepEqual(list[0]!.groups.map((g) => g.rows.map((r) => [r.key, r.sub, r.role, r.mark, r.ws])), [
		[["t1", false, "tower", "idle", "w1"], ["t1/scout", true, "subagent", "working", "w1"]],
		[["a1", false, "main", "commanding", "w1"], ["a1/docs", true, "subagent", "done", "w1"], ["a2", false, "member", "waiting", "w1"]],
		[["o1", false, "outside", "idle", "w1"]],
	]);
	const [scout, , docs] = [list[0]!.groups[0]!.rows[1]!, 0, list[0]!.groups[1]!.rows[1]!];
	assert.equal(scout.note, "tool:read");
	assert.equal(docs.ended, true);
	assert.equal(list[0]!.groups[1]!.rows[0]!.note, "watching a monitor");
});

test("a unit's state is one short word, the same colours as the map's, in both languages; a finished subagent says it ended", () => {
	for (const mark of ["working", "waiting", "idle", "done", "error", "unknown", "commanding"] as const) for (const locale of ["en", "zh-TW"] as const) assert.ok(shortState(mark, false, locale).length > 0 && shortState(mark, false, locale).length <= 10, `${mark} ${locale}`);
	assert.deepEqual(["working", "waiting", "idle", "commanding"].map((k) => shortState(k as "working", false, "zh-TW")), ["工作中", "等待", "閒置", "指揮中"]);
	assert.equal(shortState("done", true, "zh-TW"), "已結束");
	assert.equal(shortState("done", true, "en"), "ended");
});

test("the drawer's way back to the map and its Dismiss finished button are worded in every locale", () => {
	for (const locale of ["en", "zh-TW"] as const) {
		assert.ok(m.drawer_map({}, { locale }).length > 0, locale);
		assert.match(m.dismiss_all({ count: 2 }, { locale }), /2/, locale);
	}
	assert.equal(m.drawer_map({}, { locale: "zh-TW" }), "回到主地圖");
});

// The left pane on a phone: the tower as a row of two buttons, the way back to the map stuck to the bottom, and a Quit on a main that is idle.
const harbor = (): Net["bases"][number] => ({ id: "w1", label: "Harbor", mark: "idle", head: true, tower: { name: "tower · Harbor", mark: "idle", key: "t1", control: true, subs: [] }, tabs: [{ id: "w1:t1", label: "billing", units: [] }], outposts: [], outside: [] });
type Fake = HTMLElement & { attrs: Record<string, string> };
const fake = (): Fake => {
	const attrs: Record<string, string> = {};
	return { dataset: {} as Record<string, string>, hidden: false, textContent: "", attrs, setAttribute: (k: string, v: string) => void (attrs[k] = v) } as unknown as Fake;
};
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, list]) => list!.split(",").some((s) => s.trim() === selector)).map(([, , body]) => body).join(";");

test("only a main that is idle is offered Quit in the list: not while it is commanding or working, and not a tower, a member, or a subagent", () => {
	for (const mark of ["commanding", "working", "waiting", "done", "error", "unknown"] as const) assert.equal(quitable({ role: "main", mark }), false, `a ${mark} main`);
	assert.equal(quitable({ role: "main", mark: "idle" }), true);
	for (const role of ["tower", "member", "subagent", "outside"]) assert.equal(quitable({ role, mark: "idle" }), false, role);
});

test("the list's Quit is the map's own: the same request data, the same labels, and hidden from a main this session cannot control", () => {
	const net: Net = { bases: [{ ...harbor(), tabs: [{ id: "w1:t1", label: "billing", units: [unit("a1", "billing-main", "main", "idle"), unit("a2", "ops-main", "main", "idle", [], { control: false }), unit("a3", "tests-main", "main", "commanding")] }] }] };
	const rows = groupUnits(net)[0]!.groups[1]!.rows;
	assert.deepEqual(rows.map((r) => [r.key, r.control]), [["a1", true], ["a2", false], ["a3", true]], "a row says whether this session can control it");
	const button = fake();
	aimUnit(button, rows[0]!);
	assert.equal(button.hidden, false);
	assert.deepEqual({ ...button.dataset }, { close: "unit", key: "a1", name: "billing-main", role: "main" });
	assert.equal(button.textContent, m.quit());
	assert.equal(button.attrs["aria-label"], m.close_unit({ name: "billing-main" }));
	aimUnit(button, rows[1]!);
	assert.equal(button.hidden, true, "a main it cannot control cannot be quit");
});

test("the tower's + is the map's + Main aimed at the tower's base: it opens a main there, and a base with no tower takes no main", () => {
	const b = harbor(), button = fake();
	aimOpening(button, b);
	assert.deepEqual({ ...button.dataset }, { open: "main", ws: "w1" });
	assert.equal(button.hidden, false);
	assert.equal(m.open_main_title({ base: "Harbor" }, { locale: "zh-TW" }), "在 Harbor 開新的主智慧體");
	const bare = fake();
	aimOpening(bare, { ...b, tower: null });
	assert.equal(bare.dataset.open, "member", "the rule is the map's; the drawer has a + only on a tower's row, so it never gets here");
	const source = readFileSync(new URL("../gui/drawer.ts", import.meta.url), "utf8");
	assert.match(source, /aria-label", m\.open_main_title\(\{ base: base\.label \}\)/, "the + is named by the same title the tower's comms use");
	assert.match(source, /closest\("a\[data-route\], button\[data-open\], \.x"\) && settle\(false\)/, "a tap on the + shuts the drawer, so the tile that opens is not behind it");
	assert.match(source, /group\.id === "tower"\) sync\([^;]*towerEl, fillTower\)/, "only the tower group is drawn as the row");
});

test("the way back to the map is the drawer's foot, outside the list that scrolls, above the home indicator", () => {
	assert.match(rule(".drawer-foot"), /flex:\s*none/);
	assert.match(rule(".drawer-foot"), /padding:[^;]*env\(safe-area-inset-bottom\)/, "clear of the home indicator");
	assert.match(rule(".drawer-body"), /flex:\s*1/);
	assert.match(rule(".drawer-body"), /min-height:\s*0/, "the list scrolls inside its own box, so the foot never covers its last unit");
	assert.doesNotMatch(rule(".drawer-map"), /position:\s*(sticky|fixed|absolute)/, "it stays in the flow of the foot");
	const source = readFileSync(new URL("../gui/drawer.ts", import.meta.url), "utf8");
	assert.match(source, /h\("footer", \{ class: "drawer-foot" \}, home\)/, "the link is in the foot");
	assert.doesNotMatch(source, /drawer-top"[^)]*home/, "and not above the list");
});
