import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDeploys } from "../src/deploy.ts";
import { createAutoMode } from "../src/server/automode.ts";
import { autoOnForTrust } from "../src/autostate.ts";
import { createSpawn } from "../src/spawn.ts";
import { createAsk, type Decision, registerTrust } from "../src/trust/ask.ts";
import { answerFile, requestFile } from "../src/trust/files.ts";
import { askOpened, createIntents, type IntentCall, type Intents } from "../src/trust/intent.ts";
import type { TrustRequest } from "../src/trust/types.ts";
import { World } from "./fakes.ts";
import { type Hosted, startHosted, stopHosted } from "./gui-world.ts";

// An open/base pane's trust question under auto mode (docs/specs/2026-11-09-auto-mode.md, D3 note of 11/12, desk #51): a person opened the project, so it is asked as usual; every other pane
// keeps D3's answer. The intent is the server's own list of the panes it started, held in its memory only (trust/intent.ts): the asking pi asks the server over the control socket, and no
// answer, an older server, or a server that started again is D3's answer. Nothing is written to or read from disk for it (review R156-F001).

const home = realpathSync(mkdtempSync(join(tmpdir(), "psb-open-intent-")));
const proj = join(home, "beta"), other = join(home, "gamma");
mkdirSync(proj);
mkdirSync(other);
symlinkSync(proj, join(home, "beta-link"));
const realHome = process.env.HOME;
process.env.HOME = home; // createSpawn reads the home folder from os.homedir(), which follows HOME
process.on("exit", () => ((process.env.HOME = realHome), rmSync(home, { recursive: true, force: true })));

let world = new World();
afterEach(async () => {
	await stopHosted();
	await world.stopAll();
	world = new World();
});

const state = () => mkdtempSync(join(home, "state-"));
const TUI = { mode: "tui", hasUI: true };
const TTY = { isTTY: true, isRaw: false, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
const PROC = { pid: process.pid, on() {}, off() {}, listenerCount: () => 1, kill() {} };
/** The control socket as the pane's pi sees it, answered by a list in this process: what the server's `open-intent` does. */
const served = (intents: Intents, asked: unknown[] = []): IntentCall => async (request) => (asked.push(request), { ok: true, opened: intents.has(request.pane, request.cwd) });

// --- the server's list -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("intent: a pane is listed for the folder its pi starts in while its open runs, and for nothing else", () => {
	const intents = createIntents();
	const release = intents.grant("w1-1", proj);
	assert.equal(intents.has("w1-1", proj), true);
	assert.equal(intents.has("w1-1", join(proj, ".")), true, "the folder as another spelling of itself");
	assert.equal(intents.has("w1-1", join(home, "beta-link")), true, "the folder through a link to it");
	assert.equal(intents.has("w1-2", proj), false, "another pane");
	assert.equal(intents.has("w1-1", other), false, "another folder");
	assert.equal(intents.has("w1-1", home), false, "the folder above it");
	for (const [pane, cwd] of [[undefined, proj], ["", proj], [1, proj], [["w1-1"], proj], ["w1-1", undefined], ["w1-1", ""], ["w1-1", 7], ["w1-1", { path: proj }]] as const) assert.equal(intents.has(pane, cwd), false, JSON.stringify([pane, cwd]));
	const second = intents.grant("w1-1", other);
	release();
	assert.equal(intents.has("w1-1", proj), false, "the open ended");
	assert.equal(intents.has("w1-1", other), true, "an open's end takes off its own entry and no other");
	release();
	assert.equal(intents.has("w1-1", other), true, "a second call of the same release takes nothing more off");
	second();
	assert.equal(intents.has("w1-1", other), false);
});

// --- the pane's ask ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("ask: the pane's pi asks for its own pane id (Herdr's) and folder, and only the server's yes is a yes", async () => {
	const asked: unknown[] = [], intents = createIntents();
	intents.grant("w1-1", proj);
	// Nothing a pane says about itself is sent: no flag and no variable of its own names a pane or adds one.
	const env = { HERDR_PANE_ID: "w1-1", STRAW_BOSS_OPEN_INTENT: "1", STRAW_BOSS_OPEN_BASE: "w9-9", STRAW_BOSS_PANE: "w9-9", sb_open_base: "1" };
	assert.equal(await askOpened(served(intents, asked), env)(proj), true);
	assert.deepEqual(asked, [{ cmd: "open-intent", pane: "w1-1", cwd: proj }], "the request is the pane id and the folder, nothing else");
	assert.equal(await askOpened(served(intents), { ...env, HERDR_PANE_ID: "w1-2" })(proj), false, "a pane the server did not list");
	const answers: [string, Awaited<ReturnType<IntentCall>> | Error][] = [
		["no server runs, or it is not trusted", undefined],
		["an older server does not know the command", { ok: false, error: "unknown command open-intent" }],
		["a server that is restarting", { ok: false, error: "restarting" }],
		["an answer without the word", { ok: true }],
		["a word that is not true", { ok: true, opened: "yes" }],
		["a refusal that says opened", { ok: false, opened: true }],
		["the call fails", new Error("ECONNRESET")],
	];
	for (const [name, answer] of answers) assert.equal(await askOpened(async () => { if (answer instanceof Error) throw answer; return answer; }, env)(proj), false, name);
	let calls = 0;
	const counted: IntentCall = async () => (calls++, { ok: true, opened: true });
	assert.equal(await askOpened(counted, {})(proj), false, "a process in no pane");
	assert.equal(calls, 0, "a process in no pane asks nothing");
});

test("ask: a server that does not answer within the bound is no", async () => {
	const timeouts: number[] = [];
	const silent: IntentCall = (_request, timeoutMs) => (timeouts.push(timeoutMs), new Promise(() => {}));
	assert.equal(await askOpened(silent, { HERDR_PANE_ID: "w1-1" }, 20)(proj), false);
	assert.deepEqual(timeouts, [20], "the call is given no more time than the whole ask");
	const slow: IntentCall = (_request, timeoutMs) => (timeouts.push(timeoutMs), Promise.resolve({ ok: true, opened: true }));
	assert.equal(await askOpened(slow, { HERDR_PANE_ID: "w1-1" })(proj), true);
	assert.ok(timeouts[1]! >= 1000 && timeouts[1]! <= 10_000, `the call's own time limit is seconds, not minutes (${timeouts[1]})`);
});

// --- the trust question ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A pi's trust handler with auto mode on (written by the real server module) and a GUI that answers `once` to what it is asked. `asked` lists the questions that reached the GUI's files. */
function question(pane: string, listed: [pane: string, folder: string] | undefined, extraEnv: Record<string, string> = {}, over: { on?: boolean } = {}) {
	const dir = state(), clock = Date.now(), cwd = proj, intents = createIntents();
	if (listed) intents.grant(...listed);
	if (over.on !== false) {
		const auto = createAutoMode({ dir, now: () => clock, log: () => {} });
		auto.start();
		auto.switchOn({ via: "pi", name: "test" });
	}
	const notes: string[] = [], asked: TrustRequest[] = [];
	const trustDir = join(dir, "trust");
	const env = { HERDR_PANE_ID: pane, ...extraEnv };
	const decide = createAsk({
		env, dir: trustDir, stdin: TTY, proc: PROC, write() {},
		saved: () => null, defaultTrust: () => "ask", up: async () => true, first: () => true, now: () => clock, watch: () => () => {}, startOf: () => undefined, uuid: () => "11111111-2222-4333-8444-555555555555",
		sleep: async () => {
			const name = readdirSync(trustDir).find((f) => f === requestFile("11111111-2222-4333-8444-555555555555"));
			if (!name) return;
			const request = JSON.parse(readFileSync(join(trustDir, name), "utf8")) as TrustRequest;
			asked.push(request);
			writeFileSync(join(trustDir, answerFile(request.id)), JSON.stringify({ version: 1, id: request.id, digest: request.digest, choice: "once", answerId: "a".repeat(24) }));
		},
		auto: { on: () => autoOnForTrust(dir), note: (gist) => void notes.push(gist) },
		opened: askOpened(served(intents), env),
	});
	return { decide: () => decide(cwd, TUI), notes, asked };
}

test("trust: auto on + a pane the server started for open/base is asked as usual, and the answer is the boss's", async () => {
	const q = question("w1-1", ["w1-1", proj]);
	assert.deepEqual(await q.decide(), { trusted: "yes" });
	assert.equal(q.asked.length, 1, "the question reached the GUI's files");
	assert.deepEqual(q.notes, [], "nothing was refused");
});

test("trust: auto on + any other pane is still refused at once, whatever it claims", async () => {
	for (const [name, pane, claim, listed] of [
		["nothing listed", "w1-1", {}, undefined],
		["not listed", "w1-2", {}, ["w1-1", proj]],
		["claims the intent by the environment", "w1-2", { STRAW_BOSS_OPEN_INTENT: "1", STRAW_BOSS_ROLE: "member" }, ["w1-1", proj]],
		["claims the listed pane's id by a variable of its own", "w1-2", { STRAW_BOSS_PANE: "w1-1", PI_INTERCOM_PANE: "w1-1" }, ["w1-1", proj]],
		["listed for another folder", "w1-1", {}, ["w1-1", other]],
	] as const) {
		const q = question(pane, listed as [string, string] | undefined, claim);
		assert.deepEqual(await q.decide(), { trusted: "no" }, name);
		assert.equal(q.asked.length, 0, name);
		assert.match(q.notes.join("\n"), /not trusted for this session/, name);
	}
});

test("trust: auto off asks as usual with or without a listing", async () => {
	for (const pane of ["w1-1", "w1-2"]) {
		const q = question(pane, ["w1-1", proj], {}, { on: false });
		assert.deepEqual(await q.decide(), { trusted: "yes" }, pane);
		assert.equal(q.asked.length, 1);
	}
});

test("trust: a handler whose ask of the server fails, or has none, is answered as D3 says", async () => {
	const dir = state();
	const auto = createAutoMode({ dir, now: () => 1_800_000_000_000, log: () => {} });
	auto.start();
	auto.switchOn({ via: "pi", name: "test" });
	const failing: (cwd: string) => Promise<boolean> = () => Promise.reject(new Error("unreadable"));
	for (const opened of [failing, (): never => { throw new Error("unreadable"); }, undefined]) {
		const decide = createAsk({
			env: { HERDR_PANE_ID: "w1-1" }, dir: join(dir, "trust"), stdin: TTY, proc: PROC, write() {}, saved: () => null, defaultTrust: () => "ask",
			up: async () => false, first: () => true, now: () => 0, sleep: async () => {}, watch: () => () => {}, startOf: () => undefined, uuid: () => "id",
			auto: { on: () => autoOnForTrust(dir), note() {} }, ...(opened ? { opened } : {}),
		});
		assert.deepEqual(await decide(proj, TUI), { trusted: "no" });
	}
});

// --- the server lists exactly the open/base panes, for exactly their start --------------------------------------------------------------------------------------------------------------------------------

function host(intents: Intents) {
	const spawn = createSpawn({ run: world.herdr.runFor("wA:p1"), sleep: async () => {}, live: async () => true, home, deploys: createDeploys(), intents });
	return (kind: string, body: Record<string, unknown>) => spawn(["open", kind], body);
}
const joins = (pane: { pane_id: string; workspace_id: string }) => void world.agent({ id: `opened-${pane.pane_id}`, name: "member", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "member" } }).start();

test("open/base lists its pane while pi starts and takes it off when the join ends", async () => {
	const intents = createIntents(), seen: Record<string, boolean>[] = [];
	world.herdr.onAgentStart = (pane) => {
		seen.push({ own: intents.has(pane.pane_id, proj), elsewhere: intents.has(pane.pane_id, other), another: intents.has("wA:p1", proj) });
		joins(pane);
	};
	const answer = await host(intents)("base", { dir: proj, label: "", deploy: "deploy-intent-1" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(seen, [{ own: true, elsewhere: false, another: false }], "listed for its folder while pi starts");
	assert.equal(intents.has((answer.body as { pane: string }).pane, proj), false, "taken off once the open ended");
});

test("open/base takes the pane off when the open fails", async () => {
	const intents = createIntents(), seen: boolean[] = [];
	let pane = "";
	world.herdr.onAgentStart = (p) => void (seen.push(intents.has((pane = p.pane_id), proj))); // never joins: a short join wait ends the open
	const failed = await host(intents)("base", { dir: proj, label: "", joinWaitMs: 10_000 });
	assert.equal(failed.status, 502);
	assert.deepEqual(seen, [true], "control: listed while pi started");
	assert.equal(intents.has(pane, proj), false, "a failed open leaves nothing listed");
});

// --- the production wiring: the page's open, the sb server's control socket, and the handler pi registers ------------------------------------------------------------------------------------------------

/** The sb server with its GUI over the world's fake Herdr, and auto mode switched on as the boss does it. The join wait of an open stands still while a pane's pi asks (`asking`), so nothing here is a race against the clock. */
async function hosted() {
	let asking: Promise<unknown> | undefined;
	const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const call = (async (method: string, params: { pane_id: string }) => (method === "pane.get" ? { pane: world.herdr.pane(String(params.pane_id)) } : {})) as never;
	const sleep = async (ms: number) => { while (asking) await asking; await realSleep(Math.min(ms, 2)); };
	// The server's pid is this process's: the session's own call (traincar.ts `callServer`) asks only a server whose process runs.
	const h = await startHosted(world, { pid: process.pid, options: { herdr: { run: world.herdr.runFor(""), api: world.herdr.api, events: world.herdr.events, watch: world.watch, call, sleep, stateDir: world.stateDir } } });
	await world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1" }).start();
	const staged = await h.ask("auto-on", { name: "test" });
	assert.equal((await h.ask("auto-confirm", { id: (staged.pending as { id: string }).id })).ok, true);
	assert.deepEqual(autoOnForTrust(world.stateDir), { on: true, foreign: false }, "control: auto mode is on, by the server's own write");
	const failures: unknown[] = [];
	const hold = (work: Promise<unknown>) => void (asking = work.catch((error) => void failures.push(error)).finally(() => (asking = undefined)));
	return { h, hold, failures };
}
/** The trust handler a pi in `pane` registers at its load (index.ts: `registerTrust`), over the session's own way to the server; the GUI is not asked (its start time is not the recorded one), so a question that is asked as usual is pi's own: `undecided`. */
function piIn(h: Hosted, pane: string, notes: string[] = []) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = { on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => void handlers.set(type, handler) } as never;
	const cfg = { env: { ...h.options.env, HERDR_PANE_ID: pane }, now: Date.now, sleep: async () => {}, startRead: { later: async () => "not the recorded start" } };
	registerTrust(pi, { cfg: cfg as never, guiDir: world.stateDir }, { stdin: TTY, proc: PROC, write() {}, resources: () => false, saved: () => null, defaultTrust: () => "ask" }, { on: () => autoOnForTrust(world.stateDir), note: (gist) => void notes.push(gist) });
	return (cwd: string) => handlers.get("project_trust")!({ cwd }, TUI) as Promise<Decision>;
}
const NO: Decision = { trusted: "no" }, ASKED: Decision = { trusted: "undecided" };
/** The file the first version of this fix read (19552a42): a listing in the state folder. Nothing reads it now, whoever wrote it. */
const forged = new Set<string>();
const forge = (h: Hosted, pane: string, cwd: string) => {
	const name = `open-intents-${h.slot.hash}.json`;
	forged.add(name);
	for (const dir of new Set([world.stateDir, h.slot.dir])) writeFileSync(join(dir, name), JSON.stringify({ v: 1, panes: [{ pane, cwd, expires: Date.now() + 3_600_000 }] }));
};

test("wiring: the page's open/base under auto mode is asked as usual by the handler pi registers; a member's, a main's and a forged listing's pane get D3's answer", async () => {
	const { h, hold, failures } = await hosted();
	const seen: Record<string, unknown>[] = [], notes: string[] = [];
	let folder = proj;
	world.herdr.onAgentStart = (pane) => hold((async () => {
		const files = readdirSync(world.stateDir).filter((name) => name.startsWith("open-intents") && !forged.has(name));
		forge(h, "w9-9", folder);
		seen.push({ own: await piIn(h, pane.pane_id, notes)(folder), elsewhere: await piIn(h, pane.pane_id)(folder === proj ? other : proj), another: await piIn(h, "wA:p1")(folder), forged: await piIn(h, "w9-9")(folder), socket: (await h.ask("open-intent", { pane: pane.pane_id, cwd: folder })).opened, files });
		world.agent({ id: `opened-${pane.pane_id}`, name: "opened", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "" } }).start();
	})());
	const base = await h.post("open/base", { dir: proj, label: "" });
	assert.equal(base.status, 200, JSON.stringify(base.body));
	assert.deepEqual(seen, [{ own: ASKED, elsewhere: NO, another: NO, forged: NO, socket: true, files: [] }], "open/base: its own pane in its own folder is asked; the server wrote no listing");
	assert.deepEqual(notes, [], "nothing was refused for the opened pane");
	const pane = base.body.pane as string, ws = base.body.workspace as string;
	assert.deepEqual(await piIn(h, pane, notes)(proj), NO, "once the open has joined, a pi in that pane is answered by D3 again");
	assert.match(notes.join("\n"), /not trusted for this session/);
	assert.deepEqual(await h.ask("open-intent", { pane, cwd: proj }), { ok: true, opened: false });

	seen.length = 0;
	folder = other;
	const member = await h.post("open/member", { workspace: ws, dir: other });
	assert.equal(member.status, 200, JSON.stringify(member.body));
	assert.deepEqual(seen, [{ own: NO, elsewhere: NO, another: NO, forged: NO, socket: false, files: [] }], "open/member: D3");

	seen.length = 0;
	world.herdr.workspace(ws).tokens.tower = `opened-${pane}`; // the base's member stands in for a live tower
	const main = await h.post("open/main", { workspace: ws, dir: other });
	assert.equal(main.status, 200, JSON.stringify(main.body));
	assert.equal(world.herdr.pane(main.body.pane as string).tokens.sb_role, "main", "control: a main was opened");
	assert.deepEqual(seen, [{ own: NO, elsewhere: NO, another: NO, forged: NO, socket: false, files: [] }], "open/main: D3");

	// A run's token gets no word of it, and a server that is gone is D3's answer.
	assert.equal((await h.ask("open-intent", { pane, cwd: proj, token: "no-such-run" })).ok, false);
	await h.stop();
	assert.deepEqual(await piIn(h, pane)(proj), NO, "no server: D3");
	assert.deepEqual(failures, []);
});
