import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRemoteTurns } from "../src/link/hooks.ts";
import { MESSAGE_TYPE } from "../src/link/turn.ts";
import { RESTART_EVERY_MS } from "../src/server-look.ts";
import { fileOf, writeRecord } from "../src/server/record.ts";
import { type Agent, until, World } from "./fakes.ts";
import { bob, TEAM_HEX } from "./link/holder-world.ts";
import { ServerWorld, sleep } from "./server-world.ts";

// docs/specs/2026-10-26-sb-backend.md, Starting, Stopping, Seeing and restarting the server: what a pi session does about the sb server: its look, /boss server, boss_server.

let world: World;
let sw: ServerWorld;
beforeEach(() => ((world = new World()), (sw = new ServerWorld()), (panes = 0)));
afterEach(async () => {
	await world.stopAll();
	await sw.close();
});

/** What the look reaches the machine with: the server world's spawn, liveness, and timers. */
function reaching(version = "0.44.0") {
	const { slot: _slot, version: _version, by: _by, env: _env, cli: _cli, now: _now, log: _log, ...rest } = sw.ctx({ version });
	return rest;
}
let panes = 0;
function session(id = "a1", over: { version?: string; server?: object | null; env?: Record<string, string> } = {}): Agent {
	const version = over.version ?? "0.44.0";
	return world.agent({
		id, pane: `wA:p${++panes}`, tab: "wA:t1", ui: true, env: { HOME: sw.env.HOME!, ...over.env },
		deps: { stateDir: sw.stateDir, version, adoptMs: 30, server: over.server === undefined ? { ctx: reaching(version), cli: "/fake/cli.mjs" } : (over.server as never) },
	});
}
const plant = (over: Record<string, unknown> = {}) => {
	mkdirSync(sw.slot.dir, { recursive: true });
	writeRecord(sw.slot, { pid: 7, started: "T-7", version: "0.44.0", herdr: sw.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: fileOf(sw.slot, "log"), socket: "/nowhere.sock", secret: "s".repeat(64), intercomId: "sb-server-00000000", ...over });
};
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? "").join("\n");
const confirm = async (agent: Agent, answer: boolean) => {
	await until(() => agent.dialogs.some((d) => !d.settled), "a confirm");
	const dialog = agent.dialogs.find((d) => !d.settled)!;
	dialog.settle(answer);
	return dialog;
};

test("an interactive session in Herdr starts the server at session start, and the first pi of the day brings it up", async () => {
	const a = session();
	await a.start();
	await until(() => sw.record()?.pid, "the server to start");
	assert.equal(sw.spawned.length, 1);
	assert.match(sw.spawned[0]!.args[sw.spawned[0]!.args.indexOf("--by") + 1]!, /^session "a1" \(a1\)$/);
	await sleep(150);
	assert.equal(sw.spawned.length, 1, "later looks find it live and start no other");
	assert.equal(a.notices.filter((n) => /sb server/.test(n.text)).length, 0, "nothing is said when the start worked");
});

test("a session without a screen, a subagent, and a session that has no server deps start nothing", async () => {
	const quiet = world.agent({ id: "p1", pane: "wA:p91", tab: "wA:t1", env: { HOME: sw.env.HOME! }, deps: { stateDir: sw.stateDir, version: "0.44.0", adoptMs: 30, server: { ctx: reaching(), cli: "/fake/cli.mjs" } } });
	const sub = world.agent({ id: "s1", pane: "wA:p92", tab: "wA:t1", ui: true, env: { HOME: sw.env.HOME!, PI_SUBAGENT_ID: "run-1" }, deps: { stateDir: sw.stateDir, version: "0.44.0", adoptMs: 30, server: { ctx: reaching(), cli: "/fake/cli.mjs" } } });
	const none = session("n1", { server: null });
	await Promise.all([quiet.start(), sub.start(), none.start()]);
	await sleep(200);
	assert.equal(sw.spawned.length, 0);
	assert.ok(!none.tools.has("boss_server"), "no server: no tool");
});

test("a session on an older package never starts a server; one on another broker scope says so once and uses none", async () => {
	plant({ version: "0.45.0", pid: 99 });
	const old = session("old", { version: "0.44.0" });
	await old.start();
	await sleep(200);
	assert.equal(sw.spawned.length, 0);
	assert.equal(old.notices.filter((n) => /older than this session|newer than this session/.test(n.text)).length, 1, "told once, not at every look");

	writeRecord(sw.slot, { pid: 7, started: "T-7", version: "0.44.0", herdr: sw.slot.herdr, mode: "detached", desk: false, intercom: { scope: "team-a", transport: "default" }, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-00000000" });
	const other = world.agent({ id: "o1", pane: "wA:p93", tab: "wA:t1", ui: true, env: { HOME: sw.env.HOME!, PI_INTERCOM_SCOPE_ID: "team-b" }, deps: { stateDir: sw.stateDir, version: "0.44.0", adoptMs: 30, server: { ctx: reaching(), cli: "/fake/cli.mjs" } } });
	await other.start();
	await sleep(200);
	assert.equal(sw.spawned.length, 0);
	assert.equal(other.notices.filter((n) => /another pi-intercom scope/.test(n.text)).length, 1);
});

test("a server stopped on purpose is left down by the look, and /boss server starts it again", async () => {
	plant({ stopped: true });
	const a = session();
	await a.start();
	await sleep(200);
	assert.equal(sw.spawned.length, 0);
	await a.command("server");
	assert.equal(sw.spawned.length, 1);
	assert.equal(sw.record()?.stopped, undefined);
	assert.match(a.notices.at(-1)!.text, /The sb server started \(pid \d+\)\. sb server: state live, pid \d+, pi-straw-boss 0\.44\.0, detached/);
});

test("a failed start is told once with the reason, and not tried again at every look", async () => {
	sw.crashWith = 7;
	const a = session();
	await a.start();
	await until(() => a.notices.some((n) => /could not start/.test(n.text)), "the notice");
	await sleep(250);
	assert.equal(sw.spawned.length, 1, "no new attempt for a minute");
	assert.equal(a.notices.filter((n) => /could not start/.test(n.text)).length, 1);
	assert.match(a.notices.find((n) => /could not start/.test(n.text))!.text, /exited with code 7/);
});

test("a session on a newer package asks the live server to upgrade, which starts it from the session's package", async () => {
	const s = await sw.start({ version: "0.43.0" });
	await s.handle.ready;
	const a = session("a1", { version: "0.44.0" });
	await a.start();
	await until(() => sw.record()?.version === "0.44.0", "the upgrade");
	assert.equal(sw.record()?.restarting, undefined);
	assert.match(readFileSync(fileOf(sw.slot, "log"), "utf8"), /restart reason=upgrade by="session \\?"a1\\?" \(a1\)"/);
});

test("sbr-F001: the version a session judges by is the package.json beside the cli it starts, not the code it loaded: a package replaced by an older one upgrades the server once, not at every look", async () => {
	const s = await sw.start({ version: "0.43.0" });
	await s.handle.ready;
	const root = join(sw.root, "pkg");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-straw-boss", version: "0.44.0" }));
	// The session loaded 0.45.0; the package on disk (what its spawn starts) is now 0.44.0.
	const a = session("a1", { version: "0.45.0", server: { ctx: reaching("0.44.0"), cli: "/fake/cli.mjs", root } });
	await a.start();
	await until(() => sw.record()?.version === "0.44.0" && !sw.record()?.restarting, "the upgrade");
	await sleep(300);
	assert.equal(sw.spawned.length, 1, "one upgrade, then the server is as new as the package");
	assert.equal(a.notices.filter((n) => /sb server/.test(n.text)).length, 0);
});

test("sbr-F001: an upgrade that starts a server no newer than the one it replaced is told once and not asked for again for a minute", async () => {
	const s = await sw.start({ version: "0.44.0" });
	await s.handle.ready;
	// Nothing tells the session that its spawn starts 0.44.0 (a stale cache of the version): the launched server's version is what refuses the loop.
	const a = session("a1", { version: "0.45.0", server: { ctx: reaching("0.44.0"), cli: "/fake/cli.mjs" } });
	await a.start();
	await until(() => a.notices.some((n) => /not newer/.test(n.text)), "the notice");
	await sleep(300);
	assert.equal(sw.spawned.length, 1, "no new upgrade for a minute");
	assert.equal(a.notices.filter((n) => /not newer/.test(n.text)).length, 1);
});

test("sbr-NEW-4: a failed upgrade is not asked for again while the record's version and the package's stay the same, however much time passes; a new package version asks again", async () => {
	const s = await sw.start({ version: "0.44.0" });
	await s.handle.ready;
	let clock = Date.now();
	const root = join(sw.root, "pkg");
	mkdirSync(root, { recursive: true });
	const disk = (version: string) => writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-straw-boss", version }));
	disk("0.45.0");
	// A stale dist: the package says 0.45.0, but what its spawn starts is 0.44.0.
	const a = world.agent({
		id: "a1", pane: "wA:p1", tab: "wA:t1", ui: true, env: { HOME: sw.env.HOME! },
		deps: { stateDir: sw.stateDir, version: "0.45.0", adoptMs: 30, now: () => clock, server: { ctx: reaching("0.44.0"), cli: "/fake/cli.mjs", root } },
	});
	await a.start();
	await until(() => a.notices.some((n) => /not newer/.test(n.text)), "the notice");
	assert.equal(sw.spawned.length, 1);
	clock += 61_000;
	await sleep(300);
	assert.equal(sw.spawned.length, 1, "a minute later it still does not restart the server");
	disk("0.46.0");
	await until(() => sw.spawned.length === 2, "a new package version asks again");
});

// --- /boss server ---

test("/boss server shows the state of a live server in one line", async () => {
	const a = session();
	await a.start();
	await until(() => sw.record()?.pid, "the server");
	await a.command("server");
	assert.match(a.notices.at(-1)!.text, /^sb server: state live, pid \d+, pi-straw-boss 0\.44\.0, detached, up \d+ s; log .*server\.log$/);
});

test("/boss server stop asks to confirm with the warning, and stops the server on purpose; declined, it leaves it", async () => {
	const a = session();
	await a.start();
	await until(() => sw.record()?.pid, "the server");
	const declined = a.command("server stop");
	const dialog = await confirm(a, false);
	await declined;
	assert.match(String(dialog.second), /Every workspace then loses its live tower, and mains are demoted 15 s later/);
	assert.equal(a.notices.at(-1)!.text, "The sb server was not stopped.");
	assert.equal(sw.record()?.stopped, undefined);
	const stopping = a.command("server stop");
	await confirm(a, true);
	await stopping;
	assert.equal(sw.record()?.stopped, true);
	assert.match(a.notices.at(-1)!.text, /stopped on purpose\. \/boss server starts it again/);
	await sleep(150);
	assert.equal(sw.spawned.length, 1, "no look starts it again");
});

test("/boss server restart [reason] confirms, restarts with the reason and this session as the requester, and clears a stop; --downgrade says it starts from an older package", async () => {
	const a = session();
	await a.start();
	await until(() => sw.record()?.pid, "the server");
	const before = sw.record()!.pid;
	const run = a.command("server restart the logs look odd");
	await confirm(a, true);
	await run;
	assert.notEqual(sw.record()?.pid, before);
	assert.match(readFileSync(fileOf(sw.slot, "log"), "utf8"), /restart reason="the logs look odd" by="session \\?"a1\\?" \(a1\)"/);
	const older = session("a2", { version: "0.43.0" });
	await older.start();
	const down = older.command("server restart --downgrade going back");
	const dialog = await confirm(older, true);
	await down;
	assert.match(String(dialog.second), /OLDER/);
	assert.equal(sw.record()?.version, "0.43.0");
});

// --- boss_server ---

test("boss_server status works with the server down, from the files, and shows the last error and start-error", async () => {
	const a = session("a1", { server: { ctx: { ...reaching(), spawn: () => ({ pid: 1, exited: new Promise(() => {}) }) }, cli: "/fake/cli.mjs" } });
	await a.start();
	plant({ lastError: { at: "2026-10-26T00:00:00.000Z", code: "intercom", text: "no broker" } });
	const result = JSON.parse(text(await a.tool("boss_server", { action: "status" })));
	assert.equal(result.state, "gone");
	assert.equal(result.lastError.code, "intercom");
	assert.equal(result.package, "0.44.0");
	assert.ok(!JSON.stringify(result).includes("secret") && !JSON.stringify(result).includes("ssssssss"));
});

test("boss_server logs answers the last lines, at most 200", async () => {
	const a = session();
	await a.start();
	await until(() => sw.record()?.pid, "the server");
	const log = (await import("../src/server/log.ts")).createLog(fileOf(sw.slot, "log"));
	for (let i = 0; i < 300; i++) log.line("event", { n: i });
	assert.equal(text(await a.tool("boss_server", { action: "logs" })).split("\n").length, 200);
	assert.equal(text(await a.tool("boss_server", { action: "logs", lines: 3 })).split("\n").length, 3);
	assert.equal(text(await a.tool("boss_server", { action: "logs", lines: 5000 })).split("\n").length, 200);
	assert.match(text(await a.tool("boss_server", { action: "logs", lines: 1 })), /n=299/);
});

test("boss_server restart needs a one-line reason of 1 to 200 characters, restarts, and logs the reason with the asking session", async () => {
	const a = session();
	await a.start();
	await until(() => sw.record()?.pid, "the server");
	for (const bad of [undefined, "", "   ", "x".repeat(201), "two\nlines"]) {
		await assert.rejects(a.tool("boss_server", { action: "restart", ...(bad === undefined ? {} : { reason: bad }) }), /needs a reason: 1 to 200 characters on one line/, String(bad));
	}
	const before = sw.record()!.pid;
	const result = await a.tool("boss_server", { action: "restart", reason: "stuck queue, looking at it" });
	assert.match(text(result), /^The sb server restarted: pid \d+, pi-straw-boss 0\.44\.0\.$/);
	assert.notEqual(sw.record()?.pid, before);
	assert.match(readFileSync(fileOf(sw.slot, "log"), "utf8"), /restart reason="stuck queue, looking at it" by="session \\?"a1\\?" \(a1\)"/);
});

test("boss_server restart is taken once a minute, for the whole machine", async () => {
	const a = session(), b = session("a2");
	await a.start();
	await until(() => sw.record()?.pid, "the server");
	await a.tool("boss_server", { action: "restart", reason: "first" });
	await assert.rejects(a.tool("boss_server", { action: "restart", reason: "second" }), /restarted \d+ s ago \(first, by session "a1" \(a1\)\); restarts are taken once a minute at most/);
	// Another session is no way round it: the server's record keeps the last one.
	await b.start();
	await b.tool("boss_server", { action: "restart", reason: "from another" }).then(
		() => assert.fail("the second session got a restart through"),
		(error: Error) => assert.match(error.message, /once a minute at most/),
	);
	// A minute later it is taken again.
	writeRecord(sw.slot, { ...sw.record()!, lastRestart: { at: new Date(Date.now() - RESTART_EVERY_MS - 1000).toISOString(), reason: "old", by: "x" } });
	assert.match(text(await a.tool("boss_server", { action: "restart", reason: "a minute on" })), /restarted/);
});

test("sbr-F011: two sessions asking for a restart at once get one restart between them: the limit is judged under the lock", async () => {
	const a = session(), b = session("a2");
	await a.start();
	await until(() => sw.record()?.pid, "the server");
	await b.start();
	const results = await Promise.allSettled([a.tool("boss_server", { action: "restart", reason: "from a1" }), b.tool("boss_server", { action: "restart", reason: "from a2" })]);
	assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
	assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /once a minute at most/);
	assert.equal(sw.spawned.length, 2, "the first start and one restart");
});

test("boss_server restart is refused while the server is stopped on purpose, and starts a server that is down", async () => {
	plant({ stopped: true });
	const a = session();
	await a.start();
	await assert.rejects(a.tool("boss_server", { action: "restart", reason: "please" }), /stopped on purpose; an agent cannot restart it/);
	assert.equal(sw.spawned.length, 0);
	plant();
	const result = await a.tool("boss_server", { action: "restart", reason: "it is down" });
	assert.match(text(result), /The sb server started: pid \d+/);
	assert.equal(sw.spawned.length, 1);
});

// --- remote turns ---

test("a remote turn cannot use boss_server at any level, dispatch included; a local turn can", async () => {
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const pi = { events: { on: () => () => {}, emit: () => {} }, on: (t: string, h: (e: unknown, ctx: unknown) => unknown) => void handlers.set(t, h) } as unknown as ExtensionAPI;
	createRemoteTurns({
		pi, now: Date.now, config: () => ({ teams: new Map([[TEAM_HEX, { project: sw.root, share: "status" as const, name: "t" }]]), trust: new Map([[bob.id, "dispatch" as const]]), problems: [] }),
		policy: { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } }, home: sw.root, agentDir: sw.root, linkDir: sw.root, gateMs: 40,
		setOrigin: () => {}, tower: () => "tower", log: () => {}, tell: () => {}, ask: async () => ({ ok: false, error: "none" }),
	});
	const call = () => handlers.get("tool_call")!({ toolName: "boss_server", toolCallId: "c", input: { action: "restart", reason: "from a peer" } }, { cwd: sw.root, hasUI: false });
	assert.equal(await call(), undefined, "no remote turn yet: a local call is let through");
	handlers.get("message_start")!({ message: { role: "custom", customType: MESSAGE_TYPE, details: { id: bob.id.padStart(32, "0"), team: TEAM_HEX, from: bob.id, label: "bob", short: bob.id.slice(0, 6) } } }, {});
	const blocked = (await call()) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(String(blocked.reason), /cannot see or restart this computer's sb server/);
});
