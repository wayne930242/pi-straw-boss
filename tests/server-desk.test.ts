import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type CliDeps, parseArgs, run, UsageError } from "../src/server/cli.ts";
import { deskLockFor, integrationPath, integrationState, readDesk } from "../src/server/desk.ts";
import { fileOf, slotOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { TOWER_LABEL } from "../src/herdr.ts";
import { TowerWorld } from "./tower-world.ts";

// docs/specs/2026-10-26-desk-mode.md S5 and S6 as docs/specs/2026-10-26-sb-backend.md, Desk mode: what changes, has them: `cli.mjs up --dir <folder> --label <name>` makes the home base
// and finds its tower through the sb server, installs Herdr's pi integration, and prints the GUI's address. The Herdr is the fake one; the server and its tower service are the real ones.

let world: TowerWorld;
let home: string;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.STRAW_BOSS_DESK = "1";
	home = join(world.root, "home", "Straw Boss");
	mkdirSync(home, { recursive: true });
	// Herdr's integration folder is the agent directory's `extensions`, which a fresh agent directory of the shell does not have yet.
	world.herdr.integration.file = join(world.root, "agent", "extensions", "herdr-agent-state.ts");
});
afterEach(() => world.close());

interface Out { code: number; out: string; err: string; json: Record<string, any> | undefined; errJson: Record<string, any> | undefined }
async function up(argv: string[] = ["--dir", home, "--label", "Desk"], over: Partial<CliDeps> = {}): Promise<Out> {
	const version = "0.44.0";
	const { by: _by, ...requester } = world.ctx({ version });
	let out = "", err = "";
	const code = await run(["up", ...argv], {
		env: world.env, stateDir: world.stateDir, version, cli: "/fake/cli.mjs", ctx: requester, herdrListens: async () => true, herdrCli: world.herdr.runFor("cli"),
		out: (t) => void (out += t), err: (t) => void (err += t), ...over,
	});
	const parse = (text: string) => { try { return JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "") as Record<string, any>; } catch { return undefined; } };
	return { code, out, err, json: parse(out), errJson: parse(err) };
}
/** The person's own shell tab in the base, so the workspace outlives its tower tab (Herdr closes a workspace that has no tab left). */
function shellTab(workspace: string, cwd: string) {
	world.herdr.tabs.push({ tab_id: `${workspace}:tshell`, label: "shell", workspace_id: workspace });
	world.herdr.panes.push({ pane_id: `${workspace}:pshell`, tab_id: `${workspace}:tshell`, workspace_id: workspace, terminal_id: "term_shell", tokens: {}, cwd } as (typeof world.herdr.panes)[number]);
}
const desk = () => { const found = readDesk(world.slot); return typeof found === "object" ? found : undefined; };
const created = () => world.herdr.commands("workspace", "create");
const names = (r: Out) => (r.json?.steps as { name: string }[]).map((s) => s.name);

// --- usage ---

test("--dir and --label go together; --dir without the desk switch is exit 2 and starts nothing", async () => {
	assert.deepEqual(parseArgs(["up", "--dir", "/x", "--label", "y", "--timeout", "9"]), { command: "up", flags: { dir: "/x", label: "y", timeout: "9" } });
	assert.throws(() => parseArgs(["up", "--dir", "/x"]), UsageError);
	assert.throws(() => parseArgs(["up", "--label", "y"]), UsageError);
	assert.throws(() => parseArgs(["up", "--dir", "/x", "--label", ""]), UsageError);
	assert.throws(() => parseArgs(["status", "--dir", "/x", "--label", "y"]), UsageError);
	const lone = await up(["--dir", home]);
	assert.equal(lone.code, 2);
	assert.match(lone.err, /--label/);
	delete world.env.STRAW_BOSS_DESK;
	const off = await up(["--dir", home, "--label", "Desk"]);
	assert.equal(off.code, 2);
	assert.match(off.err, /STRAW_BOSS_DESK=1/);
	assert.equal(world.record(), undefined, "no server was started");
	assert.deepEqual([created().length, world.spawned.length, world.herdr.integration.installs], [0, 0, 0]);
	// Without --dir nothing of the desk runs, with or without the switch.
	const plain = await up([]);
	assert.equal(plain.code, 0, plain.err);
	assert.deepEqual(names(plain), ["herdr", "version", "server", "gui"]);
	assert.equal(created().length, 0);
});

// --- a fresh run ---

test("a fresh run installs the integration, makes one workspace in --dir with the tower tab, finds its tower through the server, writes desk.json, and prints the address", async () => {
	const r = await up();
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(names(r), ["herdr", "integration", "version", "server", "base", "tower", "gui"]);
	const j = r.json!, gui = world.record()!.gui!;
	assert.equal(j.url, `http://127.0.0.1:${gui.port}/${gui.token}/`);
	assert.equal(j.created, true);
	assert.equal(j.integration, "installed");
	assert.deepEqual((j.warnings as { code: string }[]).map((w) => w.code), ["integration_installed"]);
	assert.equal(j.desk, true);
	assert.equal(j.server, "started");
	// One workspace, in the folder, with the label; its first tab is the tower tab and its root pane is marked; no Straw Boss environment, and no pi.
	const [make] = created();
	assert.deepEqual(make, ["workspace", "create", "--cwd", home, "--label", "Desk", "--no-focus"]);
	assert.equal(created().length, 1);
	const base = world.herdr.workspaces.at(-1)!;
	assert.equal(base.label, "Desk");
	assert.equal(j.workspace, base.workspace_id);
	const tab = world.herdr.tabs.filter((t) => t.workspace_id === base.workspace_id);
	assert.deepEqual(tab.map((t) => t.label), [TOWER_LABEL], "no stray shell tab");
	assert.equal(world.herdr.commands("tab", "create").length, 0, "the base's own first tab is the tower's tab");
	assert.deepEqual(world.herdr.commands("agent", "start"), []);
	const standing = world.herdr.pane(String(j.pane));
	assert.equal(standing.tokens.sb_role, "tower");
	assert.equal(standing.tab_id, tab[0]!.tab_id);
	assert.equal(standing.env?.length ?? 0, 0, "the shell gets no environment of Straw Boss's");
	// The tower is the server's identity for the workspace.
	assert.equal(j.tower, `sb-tower-${base.workspace_id.toLowerCase()}`);
	assert.equal(base.tokens.tower, j.tower);
	// desk.json: the contract of the home base, mode 600.
	assert.deepEqual(desk(), { workspace: base.workspace_id, dir: home, label: "Desk" });
	if (process.platform !== "win32") assert.equal(statSync(join(world.slot.dir, "desk.json")).mode & 0o777, 0o600);
	assert.equal(existsSync(fileOf(world.slot, "deskLock")), false, "the lock is released");
	assert.ok(!r.out.includes(world.record()!.secret));
});

test("a second run creates nothing and prints the same workspace, pane and tower", async () => {
	const first = await up();
	assert.equal(first.code, 0, first.err);
	const again = await up();
	assert.equal(again.code, 0, again.err);
	assert.equal(again.json?.created, false);
	assert.equal(again.json?.integration, "current");
	assert.deepEqual((again.json?.warnings as unknown[]), []);
	assert.deepEqual([again.json?.workspace, again.json?.pane, again.json?.tower, again.json?.url], [first.json?.workspace, first.json?.pane, first.json?.tower, first.json?.url]);
	assert.equal(again.json?.server, "found");
	assert.equal(created().length, 1);
	assert.equal(world.herdr.commands("tab", "create").length, 0);
	assert.equal(world.herdr.integration.installs, 1);
});

test("the recorded workspace is used whatever its label is now; one that is gone is made again", async () => {
	const first = await up();
	const ws = world.herdr.workspace(String(first.json?.workspace));
	ws.label = "Renamed by the person";
	const same = await up(["--dir", home, "--label", "Another name"]);
	assert.equal(same.code, 0, same.err);
	assert.deepEqual([same.json?.workspace, same.json?.created], [first.json?.workspace, false]);
	assert.deepEqual(desk(), { workspace: ws.workspace_id, dir: home, label: "Desk" }, "the record is not rewritten");
	// The person quit the base: the next run makes a new one and records it.
	await callControl(world.record()!.socket, world.record()!.secret, { cmd: "close-tower", workspace: ws.workspace_id });
	world.herdr.workspaces = world.herdr.workspaces.filter((w) => w !== ws);
	world.herdr.tabs = world.herdr.tabs.filter((t) => t.workspace_id !== ws.workspace_id);
	world.herdr.panes = world.herdr.panes.filter((p) => p.workspace_id !== ws.workspace_id);
	const fresh = await up(["--dir", home, "--label", "Another name"]);
	assert.equal(fresh.code, 0, fresh.err);
	assert.equal(fresh.json?.created, true);
	assert.notEqual(fresh.json?.workspace, ws.workspace_id);
	assert.equal(world.herdr.workspace(String(fresh.json?.workspace)).label, "Another name");
	assert.deepEqual(desk(), { workspace: fresh.json?.workspace, dir: home, label: "Another name" });
	assert.equal(created().length, 2);
});

test("a tower the person closed is opened again in the same base, and a base never gets a second tab for it while its tower stands", async () => {
	const first = await up();
	shellTab(String(first.json?.workspace), home);
	const record = world.record()!;
	assert.equal((await callControl(record.socket, record.secret, { cmd: "close-tower", workspace: String(first.json?.workspace) })).reply?.ok, true);
	const again = await up();
	assert.equal(again.code, 0, again.err);
	assert.deepEqual([again.json?.workspace, again.json?.created], [first.json?.workspace, true]);
	assert.equal(created().length, 1, "the base is the same");
	assert.equal(world.herdr.tabs.filter((t) => t.workspace_id === first.json?.workspace && t.label === TOWER_LABEL).length, 1);
	assert.deepEqual(world.herdr.commands("agent", "start"), []);
});

test("after a Herdr restart the base is found by its workspace id and the restored tower is used: no workspace, no tab", async () => {
	const first = await up();
	assert.equal(first.code, 0, first.err);
	world.herdr.restart(); // forgets the commands so far: what comes after is the second run's own
	const [workspaces, tabs] = [world.herdr.workspaces.length, world.herdr.tabs.length];
	world.takeovers.forEach((cb) => cb());
	const again = await up();
	assert.equal(again.code, 0, again.err);
	assert.deepEqual([again.json?.workspace, again.json?.pane, again.json?.created], [first.json?.workspace, first.json?.pane, false]);
	assert.deepEqual([created().length, world.herdr.commands("tab", "create").length, world.herdr.workspaces.length, world.herdr.tabs.length], [0, 0, workspaces, tabs]);
	assert.equal(world.herdr.workspace(String(first.json?.workspace)).tokens.tower, first.json?.tower);
});

test("the folder must exist: a missing --dir fails at base with the folder named, and nothing is made", async () => {
	const missing = join(world.root, "home", "nowhere");
	const r = await up(["--dir", missing, "--label", "Desk"]);
	assert.equal(r.code, 1);
	assert.equal(r.errJson?.step, "base");
	assert.match(String(r.errJson?.reason), /nowhere/);
	assert.equal(created().length, 0);
	assert.equal(desk(), undefined);
	assert.equal(existsSync(fileOf(world.slot, "deskLock")), false);
});

// --- the tower step ---

test("with the tower service off the tower step fails with the server's own words, and the base made stays recorded", async () => {
	world.setFlag(false);
	const r = await up();
	assert.equal(r.code, 1);
	assert.equal(r.errJson?.step, "tower");
	assert.match(String(r.errJson?.reason), /towerRuns\.enabled is off/);
	assert.deepEqual((r.errJson?.steps as { name: string; ok: boolean }[]).map((s) => `${s.name}:${s.ok}`), ["herdr:true", "integration:true", "version:true", "server:true", "base:true", "tower:false"]);
	assert.equal(existsSync(fileOf(world.slot, "deskLock")), false, "the lock is released on a failure");
	// The next run, with the service on, finds the same base.
	world.setFlag(true);
	const fixed = await up();
	assert.equal(fixed.code, 0, fixed.err);
	assert.equal(created().length, 1);
	assert.equal(fixed.json?.workspace, desk()?.workspace);
});

test("a base that cannot be marked is closed again and not recorded", async () => {
	const call = world.herdr.runFor("cli");
	const r = await up(["--dir", home, "--label", "Desk"], { herdrCli: async (args) => { if (args[0] === "tab" && args[1] === "rename") throw new Error("herdr tab rename failed: not answering"); return call(args); } });
	assert.equal(r.code, 1);
	assert.equal(r.errJson?.step, "base");
	assert.equal(desk(), undefined);
	assert.equal(world.herdr.commands("workspace", "close").length, 1, "the stray workspace is closed");
	assert.equal(world.herdr.workspaces.some((w) => w.label === "Desk"), false);
});

// --- busy ---

test("a second run while one holds desk.lock is exit 1 at base with busy; a lock of a dead process or older than ten minutes is taken over", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	const lock = fileOf(world.slot, "deskLock"), holder = 4242;
	world.live.add(holder);
	writeFileSync(lock, JSON.stringify({ pid: holder, by: "up --dir", since: new Date().toISOString() }));
	const busy = await up();
	assert.equal(busy.code, 1);
	assert.equal(busy.errJson?.step, "base");
	assert.match(String(busy.errJson?.reason), /busy/);
	assert.equal(created().length, 0);
	assert.ok(existsSync(lock), "another run's lock is left alone");
	// Five minutes old and its process runs: still held (the age bound is ten minutes, not the server lock's two).
	writeFileSync(lock, JSON.stringify({ pid: holder, by: "up --dir", since: new Date(Date.now() - 5 * 60_000).toISOString() }));
	const young = await up();
	assert.equal(young.code, 1);
	assert.match(String(young.errJson?.reason), /busy/);
	assert.ok(existsSync(lock), "a live holder's lock of five minutes is left alone");
	// Older than ten minutes, though its process still runs.
	writeFileSync(lock, JSON.stringify({ pid: holder, by: "up --dir", since: new Date(Date.now() - 11 * 60_000).toISOString() }));
	const old = await up();
	assert.equal(old.code, 0, old.err);
	assert.equal(created().length, 1);
	assert.equal(existsSync(lock), false);
	// A holder that is gone.
	writeFileSync(lock, JSON.stringify({ pid: 4243, by: "up --dir", since: new Date().toISOString() }));
	const dead = await up();
	assert.equal(dead.code, 0, dead.err);
	assert.equal(created().length, 1, "the base exists, so it is used");
	// A lock that is not a record of ours is stale too.
	writeFileSync(lock, "garbage");
	utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
	assert.equal((await up()).code, 0);
});

test("the lock: taken once, released once, and a release never removes a lock another run holds now", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	let at = 1000;
	const ctx = { slot: world.slot, now: () => at, alive: (pid: number) => pid === process.pid || world.live.has(pid) };
	world.live.add(process.pid);
	const mine = await deskLockFor(ctx);
	assert.ok(mine);
	assert.equal(await deskLockFor(ctx), undefined);
	at += 11 * 60_000;
	const other = await deskLockFor(ctx);
	assert.ok(other, "past ten minutes it is taken over");
	mine!();
	assert.ok(existsSync(fileOf(world.slot, "deskLock")), "the first holder's release leaves the second's lock");
	other!();
	assert.equal(existsSync(fileOf(world.slot, "deskLock")), false);
});

test("two runs at once make one base: each ends 0 or busy at base", async () => {
	const [a, b] = await Promise.all([up(), up()]);
	for (const r of [a, b]) assert.ok(r.code === 0 || (r.code === 1 && r.errJson?.step === "base" && /busy/.test(String(r.errJson?.reason))), `${r.code} ${r.err}`);
	assert.ok([a, b].some((r) => r.code === 0));
	assert.equal(created().length, 1);
	assert.equal(world.herdr.workspaces.filter((w) => w.label === "Desk").length, 1);
});

// --- Herdr's pi integration (S6) ---

test("the integration is installed when its line says not installed or outdated, not when it is current; the extensions folder of a fresh agent directory is made first", async () => {
	for (const state of ["not installed", "outdated (legacy < v9)"]) {
		const before = world.herdr.integration.installs;
		world.herdr.integration.state = state;
		const r = await up();
		assert.equal(r.code, 0, `${state}: ${r.err}`);
		assert.equal(r.json?.integration, "installed", state);
		assert.equal(world.herdr.integration.installs, before + 1, state);
	}
	assert.ok(existsSync(dirname(world.herdr.integration.file)), "Herdr's install says nothing and writes nothing without the folder");
	const current = await up();
	assert.equal(current.json?.integration, "current");
	assert.equal(world.herdr.integration.installs, 2);
});

test("an install that leaves the line not current, or a status with no pi line, fails at integration and starts nothing", async () => {
	world.herdr.integration.refuse = true;
	const stuck = await up();
	assert.equal(stuck.code, 1);
	assert.equal(stuck.errJson?.step, "integration");
	assert.match(String(stuck.errJson?.reason), /not installed/);
	assert.equal(world.record(), undefined, "the server was not started");
	assert.equal(created().length, 0);
	const none = await up(["--dir", home, "--label", "Desk"], { herdrCli: async (args) => (args[0] === "integration" && args[1] === "status" ? "omp: not installed (/x)\n" : world.herdr.runFor("cli")(args)) });
	assert.equal(none.code, 1);
	assert.equal(none.errJson?.step, "integration");
	assert.match(String(none.errJson?.reason), /no pi line/);
});

test("integrationState reads the pi line and nothing else", () => {
	assert.equal(integrationState("pi: current (v9) (/a/extensions/herdr-agent-state.ts)\nomp: not installed (/b)\n"), "current");
	assert.equal(integrationState("pi: outdated (legacy < v9) (/a)\n"), "outdated");
	assert.equal(integrationState("omp: current (v1) (/b)\npi: not installed (/a)\n"), "not installed");
	assert.equal(integrationState("pi-extra: current (/a)\n"), undefined);
	assert.equal(integrationState("pi: something new (/a)\n"), "something new");
	assert.equal(integrationState(""), undefined);
});

// --- the gui step and the time ---

test("a GUI that does not answer in time is exit 1 at gui, after the base and tower steps; the whole call is bounded by --timeout", async () => {
	const r = await up(["--dir", home, "--label", "Desk", "--timeout", "1"], { pageAnswers: async () => false });
	assert.equal(r.code, 1);
	assert.equal(r.errJson?.step, "gui");
	assert.deepEqual((r.errJson?.steps as { name: string; ok: boolean }[]).map((s) => `${s.name}:${s.ok}`), ["herdr:true", "integration:true", "version:true", "server:true", "base:true", "tower:true", "gui:false"]);
	assert.equal(typeof desk()?.workspace, "string");
});

test("the readers of desk.json: a record with the three fields, nothing for a missing, unreadable, or incomplete one", () => {
	mkdirSync(world.slot.dir, { recursive: true });
	const file = join(world.slot.dir, "desk.json");
	assert.equal(readDesk(world.slot), undefined);
	writeFileSync(file, "{not json");
	assert.equal(readDesk(world.slot), "unreadable");
	writeFileSync(file, JSON.stringify({ workspace: "w1", dir: "/d" }));
	assert.equal(readDesk(world.slot), "unreadable");
	writeFileSync(file, JSON.stringify({ workspace: "w1", dir: "/d", label: "L" }));
	assert.deepEqual(readDesk(world.slot), { workspace: "w1", dir: "/d", label: "L" });
});

test("an unreadable desk.json is told in a warning and the base is made again", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeFileSync(join(world.slot.dir, "desk.json"), "{not json");
	const r = await up();
	assert.equal(r.code, 0, r.err);
	assert.equal(r.json?.created, true);
	assert.ok((r.json?.warnings as { code: string }[]).some((w) => w.code === "desk_json_unreadable"));
	assert.equal(desk()?.workspace, r.json?.workspace);
});


// --- desk.lock across processes (RVB7-F001) ---

const CHILD = join(import.meta.dirname, "desk-lock-child.ts");
/** `n` node processes take desk.lock at the same moment, each holding it `holdMs` and trying again while busy; returns the log lines. */
async function race(stateDir: string, n: number, holdMs: number): Promise<string[]> {
	const log = join(stateDir, "race.log"), startAt = Date.now() + 400;
	writeFileSync(log, "");
	await Promise.all(Array.from({ length: n }, () => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD, stateDir, log, String(startAt), String(holdMs)], { stdio: ["ignore", "ignore", "pipe"] });
		let text = "";
		child.stderr.on("data", (d) => void (text += d));
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${text}`))));
	})));
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}
/** Whether the log never shows two holders at once, and every process held the lock. */
function exclusive(lines: string[], n: number): string | undefined {
	let held = 0, taken = 0;
	for (const line of lines) {
		if (line.startsWith("in ")) { taken++; if (++held > 1) return `two holders at once: ${lines.join(" | ")}`; } else held--;
	}
	return taken === n && held === 0 ? undefined : `${taken} of ${n} held it: ${lines.join(" | ")}`;
}

test("desk.lock across processes: several node processes at once never hold it together, from no lock and from a stale one", { timeout: 120_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-desk-lock-"));
	try {
		const slot = slotOf(dir, { ...process.env, HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined });
		assert.equal(slot.dir, dir);
		const lock = fileOf(slot, "deskLock");
		const dead = spawn(process.execPath, ["-e", ""]);
		await new Promise((resolve) => dead.on("exit", resolve));
		for (let trial = 0; trial < 12; trial++) {
			for (const before of ["none", "dead"] as const) {
				rmSync(lock, { force: true });
				if (before === "dead") writeFileSync(lock, JSON.stringify({ pid: dead.pid, by: "up --dir", since: new Date().toISOString() }));
				const problem = exclusive(await race(dir, 4, 30), 4);
				assert.equal(problem, undefined, `trial ${trial}, before ${before}`);
				assert.equal(existsSync(lock), false, "released");
			}
		}
	} finally {
		for (const f of ["race.log", "desk.lock", "desk.lock.stale"]) rmSync(join(dir, f), { force: true });
		rmdirSync(dir);
	}
});

// --- a recorded id that is not the base any more (RVB7-F002) ---

test("a workspace that has the recorded id but is not the base (another label, no pane in the folder) is not adopted: a new base is made, with a warning", async () => {
	const first = await up();
	const id = String(first.json?.workspace), ws = world.herdr.workspace(id);
	// Herdr restarted and numbered a workspace of the person's with the freed id.
	const elsewhere = join(world.root, "proj");
	world.herdr.tabs.filter((t) => t.workspace_id === id).forEach((t) => (t.label = "work"));
	world.herdr.panes.filter((p) => p.workspace_id === id).forEach((p) => (p.cwd = elsewhere));
	ws.label = "My project";
	const again = await up();
	assert.equal(again.code, 0, again.err);
	assert.equal(again.json?.created, true);
	assert.notEqual(again.json?.workspace, id);
	assert.ok((again.json?.warnings as { code: string }[]).some((w) => w.code === "desk_base_replaced"));
	assert.equal(desk()?.workspace, again.json?.workspace);
	assert.equal(world.herdr.tabs.filter((t) => t.workspace_id === id).length, 1, "the person's workspace got no tab");
	assert.equal(world.herdr.workspace(id).label, "My project");
});

test("a recorded workspace is the base while it keeps its label or a pane in the folder", async () => {
	const first = await up();
	const id = String(first.json?.workspace), ws = world.herdr.workspace(id);
	const elsewhere = join(world.root, "moved");
	ws.label = "renamed"; // the pane is still in the folder
	const byFolder = await up();
	assert.deepEqual([byFolder.json?.workspace, byFolder.json?.created, byFolder.json?.warnings], [id, false, []]);
	ws.label = "Desk";
	world.herdr.panes.filter((p) => p.workspace_id === id).forEach((p) => (p.cwd = elsewhere)); // the label is still the recorded one
	const byLabel = await up();
	assert.deepEqual([byLabel.json?.workspace, byLabel.json?.created, byLabel.json?.warnings], [id, false, []]);
	assert.equal(created().length, 1);
});

test("a base whose tower was quit and whose other tab works elsewhere is still the base: the next up opens a new tower in it, no second base (RVB7B-F001)", async () => {
	const first = await up();
	const id = String(first.json?.workspace);
	shellTab(id, join(world.root, "proj"));
	const record = world.record()!;
	assert.equal((await callControl(record.socket, record.secret, { cmd: "close-tower", workspace: id })).reply?.ok, true);
	assert.equal(world.herdr.tabs.some((t) => t.workspace_id === id && t.label === TOWER_LABEL), false, "no tower tab is left");
	for (let i = 0; i < 2; i++) {
		const again = await up();
		assert.equal(again.code, 0, again.err);
		assert.deepEqual([again.json?.workspace, again.json?.created, again.json?.warnings], [id, i === 0, []]);
	}
	assert.equal(created().length, 1, "one base, however many ups");
});

test("a workspace of the person's that took the recorded id and has a tower tab of its own is not the base (RVB7B-F002)", async () => {
	const first = await up();
	const id = String(first.json?.workspace), ws = world.herdr.workspace(id), elsewhere = join(world.root, "proj");
	world.herdr.tabs.filter((t) => t.workspace_id === id).forEach((t) => (t.label = TOWER_LABEL)); // its own tower, in its own folder
	world.herdr.panes.filter((p) => p.workspace_id === id).forEach((p) => (p.cwd = elsewhere));
	ws.label = "My project";
	const again = await up();
	assert.equal(again.code, 0, again.err);
	assert.equal(again.json?.created, true);
	assert.notEqual(again.json?.workspace, id);
	assert.ok((again.json?.warnings as { code: string }[]).some((w) => w.code === "desk_base_replaced"));
	assert.equal(world.herdr.workspace(id).label, "My project");
});

test("an unlabelled workspace of the person's that took the recorded id and sits in a folder named like the base label is not the base (RVB7C-F001)", async () => {
	const first = await up();
	const id = String(first.json?.workspace), ws = world.herdr.workspace(id);
	const same = join(world.root, "x", "Desk"); // Herdr's own label for such a workspace is the folder's name
	world.herdr.panes.filter((p) => p.workspace_id === id).forEach((p) => (p.cwd = same));
	ws.label = "Desk";
	const again = await up();
	assert.equal(again.code, 0, again.err);
	assert.equal(again.json?.created, true);
	assert.notEqual(again.json?.workspace, id);
	assert.ok((again.json?.warnings as { code: string }[]).some((w) => w.code === "desk_base_replaced"));
});

test("the pane's folder is compared as a real path: a base made under a link is still the base when Herdr reports the real path (RVB7B-F003)", async (t) => {
	const real = join(world.root, "real-home"), link = join(world.root, "link-home");
	mkdirSync(real);
	try { symlinkSync(real, link, "dir"); } catch { return t.skip("no symlinks here"); }
	const first = await up(["--dir", link, "--label", "Desk"]);
	assert.equal(first.code, 0, first.err);
	const id = String(first.json?.workspace), ws = world.herdr.workspace(id);
	ws.label = "renamed"; // only the pane tells now
	world.herdr.panes.filter((p) => p.workspace_id === id).forEach((p) => (p.cwd = realpathSync(real)));
	const again = await up(["--dir", link, "--label", "Desk"]);
	assert.deepEqual([again.json?.workspace, again.json?.created, again.json?.warnings], [id, false, []]);
});

// --- a kept base keeps its folder (RVB7-F003) ---

test("a kept base opens its tower in the recorded folder, whatever --dir says now, and --dir is checked only when a base is made", async () => {
	const first = await up();
	shellTab(String(first.json?.workspace), home);
	const record = world.record()!;
	assert.equal((await callControl(record.socket, record.secret, { cmd: "close-tower", workspace: String(first.json?.workspace) })).reply?.ok, true);
	const other = join(world.root, "home", "Other");
	mkdirSync(other);
	const before = world.herdr.commands("tab", "create").length;
	const again = await up(["--dir", other, "--label", "Desk"]);
	assert.equal(again.code, 0, again.err);
	const opened = world.herdr.commands("tab", "create").slice(before);
	assert.equal(opened.length, 1);
	assert.equal(opened[0]![opened[0]!.indexOf("--cwd") + 1], home);
	// A folder that is gone is no matter to a base that is kept.
	const gone = await up(["--dir", join(world.root, "home", "nowhere"), "--label", "Desk"]);
	assert.equal(gone.code, 0, gone.err);
	assert.equal(gone.json?.workspace, first.json?.workspace);
});

// --- the extensions folder and the time (RVB7-F004, F006) ---

test("the extensions folder is where Herdr's own status line says, whatever PI_CODING_AGENT_DIR says", async () => {
	assert.equal(integrationPath("pi: not installed (/a b/extensions/herdr-agent-state.ts)\nomp: not installed (/c)\n"), "/a b/extensions/herdr-agent-state.ts");
	assert.equal(integrationPath("pi: current (v9) (/a/extensions/x.ts)\n"), "/a/extensions/x.ts");
	assert.equal(integrationPath("pi: not installed\n"), undefined);
	for (const odd of ["", "~/x"]) {
		world.env.PI_CODING_AGENT_DIR = odd;
		rmSync(dirname(world.herdr.integration.file), { recursive: true, force: true });
		world.herdr.integration.state = "not installed";
		const r = await up();
		assert.equal(r.code, 0, `${odd}: ${r.err}`);
		assert.ok(existsSync(dirname(world.herdr.integration.file)));
		assert.equal(existsSync(join(process.cwd(), "extensions")) && statSync(join(process.cwd(), "extensions")).mtimeMs > Date.now() - 60_000, false, "nothing made in the working folder");
	}
});

test("--timeout bounds the time of every Herdr call of the desk steps", async () => {
	world.herdr.integration.state = "not installed";
	const asked: number[] = [], inner = world.herdr.runFor("cli");
	const r = await up(["--dir", home, "--label", "Desk", "--timeout", "5"], { herdrCli: async (args, ms) => { asked.push(ms ?? -1); return inner(args); } });
	assert.equal(r.code, 0, r.err);
	assert.ok(asked.length >= 5, String(asked.length));
	assert.ok(asked.every((ms) => ms >= 0 && ms <= 5000), asked.join(","));
});
