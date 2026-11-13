import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { integMark, integratorOf } from "../src/integrator.ts";
import { opener, type OpenRequest } from "../src/opener.ts";
import { World } from "./fakes.ts";
import { sleep } from "./server-world.ts";
import { SHA_A, SHA_B, SHA_C, slip } from "./train-fixtures.ts";

// The tower opens the project's one integrator itself (todo #151, the boss's choice of 2026-11-10: the box's tower opens the integrator, and an ally sends only the car slip): `role: "integrator"` on the opener. The main it opens is
// the tower's own (marked `integ:<project>`, named `integ <project>`, so the new pi is of kind integrator from its first turn), counts toward neither the sender's one main nor the workspace's two, and is never a second one for a project.

let world = new World();
let dir = "";
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-")));
	mkdirSync(join(dir, ".straw-boss"));
	mkdirSync(join(dir, ".git"));
	named("acme");
	world.herdr.workspace("wA").worktree = { checkout_path: dir };
});
/** The checkout's apps.json: `project` is its top-level `integration.project` (none when undefined), which the opener reads the integrator's project from. */
const named = (project: unknown, at = dir) => writeFileSync(join(at, ".straw-boss", "apps.json"), JSON.stringify({ ...(project === undefined ? {} : { integration: { project } }), apps: [{ name: "web", dir: "apps/web", integration: { base: "develop" } }, { name: "docs", dir: "docs" }] }));
afterEach(async () => {
	await world.stopAll();
	world = new World();
	rmSync(dir, { recursive: true, force: true });
});

/** A pi started in a tab the tower opened: it carries the name `--name` gave it, as pi's session does, and the role its tab was created with. */
const pis = () => {
	world.herdr.onAgentStart = (pane, args) => void world.agent({ id: `opened-${pane.pane_id}`, name: args[args.indexOf("--name") + 1]!, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "" } }).start();
};
const handed: { to: string; message: string }[] = [];
/** The waits the opener asked for, and what happens during its second look for an integrator (2 s). */
const naps: number[] = [];
let onReread: (() => void) | undefined;
/** The opener of workspace wA's tower, over the world's Herdr and broker; `off` turns the merge train off. */
const towerOpener = (workspaceId = "wA", off = false) => {
	handed.length = 0;
	(naps.length = 0), (onReread = undefined);
	return opener({
		run: world.herdr.runFor(`${workspaceId}:p7`), sleep: (ms) => (naps.push(ms), ms === 2000 && onReread?.(), sleep(Math.min(ms, 2))), workspaceId, cwd: dir, sessions: () => world.broker.sessionList() as never,
		send: async (to, message) => (handed.push({ to, message }), { status: "sent" }), tower: () => ({ id: `tower-${workspaceId}`, name: `tower · ${workspaceId}` }), integrationOff: () => off, stateDir: world.stateDir,
	});
};
async function net() {
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	const senders = [];
	for (const n of [1, 2, 3]) {
		const a = world.agent({ id: `sender-${n}`, name: `coord-${n}`, pane: `wA:p${n}`, tab: "wA:t1" });
		await a.start();
		senders.push(a);
	}
	await senders[0]!.promote();
	return senders;
}
const car = (over: Record<string, string> = {}): OpenRequest => ({ role: "integrator", project: "acme", request: slip({ coordinator: "sender-1", ...over }), sender: "sender-1" });
const tabs = () => world.herdr.commands("tab", "create");
const paneOf = (id: string) => world.herdr.panes.find((p) => p.pane_id === id)!;

test("a car slip opens the project's integrator as the tower's own main: its tab and session are named integ <project>, its pane is marked integ:<project>, the new pi is of kind integrator, and its handoff names the project and the tower and carries no slip", async () => {
	pis();
	await net();
	const opened = await towerOpener()(car());
	assert.deepEqual(tabs(), [["tab", "create", "--workspace", "wA", "--label", "integ acme", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	assert.deepEqual(world.herdr.commands("agent", "start")[0]!.slice(-2), ["--name", "integ acme"]);
	const pane = paneOf(opened.pane);
	assert.equal(pane.tokens.sb_opened_by, "integ:acme", "the marker names the project, not the slip's sender");
	assert.equal(pane.tokens.sb_role, "main");
	assert.equal(pane.tokens.sb_duty, "integrator", "the opened main is of kind integrator before it is handed anything");
	assert.equal(pane.tokens.sb_open_main, undefined, "the one-time token was consumed");
	assert.equal(pane.tokens.sb_open_duty, undefined, "and the kind it was opened with (docs/specs/2026-11-09-agent-kinds.md §6), with it");
	const kinds = world.agents.find((a) => a.id === opened.main)!.entries.flatMap((e) => (e.customType === "straw-boss" && typeof (e.data as { dutyWhy?: unknown }).dutyWhy === "string" ? [(e.data as { dutyWhy: string }).dutyWhy] : []));
	assert.deepEqual(kinds, ["opened by tower of workspace wA as integrator"], "its kind comes from the opener, not from a migration by name");
	assert.deepEqual(opened, { tab: pane.tab_id, pane: pane.pane_id, main: `opened-${pane.pane_id}`, sender: "sender-1", integrator: "acme" });
	assert.equal(handed.length, 1);
	assert.equal(handed[0]!.to, opened.main);
	assert.match(handed[0]!.message, /you are the integrator of project acme/);
	assert.match(handed[0]!.message, /Tower: tower · wA \(session id tower-wA\)/);
	assert.doesNotMatch(handed[0]!.message, /car: web/, "the slip follows as the tower's forward, stamped by the code");
	assert.equal(integratorOf(pane.tokens.sb_opened_by), "acme");
	assert.equal(integMark("acme"), "integ:acme");
});

test("a second slip goes to the same integrator: nothing opens, whoever sends it and whatever it carries, and the same slip sent again is answered from the live net, not from a ledger", async () => {
	pis();
	await net();
	const open = towerOpener();
	const first = await open(car());
	const again = await open({ ...car({ head: SHA_B, coordinator: "sender-2" }), sender: "sender-2" });
	assert.deepEqual(again, { ...first, sender: "sender-2", repeated: true });
	assert.deepEqual(await open(car()), { ...first, repeated: true });
	assert.equal(tabs().length, 1);
	assert.equal(handed.length, 1, "the integrator is told who it is once");
	// The integrator reported idle and the tower closed it: the next slip, even the very same one, opens a new one.
	await world.herdr.runFor("wA:p7")(["tab", "close", first.tab]);
	await world.quiet();
	const next = await open(car());
	assert.equal(next.repeated, undefined);
	assert.notEqual(next.pane, first.pane);
	assert.equal(tabs().length, 2);
});

test("the integrator takes none of the two mains' places and none of its sender's: it opens beside two opened mains, one of them the sender's own, and they keep their limits", async () => {
	world.autoMains();
	await net();
	const open = towerOpener();
	await open({ request: "one", sender: "sender-1" });
	await open({ request: "two", sender: "sender-2" });
	await assert.rejects(open({ request: "three", sender: "sender-3" }), /already has 2 mains opened by its tower \(the limit is 2\)/);
	pis();
	const integ = await open(car());
	assert.equal(integ.integrator, "acme");
	assert.equal(tabs().length, 3);
	world.autoMains();
	await assert.rejects(open({ request: "three", sender: "sender-3" }), /the limit is 2/, "the integrator is not one of the two");
	await assert.rejects(open({ request: "again", sender: "sender-1" }), /already has an opened main running/, "the sender's own limit still holds");
});

test("with the integrator open, two mains still open: it uses up no place", async () => {
	pis();
	await net();
	const open = towerOpener();
	await open(car());
	world.autoMains();
	await open({ request: "one", sender: "sender-1" });
	await open({ request: "two", sender: "sender-2" });
	assert.equal(tabs().length, 3);
});

test("never two for one project: a main the boss opened as integ <project> of kind integrator takes the slip, in whatever workspace it runs", async () => {
	pis();
	await net();
	world.herdr.addTab("wB:t9", "integ", "wB:p9");
	const boss = world.agent({ id: "boss-integ", name: "integ acme", pane: "wB:p9" });
	await boss.start();
	await boss.promote();
	await boss.run(); // its first run migrates it by its name (mainduty.ts)
	await world.quiet();
	assert.equal(paneOf("wB:p9").tokens.sb_duty, "integrator");
	Object.assign(paneOf("wB:p9"), { cwd: join(dir, "apps", "web") });
	const got = await towerOpener()(car());
	assert.deepEqual(got, { tab: "wB:t9", pane: "wB:p9", main: "boss-integ", sender: "sender-1", integrator: "acme", repeated: true });
	assert.deepEqual(tabs(), []);
	// A main opened for a teammate's device that calls itself the project's integrator is not one: the tower's own would open beside it (here the boss's takes the slip).
	world.herdr.addTab("wA:t8", "integ", "wA:p8");
	const peers = world.agent({ id: "peer-integ", name: "integ acme", pane: "wA:p8" });
	await peers.start();
	await peers.promote();
	await peers.run();
	await world.quiet();
	paneOf("wA:p8").tokens.sb_opened_by = `link:${"a".repeat(26)}`;
	assert.equal(paneOf("wA:p8").tokens.sb_duty, "integrator");
	assert.equal((await towerOpener()(car())).main, "boss-integ");
	// Another project's integrator is no one's stand-in: it works in its own repository, in another workspace.
	Object.assign(paneOf("wB:p9"), { cwd: tmpdir() });
	named("beta");
	const other = await towerOpener()({ ...car(), project: "beta" });
	assert.equal(other.repeated, undefined);
	assert.equal(paneOf(other.pane).tokens.sb_opened_by, "integ:beta");
});

test("never two for one project: a marked pane whose pi has not joined, or whose main is of another kind now, opens no second one and is told as it is; two live integrators of a project are named", async () => {
	pis();
	await net();
	const open = towerOpener();
	// A pane a tower marked a moment ago (or whose pi died): the marker counts at once.
	world.herdr.addTab("wB:t8", "integ acme", "wB:p8", "shell");
	paneOf("wB:p8").tokens.sb_opened_by = "integ:acme";
	await assert.rejects(open(car()), /The integrator of project acme \(pane wB:p8\) has not joined yet or no longer answers/);
	assert.deepEqual(tabs(), []);
	// It joined, and is a coordinator now (it called boss_duty): still the project's one, and no slip goes to it.
	const switched = world.agent({ id: "was-integ", name: "integ acme", pane: "wB:p8" });
	await switched.start();
	await switched.promote();
	await switched.run();
	await switched.tool("boss_duty", { duty: "coordinator", reason: "testing" });
	await world.quiet();
	paneOf("wB:p8").tokens.sb_opened_by = "integ:acme";
	await assert.rejects(open(car()), /The main opened as the integrator of project acme \(integ acme, session was-integ\) is of kind coordinator now/);
	assert.deepEqual(tabs(), []);
	// Two that both answer to the name: nothing is guessed.
	await switched.tool("boss_duty", { duty: "integrator", reason: "back" });
	world.herdr.addTab("wA:t9", "integ", "wA:p9");
	const twin = world.agent({ id: "twin-integ", name: "integ acme", pane: "wA:p9" });
	await twin.start();
	await twin.promote();
	await twin.run();
	await world.quiet();
	await assert.rejects(open(car()), /Project acme has 2 integrators \(session (was-integ|twin-integ), session (was-integ|twin-integ)\); a project has one/);
	assert.deepEqual(tabs(), []);
});

test("a project keeps one name: an app whose trains an integrator's ledger keeps under a project goes to that project, whatever the checkout calls itself", async () => {
	pis();
	await net();
	mkdirSync(join(world.stateDir, "trains", "acme"), { recursive: true });
	writeFileSync(join(world.stateDir, "trains", "acme", "web.json"), JSON.stringify({ index: [] }));
	mkdirSync(join(world.stateDir, "trains", "other"), { recursive: true });
	writeFileSync(join(world.stateDir, "trains", "other", "api.json"), "{}"); // another app's ledger says nothing of web
	const open = towerOpener();
	named("acme-web");
	await assert.rejects(open({ ...car(), project: "acme-web" }), /The trains of app web are kept under project acme \(trains\/acme\/web\.json in the state folder\), and this checkout's project reads acme-web \(integration\.project in .*apps\.json\): its cars go to one integrator, so set integration\.project in .*apps\.json to the project that keeps them\./);
	named(undefined); // the folder's name is no better: the ledger still says acme
	await assert.rejects(open({ ...car(), project: undefined }), /this checkout's project reads psb-integ-\S+ \(the folder name of its repository; .*apps\.json names no integration\.project\)/);
	assert.deepEqual(tabs(), []);
	named("acme");
	assert.equal((await open(car())).integrator, "acme");
});

test("a tower opens at most two integrators in its workspace: a third project waits, and a closed one frees its place", async () => {
	pis();
	await net();
	const open = towerOpener();
	// One checkout has one project, so a second one in a workspace takes the boss renaming the checkout's project while the first still runs.
	const first = await open(car());
	named("beta");
	await open({ ...car(), project: "beta" });
	named("gamma");
	await assert.rejects(open({ ...car(), project: "gamma" }), /Workspace Alpha already has 2 integrators opened by its tower \(acme, beta; the limit is 2\)/);
	assert.equal(tabs().length, 2);
	await world.herdr.runFor("wA:p7")(["tab", "close", first.tab]);
	await world.quiet();
	await open({ ...car(), project: "gamma" });
	assert.equal(tabs().length, 3);
});

test("an integrator is opened on a car slip of an app that takes the train, and on nothing else: each refusal names what is missing and opens nothing", async () => {
	pis();
	await net();
	const open = towerOpener();
	await assert.rejects(open({ ...car(), request: "please open an integrator for acme" }), /An integrator is opened on a car slip/);
	await assert.rejects(open({ ...car(), project: "../up" }), /The project of this workspace's checkout is acme/);
	await assert.rejects(open(car({ car: "docs" })), /app docs has no integration/);
	await assert.rejects(open(car({ car: "ghost" })), /has no app named ghost, so its car takes no train \(the slip's car: names the car's app/);
	await assert.rejects(open({ ...car(), request: `app: web | ${slip({ coordinator: "sender-1", car: "T-15" })}` }), /cannot be taken as written: .*app: "web" and car: "T-15" name two apps/, "0.77.3 A3: an inline app: is read, and one that differs from car: is refused with the reason");
	await assert.rejects(open(car({ colour: "blue" })), /cannot be taken as written: .*colour is not a slip field/, "0.77.3 A3: an unknown field is refused, not dropped");
	await assert.rejects(open({ ...car(), request: `${slip({ coordinator: "sender-1" })}\nNote: urgent` }), /note is not a slip field.*A slip ends at a blank line: words of your own \(`Note: …`\) go after one/, "R0773-F003: the refusal says how to send prose with a slip");
	await assert.rejects(open({ ...car(), sender: "nobody" }), /No live session is named or has the id "nobody"/);
	await assert.rejects(open({ ...car(), peer: { id: "link:d1", label: "Ann's laptop", short: "ab12" } }), /not for a teammate's device/);
	await assert.rejects(towerOpener("wA", true)(car()), /integration is off on this computer/);
	await assert.rejects(open({ ...car(), role: "main" }), /role must be "train" or "integrator"/);
	rmSync(join(dir, ".straw-boss", "apps.json"));
	await assert.rejects(open(car()), /apps\.json.* is not there/);
	assert.deepEqual(tabs(), []);
	assert.deepEqual(handed, []);
});

test("a refused or failed integrator open is not kept: the same slip opens one once what refused it is gone", async () => {
	await net();
	const open = towerOpener();
	world.herdr.onAgentStart = () => {}; // pi never joins
	await assert.rejects(open(car()), /did not become the integrator of project acme/);
	assert.equal(world.herdr.closed.length, 1, "the tab of the failed open was closed");
	pis();
	const opened = await open(car());
	assert.equal(opened.repeated, undefined);
	assert.equal(opened.integrator, "acme");
});

test("a new pi that joins as a main of another kind is not handed the project: the open fails, its tab is closed, and nothing is left marked", async () => {
	await net();
	// Its own read of the switch says the merge train is off, so its name does not make it an integrator (mainduty.ts).
	world.herdr.onAgentStart = (pane, args) => void world.agent({ id: `opened-${pane.pane_id}`, name: args[args.indexOf("--name") + 1]!, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "main", STRAW_BOSS_INTEGRATION: "off" } }).start();
	await assert.rejects(towerOpener()(car()), /did not become the integrator of project acme \(a main of kind integrator\)/);
	assert.equal(world.herdr.closed.length, 1);
	assert.deepEqual(handed, []);
	assert.equal(world.herdr.panes.some((p) => p.tokens.sb_opened_by === "integ:acme"), false);
});

test("a resident tower session opens no integrator: the door is a run's, where the server holds the messages a slip came in", async () => {
	world.autoMains();
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "coord-1", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await assert.rejects(tower.tool("boss_open_main", { ...car(), sender: "sender-1" }), /role integrator works in a tower run of the sb server/);
	assert.deepEqual(tabs(), []);
});

test("the marker is the opener's own: a session whose id reads as one gets no main opened in its name, and a main that carries the marker is not counted for a sender", async () => {
	world.autoMains();
	await net();
	const forged = world.agent({ id: "integ:acme", name: "odd", pane: "wA:p4", tab: "wA:t1" });
	await forged.start();
	const open = towerOpener();
	await assert.rejects(open({ request: "work", sender: "integ:acme" }), /reads as an integrator's marker/);
	assert.deepEqual(tabs(), []);
	assert.equal(integratorOf("integ:"), undefined);
	assert.equal(integratorOf("integ:../up"), undefined);
	assert.equal(integratorOf("link:abc"), undefined);
	assert.equal(integratorOf(undefined), undefined);
	assert.equal(SHA_C.length, 40);
});

// --- review fixes (R151-F002, F003) ---------------------------------------------------------------------------------------------------------------------------

test("the project is the checkout's, not the caller's word: apps.json names it, another word opens nothing and fills no place, and no word at all opens the checkout's own", async () => {
	pis();
	await net();
	const open = towerOpener();
	// A slip of this checkout's app cannot be sent to another project, and made-up names cannot use up the workspace's two integrators.
	for (const word of ["beta", "gamma", "acme-2", "Acme", ""]) await assert.rejects(open({ ...car(), project: word }), /The project of this workspace's checkout is acme \(integration\.project in .*apps\.json\), not "[^"]*": the slip of its app web goes to integ acme and to no other project's integrator\./);
	assert.deepEqual(tabs(), []);
	const opened = await open({ ...car(), project: undefined });
	assert.equal(opened.integrator, "acme");
	assert.equal(paneOf(opened.pane).tokens.sb_opened_by, "integ:acme");
	assert.equal(world.herdr.commands("agent", "start")[0]!.at(-1), "integ acme");
	// A name the file gives that is none is a refusal, not a guess.
	for (const odd of ["../up", "a b", 7, { name: "acme" }]) {
		named(odd);
		await assert.rejects(open({ ...car(), project: undefined }), /apps\.json: integration\.project must be a path-safe name/);
	}
	assert.equal(tabs().length, 1);
});

test("a checkout whose apps.json names no project is its repository's folder: every worktree of one repository reads the same project, so its app gets one integrator's name before any ledger exists", async () => {
	pis();
	await net();
	named(undefined);
	const folder = basename(dir);
	const first = await towerOpener()({ ...car(), project: undefined });
	assert.equal(first.integrator, folder);
	await assert.rejects(towerOpener()({ ...car(), project: "acme" }), new RegExp(`The project of this workspace's checkout is ${folder} \\(the folder name of its repository; .*apps\\.json names no integration\\.project\\), not "acme"`));
	// A linked worktree of the same repository, in another folder and another workspace: git's own files lead back to the repository, and its project is the same.
	const tree = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-tree-")));
	try {
		mkdirSync(join(dir, ".git", "worktrees", "feat"), { recursive: true });
		writeFileSync(join(dir, ".git", "worktrees", "feat", "commondir"), "../..\n");
		writeFileSync(join(tree, ".git"), `gitdir: ${join(dir, ".git", "worktrees", "feat")}\n`);
		mkdirSync(join(tree, ".straw-boss"));
		named(undefined, tree);
		world.herdr.workspace("wB").worktree = { checkout_path: tree };
		world.herdr.addTab("wB:t7", "tower", "wB:p7");
		const again = await towerOpener("wB")({ ...car(), project: undefined });
		assert.deepEqual(again, { ...first, repeated: true }, "the worktree's slip goes to the repository's one integrator");
		assert.equal(tabs().length, 1);
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
});

test("an integrator that works in another repository takes no slip of this one, whatever name it carries: the open is refused and names both; one in a worktree of this repository takes it", async () => {
	pis();
	await net();
	const other = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-other-")));
	try {
		mkdirSync(join(other, ".git"));
		world.herdr.addTab("wB:t9", "integ", "wB:p9");
		const theirs = world.agent({ id: "their-integ", name: "integ acme", pane: "wB:p9" });
		await theirs.start();
		await theirs.promote();
		await theirs.run();
		await world.quiet();
		Object.assign(paneOf("wB:p9"), { cwd: other });
		await assert.rejects(towerOpener()(car()), /The integrator of project acme \(integ acme, session their-integ\) works in another repository \(.*psb-integ-other-\S+\), not in this workspace's \(.*psb-integ-\S+\): a project's integrator works in its project's checkout, so no slip goes to it\./);
		// Herdr names no folder for its pane: nothing is assumed.
		Object.assign(paneOf("wB:p9"), { cwd: undefined });
		await assert.rejects(towerOpener()(car()), /works in a folder Herdr does not name/);
		assert.deepEqual(tabs(), []);
		assert.deepEqual(handed, []);
		Object.assign(paneOf("wB:p9"), { cwd: dir });
		assert.equal((await towerOpener()(car())).main, "their-integ");
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});

test("an ally run's slip stays inside the project its team binds here: a workspace whose checkout is outside it opens nothing, and one inside it does", async () => {
	pis();
	await net();
	const open = towerOpener(), outside = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-out-")));
	try {
		for (const within of [outside, join(dir, "apps"), ""]) await assert.rejects(open({ ...car(), within }), /An ally run's slip goes to the integrator of the project its team binds on this computer, and this workspace's checkout is outside that project/);
		assert.deepEqual(tabs(), []);
		assert.equal((await open({ ...car(), within: dir })).integrator, "acme");
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
});

test("one integrator per project across workspaces: two towers' openers that take a slip of the same project at the same moment open one, and the other's slip goes to it", async () => {
	pis();
	await net();
	world.herdr.workspace("wB").worktree = { checkout_path: dir };
	world.herdr.addTab("wB:t7", "tower", "wB:p7");
	const a = towerOpener("wA"), b = towerOpener("wB");
	const both = await Promise.all([a(car()), b({ ...car({ head: SHA_B, coordinator: "sender-2" }), sender: "sender-2" })]);
	assert.equal(tabs().length, 1, "one tab, whichever tower was first");
	assert.deepEqual(both.map((o) => o.repeated).sort(), [true, undefined].sort());
	assert.equal(both[0]!.main, both[1]!.main);
	assert.equal(world.herdr.panes.filter((p) => p.tokens.sb_opened_by === "integ:acme").length, 1);
	// A failed open gives the project's turn back: the next one is not left waiting.
	await world.herdr.runFor("wA:p7")(["tab", "close", both[0]!.tab]);
	await world.quiet();
	world.herdr.onAgentStart = () => {};
	const failed = await Promise.allSettled([a(car()), b(car())]);
	assert.deepEqual(failed.map((f) => f.status), ["rejected", "rejected"]);
	pis();
	assert.equal((await b(car())).repeated, undefined);
});

// --- a project that already runs integrators of its own (0.73: the boss's, one per app) ---------------------------------------------------------------------------------------

/** A live main of kind integrator under `name`, in `pane`: the boss opened it, so no tower marked its pane. */
async function bossIntegrator(id: string, name: string, pane: string, cwd?: string) {
	world.herdr.addTab(`${pane.split(":")[0]}:t${pane.split(":p")[1]}`, name, pane);
	const a = world.agent({ id, name, pane });
	await a.start();
	await a.promote();
	await a.tool("boss_duty", { duty: "integrator", reason: "the boss's own" });
	await world.quiet();
	assert.equal(paneOf(pane).tokens.sb_duty, "integrator");
	if (cwd !== undefined) Object.assign(paneOf(pane), { cwd });
	return a;
}

test("a project that already runs integrators under names of their own keeps them: the door opens nothing and names each, wherever in the workspace or the checkout it works; they are never two of one project and take none of the tower's two places", async () => {
	pis();
	await net();
	// Like the boss's MP Center: one integrator per app, in the tower's workspace; one works in its app's own repository below the checkout.
	mkdirSync(join(dir, "apps", "web", ".git"), { recursive: true });
	await bossIntegrator("integ-fe2", "integ FE2", "wA:p31", dir);
	await bossIntegrator("integ-v3", "integ v3", "wA:p32", join(dir, "apps", "web"));
	const open = towerOpener();
	await assert.rejects(open(car()), (error: Error) => {
		assert.equal(error.constructor.name, "ForwardAsBefore");
		assert.deepEqual((error as unknown as { mains: unknown }).mains, [{ id: "integ-fe2", name: "integ FE2" }, { id: "integ-v3", name: "integ v3" }]);
		assert.match(error.message, /Project acme already runs 2 integrators of its own, opened before this door and not by it: integ FE2 \(session integ-fe2\), integ v3 \(session integ-v3\)\. Nothing opens beside them and the door picks none: the slip of app web goes to the one that runs that app's trains, forwarded as before\./);
		return true;
	});
	await assert.rejects(open({ ...car(), project: undefined }), /already runs 2 integrators of its own/);
	assert.deepEqual(tabs(), []);
	assert.deepEqual(handed, []);
	// One of them is named after the project as well: still the boss's set, and the door picks none of the three.
	await bossIntegrator("integ-acme", "integ acme", "wA:p33", dir);
	await assert.rejects(open(car()), /already runs 3 integrators of its own.*integ acme \(session integ-acme\)/);
	assert.deepEqual(tabs(), []);
});

test("which mains are a project's own integrators: one in another workspace counts only when it works in this checkout; a coordinator, a peer's main, and a tower-marked integrator are none, and the door opens beside them", async () => {
	pis();
	await net();
	const other = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-kept-")));
	try {
		mkdirSync(join(other, ".git"));
		// Another repository's integrator in another workspace, a coordinator in this one, and a main opened for a teammate's device that declared the kind: none of them is this project's.
		await bossIntegrator("their-integ", "integ theirs", "wB:p31", other);
		const coordinator = await bossIntegrator("was-integ", "integ old", "wA:p32", dir);
		await coordinator.tool("boss_duty", { duty: "coordinator", reason: "testing" });
		await bossIntegrator("peer-integ", "integ peer", "wA:p33", dir);
		paneOf("wA:p33").tokens.sb_opened_by = `link:${"a".repeat(26)}`;
		await world.quiet();
		const open = towerOpener(), first = await open(car());
		assert.equal(first.repeated, undefined);
		assert.equal(paneOf(first.pane).tokens.sb_opened_by, "integ:acme");
		// The tower's own (marked) integrator is the door's: the next slip goes to it.
		assert.deepEqual(await open(car({ head: SHA_B })), { ...first, repeated: true });
		assert.equal(tabs().length, 1);
		// The other workspace's integrator moves into this checkout: now the project runs one of its own, and the door forwards to neither.
		mkdirSync(join(dir, "apps", "web", ".git"), { recursive: true }); // an app's own repository below the checkout
		Object.assign(paneOf("wB:p31"), { cwd: join(dir, "apps", "web") });
		await assert.rejects(open(car({ head: SHA_C })), /Project acme already runs an integrator of its own, opened before this door and not by it: integ theirs \(session their-integ\)\. Nothing opens beside it and the door picks none/);
		assert.equal(tabs().length, 1);
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});

test("a ledger of the project and no integrator seen: the door looks once more, and opens one only when no unmarked integrator main is alive on the computer; otherwise it refuses and names it (RR151-F003)", async () => {
	pis();
	await net();
	const other = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-unseen-")));
	try {
		mkdirSync(join(other, ".git"));
		mkdirSync(join(world.stateDir, "trains", "acme"), { recursive: true });
		writeFileSync(join(world.stateDir, "trains", "acme", "web.json"), JSON.stringify({ index: [] }));
		// The project's kept integrator sits outside the tower's workspace and outside the checkout (a train's worktree elsewhere): the door does not see it as the project's.
		const kept = await bossIntegrator("integ-fe2", "integ FE2", "wB:p31", other);
		const open = towerOpener();
		await assert.rejects(open(car()), /^Error: No integrator of project acme is seen in this workspace or its checkout, and its ledger \(trains\/acme in the state folder\) says one has run its trains; integ FE2 \(session integ-fe2\) is a main of kind integrator elsewhere on this computer, so nothing opens beside it\. Try again, or ask the boss: an integrator the project keeps sits in the tower's workspace or works in the checkout\.$/);
		assert.deepEqual([tabs(), naps.filter((ms) => ms === 2000)], [[], [2000]], "nothing opened, after one second look");
		// It is back in the checkout by the second look (a restart, a takeover): the slip is forwarded to it as before.
		onReread = () => void Object.assign(paneOf("wB:p31"), { cwd: dir });
		await assert.rejects(open(car()), /Project acme already runs an integrator of its own, opened before this door and not by it: integ FE2 \(session integ-fe2\)/);
		assert.deepEqual(tabs(), []);
		// No main of kind integrator is alive anywhere: the dead one is replaced.
		onReread = undefined;
		Object.assign(paneOf("wB:p31"), { cwd: other });
		await kept.tool("boss_duty", { duty: "coordinator", reason: "testing" });
		await world.quiet();
		naps.length = 0;
		const first = await open(car());
		assert.equal(first.repeated, undefined);
		assert.deepEqual([tabs().length, naps.filter((ms) => ms === 2000)], [1, [2000]]);
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});
