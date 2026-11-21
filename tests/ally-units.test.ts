import assert from "node:assert/strict";
import { test } from "node:test";
import type { UnitCard } from "../gui/linkmodel.ts";
import { El, page } from "./fake-dom.ts";
import { until } from "./fakes.ts";

// An unattended device's units on the card of its ally base (gui/allyunits.ts), on the fake document: the state word and when it was updated, the monitors on one line, the report folded to its first line, a crash's notice behind a
// fold, a stale unit marked; a teammate's text only ever becomes text.

const { fillAllyUnits } = await import("../gui/allyunits.ts");
const { m } = await import("../gui/paraglide/messages.js");

const card = (over: Partial<UnitCard> = {}): UnitCard => ({ unit: "Harbor API", state: "running", tone: "working", word: m.link_unit_running(), at: Date.now() - 40_000, stale: false, monitors: [], report: "", team: "t", device: "d1", mains: [], ...over });
const draw = (cards: UnitCard[], named = false) => {
	const list = new El("ul");
	page.body.replaceChildren(list);
	fillAllyUnits(list as unknown as HTMLElement, cards, named);
	return list;
};
const one = (list: El, selector: string) => list.querySelector(selector)!;

test("a unit says its state in a word and when it was updated, with its tone for the colour; the card's title is its name, so a unit of a workspace does not repeat it", () => {
	const list = draw([card()]);
	const li = one(list, ".ally-unit");
	assert.equal(li.dataset.tone, "working");
	assert.equal(one(list, ".au-word").textContent, m.link_unit_running());
	assert.equal(one(list, ".au-name").textContent, "", "no name beside the card's title");
	assert.equal(one(list, ".au-head .age").textContent, "40s");
	assert.ok(Number(one(list, ".au-head .age").dataset.since) > 0, "the page's clock keeps it current");
	assert.equal(one(list, ".au-head .au-time").textContent, `${m.link_unit_updated_pre()}40s${m.link_unit_updated_post()}`);
	assert.equal(draw([card({ unit: "Quarry Tools" })], true).querySelector(".au-name")!.textContent, "Quarry Tools", "a whole device (no workspace of its own) says each unit's name");
});

test("a tower's state word says in its tooltip that its runs are short and it stands by between them; a unit mark that is no tower state has none", () => {
	for (const state of ["standing", "running", "waking"]) assert.equal(one(draw([card({ state })]), ".au-word").title, m.link_unit_run_hint(), state);
	assert.equal(one(draw([card({ state: "working" })]), ".au-word").title, "");
	assert.equal(one(draw([card({ state: "held" })]), ".au-word").title, "", "a held tower is in trouble, not between runs");
});

test("monitors are one compact line with their count, and none draws nothing", () => {
	const list = draw([card({ monitors: ["tail -f deploy.log", "npm run watch"] })]);
	assert.equal(one(list, ".au-mons").hidden, false);
	assert.equal(one(list, ".au-mons b").textContent, m.link_unit_monitors({ count: 2 }));
	assert.equal(one(list, ".au-mons span").textContent, "tail -f deploy.log · npm run watch");
	assert.equal(draw([card()]).querySelector(".au-mons")!.hidden, true);
});

test("the report is folded to its first line with no Markdown marks, and no report draws no fold", () => {
	const list = draw([card({ report: "## Staging deploy\n\nDeployed **v1.2**." })]);
	const fold = one(list, ".au-report");
	assert.equal(fold.hidden, false);
	assert.equal(one(list, ".au-label").textContent, m.link_unit_report());
	assert.equal(one(list, ".au-peek").textContent, "Staging deploy");
	assert.equal(one(list, ".au-md").textContent, "", "its Markdown is made when the fold opens");
	assert.equal(draw([card()]).querySelector(".au-report")!.hidden, true);
});

test("a crash shows its word and its notice behind a fold of its own, with how long ago; no crash hides the fold", () => {
	const list = draw([card({ tone: "crashed", word: m.link_unit_crashed(), state: "standing", crash: { at: Date.now() - 4 * 60_000, text: "An ally run crashed: <b>exit 1</b>" } })]);
	assert.equal(one(list, ".ally-unit").dataset.tone, "crashed");
	assert.equal(one(list, ".au-word").textContent, m.link_unit_crashed());
	const fold = one(list, ".au-crash");
	assert.equal(fold.hidden, false);
	assert.equal(one(list, ".au-crash summary b").textContent, m.link_unit_crash());
	assert.equal(one(list, ".au-crash .age").textContent, "4m");
	assert.equal(one(list, ".au-crash pre").textContent, "An ally run crashed: <b>exit 1</b>", "text, never markup");
	assert.equal(draw([card()]).querySelector(".au-crash")!.hidden, true);
});

test("a stale unit is marked in words and drawn as stale; a fresh one is not", () => {
	const stale = draw([card({ stale: true, at: Date.now() - 8 * 60_000 })]);
	assert.equal(one(stale, ".au-stale").hidden, false);
	assert.equal(one(stale, ".au-stale").textContent, m.link_unit_stale());
	assert.ok(one(stale, ".ally-unit").classes.has("stale"));
	assert.equal(one(stale, ".au-head .age").textContent, "8m");
	const fresh = draw([card()]);
	assert.equal(one(fresh, ".au-stale").hidden, true);
	assert.equal(one(fresh, ".ally-unit").classes.has("stale"), false);
});

test("a redraw keeps the unit's element (and so its open folds) and a unit that is gone leaves", () => {
	const list = new El("ul");
	page.body.replaceChildren(list);
	const el = list as unknown as HTMLElement;
	fillAllyUnits(el, [card({ report: "one" })], false);
	const first = list.querySelector(".ally-unit")!;
	fillAllyUnits(el, [card({ report: "two", state: "standing", tone: "idle", word: m.mark_standing() })], false);
	assert.equal(list.querySelector(".ally-unit"), first);
	assert.equal(one(list, ".au-peek").textContent, "two");
	assert.equal(first.dataset.state, "standing");
	fillAllyUnits(el, [], false);
	assert.equal(list.children.every((x) => x.classes.has("leaving")), true);
});

test("ALLY-F005: opening the report's fold paints its Markdown (headings and lists) in a chunk of its own; raw HTML and a javascript: link stay text", async () => {
	const report = "## Staging deploy\n\n- Migration `0042` applied\n- **green** 48 of 48\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.com)";
	Object.assign(document, { createDocumentFragment: () => new El("#fragment"), createTextNode: (t: string) => t }); // the fake document has neither
	const list = draw([card({ report })]);
	const fold = one(list, ".au-report") as El & { open: boolean; ontoggle: () => void };
	assert.equal(list.querySelectorAll(".au-md h2").length, 0, "nothing is made while the fold is shut");
	fold.open = true;
	fold.ontoggle();
	await until(() => list.querySelectorAll(".au-md h2").length === 1, "the heading");
	assert.equal(list.querySelectorAll(".au-md ul li").length, 2);
	assert.equal(list.querySelectorAll(".au-md strong").length, 1);
	assert.equal(list.querySelectorAll(".au-md img").length, 0, "an <img onerror> is text");
	assert.deepEqual(list.querySelectorAll(".au-md a").map((a) => a.getAttribute("href")), ["https://example.com"], "only the https link is a link; the javascript: one is text");
	assert.ok(one(list, ".au-md").textContent.includes("<img src=x onerror=alert(1)>") && one(list, ".au-md").textContent.includes("javascript:alert(1)"));
	// A redraw with another report repaints the open fold; a shut fold keeps its last Markdown until it opens again.
	fillAllyUnits(list as unknown as HTMLElement, [card({ report: "# Second" })], false);
	await until(() => list.querySelectorAll(".au-md h1").length === 1, "the new report");
	assert.equal(list.querySelectorAll(".au-md h2").length, 0);
});

test("ALLY-F003: a trust question nobody answered reads 'Why it stopped' with the notice and the hint where trust is granted; a crash keeps 'What happened' and no hint", () => {
	const at = Date.now() - 4 * 60_000;
	const trust = draw([card({ tone: "waiting", word: m.link_unit_trust(), state: "standing", crash: { at, text: "An ally run crashed: No trust decision for /work/p", trust: true } })]);
	assert.equal(one(trust, ".ally-unit").dataset.tone, "waiting");
	assert.equal(one(trust, ".au-word").textContent, m.link_unit_trust());
	assert.equal(one(trust, ".au-crash summary b").textContent, m.link_unit_trust_why());
	assert.equal(one(trust, ".au-crash pre").textContent, "An ally run crashed: No trust decision for /work/p");
	assert.equal(one(trust, ".au-hint").hidden, false);
	assert.equal(one(trust, ".au-hint").textContent, m.link_unit_trust_hint());
	assert.ok(one(trust, ".au-crash").hasAttribute("data-trust"));
	const crashed = draw([card({ tone: "crashed", word: m.link_unit_crashed(), state: "standing", crash: { at, text: "An ally run crashed: exit 1" } })]);
	assert.equal(one(crashed, ".au-crash summary b").textContent, m.link_unit_crash());
	assert.equal(one(crashed, ".au-hint").hidden, true);
	assert.equal(one(crashed, ".au-crash").hasAttribute("data-trust"), false);
	// The same element redrawn from a trust notice to a crash drops the hint.
	fillAllyUnits(trust as unknown as HTMLElement, [card({ tone: "crashed", word: m.link_unit_crashed(), state: "standing", crash: { at, text: "An ally run crashed: exit 1" } })], false);
	assert.equal(one(trust, ".au-hint").hidden, true);
	assert.equal(one(trust, ".au-crash summary b").textContent, m.link_unit_crash());
});

// The card itself (gui/render.ts `fillAlly`): the box's own mains and workers are never listed, and the card says one state, the units'.
const ally = (over: object = {}) => ({ id: "ally/d1", teams: [{ team: "t", teamName: "moldplan" }], device: "d1", short: "9f3a1c", label: "ci-box", online: true, unattended: true, workspace: null, tower: "working", tabs: [{ label: "main \u00b7 trial13", state: "working" }, { label: "worker \u00b7 scout", state: "idle" }], ...over });
const link = (units: object[] = []) => ({ allies: [], alerts: [], confirms: [], units: units.length ? [{ team: "t", device: "d1", at: Date.now() - 5_000, units }] : [] });
const unit = (name: string, state = "standing") => ({ unit: name, state, monitors: [], report: "" });
async function drawn(a: object, l: object) {
	const { allyEl } = await import("../gui/render.ts");
	const el = allyEl() as unknown as El;
	page.body.replaceChildren(el);
	await fillAllyOn(el, a, l);
	return el;
}
async function fillAllyOn(el: El, a: object, l: object) {
	const { fillAlly } = await import("../gui/render.ts");
	fillAlly(el as unknown as HTMLElement, a as never, l as never);
}

test("ALLY-F005/F009: a card that has units lists no tab of the box; an unattended box without them says how many units are online in one line, never their names", async () => {
	const withUnits = await drawn(ally(), link([unit("Quarry Tools"), unit("Lighthouse Web")]));
	assert.equal(withUnits.querySelectorAll(".ally-tab").length, 0, "the units are the card's content, the box's mains are not listed beside them");
	await until(() => withUnits.querySelectorAll(".ally-unit").length === 2, "the units");
	assert.ok(!withUnits.dump().includes("trial13") && !withUnits.dump().includes("scout"));
	const none = await drawn(ally(), link());
	const rows = none.querySelectorAll(".ally-tab");
	assert.equal(rows.length, 1, "no unit status (an older box, a presence-only team, the minute after a restart): one summary line");
	assert.equal(rows[0]!.textContent, m.link_unit_summary({ count: 2 }));
	assert.ok(!none.dump().includes("trial13") && !none.dump().includes("scout"), "no main or worker is named");
	assert.equal((await drawn(ally({ tabs: [{ label: "main", state: "idle" }] }), link())).querySelectorAll(".ally-tab")[0]!.textContent, m.link_unit_summary({ count: 1 }));
	assert.equal((await drawn(ally({ tabs: [] }), link())).querySelectorAll(".ally-tab").length, 0, "nothing online, nothing said");
	assert.equal((await drawn(ally({ online: false }), link())).querySelectorAll(".ally-tab").length, 0, "an offline box says nothing about units");
	assert.equal((await drawn(ally({ tower: "blocked" }), link())).querySelectorAll(".ally-tab")[0]!.dataset.state, "blocked", "a question that waits keeps the line a way into the panel");
});

test("a teammate's own computer (attended) lists its mains and workers as before, with their states, and never says 'units online'; an offline one lists them without states", async () => {
	const mate = await drawn(ally({ unattended: undefined, label: "Mei's Mac" }), link());
	const rows = mate.querySelectorAll(".ally-tab");
	assert.deepEqual(rows.map((r) => r.querySelector("b")!.textContent), ["main \u00b7 trial13", "worker \u00b7 scout"], "each tab is a row");
	assert.deepEqual(rows.map((r) => r.querySelector("span")!.textContent), [m.mark_working(), m.mark_idle()], "with its state");
	assert.ok(!mate.dump().includes(m.link_unit_summary({ count: 2 })));
	assert.equal(one(mate, ".tstate").textContent, `9f3a1c \u00b7 ${m.mark_working()}`, "and the subtitle names the tower's state, as before");
	const off = await drawn(ally({ unattended: undefined, online: false }), link());
	assert.deepEqual(off.querySelectorAll(".ally-tab").map((r) => r.querySelector("span")!.textContent), ["", ""]);
	assert.equal((await drawn(ally({ unattended: undefined, tower: "blocked" }), link())).querySelectorAll(".ally-tab")[0]!.dataset.state, "working", "a row carries its own tab's state");
	const old = await drawn(ally({ unattended: undefined }), link([unit("x")]));
	assert.equal(old.querySelectorAll(".ally-tab").length, 0, "(a base that did report units shows them and no tabs, attended or not)");
});

test("ALLY-F008: once the card shows units, its subtitle names the box and whether it is there and not what its tower does; without units it says that too", async () => {
	const withUnits = await drawn(ally({ workspace: "Harbor API" }), link([unit("Harbor API", "standing")]));
	assert.equal(one(withUnits, ".tstate").textContent, "ci-box \u00b7 9f3a1c", "the unit's own word is the card's only state");
	assert.equal(one(await drawn(ally({ workspace: "Harbor API", online: false }), link([unit("Harbor API")])), ".tstate").textContent, `ci-box \u00b7 9f3a1c \u00b7 ${m.link_offline()}`);
	assert.equal(one(await drawn(ally(), link()), ".tstate").textContent, `9f3a1c \u00b7 ${m.mark_working()}`, "with no units the tower's state stands in");
});

// One card per device, however many teams it is in (docs/how-it-works.md, Unattended devices): the card names its teams on a quiet line, one status block, the device's.
const TEAMS = [{ team: "t", teamName: "moldplan" }, { team: "t2", teamName: "agent-tower-team" }];
const teamsLine = (el: El) => el.querySelector(".ally-teams")!;

test("a card of a device in two teams names both on a quiet line of its own, and the crown does not pick one of them; one team says nothing more than its crown", async () => {
	const two = await drawn(ally({ teams: TEAMS }), link([unit("Quarry Tools")]));
	assert.equal(teamsLine(two).hidden, false);
	assert.equal(teamsLine(two).textContent, m.ally_teams({ teams: `moldplan${m.ally_teams_sep()}agent-tower-team` }));
	assert.equal(one(two, ".ally-tag").textContent, m.ally_tag_many(), "the crown says teammate and no team");
	assert.ok(!one(two, ".ally-tag").textContent!.includes("moldplan"));
	const solo = await drawn(ally(), link([unit("Quarry Tools")]));
	assert.equal(teamsLine(solo).hidden, true, "one team: no line");
	assert.equal(one(solo, ".ally-tag").textContent, m.ally_tag({ team: "moldplan" }), "and the crown names it, as before");
	const back = await drawn(ally({ teams: TEAMS }), link());
	assert.equal(teamsLine(back).hidden, false);
	await fillAllyOn(back, ally(), link());
	assert.equal(teamsLine(back).hidden, true, "a card drawn again for one team loses the line");
});

test("the two-team card has one status block: the freshest unit status of either team, the unit once", async () => {
	const rows = [{ team: "t", device: "d1", at: Date.now() - 90_000, units: [{ unit: "Quarry Tools", state: "running", monitors: [], report: "old" }] }, { team: "t2", device: "d1", at: Date.now() - 5_000, units: [{ unit: "Quarry Tools", state: "standing", monitors: [], report: "new" }] }];
	const el = await drawn(ally({ teams: TEAMS }), { ...link(), units: rows });
	await until(() => el.querySelectorAll(".ally-unit").length === 1, "one unit");
	assert.equal(el.querySelectorAll(".ally-unit").length, 1);
	assert.equal(one(el, ".ally-unit").dataset.tone, "idle", "the later status, from the second team");
	assert.equal(one(el, ".au-peek").textContent, "new");
});

test("a crash told in either team shows once on the merged card", async () => {
	const at = Date.now() - 2 * 60_000;
	const note = (team: string, id: string) => ({ id, kind: "notice", level: "warning", team, teamName: team, data: { device: "d1", label: "ci-box", short: "9f3a1c", what: "run-crashed", unit: "Quarry Tools", at, text: `crashed in ${team}` } });
	const rows = [{ team: "t", device: "d1", at: Date.now() - 5_000, units: [{ unit: "Quarry Tools", state: "standing", monitors: [], report: "" }] }];
	const el = await drawn(ally({ teams: TEAMS }), { ...link(), units: rows, alerts: [note("t2", "notice/2")] });
	await until(() => el.querySelectorAll(".ally-unit").length === 1, "the unit");
	assert.equal(one(el, ".ally-unit").dataset.tone, "crashed", "the notice of the second team tells on a card that lists it");
	assert.equal(el.querySelectorAll(".au-crash").length, 1);
});

test("the demo's teams scene puts the ci-box, a teammate's computer and their units in a second team, and every other scene is unchanged", async () => {
	const { allyDemo } = await import("../gui/demo-ally.ts");
	const { mergeAllies } = await import("../gui/linkmodel.ts");
	const fresh = () => ({ allies: [{ id: "t/d1/Harbor API", team: "t", teamName: "moldplan", device: "d1", short: "9f3a1c", label: "ci-box", online: true, unattended: true as const, workspace: "Harbor API", tower: "working", tabs: [] }], alerts: [{ id: "notice/1", kind: "notice" as const, level: "warning" as const, team: "t", teamName: "moldplan", data: { device: "d1", unit: "Harbor API", what: "run-crashed", text: "x" } }], confirms: [], units: [{ team: "t", device: "d1", at: 0, units: [{ unit: "Harbor API", state: "working", monitors: [], report: "r" }] }] });
	const plain = fresh();
	allyDemo(plain, "crashed", 1_000_000);
	assert.deepEqual(mergeAllies(plain.allies).map((c) => c.teams.length), [1], "without it one team, as before");
	const link = fresh();
	allyDemo(link, "mate,teams", 1_000_000);
	const cards = mergeAllies(link.allies);
	assert.deepEqual(cards.map((c) => [c.device, c.teams.map((t) => t.teamName)]), [["d1", ["moldplan", "agent-tower-team"]], ["d3", ["moldplan", "agent-tower-team"]]], "one card per device, both teams on each");
	assert.equal(link.units.filter((u) => u.device === "d1").length, 0, "(mate says the box reports no units)");
	const withUnits = fresh();
	allyDemo(withUnits, "crashed,teams", 1_000_000);
	assert.deepEqual(withUnits.units.map((u) => u.team), ["t", "t2"]);
	assert.equal(withUnits.alerts.filter((a) => a.kind === "notice").length, 2, "the box's notice reaches both teams");
	assert.equal(new Set(withUnits.alerts.map((a) => a.id)).size, withUnits.alerts.length, "with ids of their own");
});

// ---- the Mains fold of a unit (docs/specs/2026-11-07-link-remote-stop.md §6) ---------------------------------------------------------------------------------

const { io } = await import("../gui/mainstop.ts");
const mainCard = (over: object = {}) => ({ handle: "0123456789abcdef", team: "t", name: "docs", state: "idle", tone: "idle" as const, word: m.mark_idle(), stopping: false, canStop: true, ...over });
const mains = (...cards: object[]) => card({ mains: cards as UnitCard["mains"] });

test("a unit with no mains has no fold; with mains the fold counts them and each row says its name, its state word, and the dispatcher of a main another device dispatched", () => {
	assert.equal(draw([card()]).querySelector(".au-mains")!.hidden, true);
	const list = draw([mains(mainCard(), mainCard({ handle: "fedcba9876543210", name: "api", state: "working", tone: "working", word: m.mark_working(), byLabel: "bob-mac" }))]);
	assert.equal(one(list, ".au-mains").hidden, false);
	assert.equal(one(list, ".au-mains-label").textContent, m.link_mains({ count: 2 }));
	const rows = list.querySelectorAll(".au-main");
	assert.deepEqual(rows.map((r) => [r.querySelector(".au-mname")!.textContent, r.querySelector(".au-mstate")!.textContent, r.querySelector(".au-mby")!.hidden, r.querySelector(".au-mby")!.textContent]), [
		["docs", m.mark_idle(), true, ""],
		["api", m.mark_working(), false, m.link_main_by({ who: "bob-mac" })],
	]);
	assert.equal(rows[1]!.dataset.tone, "working");
	assert.ok(rows.every((r) => r.querySelector(".au-stop")!.hidden === false && r.querySelector(".au-stop")!.textContent === m.link_main_stop()));
	assert.equal(rows[0]!.querySelector(".au-stop")!.getAttribute("aria-label"), m.link_main_stop_aria({ name: "docs" }));
});

test("a main's row says its kind in the word the local page uses, between its name and its state; a train says train; no kind, or one the page does not know, draws no word; the word is text", () => {
	const list = draw([mains(
		mainCard({ kind: "coordinator" }), mainCard({ handle: "1111111111111111", name: "ship", kind: "integrator" }), mainCard({ handle: "2222222222222222", name: "keep", kind: "standing" }),
		mainCard({ handle: "3333333333333333", name: "car", kind: "train" }), mainCard({ handle: "4444444444444444", name: "old" }), mainCard({ handle: "5555555555555555", name: "odd", kind: "<img src=x>" }),
	)]);
	const words = list.querySelectorAll(".au-main").map((r) => [r.querySelector(".au-mname")!.textContent, r.querySelector(".au-mkind")!.hidden, r.querySelector(".au-mkind")!.textContent]);
	assert.deepEqual(words, [
		["docs", false, m.kind_coordinator()], ["ship", false, m.kind_integrator()], ["keep", false, m.kind_standing()],
		["car", false, m.role_train()], ["old", true, ""], ["odd", true, ""],
	]);
	assert.equal(list.all((x) => x.tag === "img").length, 0);
	assert.equal(list.querySelectorAll(".au-main")[0]!.dataset.kind, "coordinator", "a hook for the theme's colour and the tests");
	assert.equal(list.querySelectorAll(".au-main")[3]!.dataset.kind, "train");
	assert.equal(list.querySelectorAll(".au-main")[5]!.dataset.kind, undefined);
});

test("a main whose stop is pending reads 'stopping…' with no Stop; a box that takes no stop shows the same rows with no button; a teammate's words are text", () => {
	const list = draw([mains(mainCard({ stopping: true, canStop: false, word: m.link_main_stopping(), tone: "other" }), mainCard({ handle: "2222222222222222", name: "<b>x</b>", canStop: false, byLabel: "<img src=x>" }))]);
	const [pending, plain] = list.querySelectorAll(".au-main");
	assert.deepEqual([pending!.querySelector(".au-mstate")!.textContent, pending!.querySelector(".au-stop")!.hidden], [m.link_main_stopping(), true]);
	assert.equal(plain!.querySelector(".au-stop")!.hidden, true, "no button without the box's caps");
	assert.equal(plain!.querySelector(".au-mname")!.textContent, "<b>x</b>");
	assert.equal(plain!.querySelector(".au-mby")!.textContent, m.link_main_by({ who: "<img src=x>" }));
	assert.equal(list.querySelectorAll(".au-mname b").length + list.querySelectorAll(".au-mby img").length, 0);
});

test("Stop asks in the page's confirm with Stop and Interrupt and stop, posts link/unit-stop of the main's own team (a box in two teams: the row that named it, #121 trial) and box with the chosen mode, and the row then reads 'stopping…' with no button", async () => {
	const asked: { text: string; labels: string[] }[] = [], posted: { path: string; body: Record<string, unknown> }[] = [];
	let choice: string | undefined = "interrupt";
	io.choose = (async (text: string, choices: { label: string; value: string }[]) => (asked.push({ text, labels: choices.map((c) => c.label) }), choices.length ? choice : undefined)) as typeof io.choose;
	io.post = async (path, body) => (posted.push({ path, body }), { ok: true, status: 200, body: { status: "sent" } });
	const list = draw([mains(mainCard({ handle: "aaaaaaaaaaaaaaaa", name: "docs-sent", team: "t-other" }))]);
	fillAllyUnits(list as unknown as HTMLElement, [mains(mainCard({ handle: "aaaaaaaaaaaaaaaa", name: "docs-sent", team: "t-other" }))], false, "ci-box");
	const button = one(list, ".au-stop");
	button.click();
	await until(() => posted.length === 1, "the post");
	assert.deepEqual(asked.map((a) => a.labels), [[m.link_main_stop(), m.link_main_interrupt()]]);
	assert.equal(asked[0]!.text, m.link_main_stop_ask({ box: "ci-box", name: "docs-sent" }));
	assert.deepEqual(posted, [{ path: "link/unit-stop", body: { team: "t-other", device: "d1", handle: "aaaaaaaaaaaaaaaa", mode: "interrupt", reason: "" } }], "the main's team, not the card's");
	await until(() => one(list, ".au-mstate").textContent === m.link_main_stopping(), "the row reads stopping");
	assert.equal(button.hidden, true);
	// A redraw before the box's own status says so keeps it pending, and does not offer Stop again.
	fillAllyUnits(list as unknown as HTMLElement, [mains(mainCard({ handle: "aaaaaaaaaaaaaaaa", name: "docs-sent" }))], false, "ci-box");
	assert.deepEqual([one(list, ".au-mstate").textContent, one(list, ".au-stop").hidden], [m.link_main_stopping(), true]);
});

test("a cancelled confirm posts nothing and leaves the button; a refusal is said in the page's dialog with the box and the reason, and the button comes back", async () => {
	const asked: string[][] = [], texts: string[] = [], posted: unknown[] = [];
	let choice: string | undefined;
	io.choose = (async (text: string, choices: { label: string; value: string }[]) => (texts.push(text), asked.push(choices.map((c) => c.label)), choices.length ? choice : undefined)) as typeof io.choose;
	let reply: { ok: boolean; status: number; body: { reason?: string } } = { ok: false, status: 409, body: { reason: "The relay does not take stop requests yet" } };
	io.post = async (_path, body) => (posted.push(body), reply);
	const list = draw([mains(mainCard({ handle: "bbbbbbbbbbbbbbbb", name: "docs-refused" }))]);
	one(list, ".au-stop").click();
	await until(() => asked.length === 1, "the question");
	await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual([posted.length, one(list, ".au-stop").hidden, one(list, ".au-stop").disabled], [0, false, false], "cancelled: nothing was sent");
	choice = "quit";
	one(list, ".au-stop").click();
	await until(() => asked.length === 3, "the refusal's dialog");
	assert.deepEqual(asked[2], [], "a notice, not a question");
	assert.equal(texts[2], m.link_main_refused({ box: "", reason: "The relay does not take stop requests yet" }));
	assert.deepEqual(posted.length, 1);
	await until(() => one(list, ".au-stop").disabled === false, "the button comes back");
	assert.equal(one(list, ".au-stop").hidden, false);
	reply = { ok: false, status: 0, body: {} };
	one(list, ".au-stop").click();
	await until(() => asked.length === 5, "the no-answer dialog");
	assert.equal(texts[4], m.link_main_refused({ box: "", reason: m.no_answer() }));
});

test("the demo's mains scenes: mains is the dispatcher's own two with Stop, admin adds a teammate's two named by their dispatcher, stopping has one pending, nostop is a box that takes no stop; no scene leaves the unit as it was", async () => {
	const { allyDemo } = await import("../gui/demo-ally.ts");
	const { unitCards } = await import("../gui/linkmodel.ts");
	const cards = (scene: string | null) => {
		const link = { allies: [], alerts: [], confirms: [], units: [{ team: "t", device: "d1", at: 0, units: [{ unit: "Harbor API", state: "running", monitors: [], report: "" }] }] };
		allyDemo(link as never, scene, 1_000_000);
		return unitCards(link.units, [], { teams: ["t"], device: "d1", workspace: "Harbor API" }, 1_000_000)[0]!.mains;
	};
	assert.equal(cards("idle").length, 0);
	assert.deepEqual(cards("mains").map((c) => [c.name, c.byLabel, c.canStop]), [["docs · ledger fix", undefined, true], ["docs · release notes", undefined, true]]);
	assert.deepEqual(cards("mains,admin").map((c) => [c.byLabel, c.canStop]), [[undefined, true], [undefined, true], ["Mei's Mac", true], ["Mei's Mac", true]]);
	assert.deepEqual(cards("mains,stopping").map((c) => [c.stopping, c.canStop]), [[true, false], [false, true]]);
	assert.deepEqual(cards("mains,nostop").map((c) => c.canStop), [false, false]);
});

test("a box main with an open link wait on this computer says so on its row, beside its dispatcher (docs/specs/2026-11-21-box-mac-waits.md §5)", async () => {
	const { unitCards } = await import("../gui/linkmodel.ts");
	const status = { team: "t", device: "d1", at: 0, units: [{ unit: "Harbor API", state: "running", monitors: [], report: "" }], dispatchers: { b: { label: "bob-mac" } }, waiting: { "0123456789abcdef": ["L3", "L4"] }, mains: [
		{ handle: "0123456789abcdef", unit: "Harbor API", name: "work-on", state: "blocked", by: "b", stopping: false },
		{ handle: "fedcba9876543210", unit: "Harbor API", name: "docs", state: "idle", by: "b", stopping: false },
	] };
	const [waiting, plain] = unitCards([status] as never, [], { teams: ["t"], device: "d1", workspace: "Harbor API" }, 1_000_000)[0]!.mains;
	assert.deepEqual([waiting!.waiting, plain!.waiting], [["L3", "L4"], undefined]);
	const rows = draw([mains(mainCard({ byLabel: "bob-mac", waiting: ["L3", "L4"] }), mainCard({ handle: "fedcba9876543210", waiting: ["L5"] }))]).querySelectorAll(".au-main");
	assert.deepEqual(rows.map((r) => r.querySelector(".au-mby")!.textContent), [`${m.link_main_by({ who: "bob-mac" })} · ${m.link_main_waiting({ ids: "L3, L4" })}`, m.link_main_waiting({ ids: "L5" })]);
});
