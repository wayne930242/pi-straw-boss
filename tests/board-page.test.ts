import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardViewRow } from "../src/boardview.ts";
import type { Net } from "../src/net.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { until } from "./fakes.ts";

// The work board on the head page (docs/specs/2026-11-09-board-view.md, Head page): the fold's counts, the rows grouped by workspace in tab order, the name link of a live main only, Ask progress (the exact prompt to the main's input, "Asked" for
// 60 s), Clear (only on a clearable row, in the page's sheet with Cancel first, then board/clear), and every field of a row as text.

sessionGlobals();
class Dialog extends El {
	open = false;
	showModal() { this.open = true; }
	close() {
		this.open = false;
		setTimeout(() => this.dispatchEvent({ type: "close" }), 0);
	}
}
const make = page.createElement;
page.createElement = (tag: string) => (tag === "dialog" ? new Dialog("dialog") : make(tag));

const { ASK_PROMPT, ASKED_MS, ageText, boardCounts, boardGroups, fillBoard, io } = await import("../gui/board.ts");
const { m } = await import("../gui/paraglide/messages.js");
const zh = { locale: "zh-TW" } as const;

const NOW = Date.parse("2026-11-09T10:00:00Z"), MIN = 60_000, HOUR = 60 * MIN;
const row = (over: Partial<BoardViewRow> & Pick<BoardViewRow, "session">): BoardViewRow => ({ workspace: "Alpha", tab: "api", main: "billing", state: "idle", items: [], ...over });
const ROWS: BoardViewRow[] = [
	row({ session: "s-1", main: "billing", state: "working", now: "MP-1 export", items: [{ t: "schema", done: true }, { t: "writer", done: false }], src: "set", updated: NOW - 12 * MIN }),
	row({ session: "s-2", tab: "ui", main: "reports", now: "was busy", items: [], updated: NOW - 3 * HOUR, stale: true, clearable: true }),
	row({ session: "s-3", tab: "ops", main: "quiet" }),
	row({ session: "s-4", workspace: "Beta", tab: "mobile", main: "mobile", role: "train", state: "waiting", now: "waiting on review", updated: NOW - 5 * MIN }),
	row({ session: "gone-1", workspace: "", tab: "", main: "", state: "ended", now: "left behind", items: [{ t: "a", done: true }], updated: NOW - 9 * HOUR, clearable: true }),
];
const unit = (key: string) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "idle" as const, subs: [] });
const net = (board: BoardViewRow[] | null = ROWS): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "idle", tower: null, tabs: [{ id: "t1", label: "api", units: [unit("s-1"), unit("s-2"), unit("s-3")] }], outposts: [], outside: [] }, { id: "wB", label: "Beta", mark: "idle", tower: null, tabs: [{ id: "t2", label: "mobile", units: [unit("s-4")] }], outposts: [], outside: [] }], ...(board ? { board } : {}) });
const box = () => {
	const b = new El("details"), summary = new El("summary"), t = new El("b"), s = new El("span"), body = new El("div");
	body.className = "board-rows";
	summary.append(t, s);
	b.append(summary, body);
	return b;
};
const rowEl = (b: El, session: string) => b.querySelector(`.board-row[data-session="${session}"]`) as El;
const reset = () => { io.now = () => NOW; io.later = () => {}; io.post = async () => ({ ok: true, status: 200, body: {} }); page.body.replaceChildren(); };

test("the fold's line counts the lines and says how many are idle over 2 hours, ended, and not written, in both languages; it is hidden with no board", () => {
	reset();
	assert.equal(boardCounts(ROWS).text, "4 lines (1 idle, 1 ended, 1 not written)");
	assert.equal(boardCounts(ROWS, zh).text, "4 條（閒置 1、已結束 1、未寫 1）");
	assert.equal(boardCounts([ROWS[0]!]).text, "1 line");
	assert.equal(boardCounts([ROWS[0]!], zh).text, "1 條");
	const b = box();
	fillBoard(b as never, net());
	assert.equal(b.hidden, false);
	assert.deepEqual([b.querySelector("summary b")!.textContent, b.querySelector("summary span")!.textContent], [m.board_title(), "4 lines (1 idle, 1 ended, 1 not written)"]);
	fillBoard(b as never, net(null));
	assert.equal(b.hidden, true, "a net with no board shows nothing");
	fillBoard(b as never, undefined);
	assert.equal(b.hidden, true);
});

test("rows group by workspace in the net's order, tab order inside, and the ended rows are the last group", () => {
	reset();
	assert.deepEqual(boardGroups(ROWS).map((g) => [g.label, g.rows.map((r) => r.session)]), [["Alpha", ["s-1", "s-2", "s-3"]], ["Beta", ["s-4"]], [m.board_ended_group(), ["gone-1"]]]);
	const b = box();
	fillBoard(b as never, net());
	assert.deepEqual(b.querySelectorAll(".board-group h4").map((h) => h.textContent), ["Alpha", "Beta", m.board_ended_group()]);
	assert.deepEqual(b.querySelectorAll(".board-row").map((r) => r.dataset.session), ["s-1", "s-2", "s-3", "s-4", "gone-1"]);
});

test("a row says its state in words: the net's mark, 'idle over 2 hours', 'ended', and 'not written'; a train is tagged; the done count and the age are there", () => {
	reset();
	const b = box();
	fillBoard(b as never, net());
	const text = (session: string, sel: string) => rowEl(b, session).querySelector(sel)?.textContent;
	assert.equal(text("s-1", ".board-state"), m.mark_working());
	assert.equal(text("s-2", ".board-state"), m.board_idle_word());
	assert.equal(text("gone-1", ".board-state"), m.board_ended_word());
	assert.equal(text("s-3", ".board-none"), m.board_no_line());
	assert.equal(rowEl(b, "s-3").querySelector(".board-age"), null, "a main with no line has no age");
	assert.equal(text("s-4", ".board-tag"), "train");
	assert.equal(text("s-1", ".board-age"), "12m ago");
	assert.equal(text("s-2", ".board-age"), "3h ago");
	assert.equal(text("s-1", ".board-items summary"), "1/2 done");
	assert.deepEqual(rowEl(b, "s-1").querySelectorAll(".board-items li").map((li) => [li.textContent, li.dataset.done]), [["schema", "true"], ["writer", "false"]]);
	assert.equal(ageText(12 * MIN, zh), "12 分鐘前");
	assert.equal(ageText(30_000), "30s ago");
	assert.equal(ageText(3 * 86_400_000), "3d ago");
});

test("only a live main's name opens its session page, by the route the net's own unit makes; an ended row has no link", () => {
	reset();
	const b = box();
	fillBoard(b as never, net());
	const link = (session: string) => rowEl(b, session).querySelector("a.board-name");
	assert.equal(link("s-1")!.getAttribute("href"), link("s-1")!.dataset.route);
	assert.match(link("s-1")!.dataset.route!, /wA/);
	assert.match(link("s-4")!.dataset.route!, /wB/);
	assert.equal(link("gone-1"), null);
	assert.equal(rowEl(b, "gone-1").querySelector("b.board-name")!.textContent, "gone-1", "an unnamed ended row shows its session id");
	// A live row the net does not list (it moved between the reading and the draw) is a name without a link.
	const lonely = box();
	fillBoard(lonely as never, { bases: [], board: [ROWS[0]!] });
	assert.equal(rowEl(lonely, "s-1").querySelector("a.board-name"), null);
});

test("Ask progress is on live mains only; it posts the exact prompt to the main's input, then reads Asked and cannot be pressed for 60 seconds", async () => {
	reset();
	const posts: [string, Record<string, unknown>][] = [];
	let later: (() => void) | undefined, at = NOW;
	io.post = async (path, body) => (posts.push([path, body]), { ok: true, status: 200, body: { accepted: true } });
	io.later = (fn, ms) => { assert.equal(ms, ASKED_MS + 50); later = fn; };
	io.now = () => at;
	const b = box();
	fillBoard(b as never, net());
	assert.equal(rowEl(b, "gone-1").querySelector(".board-ask"), null, "an ended main cannot be asked");
	const button = () => rowEl(b, "s-1").querySelector(".board-ask") as El;
	assert.equal(button().textContent, "Ask for a sitrep");
	assert.equal(ASK_PROMPT, "The boss asks from the work board: how far has this work got? Reply in two or three lines (Traditional Chinese), and update your board line (board_set) if it is out of date.");
	button().click();
	await until(() => button().textContent === "Asked", "the button reads Asked");
	assert.deepEqual(posts, [["sessions/s-1/input", { text: ASK_PROMPT, as: "send" }]]);
	assert.equal(button().hasAttribute("disabled"), true);
	button().click();
	await new Promise((done) => setImmediate(done));
	assert.equal(posts.length, 1, "no second send inside the minute");
	at += ASKED_MS - 1;
	fillBoard(b as never, net());
	assert.equal(button().textContent, "Asked");
	at += 2;
	later!();
	assert.deepEqual([button().textContent, button().hasAttribute("disabled")], ["Ask for a sitrep", false], "after the minute it can be asked again");
});

test("a send in flight disables the button (no double tap) and a refusal says why and leaves the button free", async () => {
	reset();
	const posts: string[] = [];
	let release!: (a: { ok: boolean; status: number; body: Record<string, unknown> }) => void;
	io.post = (path) => (posts.push(path), new Promise((done) => (release = done)));
	const b = box();
	fillBoard(b as never, net());
	const button = () => rowEl(b, "s-4").querySelector(".board-ask") as El;
	button().click();
	await until(() => button().hasAttribute("disabled"), "disabled while the request is on its way");
	button().click();
	assert.equal(posts.length, 1);
	release({ ok: false, status: 409, body: { error: "blocked", reason: "It is waiting on a dialog; answer it in the terminal." } });
	await until(() => b.querySelector(".board-note")!.textContent === "It is waiting on a dialog; answer it in the terminal.", "the reason is shown");
	assert.deepEqual([button().textContent, button().hasAttribute("disabled")], ["Ask for a sitrep", false]);
});

test("Clear is on clearable rows only; it asks in the page's sheet with Cancel first and focused, and posts board/clear only after the choice", async () => {
	reset();
	const posts: [string, Record<string, unknown>][] = [];
	io.post = async (path, body) => (posts.push([path, body]), { ok: true, status: 200, body: { cleared: true, told: "delivered" } });
	const real = (await import("../gui/quit.ts")).choose;
	io.choose = real;
	const b = box();
	fillBoard(b as never, net());
	assert.deepEqual(b.querySelectorAll(".board-clear").length, 2);
	assert.equal(rowEl(b, "s-1").querySelector(".board-clear"), null, "a working main's fresh line is not clearable");
	assert.equal(rowEl(b, "s-3").querySelector(".board-clear"), null);
	(rowEl(b, "s-2").querySelector(".board-clear") as El).click();
	const sheet = () => page.body.find((el) => el instanceof Dialog)[0] as Dialog;
	await until(() => sheet() !== undefined, "the sheet opens");
	const buttons = sheet().querySelectorAll("button");
	assert.deepEqual(buttons.map((x) => x.textContent), [m.cancel(), "Clear"]);
	assert.equal(page.focused, buttons[0], "Cancel has the focus");
	assert.match(sheet().textContent, /reports/);
	assert.match(sheet().textContent, /was busy/);
	assert.match(sheet().textContent, /will be told/, "a live main is told, and the sheet says so");
	buttons[0]!.click();
	await until(() => page.body.find((el) => el instanceof Dialog).length === 0, "the sheet is gone");
	assert.deepEqual(posts, [], "Cancel posts nothing");
	(rowEl(b, "gone-1").querySelector(".board-clear") as El).click();
	await until(() => sheet() !== undefined, "the sheet opens for the ended row");
	assert.match(sheet().textContent, /session has ended/);
	assert.doesNotMatch(sheet().textContent, /will be told/);
	sheet().querySelectorAll("button")[1]!.click();
	await until(() => posts.length === 1, "the post");
	assert.deepEqual(posts, [["board/clear", { session: "gone-1" }]]);
	await until(() => b.querySelector(".board-note")!.textContent === m.board_cleared_told(), "the note says cleared and told");
	// A refusal is read out.
	io.post = async () => ({ ok: false, status: 409, body: { error: "refused", reason: "Only a line whose session has ended can be cleared." } });
	(rowEl(b, "s-2").querySelector(".board-clear") as El).click();
	await until(() => sheet() !== undefined, "the sheet");
	sheet().querySelectorAll("button")[1]!.click();
	await until(() => b.querySelector(".board-note")!.textContent === "Only a line whose session has ended can be cleared.", "the refusal");
});

test("the note after a clear says whether the writer was told, was only left a queued reminder, or was not told, in both languages (BV-F005)", async () => {
	reset();
	assert.deepEqual([m.board_cleared_told(), m.board_cleared_queued(), m.board_cleared()], ["Cleared; it was told.", "Cleared; the reminder is queued.", "Cleared."]);
	assert.deepEqual([m.board_cleared_told({}, zh), m.board_cleared_queued({}, zh), m.board_cleared({}, zh)], ["已清掉，已通知它", "已清掉，提醒已排隊", "已清掉"]);
	io.choose = (async () => "clear") as typeof io.choose;
	for (const [told, note] of [["delivered", m.board_cleared_told()], ["queued", m.board_cleared_queued()], [false, m.board_cleared()]] as const) {
		io.post = async () => ({ ok: true, status: 200, body: { cleared: true, told } });
		const b = box();
		fillBoard(b as never, net());
		(rowEl(b, "s-2").querySelector(".board-clear") as El).click();
		await until(() => b.querySelector(".board-note")!.textContent === note, `the note for told=${String(told)}`);
	}
});

test("Clear is disabled while its request is on its way, and a second tap does nothing; a refusal frees it again (BV-F006)", async () => {
	reset();
	const posts: string[] = [];
	let release!: (a: { ok: boolean; status: number; body: Record<string, unknown> }) => void, sheets = 0;
	io.choose = (async () => (sheets++, "clear")) as typeof io.choose;
	io.post = (path) => (posts.push(path), new Promise((done) => (release = done)));
	const b = box();
	fillBoard(b as never, net());
	const button = () => rowEl(b, "s-2").querySelector(".board-clear") as El;
	button().click();
	await until(() => button().hasAttribute("disabled"), "disabled while the request is on its way");
	button().click();
	await new Promise((done) => setImmediate(done));
	assert.deepEqual([posts, sheets], [["board/clear"], 1], "the second tap opened no sheet and posted nothing");
	assert.equal((rowEl(b, "gone-1").querySelector(".board-clear") as El).hasAttribute("disabled"), false, "only that row's button");
	release({ ok: false, status: 409, body: { error: "changed", reason: "The line was written again just now, so it stays." } });
	await until(() => b.querySelector(".board-note")!.textContent === "The line was written again just now, so it stays.", "the reason is shown");
	assert.equal(button().hasAttribute("disabled"), false, "free again");
	// A cancelled sheet leaves nothing disabled.
	io.choose = async () => undefined;
	button().click();
	await new Promise((done) => setImmediate(done));
	assert.equal(button().hasAttribute("disabled"), false);
	assert.equal(posts.length, 1);
});

test("a line whose session is open but no longer a main reads 'not a main' (not 'ended') and the sheet says the writer will be told (BV-F004)", async () => {
	reset();
	const b = box();
	fillBoard(b as never, { bases: [], board: [row({ session: "member-1", workspace: "", tab: "", main: "", state: "ended", open: true, now: "was a main", updated: NOW - 40 * MIN, clearable: true })] });
	assert.equal(rowEl(b, "member-1").querySelector(".board-state")!.textContent, m.board_open_word());
	assert.equal(m.board_open_word(), "not a main");
	assert.equal(m.board_open_word({}, zh), "已不是 main");
	let asked = "";
	io.choose = async (text) => ((asked = text), undefined);
	(rowEl(b, "member-1").querySelector(".board-clear") as El).click();
	await until(() => asked !== "", "the sheet");
	assert.match(asked, /no longer a main/);
	assert.match(asked, /will be told/);
});

test("every field is text: markup in a name, a line, an item, or a workspace never becomes an element, a link, or a route", () => {
	reset();
	const evil = '<img src=x onerror=alert(1)><a href="javascript:alert(1)">go</a>';
	const b = box();
	fillBoard(b as never, { bases: [], board: [row({ session: "s-1", workspace: evil, main: evil, now: evil, items: [{ t: evil, done: false }], updated: NOW - MIN })] });
	assert.equal(b.querySelectorAll("img").length + b.querySelectorAll("script").length, 0);
	assert.deepEqual(b.querySelectorAll("a").length, 0, "no link: the unit is not in the net, and no text makes one");
	assert.equal(b.querySelector(".board-now")!.textContent, evil);
	assert.equal(b.querySelector(".board-name")!.textContent, evil);
	assert.equal(b.querySelector(".board-group h4")!.textContent, evil);
	assert.equal(b.querySelector(".board-items li")!.textContent, evil);
	// The text is in text nodes; the only attribute values made from row fields are the buttons' titles.
	const attrs = b.dump().split(evil).length - 1;
	assert.ok(attrs >= 4);
	for (const el of b.find((x) => x.tagName !== "details")) for (const [name, value] of el.attrs) if (value.includes("<") && name !== "title") assert.fail(`${name} holds markup on ${el.tagName}`);
});

test("a redraw with the same board keeps the elements (a tap never lands on a replaced button) and only rewrites the ages; an open items fold stays open across a change", () => {
	reset();
	const b = box();
	fillBoard(b as never, net(), false, NOW + 10 * MIN); // later than the minute the first Ask test left running
	const before = rowEl(b, "s-4").querySelector(".board-ask");
	const items = rowEl(b, "s-1").querySelector(".board-items") as El;
	items.setAttribute("open", "");
	items.dispatchEvent({ type: "toggle" });
	fillBoard(b as never, net(), false, NOW + 12 * MIN);
	assert.equal(rowEl(b, "s-4").querySelector(".board-ask"), before, "the same button");
	assert.equal(rowEl(b, "s-1").querySelector(".board-age")!.textContent, "24m ago");
	fillBoard(b as never, net([...ROWS, row({ session: "s-9", main: "late", now: "new line" })]), false, NOW + 12 * MIN);
	assert.equal(rowEl(b, "s-9").querySelector(".board-now")!.textContent, "new line");
	assert.equal(rowEl(b, "s-1").querySelector(".board-items")!.hasAttribute("open"), true, "the fold the boss opened stays open");
});

test("the result of a Clear or an Ask is brought into view: the row list scrolls back to its top, where the note is (VR-F001)", async () => {
	reset();
	io.choose = (async () => "clear") as typeof io.choose;
	io.post = async () => ({ ok: true, status: 200, body: { cleared: true, told: "delivered" } });
	const b = box();
	fillBoard(b as never, net());
	const rows = b.querySelector(".board-rows") as El & { scrollTop: number };
	rows.scrollTop = 400; // the boss scrolled down to a row below the first two
	(rowEl(b, "s-2").querySelector(".board-clear") as El).click();
	await until(() => b.querySelector(".board-note")!.textContent === m.board_cleared_told(), "the note");
	assert.equal(rows.scrollTop, 0, "the note at the list's top is in view");
});
