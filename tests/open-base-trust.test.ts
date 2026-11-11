import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDeploys } from "../src/deploy.ts";
import { slotOf } from "../src/server/record.ts";
import { createAutoMode } from "../src/server/automode.ts";
import { autoOnForTrust } from "../src/autostate.ts";
import { createSpawn } from "../src/spawn.ts";
import { createAsk } from "../src/trust/ask.ts";
import { answerFile, requestFile } from "../src/trust/files.ts";
import { createIntents, intended, intentFile } from "../src/trust/intent.ts";
import type { TrustRequest } from "../src/trust/types.ts";
import { World } from "./fakes.ts";

// An open/base pane's trust question under auto mode (docs/specs/2026-11-09-auto-mode.md, D3 note of 11/12, desk #51): a person opened the project, so it is asked as usual; every other pane
// keeps D3's answer. The intent is the server's own list of the panes it started (trust/intent.ts), found by the asking pane's own id and folder, never by anything the pane says.

const home = realpathSync(mkdtempSync(join(tmpdir(), "psb-open-intent-")));
const proj = join(home, "beta"), other = join(home, "gamma");
mkdirSync(proj);
mkdirSync(other);
const realHome = process.env.HOME;
process.env.HOME = home;
process.on("exit", () => ((process.env.HOME = realHome), rmSync(home, { recursive: true, force: true })));

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const SOCKET = "/tmp/herdr-intent-test.sock";
const envOf = (pane: string, extra: Record<string, string> = {}) => ({ HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: SOCKET, ...extra });
const state = () => mkdtempSync(join(home, "state-"));
const fileOf = (dir: string, socket = SOCKET) => intentFile(dir, slotOf(dir, { HERDR_SOCKET_PATH: socket }).hash);
const TUI = { mode: "tui", hasUI: true };

// --- the intent file ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("intent: a pane is found by its own id and folder while its entry lives, and by nothing else", () => {
	const dir = state();
	let t = 1000;
	const intents = createIntents(fileOf(dir), () => t);
	const release = intents.grant("w1-1", proj, 5000);
	assert.equal(intended(dir, envOf("w1-1"), proj, t), true);
	assert.equal(intended(dir, envOf("w1-1"), join(proj, "."), t), true, "the folder as another spelling of itself");
	assert.equal(intended(dir, envOf("w1-2"), proj, t), false, "another pane");
	assert.equal(intended(dir, envOf("w1-1"), other, t), false, "another folder");
	assert.equal(intended(dir, envOf("w1-1", { HERDR_SOCKET_PATH: "/tmp/other-herdr.sock" }), proj, t), false, "another Herdr has a file of its own");
	assert.equal(intended(dir, {}, proj, t), false, "a process that is in no pane");
	assert.equal(intended(dir, envOf("w1-1"), proj, t + 5000), false, "the entry ran out");
	release();
	assert.equal(intended(dir, envOf("w1-1"), proj, t), false, "the open ended");
	intents.grant("w1-1", proj, 100);
	t += 200;
	intents.grant("w1-3", proj, 100);
	assert.deepEqual((JSON.parse(readFileSync(fileOf(dir), "utf8")) as { panes: { pane: string }[] }).panes.map((p) => p.pane), ["w1-3"], "an entry that ran out is dropped at the next write");
});

test("intent: nothing a pane says about itself makes it listed; a file that is not a plain readable listing says no", () => {
	const dir = state();
	// A request field, a flag and an environment variable are not read at all.
	for (const claim of [{ STRAW_BOSS_OPEN_INTENT: "1" }, { STRAW_BOSS_OPEN_BASE: "w1-1" }, { sb_open_base: "1" }] as Record<string, string>[]) assert.equal(intended(dir, envOf("w1-1", claim), proj, 1000), false);
	const file = fileOf(dir), good = { v: 1, panes: [{ pane: "w1-1", cwd: proj, expires: 9_999_999 }] };
	writeFileSync(file, JSON.stringify(good));
	assert.equal(intended(dir, envOf("w1-1"), proj, 1000), true, "control: the listing as the server writes it");
	for (const bad of ["{ nope", JSON.stringify({ ...good, v: 2 }), JSON.stringify({ v: 1, panes: "w1-1" }), JSON.stringify({ v: 1, panes: [{ pane: "w1-1", cwd: proj }] }), JSON.stringify({ v: 1, panes: [{ pane: "w1-1", cwd: proj, expires: "never" }] })]) {
		writeFileSync(file, bad);
		assert.equal(intended(dir, envOf("w1-1"), proj, 1000), false, bad);
	}
	rmSync(file);
	symlinkSync(join(dir, "elsewhere.json"), file);
	writeFileSync(join(dir, "elsewhere.json"), JSON.stringify(good));
	assert.equal(intended(dir, envOf("w1-1"), proj, 1000), false, "a link is not a file the server wrote");
});

test("intent: a listing that cannot be written throws, and leaves nothing listed", () => {
	const dir = state();
	const blocked = join(dir, "blocked");
	writeFileSync(blocked, ""); // a file where the folder of the listing should be
	const intents = createIntents(join(blocked, "open-intents.json"));
	assert.throws(() => intents.grant("w1-1", proj, 5000));
	chmodSync(dir, 0o700);
});

// --- the trust question ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A pi's trust handler with auto mode on (written by the real server module) and a GUI that answers `once` to what it is asked. `asked` lists the questions that reached the GUI's files. */
function question(pane: string, listed: (dir: string) => void, extraEnv: Record<string, string> = {}, over: { on?: boolean } = {}) {
	const dir = state(), clock = Date.now(), cwd = proj;
	listed(dir);
	if (over.on !== false) {
		const auto = createAutoMode({ dir, now: () => clock, log: () => {} });
		auto.start();
		auto.switchOn({ via: "pi", name: "test" });
	}
	const notes: string[] = [], asked: TrustRequest[] = [];
	const trustDir = join(dir, "trust");
	const env = envOf(pane, extraEnv);
	const decide = createAsk({
		env, dir: trustDir, stdin: { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} }, proc: { pid: process.pid, on() {}, off() {}, listenerCount: () => 1, kill() {} }, write() {},
		saved: () => null, defaultTrust: () => "ask", up: async () => true, first: () => true, now: () => clock, watch: () => () => {}, startOf: () => undefined, uuid: () => "11111111-2222-4333-8444-555555555555",
		sleep: async () => {
			const name = readdirSync(trustDir).find((f) => f === requestFile("11111111-2222-4333-8444-555555555555"));
			if (!name) return;
			const request = JSON.parse(readFileSync(join(trustDir, name), "utf8")) as TrustRequest;
			asked.push(request);
			writeFileSync(join(trustDir, answerFile(request.id)), JSON.stringify({ version: 1, id: request.id, digest: request.digest, choice: "once", answerId: "a".repeat(24) }));
		},
		auto: { on: () => autoOnForTrust(dir), note: (gist) => void notes.push(gist) },
		opened: (c) => intended(dir, env, c, clock),
	});
	return { decide: () => decide(cwd, TUI), notes, asked };
}
const listing = (pane: string, folder = proj) => (dir: string) => void createIntents(fileOf(dir)).grant(pane, folder, 60_000);

test("trust: auto on + a pane the server started for open/base is asked as usual, and the answer is the boss's", async () => {
	const q = question("w1-1", listing("w1-1"));
	assert.deepEqual(await q.decide(), { trusted: "yes" });
	assert.equal(q.asked.length, 1, "the question reached the GUI's files");
	assert.deepEqual(q.notes, [], "nothing was refused");
});

test("trust: auto on + any other pane is still refused at once, whatever it claims", async () => {
	for (const [name, pane, claim, folder] of [
		["not listed", "w1-2", {}, proj],
		["claims the intent by the environment", "w1-2", { STRAW_BOSS_OPEN_INTENT: "1", STRAW_BOSS_ROLE: "member" }, proj],
		["claims the listed pane's id by a variable of its own", "w1-2", { STRAW_BOSS_PANE: "w1-1", PI_INTERCOM_PANE: "w1-1" }, proj],
		["listed for another folder", "w1-1", {}, other],
	] as const) {
		const q = question(pane, listing("w1-1", folder), claim);
		assert.deepEqual(await q.decide(), { trusted: "no" }, name);
		assert.equal(q.asked.length, 0, name);
		assert.match(q.notes.join("\n"), /not trusted for this session/, name);
	}
});

test("trust: auto off asks as usual with or without a listing", async () => {
	for (const pane of ["w1-1", "w1-2"]) {
		const q = question(pane, listing("w1-1"), {}, { on: false });
		assert.deepEqual(await q.decide(), { trusted: "yes" }, pane);
		assert.equal(q.asked.length, 1);
	}
});

test("trust: a handler whose intent read throws is answered as D3 says", async () => {
	const dir = state();
	const auto = createAutoMode({ dir, now: () => 1_800_000_000_000, log: () => {} });
	auto.start();
	auto.switchOn({ via: "pi", name: "test" });
	const decide = createAsk({
		env: envOf("w1-1"), dir: join(dir, "trust"), stdin: { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} }, proc: process, write() {}, saved: () => null, defaultTrust: () => "ask",
		up: async () => false, first: () => true, now: () => 0, sleep: async () => {}, watch: () => () => {}, startOf: () => undefined, uuid: () => "id",
		auto: { on: () => autoOnForTrust(dir), note() {} }, opened: () => { throw new Error("unreadable"); },
	});
	assert.deepEqual(await decide(proj, TUI), { trusted: "no" });
});

// --- the server lists exactly the open/base panes, for exactly their start --------------------------------------------------------------------------------------------------------------------------------

function host(dir: string, over: { intents?: ReturnType<typeof createIntents>; notes?: string[] } = {}) {
	const spawn = createSpawn({
		run: world.herdr.runFor("wA:p1"), sleep: async () => {}, live: async () => true, home, deploys: createDeploys(),
		intents: over.intents ?? createIntents(fileOf(dir)), note: (event, facts) => void over.notes?.push(`${event} ${JSON.stringify(facts)}`),
	});
	return (kind: string, body: Record<string, unknown>) => spawn(["open", kind], body);
}
const joins = (pane: { pane_id: string; workspace_id: string }) => void world.agent({ id: `opened-${pane.pane_id}`, name: "member", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "member" } }).start();

test("open/base lists its pane while pi starts and takes it off when the join ends", async () => {
	const dir = state(), seen: Record<string, boolean>[] = [];
	world.herdr.onAgentStart = (pane) => {
		const at = (folder: string) => intended(dir, envOf(pane.pane_id), folder, Date.now());
		seen.push({ own: at(proj), elsewhere: at(other) });
		joins(pane);
	};
	const answer = await host(dir)("base", { dir: proj, label: "", deploy: "deploy-intent-1" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(seen, [{ own: true, elsewhere: false }], "listed for its folder while pi starts");
	assert.equal(intended(dir, envOf((answer.body as { pane: string }).pane), proj, Date.now()), false, "taken off once the open ended");
});

test("open/base takes the pane off when the open fails, and an open that cannot list it goes on and says so", async () => {
	const dir = state(), notes: string[] = [];
	let pane = "";
	world.herdr.onAgentStart = (p) => void (pane = p.pane_id); // never joins: a short join wait ends the open
	const failed = await host(dir)("base", { dir: proj, label: "", joinWaitMs: 10_000 });
	assert.equal(failed.status, 502);
	assert.ok(pane);
	assert.equal(intended(dir, envOf(pane), proj, Date.now()), false, "a failed open leaves nothing listed");
	// The list cannot be written: the open is not failed for it; pi's question is then auto mode's own answer (refused), and the log says why.
	world.herdr.onAgentStart = joins;
	const blocked = join(dir, "blocked");
	writeFileSync(blocked, "");
	const ok = await host(dir, { intents: createIntents(join(blocked, "x.json")), notes })("base", { dir: proj, label: "" });
	assert.equal(ok.status, 200, JSON.stringify(ok.body));
	assert.match(notes.join("\n"), /open-intent-failed/);
});

test("open/member and open/main list nothing", async () => {
	const dir = state(), seen: boolean[] = [];
	world.herdr.onAgentStart = (pane) => {
		seen.push(existsList(dir));
		joins(pane);
	};
	const open = host(dir);
	const base = await open("base", { dir: proj, label: "" });
	assert.equal(base.status, 200, JSON.stringify(base.body));
	assert.deepEqual(seen, [true], "control: the base listed its pane");
	seen.length = 0;
	const member = await open("member", { workspace: (base.body as { workspace: string }).workspace, dir: other });
	assert.equal(member.status, 200, JSON.stringify(member.body));
	assert.deepEqual(seen, [false], "a member's pane is not listed while its pi starts");
});
function existsList(dir: string): boolean {
	try {
		return (JSON.parse(readFileSync(fileOf(dir), "utf8")) as { panes: unknown[] }).panes.length > 0;
	} catch {
		return false;
	}
}
