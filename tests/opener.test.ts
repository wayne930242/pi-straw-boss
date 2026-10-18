import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { PROMPT_DIR, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");
const REQUEST = 'Fix the export button on the order page. The boss said: "ship it behind the flag, do not touch prod".';

async function net() {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "docs-main", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await sender.promote();
	return { tower, sender };
}
// The first tab and pane the fake opens in a fresh world.
const NEW = { tab: "wA:t100", pane: "wA:p101", main: "opened-wA:p101" };

test("with no owner, the tower opens one unfocused tab in the workspace, starts pi there as its main, and hands it the request and the sender", async () => {
	world.autoMains();
	const { tower } = await net();
	const result = await tower.tool("boss_open_main", { request: REQUEST, sender: "docs-main", label: "export" });
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", "export", "--cwd", "/w/alpha", "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	const [start] = world.herdr.commands("agent", "start");
	assert.deepEqual(start?.slice(0, 7), ["agent", "start", start![2]!, "--kind", "pi", "--pane", NEW.pane]);
	assert.match(start![2]!, /^main-[0-9a-f]{8}$/);
	assert.deepEqual(start?.slice(-2), ["--name", "main · export"]);
	const opened = world.agents.find((a) => a.id === NEW.main)!;
	assert.equal(opened.tokens.sb_role, "main", "the new pi promoted itself");
	const delivered = world.broker.delivered.filter((d) => d.to === NEW.main);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]?.from, "tower-wA");
	assert.match(delivered[0]!.message, /Sender: docs-main \(session id sender-1\)/);
	assert.ok(delivered[0]!.message.endsWith(`Request, verbatim:\n${REQUEST}`), "the request is carried unchanged");
	assert.deepEqual(result.details, { tab: NEW.tab, pane: NEW.pane, main: NEW.main, sender: "sender-1" });
	assert.match(textOf(result), /Opened tab wA:t100 with a main agent/);
});

test("opening touches no existing pane and never moves the user's focus", async () => {
	world.autoMains();
	const { tower } = await net();
	const before = world.herdr.calls.length;
	await tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" });
	const mine = world.herdr.calls.slice(before);
	assert.deepEqual(world.herdr.commands("tab", "focus"), []);
	assert.deepEqual(mine.filter((args) => !["list", "current", "report-metadata"].includes(args[1]!) && args[1] !== "create" && args[1] !== "start"), [], "only reads, token writes, one tab create, and one agent start");
	assert.ok(mine.filter((args) => args[1] === "report-metadata").every((args) => args[2] === NEW.pane || ["wA:p7", "wA:p1", "wA"].includes(args[2]!)), "no other pane is written");
	assert.ok(mine.every((args) => args[1] !== "start" || args[args.indexOf("--pane") + 1] === NEW.pane), "pi starts only in the pane just created");
	assert.deepEqual(world.herdr.commands("tab", "create").map((args) => args.includes("--no-focus")), [true]);
});

test("the same request is opened once: a repeat, even while the first is running, opens nothing and says so", async () => {
	world.autoMains();
	const { tower } = await net();
	const [first, second] = await Promise.all([tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" }), tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" })]);
	const third = await tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" });
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	assert.equal(world.broker.delivered.filter((d) => d.to === NEW.main).length, 1);
	assert.equal((first.details as { repeated?: boolean }).repeated, undefined);
	assert.deepEqual([(second.details as { repeated?: boolean }).repeated, (third.details as { repeated?: boolean }).repeated], [true, true]);
	assert.match(textOf(third), /already opened for this request/);
});

test("a different request opens its own main", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" });
	await tower.tool("boss_open_main", { request: "Rebuild the index.", sender: "sender-1" });
	assert.equal(world.herdr.commands("tab", "create").length, 2);
});

test("a sender that is not a live session fails before anything opens", async () => {
	world.autoMains();
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { request: REQUEST, sender: "ghost" }), /No live session is named or has the id "ghost"/);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
});

test("a failed agent start closes the tab it created and is reported; the same request is not tried again", async () => {
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: readiness timeout");
	};
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" }), /readiness timeout/);
	assert.deepEqual(world.herdr.closed, [NEW.tab]);
	await assert.rejects(tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" }), /already tried for this request and is not opened again: .*readiness timeout/);
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	assert.equal(world.herdr.commands("agent", "start").length, 1);
});

test("a pi that never becomes the tab's main fails with the pane, closes the tab, and hands over nothing", async () => {
	world.herdr.onAgentStart = (pane) => void (pane.agent = "pi"); // pi runs but joins nothing
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" }), new RegExp(`pane ${NEW.pane} did not become the main agent of its tab within 60 s`));
	assert.deepEqual(world.herdr.closed, [NEW.tab]);
	assert.deepEqual(world.broker.delivered, []);
});

test("a main that refuses the request closes the tab and reports the refusal", async () => {
	world.autoMains();
	world.broker.failing.add(NEW.main);
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1" }), /did not take the request: failed delivery_failed/);
	assert.deepEqual(world.herdr.closed, [NEW.tab]);
});

test("only the tower has the tool; a pi started with the main role promotes itself, and one whose tab has a main stays a member and says so", async () => {
	const { tower, sender } = await net();
	assert.ok(tower.tools.has("boss_open_main"));
	assert.ok(!sender.tools.has("boss_open_main"));
	const second = world.agent({ id: "late", pane: "wA:p2", tab: "wA:t1", env: { STRAW_BOSS_ROLE: "main" } });
	await second.start();
	assert.equal(second.tokens.sb_role, "member", "a live main is never taken over");
	assert.ok(second.notices.some((n) => n.level === "warning" && /already has a main agent, docs-main/.test(n.text)));
	const fresh = world.agent({ id: "fresh", pane: "wA:p3", tab: "wA:t2", env: { STRAW_BOSS_ROLE: "main" } });
	await fresh.start();
	assert.equal(fresh.tokens.sb_role, "main");
});

test("the tower prompt lets it open a main without asking the boss, and keeps its other limits", () => {
	const text = readFileSync(`${PROMPT_DIR}/tower.md`, "utf8");
	assert.match(text, /open a main with boss_open_main without asking the boss/);
	assert.match(text, /verbatim/);
	assert.match(text, /Do no work yourself: no commands, process signals, or edits/);
	assert.match(text, /Never ask the boss \(no ask_user, robot_hand, focus changes\)/);
});
