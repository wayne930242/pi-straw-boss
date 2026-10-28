import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { forAllies, readEntries, writeEntry } from "../src/board.ts";
import { readBoard } from "../src/boardread.ts";
import { deriveBoard, scrubBoard } from "../src/boardauto.ts";
import type { Todo } from "../src/items.ts";
import { gatherMains } from "../src/server/towerbrief.ts";
import { panes } from "../src/herdr.ts";
import { type Agent, World } from "./fakes.ts";

// The work board fills itself (docs/specs/2026-10-25-straw-link.md, Work board, Auto-fill): the derivation, the scrub, the override, and what allies get.

const todo = (id: number, subject: string, status: Todo["status"], activeForm?: string): Todo => ({ id, subject, status, ...(activeForm ? { activeForm } : {}) });
const ROOT = "/work/app";

test("now: the task in progress, else the first pending as next, else done (n/n), else the name alone; no name, no prefix", () => {
	const l = [todo(1, "Write tests", "completed"), todo(2, "Fix rounding", "in_progress", "Fixing rounding"), todo(3, "Ship", "pending")];
	assert.equal(deriveBoard({ name: "MP-1 cost", todos: l })!.text.now, "MP-1 cost: Fixing rounding", "the activeForm of the task in progress");
	assert.equal(deriveBoard({ name: "MP-1 cost", todos: [todo(2, "Fix rounding", "in_progress"), todo(3, "Ship", "pending")] })!.text.now, "MP-1 cost: Fix rounding", "else its subject");
	assert.equal(deriveBoard({ name: "MP-1 cost", todos: [todo(1, "A", "completed"), todo(5, "Later", "pending"), todo(3, "Ship", "pending")] })!.text.now, "MP-1 cost: next Ship", "the first pending in id order");
	assert.equal(deriveBoard({ name: "MP-1 cost", todos: [todo(1, "A", "completed"), todo(2, "B", "completed")] })!.text.now, "MP-1 cost: done (2/2)");
	assert.deepEqual(deriveBoard({ name: "MP-1 cost", todos: [] }), { text: { now: "MP-1 cost", items: [] }, who: "MP-1 cost" }, "no list: the name alone, and no count");
	assert.deepEqual(deriveBoard({ name: "MP-1 cost", todos: undefined }), { text: { now: "MP-1 cost", items: [] }, who: "MP-1 cost" });
	assert.equal(deriveBoard({ name: "", todos: l })!.text.now, "Fixing rounding", "pi's default name is none, so the line has no prefix");
	assert.equal(deriveBoard({ name: "", todos: [] }), undefined, "no name and no list: no entry");
	assert.equal(deriveBoard({ name: "  ", todos: undefined }), undefined);
});

test("items: in progress first, then pending in id order, then completed newest first; at most 8; the count is of the whole list", () => {
	const list = [todo(1, "one", "completed"), todo(2, "two", "completed"), todo(7, "seven", "pending"), todo(4, "four", "pending"), todo(5, "five", "in_progress"), ...[8, 9, 10, 11, 12].map((n) => todo(n, `p${n}`, "pending"))];
	const d = deriveBoard({ name: "n", todos: list })!;
	assert.deepEqual(d.text.items.map((i) => [i.t, i.done]), [["five", false], ["four", false], ["seven", false], ["p8", false], ["p9", false], ["p10", false], ["p11", false], ["p12", false]]);
	assert.deepEqual(d.count, { done: 2, total: 10 });
	const done = deriveBoard({ name: "n", todos: [todo(1, "a", "completed"), todo(3, "c", "completed"), todo(2, "b", "completed")] })!;
	assert.deepEqual(done.text.items.map((i) => [i.t, i.done]), [["c", true], ["b", true], ["a", true]], "completed: the highest id first");
});

test("the board's caps hold by cutting, after the scrub: now at 120, an item at 80", () => {
	const d = deriveBoard({ name: "n".repeat(30), todos: [todo(1, "x".repeat(200), "in_progress", "y".repeat(200))] })!;
	assert.equal(Array.from(d.text.now).length, 120);
	assert.equal(Array.from(d.text.items[0]!.t).length, 80);
	assert.equal(Array.from(deriveBoard({ name: "n".repeat(200), todos: undefined })!.text.now).length, 40, "a name is cut to the board's label length");
});

test("the scrub: paths inside the project are relative, every other path is hidden", () => {
	const s = (t: string) => scrubBoard(t, ROOT);
	assert.equal(s("edit /work/app/src/a.ts and /work/app/README.md"), "edit src/a.ts and README.md");
	assert.equal(s("see (/work/app/src/a.ts)."), "see (src/a.ts).");
	assert.equal(s("in /work/app now"), "in . now");
	assert.equal(s("read /etc/hosts and /Users/me/secret/notes.txt"), "read … and …");
	assert.equal(s("a sibling /work/app-other/x.ts"), "a sibling …", "a folder that only shares the prefix is outside");
	assert.equal(s("up /work/app/../other/x.ts"), "up …", "a path that climbs out is outside");
	assert.equal(s("cwd:/Users/me/x and HOME=/Users/me"), "cwd:… and HOME=…", "a path after a colon or an equals sign");
	assert.equal(s("home ~/projects/x and $HOME/y and %USERPROFILE%\\z"), "home … and … and …");
	assert.equal(s("climb ../customer-a/data.csv"), "climb …");
	assert.equal(s("unc //server/share/x and \\Users\\me\\o and c:Users\\me and ~me/notes"), "unc … and … and … and …", "slash UNC, no drive, drive-relative, ~user");
	assert.equal(s("fw ／Users／me／x and ∕Users∕me and \uff3cUsers\uff3cme"), "fw … and … and …", "look-alike slashes");
	assert.equal(s("win C:\\Users\\me\\x.txt and D:/data/y"), "win … and …");
	assert.equal(s("share \\\\fileserver\\public\\plan.xlsx ok"), "share … ok");
	assert.equal(s("relative src/a.ts and 3/5 and and/or stay"), "relative src/a.ts and 3/5 and and/or stay");
	assert.equal(scrubBoard("/work/app/src/a.ts", undefined), "…", "no project root known: every path is hidden");
	assert.equal(scrubBoard("C:\\work\\app\\src\\a.ts and C:\\other\\b.ts", "C:\\work\\app"), "src/a.ts and …", "a Windows root compares in its own style");
	assert.equal(scrubBoard("c:\\WORK\\app\\x.ts", "C:\\work\\app"), "x.ts", "and without regard to case");
	assert.equal(scrubBoard("/work/app/x.ts", "C:\\work\\app"), "…", "a path of the other style is outside");
});

test("the scrub: a URL becomes its host, one with userinfo or no host becomes …", () => {
	const s = (t: string) => scrubBoard(t, ROOT);
	assert.equal(s("open https://gitlab.example.com/group/proj/-/merge_requests/4?x=1."), "open gitlab.example.com.");
	assert.equal(s("see http://localhost:8080/path and https://a.b.c/x)"), "see localhost and a.b.c)");
	assert.equal(s("clone https://user:pw@git.example.com/r.git now"), "clone … now");
	assert.equal(s("clone ssh://git@git.example.com/r.git now"), "clone … now");
	assert.equal(s("file:///Users/me/x.txt"), "…");
	assert.equal(s("bare example.com/path stays a word"), "bare example.com/path stays a word", "only a URL with a scheme is one");
});

test("the scrub: emails and each token family", () => {
	const s = (t: string) => scrubBoard(t, ROOT);
	assert.equal(s("mail wei.hung+x@example.co.uk about it"), "mail … about it");
	assert.equal(s("git@github.com:org/repo.git"), "…:org/repo.git");
	const tokens = [
		"sk-ant-api03-abcdefghijklmnop", "sk-proj-0123456789abcdef", "ghp_0123456789abcdefghijklmnopqrstuv", "gho_0123456789abcdefghijklmnopqrstuv", "glpat-abcdefghij0123456789",
		"xoxb-123456789012-abcdefghij", "xoxp-123456789012-abcdefghij", "AKIAIOSFODNN7EXAMPLE",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		"0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef01234567", "Zm9vYmFyQmF6cXV4MTIzNDU2Nzg5MEFiQ2RFZkdoSWo",
		"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "rk_live_abcdef012345", "sk_live_abcdef012345", "pk_live_abcdef012345", "sk_test_abcdef012345",
		"0x0123456789abcdef0123456789abcdef", "Password=Hunter22", "Pwd=Hunter22", "api_key: abc123",
	];
	for (const token of tokens) assert.equal(s(`key ${token} end`), "key … end", token);
	// Not secrets: a short hex, a long word, a long path segment, and prose that starts like a prefix.
	for (const text of ["commit abc1234 and 0123456789abcdef", "internationalization-and-localization-of-everything", "the sk-learn and ghp_ prefix", "disk-usage-checks", "Ab1 Cd2 Ef3"]) assert.equal(s(text), text, text);
});

test("the scrub cleans first: a format character inside a token, path, or email does not hide it", () => {
	for (const ch of ["\u200b", "\u00ad", "\u200d", "\u202e"]) {
		assert.equal(scrubBoard(`fix sk-${ch}proj1234567890abcdef`, ROOT), "fix …", `token with U+${ch.charCodeAt(0).toString(16)}`);
		assert.equal(scrubBoard(`gh${ch}p_0123456789abcdefghijklmnopqrstuv`, ROOT), "…");
		assert.equal(scrubBoard(`C${ch}:\\Users\\me\\secret.txt`, ROOT), "…", "path");
		assert.equal(scrubBoard(`a${ch}@example.com`, ROOT), "…", "email");
		assert.equal(scrubBoard(`/Users${ch}/me/x`, ROOT), "…");
	}
	const d = deriveBoard({ name: "n", root: ROOT, todos: [todo(1, "x sk-\u200bproj1234567890abcdef", "in_progress")] })!;
	assert.ok(!d.text.now.includes("sk-") && !d.text.items[0]!.t.includes("sk-"));
});

test("the scrub removes default-ignorable characters that are not format characters", () => {
	for (const ch of ["\ufe0f", "\u034f", "\u{e0100}", "\u180b", "\u3164"]) {
		const id = `U+${ch.codePointAt(0)!.toString(16)}`;
		assert.equal(scrubBoard(`ghp_ABCDEFGH${ch}IJKLMNOPQRSTUVWX01`, ROOT), "…", `token ${id}`);
		assert.equal(scrubBoard(`me${ch}@corp.example`, ROOT), "…", `email ${id}`);
		assert.equal(scrubBoard(`/${ch}Users/me/acme`, ROOT), "…", `path ${id}`);
		assert.ok(!scrubBoard(`a${ch}b`, ROOT).includes(ch), `plain ${id}`);
	}
});

test("quoted credential values and short bearer tokens are scrubbed", () => {
	for (const t of [`password: 'x'`, `token = "abc123"`, `password: 'Hunter22'`, "Bearer abcdefgh12345678abcd"]) {
		assert.equal(scrubBoard(`a ${t} b`, ROOT), "a … b", t);
	}
});

test("scrub, then cut: a token that straddles the cut leaves no prefix", () => {
	const d = deriveBoard({ name: "", root: ROOT, todos: [todo(1, `${"a ".repeat(55)}sk-ant-api03-abcdefghijklmnop`, "in_progress")] })!;
	assert.ok(!d.text.now.includes("sk-") && !d.text.items[0]!.t.includes("sk-"), d.text.now);
	assert.equal(deriveBoard({ name: "", root: ROOT, todos: [todo(1, `${"a ".repeat(37)}sk-ant-api03-abcdefghijklmnop`, "in_progress")] })!.text.items[0]!.t.includes("sk"), false);
});

test("deriveBoard keeps the scrubbed name as who, and none when there is no name", () => {
	assert.equal(deriveBoard({ name: "acme /etc/x", todos: [todo(1, "t", "pending")] })!.who, "acme …");
	assert.equal(deriveBoard({ name: "", todos: [todo(1, "t", "pending")] })!.who, undefined);
});

test("deriveBoard scrubs the name, the task, and the items; an item that is mostly scrubbed is dropped and counted as (n hidden), which is not an open task", () => {
	const d = deriveBoard({
		name: "ops /etc/x", root: ROOT,
		todos: [
			todo(1, "Read /Users/me/a.txt /Users/me/b.txt", "pending"), todo(2, "Edit /work/app/src/a.ts", "in_progress", "Editing /work/app/src/a.ts"),
			todo(3, "mail a@b.co and see https://x.example.com/p", "pending"), todo(4, "/var/log/x", "completed"), todo(5, "Fix bug in … and /etc/passwd", "pending"),
		],
	})!;
	assert.equal(d.text.now, "ops …: Editing src/a.ts");
	assert.deepEqual(d.text.items, [{ t: "Edit src/a.ts", done: false }, { t: "mail … and see x.example.com", done: false }, { t: "Fix bug in … and …", done: false }, { t: "(2 hidden)", done: true }]);
	assert.deepEqual(d.count, { done: 1, total: 5 }, "the count is of the todo list, hidden tasks included");
	const eight = deriveBoard({ name: "n", todos: [...Array.from({ length: 10 }, (_, i) => todo(i + 1, `task ${i + 1}`, "pending")), todo(11, "/etc/a", "pending")] })!;
	assert.equal(eight.text.items.length, 8);
	assert.deepEqual(eight.text.items.at(-1), { t: "(1 hidden)", done: true }, "the note takes the last of the eight places");
});

test("what allies get: an auto entry is its line and the done count only, a board_set entry whole", () => {
	const items = [{ t: "a", done: true }, { t: "b", done: false }];
	assert.deepEqual(forAllies({ now: "n: doing x", items, src: "todo", count: { done: 1, total: 5 }, who: "n" }), { now: "n (1/5)", items: [] }, "the name and the count, no task text");
	assert.deepEqual(forAllies({ now: "n", items: [], src: "todo", who: "n" }), { now: "n", items: [] }, "a name-only entry has no count");
	assert.deepEqual(forAllies({ now: "doing secret x", items, src: "todo", count: { done: 1, total: 5 } }), { now: "(1/5)", items: [] }, "no name: the count alone");
	assert.deepEqual(forAllies({ now: "n: done (3/3)", items, src: "todo", count: { done: 3, total: 3 }, who: "n" }), { now: "n (3/3)", items: [] }, "the count once");
	assert.deepEqual(forAllies({ now: "n: doing x", items, src: "set", count: { done: 1, total: 5 }, who: "n" }), { now: "n: doing x", items });
	const long = forAllies({ now: "x", items, src: "todo", count: { done: 12, total: 20 }, who: "x".repeat(200) });
	assert.ok(Array.from(long.now).length <= 120 && long.now.endsWith(" (12/20)"), "the count keeps its place when the name is cut");
});

// ---- Files ---------------------------------------------------------------------------------------------------------------

let dir = "";
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "psb-board-auto-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("src and count are in the file for an auto entry, a board_set entry is src set, and a file from before src is a set entry", () => {
	writeEntry(dir, "s1", { now: "auto", items: [] }, 1, { src: "todo", count: { done: 1, total: 3 } });
	writeEntry(dir, "s2", { now: "manual", items: [] }, 1);
	writeEntry(dir, "s3", { now: "manual", items: [] }, 1, { src: "set", count: { done: 1, total: 3 } });
	writeFileSync(join(dir, "old.json"), JSON.stringify({ v: 1, session: "old", now: "before src", items: [], updated: 1 }));
	writeFileSync(join(dir, "bad.json"), JSON.stringify({ v: 1, session: "bad", now: "x", items: [], updated: 1, src: "todo", count: { done: 9, total: 3 } }));
	const by = Object.fromEntries(readEntries(dir).map((e) => [e.session, e]));
	assert.deepEqual([by.s1!.src, by.s1!.count], ["todo", { done: 1, total: 3 }]);
	assert.deepEqual([by.s2!.src, by.s2!.count, by.s3!.src, by.s3!.count], ["set", undefined, "set", undefined]);
	assert.deepEqual([by.old!.src, by.old!.count], ["set", undefined]);
	assert.deepEqual([by.bad!.src, by.bad!.count], ["todo", undefined], "a count out of shape is dropped");
	assert.equal(JSON.parse(readFileSync(join(dir, "s2.json"), "utf8")).src, "set");
});

// ---- A session in a world ------------------------------------------------------------------------------------------------

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const boardDir = () => join(world.stateDir, "board");
let clock = 1_800_000_000_000;
const now = () => (clock += 1000);
const state = (list: Todo[]) => ({ tasks: list, nextId: list.length + 1 });
const setTodos = (agent: Agent, list: Todo[]) => agent.entries.push({ customType: "rpiv-todo-state", data: state(list) });
const entryOf = (id: string) => readEntries(boardDir()).find((e) => e.session === id);
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text).join("");

async function main(name = "api-main", id = "a1", n = 1) {
	const agent = world.agent({ id, name, pane: `wA:p${n}`, tab: `wA:t${n}`, deps: { now } });
	await agent.start();
	await agent.promote();
	return agent;
}
const LIST = [todo(1, "Write schema", "completed"), todo(2, "Write the CSV writer", "in_progress", "Writing the CSV writer"), todo(3, "Ship", "pending")];

test("a main's board fills from its todo list and name at the turn's end, once per change", async () => {
	const a = await main();
	assert.equal(entryOf("a1"), undefined, "nothing is written before a turn ends");
	setTodos(a, LIST);
	await a.fire("turn_end");
	const e = entryOf("a1")!;
	assert.deepEqual([e.src, e.now, e.count], ["todo", "api-main: Writing the CSV writer", { done: 1, total: 3 }]);
	assert.deepEqual(e.items, [{ t: "Write the CSV writer", done: false }, { t: "Ship", done: false }, { t: "Write schema", done: true }]);
	const first = e.updated;
	await a.fire("turn_end");
	await a.fire("tool_execution_end", { toolCallId: "c", toolName: "bash" });
	assert.equal(entryOf("a1")!.updated, first, "the same list is not written again");
	setTodos(a, [todo(1, "Write schema", "completed"), todo(2, "Write the CSV writer", "completed"), todo(3, "Ship", "in_progress")]);
	await a.fire("tool_execution_end", { toolCallId: "c", toolName: "todo" });
	assert.deepEqual([entryOf("a1")!.now, entryOf("a1")!.updated > first], ["api-main: Ship", true]);
	for (const event of ["session_tree", "session_compact"]) {
		setTodos(a, [todo(1, "Write schema", "completed"), todo(2, event, "pending")]);
		await a.fire(event);
		assert.equal(entryOf("a1")!.now, `api-main: next ${event}`, event);
	}
});

test("boss_rename changes the line at once", async () => {
	const a = await main();
	await a.tool("boss_rename", { name: "MP-9 export" });
	assert.equal(entryOf("a1")!.now, "MP-9 export", "the name alone");
	setTodos(a, LIST);
	await a.fire("turn_end");
	await a.tool("boss_rename", { name: "MP-9 csv" });
	assert.equal(entryOf("a1")!.now, "MP-9 csv: Writing the CSV writer");
});

test("pi's default name (the session id) makes no prefix, and no name with no list makes no entry", async () => {
	const b = await main("b1", "b1");
	await b.fire("turn_end");
	assert.equal(entryOf("b1"), undefined, "the default name and no todo list: no entry");
	setTodos(b, LIST);
	await b.fire("turn_end");
	assert.equal(entryOf("b1")!.now, "Writing the CSV writer");
});

test("a stale auto entry goes when the todo list empties and the session has no name; a name keeps a name-only entry; a board_set entry stays", async () => {
	const b = await main("b1", "b1");
	setTodos(b, LIST);
	await b.fire("turn_end");
	assert.ok(entryOf("b1"));
	setTodos(b, []);
	await b.fire("turn_end");
	assert.equal(entryOf("b1"), undefined, "no name, no list: the old line is removed");
	const c = await main("named", "c1", 2);
	setTodos(c, LIST);
	await c.fire("turn_end");
	setTodos(c, []);
	await c.fire("turn_end");
	assert.deepEqual([entryOf("c1")!.now, entryOf("c1")!.who, entryOf("c1")!.count], ["named", "named", undefined]);
	const d = await main("b3", "b3", 3);
	setTodos(d, LIST);
	await d.fire("turn_end");
	await d.tool("board_set", { now: "manual" });
	setTodos(d, []);
	await d.fire("turn_end");
	assert.equal(entryOf("b3")!.now, "manual", "a board_set entry is not an auto line");
});

test("board_set overrides until the todo list or the name moves, and auto: true hands the board back at once", async () => {
	const a = await main();
	setTodos(a, LIST);
	await a.fire("turn_end");
	const answer = textOf(await a.tool("board_set", { now: "manual line", items: [{ t: "mine", done: false }] }));
	assert.match(answer, /It stands until your todo list or your name changes/);
	assert.deepEqual([entryOf("a1")!.src, entryOf("a1")!.now], ["set", "manual line"]);
	await a.fire("turn_end");
	await a.fire("tool_execution_end", { toolCallId: "c", toolName: "bash" });
	assert.equal(entryOf("a1")!.now, "manual line", "the same todo list: the override stands");
	setTodos(a, [todo(1, "Write schema", "completed"), todo(2, "Write the CSV writer", "completed"), todo(3, "Ship", "in_progress")]);
	await a.fire("turn_end");
	assert.deepEqual([entryOf("a1")!.src, entryOf("a1")!.now], ["todo", "api-main: Ship"], "a move in the list ends it");
	await a.tool("board_set", { now: "manual again" });
	await a.tool("boss_rename", { name: "renamed" });
	assert.deepEqual([entryOf("a1")!.src, entryOf("a1")!.now], ["todo", "renamed: Ship"], "so does a new name");
	await a.tool("board_set", { now: "manual three" });
	const back = textOf(await a.tool("board_set", { auto: true }));
	assert.match(back, /handed back to auto-fill \(3 items\)\. It goes to: local towers; allies get its name and done count only/);
	assert.deepEqual([entryOf("a1")!.src, entryOf("a1")!.now, entryOf("a1")!.count], ["todo", "renamed: Ship", { done: 2, total: 3 }]);
});

test("board_set auto: true takes no text, board_set without auto needs one, and a session with nothing to show loses its entry", async () => {
	const a = await main();
	await assert.rejects(a.tool("board_set", { auto: true, now: "x" }), /takes no now or items/);
	await assert.rejects(a.tool("board_set", {}), /now is required unless auto is true/);
	await a.tool("board_set", { now: "manual" });
	assert.ok(entryOf("a1"));
	const a2 = world.agent({ id: "n2", name: "n2", pane: "wA:p2", tab: "wA:t2", deps: { now } });
	await a2.start();
	await a2.promote();
	await a2.tool("board_set", { now: "manual" });
	assert.match(textOf(await a2.tool("board_set", { auto: true })), /nothing to show yet/);
	assert.equal(entryOf("n2"), undefined);
});

test("a member and a demoted main write nothing, and a member's board_set auto is refused", async () => {
	const a = await main();
	const member = world.agent({ id: "m1", name: "helper", pane: "wA:p2", tab: "wA:t1", deps: { now } });
	await member.start();
	setTodos(member, LIST);
	await member.fire("turn_end");
	await assert.rejects(member.tool("board_set", { auto: true }), /Only the main agent of a tab writes/);
	assert.equal(entryOf("m1"), undefined);
	setTodos(a, LIST);
	await a.fire("turn_end");
	const before = entryOf("a1")!;
	await member.command("");
	let demoted = false;
	for (let i = 0; i < 100 && !demoted; i++) demoted = await a.tool("board_set", { now: "x" }).then(() => false, () => true) || (await new Promise((r) => setTimeout(r, 20)), false);
	assert.ok(demoted, "the old main learns it was replaced");
	setTodos(a, [todo(1, "Elsewhere", "in_progress")]);
	await a.fire("turn_end");
	assert.deepEqual(entryOf("a1"), before, "a demoted main writes nothing");
});

test("a board_set entry that outlived a reload stands until the todo list moves; a tower has no board", async () => {
	mkdirSync(boardDir(), { recursive: true });
	writeEntry(boardDir(), "a1", { now: "set before the reload", items: [] }, 5);
	const a = await main();
	setTodos(a, LIST);
	await a.fire("turn_end");
	assert.equal(entryOf("a1")!.now, "set before the reload", "the first reading only records the list");
	await a.fire("turn_end");
	assert.equal(entryOf("a1")!.now, "set before the reload");
	setTodos(a, [todo(1, "Other", "in_progress")]);
	await a.fire("turn_end");
	assert.equal(entryOf("a1")!.now, "api-main: Other");
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	setTodos(tower, LIST);
	await tower.fire("turn_end");
	assert.equal(entryOf("tower-wA"), undefined);
});

test("the entry holds nothing scrubbed away: a path outside the project, a URL with credentials, a token, an email", async () => {
	const a = await main();
	a.cwd = "/work/app";
	setTodos(a, [todo(1, "Fix /Users/me/customer-x/data.csv https://u:p@host.example.com/x sk-ant-api03-abcdefghijklmnop", "in_progress", "Fixing /work/app/src/a.ts for me@corp.example"), todo(2, "Read ghp_0123456789abcdefghijklmnopqrstuv", "pending")]);
	await a.fire("turn_end");
	const file = readFileSync(join(boardDir(), "a1.json"), "utf8");
	for (const secret of ["/Users/me", "customer-x", "u:p@", "sk-ant", "ghp_", "me@corp"]) assert.ok(!file.includes(secret), secret);
	assert.equal(entryOf("a1")!.now, "api-main: Fixing src/a.ts for …");
});

test("the entry goes with the session on quit and stays on reload", async () => {
	for (const reason of ["quit", "reload"]) {
		world = new World();
		const a = await main();
		setTodos(a, LIST);
		await a.fire("turn_end");
		assert.ok(entryOf("a1"));
		await a.stop(reason);
		assert.equal(readdirSync(boardDir()).length, reason === "quit" ? 0 : 1, reason);
	}
});

// ---- What a tower and an ally run read -----------------------------------------------------------------------------------

test("board_read in a remote turn and an ally run's brief show an auto entry as its name and done count; a local turn shows it whole; a board_set entry is whole to all", async () => {
	const project = mkdtempSync(join(tmpdir(), "psb-board-auto-project-"));
	try {
		const a = await main(), b = await main("set-main", "a2", 2);
		world.herdr.pane("wA:p1").cwd = project;
		world.herdr.pane("wA:p2").cwd = project;
		setTodos(a, LIST);
		await a.fire("turn_end");
		await b.tool("board_set", { now: "manual line", items: [{ t: "mine", done: false }] });
		const run = world.herdr.runFor("wA:p1"), scope = { teams: ["t1"], project };
		const read = async (scoped: boolean) => (await readBoard({ dir: boardDir(), now: Date.now(), net: { sessions: await world.broker.sessionList(), ps: await panes(run) }, link: { boards: async () => [], remoteScope: () => (scoped ? scope : undefined) }, scope: "local" })).local as { main: string; now: string; items: unknown[] }[];
		const shape = (rows: { main: string; now: string; items: unknown[] }[]) => rows.map((r) => [r.main, r.now, r.items.length]).sort();
		assert.deepEqual(shape(await read(false)), [["api-main", "api-main: Writing the CSV writer", 3], ["set-main", "manual line", 1]], "a local turn: whole");
		assert.deepEqual(shape(await read(true)), [["api-main", "api-main (1/3)", 0], ["set-main", "manual line", 1]], "a remote turn: what the allies get");
		const gather = (within?: { project: string }) => gatherMains({ run, now: Date.now, sessions: () => world.broker.sessionList(), boardDir: boardDir(), workspace: { workspace_id: "wA", label: "Alpha" } as never, ledger: [], ...(within ? { within } : {}) });
		const nowOf = (g: Awaited<ReturnType<typeof gatherMains>>) => g.rows.flatMap((r) => (r.main ? [[r.main.name, r.main.now, r.main.open]] : [])).sort();
		assert.deepEqual(nowOf(await gather()), [["api-main", "api-main: Writing the CSV writer", 2], ["set-main", "manual line", 1]], "the local run: the line and the open count");
		world.herdr.tabs.find((t) => t.tab_id === "wA:t1")!.label = "tab /etc/secret";
		assert.ok(!JSON.stringify((await gather({ project })).rows).includes("/etc/secret"), "an ally run: no path in a tab label");
		assert.ok(JSON.stringify((await gather()).rows).includes("/etc/secret"), "the local run keeps the raw tab label");
		assert.deepEqual(nowOf(await gather({ project })), [["api-main", "api-main (1/3)", 0], ["set-main", "manual line", 1]], "an ally run: the name and the done count, and no open count (the brief omits a zero)");
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});
