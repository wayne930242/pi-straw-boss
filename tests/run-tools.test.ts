import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveArg } from "../src/link/allow.ts";
import { afterEach, beforeEach, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { LOCAL_RUN_TOOLS, RUN_FILE_TOOLS, RUN_TOWER_TOOLS, refusedPath, toolAllowed } from "../src/runallow.ts";
import { LOCAL_TOOLS } from "../src/server/towerbrief.ts";
import { type Answer, call, type Request, results, rig as makeRig, scratchRoot } from "./run-rig.ts";
import { until } from "./server-world.ts";
import { NO_CONFIRM } from "../src/autotext.ts";

// A local tower run has no shell, no edit or write tool, and no way to read the sb server's state (todo #31, docs/how-it-works.md, Tower runs): the sb server starts its pi with `--tools` naming the tower tools and
// read-only file access (runallow.ts; tests/server-tower-runs.test.ts holds the launch), and the run mode refuses everything else again at `tool_call`. These tests run a real pi agent session (a faux model, a scripted
// server) once with the allowlist pi was given and once without it, which is the backstop alone.

let root = "";
const sessions: AgentSession[] = [];
beforeEach(() => void (root = scratchRoot()));
afterEach(() => {
	for (const s of sessions.splice(0)) s.dispose();
	rmSync(root, { recursive: true, force: true });
});

const DEV = "a".repeat(26), TEAM = "1".repeat(32);
const PEER = { device: DEV, label: "Carol Mac", short: DEV.slice(0, 6), team: TEAM, teamName: "Team One" };
const BRIEF = "You are a run of the tower of workspace Alpha (wA); head tower: Alpha. BRIEF-MARK";
/** The server a run talks to: a claim of the given kind, and every other request answered ok. */
const server = (claim: Record<string, unknown> = {}) => {
	const requests: Request[] = [];
	return {
		requests,
		ask: async (request: Request): Promise<Answer> => {
			requests.push(request);
			if (request.cmd === "claim") return { ok: true, token: "TOKEN", kind: "local", run: "RUN", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: BRIEF, ...claim };
			if (request.cmd === "run-tool") return { ok: true, text: "tool answer" };
			return { ok: true };
		},
	};
};
type Srv = ReturnType<typeof server>;
const rig = (srv: Srv, over: Parameters<typeof makeRig>[3] = {}) => makeRig(root, (r) => srv.ask(r), sessions, over);
const SECRET = "SECRET-VALUE-0123";
/** The files of the sb server's state folder the rig's run mode is given (`<root>/straw-boss`), each holding the secret, and a project file a tower may read. */
const plant = () => {
	const state = join(root, "straw-boss");
	mkdirSync(join(state, "tower", "wA"), { recursive: true });
	mkdirSync(join(state, "link"), { recursive: true });
	for (const f of ["server.json", "gui.json", "gui-secrets.json", "lan-ca.json", "paired.json", "remote.json", join("tower", "wA", "memory.json"), join("link", "device.key")]) writeFileSync(join(state, f), SECRET);
	mkdirSync(join(root, "project", ".straw-boss"), { recursive: true });
	writeFileSync(join(root, "project", ".straw-boss", "apps.json"), JSON.stringify({ web: { integration: "dev" } }));
	writeFileSync(join(root, "project", "notes.txt"), "PROJECT-LINE one\n");
	mkdirSync(join(root, "home", ".ssh"), { recursive: true });
	writeFileSync(join(root, "home", ".ssh", "id_ed25519"), SECRET);
	return state;
};
/** Runs a scripted list of calls in a local run and returns what each answered, in order. */
const run = async (calls: [string, Record<string, unknown>][], over: Parameters<typeof makeRig>[3] = {}, srv: Srv = server(), source: "interactive" | "extension" = "interactive") => {
	const r = await rig(srv, over);
	r.faux.setResponses([...calls.map(([name, args]) => call(name, args as never)), fauxAssistantMessage("finished")]);
	// Nothing queued wakes the model: the boss's own words do.
	await r.session.prompt("go", { source });
	await until(() => results(r.session).length === calls.length, `${calls.length} results`);
	return { r, out: results(r.session), srv };
};
const NOT_IN_RUN = /is not available in a tower run/;
/** A pi that kept the shell and the editors besides the run's tools (an extension turned them back on): only the run mode's own check stands between the model and them. */
const WIDE = [...LOCAL_RUN_TOOLS, "bash", "write", "edit", "subagent", "subagent_resume", "intercom"];

test("a run's pi is given the tower tools and read-only files and nothing else: bash, write, edit, and the other tools of the session are not even registered, and every tool the run registers is active", async () => {
	const srv = server();
	const r = await rig(srv, { tools: LOCAL_RUN_TOOLS });
	await until(() => srv.requests.some((q) => q.cmd === "run-file"), "the run to be set up");
	const active = r.session.getActiveToolNames().sort();
	const registered = ["boss_status", "call_tower", "boss_server", "tower_list", "board_read", "tower_send", "boss_open_main", "boss_close_main", "tower_memory", "tower_reply", "tower_done", "link_request", "boss_wait_ask"];
	for (const n of [...registered, ...RUN_FILE_TOOLS]) assert.ok(active.includes(n), `${n} is active`);
	assert.deepEqual(active, [...registered, ...RUN_FILE_TOOLS].sort(), "and nothing else is");
	const all = r.session.getAllTools().map((t) => t.name);
	for (const n of ["bash", "write", "edit", "subagent", "subagent_resume", "intercom"]) assert.ok(!all.includes(n), `${n} is not registered`);
});

test("the allowlist names exactly the tools the run registers, and every tool the tower prompt and the brief name", () => {
	assert.deepEqual([...RUN_TOWER_TOOLS].sort(), ["board_read", "boss_close_main", "boss_open_main", "boss_server", "boss_status", "boss_wait_ask", "call_tower", "link_request", "tower_done", "tower_list", "tower_memory", "tower_reply", "tower_send"]);
	assert.deepEqual([...RUN_FILE_TOOLS], ["read", "grep", "find", "ls"]);
	const named = (text: string) => [...new Set(text.match(/\b(?:tower_[a-z]+|boss_[a-z_]+|board_read|call_tower|link_request)\b/g) ?? [])];
	// A quoted request the run passes to a main it opens ("... call `boss_duty` ...") names that main's tool, not the run's.
	const prompt = readFileSync(new URL("../prompts/tower-run.md", import.meta.url), "utf8").replace(/\("[^"]*"\)/g, "");
	const mentioned = [...named(prompt), ...named(LOCAL_TOOLS.join("\n"))];
	assert.ok(mentioned.length >= 10, "the prompt and the brief name the tower tools");
	for (const n of mentioned) assert.ok(toolAllowed(n), `${n} (named by the tower run prompt or its brief) is on the allowlist`);
	for (const n of ["bash", "write", "edit", "subagent", "intercom", "powershell", "codemode", "tool_search", "ask_user", "robot_hand"]) assert.ok(!toolAllowed(n), `${n} is not`);
});

test("a run cannot call bash, write, edit, or a subagent: refused at the run's tool_call (the pi here still has them, so the guard stands alone)", async () => {
	const { out, r } = await run([["bash", {}], ["write", { path: "x.txt", content: "x" }], ["edit", { path: "x.txt", edits: [{ oldText: "a", newText: "b" }] }], ["subagent", {}], ["subagent_resume", {}]], { tools: WIDE });
	assert.equal(out.length, 5);
	for (const o of out) assert.match(o, /not available in a tower run|A tower run dispatches no subagents/);
	assert.doesNotMatch(out.join(""), /RAN|DISPATCHED/);
	assert.match(out[0]!, /bash is not available in a tower run/);
	assert.match(out[1]!, /write is not available in a tower run/);
	assert.match(out[2]!, /edit is not available in a tower run/);
	assert.equal(r.session.messages.some((m) => JSON.stringify(m).includes("x.txt written")), false);
});

test("a run cannot read the state folder: server.json, gui.json, memory.json, the LAN, pairing, remote, and link files are refused by read, grep, find, and ls, symlinks and relative paths included", async () => {
	const state = plant();
	symlinkSync(join(state, "server.json"), join(root, "project", "innocent.txt"));
	const { out } = await run([
		["read", { path: join(state, "server.json") }],
		["read", { path: join(state, "gui.json") }],
		["read", { path: join(state, "tower", "wA", "memory.json") }],
		["read", { path: join(state, "lan-ca.json") }],
		["read", { path: join(state, "paired.json") }],
		["read", { path: join(state, "remote.json") }],
		["read", { path: join(state, "link", "device.key") }],
		["read", { path: "../straw-boss/server.json" }],
		["read", { path: "innocent.txt" }],
		["grep", { pattern: "SECRET", path: state }],
		["grep", { pattern: "SECRET", path: join(root, "straw-boss", "tower") }],
		["find", { pattern: "*.json", path: state }],
		["ls", { path: state }],
		["ls", { path: join(state, "tower") }],
		["read", { path: join(root, "home", ".ssh", "id_ed25519") }],
	], { tools: WIDE });
	assert.equal(out.length, 15);
	for (const [i, o] of out.entries()) {
		assert.doesNotMatch(o, new RegExp(SECRET), `call ${i} did not show the secret`);
		assert.match(o, /sb server's state or a secret/, `call ${i} was refused for its path: ${o}`);
	}
});

test("a search cannot reach the state folder from above or by a glob: a root that holds it, a search with no root from a folder that holds it, and an absolute pattern are refused", async () => {
	const state = plant();
	const home = join(root, "home");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "auth.json"), SECRET);
	const { out } = await run([
		["grep", { pattern: "SECRET", path: root }],
		["grep", { pattern: "SECRET", path: home }],
		["find", { pattern: "**/server.json", path: root }],
		["find", { pattern: `${state}/*.json` }],
		["grep", { pattern: "SECRET", glob: `${state}/**` }],
		["ls", { path: root }],
	], { tools: WIDE });
	assert.equal(out.length, 6);
	for (const [i, o] of out.entries()) {
		assert.doesNotMatch(o, new RegExp(SECRET), `call ${i} did not show the secret`);
		assert.match(o, /sb server's state|descend into the sb server's state/, `call ${i} was refused: ${o}`);
	}
});

test("a run still reads and searches a project: read, grep, find, and ls answer for a path below it", async () => {
	plant();
	const project = join(root, "project");
	const { out } = await run([
		["read", { path: join(project, ".straw-boss", "apps.json") }],
		["read", { path: "notes.txt" }],
		["grep", { pattern: "PROJECT-LINE" }],
		["grep", { pattern: "integration", path: join(project, ".straw-boss") }],
		["find", { pattern: "*.txt" }],
		["ls", { path: project }],
	], { tools: LOCAL_RUN_TOOLS });
	assert.match(out[0]!, /"integration":"dev"/);
	assert.match(out[1]!, /PROJECT-LINE one/);
	assert.match(out[2]!, /notes\.txt/);
	assert.match(out[3]!, /apps\.json/);
	assert.match(out[4]!, /notes\.txt/);
	assert.match(out[5]!, /notes\.txt/);
	for (const o of out) assert.doesNotMatch(o, /not available in a tower run|sb server's state|descend/);
});

test("a run still has every tower tool, with the allowlist given to pi and without it: each is a client of the server", async () => {
	for (const tools of [LOCAL_RUN_TOOLS, undefined]) {
		const srv = server();
		const { out } = await run([
			["boss_status", {}], ["tower_list", {}], ["board_read", {}], ["tower_send", { message: "hello", workspace: "Beta" }], ["tower_reply", { to: "main-1", message: "ok" }],
			["boss_open_main", { request: "do it", sender: "main-1" }], ["boss_close_main", { main: "main-1" }], ["tower_memory", { op: "read" }], ["boss_server", { action: "status" }], ["call_tower", { message: "hi" }],
		], tools ? { tools } : {}, srv);
		assert.equal(out.length, 10);
		for (const o of out) assert.doesNotMatch(o, NOT_IN_RUN, `${tools ? "with" : "without"} the allowlist: ${o}`);
		assert.deepEqual(srv.requests.filter((q) => q.cmd === "run-tool").map((q) => q.tool), ["boss_status", "tower_list", "board_read", "tower_send", "tower_reply", "boss_open_main", "boss_close_main", "tower_memory", "boss_server", "call_tower"]);
		sessions.splice(0).forEach((s) => s.dispose());
	}
});

test("a hand run's boss turn has every tool the boss chose; an ally run is not held to the list: it keeps the gate of its sender", async () => {
	const hand = await run([["bash", {}]], { tools: WIDE }, server({ hand: true }));
	assert.match(hand.out[0]!, /RAN/);
	sessions.splice(0).forEach((s) => s.dispose());
	const ally = await run([["bash", {}]], { tools: WIDE }, server({ kind: "ally", level: "reply", peer: { device: "dev1", label: "Dev", short: "d1", team: "t1", teamName: "T" } }));
	assert.doesNotMatch(ally.out[0]!, NOT_IN_RUN, "an ally run is judged by its sender's gate (here it is put to the boss, who does not answer), not by the list");
	assert.match(ally.out[0]!, /declined a remote request/);
});

test("an ally run under auto mode is refused at the sender's gate without asking anyone: no one can confirm (#140)", async () => {
	const srv = server({ kind: "ally", level: "reply", peer: { device: "dev1", label: "Dev", short: "d1", team: "t1", teamName: "T" } });
	const ally = await run([["bash", {}]], { tools: WIDE, autoOn: true }, srv);
	assert.equal(ally.out[0], NO_CONFIRM);
});

test("the boss's own !cmd in a run's pane still works: it is pi's own shell for the user, not a tool call, so neither the allowlist nor the run mode touches it", async () => {
	const srv = server();
	const r = await rig(srv, { tools: LOCAL_RUN_TOOLS });
	await until(() => srv.requests.some((q) => q.cmd === "run-file"), "the run to be set up");
	assert.ok(!r.session.getActiveToolNames().includes("bash"), "the model has no bash");
	const done = await r.session.executeBash("echo BOSS-CMD-OK");
	assert.match(done.output, /BOSS-CMD-OK/);
	assert.equal(done.exitCode, 0);
});

test("a run cannot read the state folder by a file:// URL: read, grep, find, and ls refuse the URL of server.json, memory.json, the link key, the GUI secrets, auth.json, and the folder itself", async () => {
	const state = plant();
	const home = join(root, "home");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "auth.json"), SECRET);
	const url = (p: string) => pathToFileURL(p).href;
	const { out } = await run([
		["read", { path: url(join(state, "server.json")) }],
		["read", { path: `@${url(join(state, "tower", "wA", "memory.json"))}` }],
		["read", { path: url(join(state, "link", "device.key")) }],
		["read", { path: url(join(state, "gui-secrets.json")) }],
		["read", { path: url(join(home, ".pi", "agent", "auth.json")) }],
		["read", { path: url(join(state, "gui.json")).replace("gui", "%67ui") }],
		["grep", { pattern: "SECRET", path: url(state) }],
		["grep", { pattern: "SECRET", path: url(home) }],
		["find", { pattern: "*.json", path: url(state) }],
		["ls", { path: url(state) }],
		["read", { path: "file://bad host/x" }],
	], { tools: WIDE });
	assert.equal(out.length, 11);
	for (const [i, o] of out.entries()) {
		assert.doesNotMatch(o, new RegExp(SECRET), `call ${i} did not show the secret`);
		assert.match(o, /sb server's state|secret|could not be checked/, `call ${i} was refused: ${o}`);
	}
});

test("a grep regex that looks like a path is a regex, not a path: only grep's path and glob and find's path and pattern are read as places", async () => {
	plant();
	const { out } = await run([
		["grep", { pattern: "/Users", path: "." }],
		["grep", { pattern: "~", path: "." }],
		["grep", { pattern: "PROJECT-LINE", path: "." }],
	], { tools: WIDE });
	for (const [i, o] of out.entries()) assert.doesNotMatch(o, /sb server's state|secret/, `call ${i} was not refused: ${o}`);
	assert.match(out[2]!, /PROJECT-LINE/);
});

// Run-tools parity: after bumping @earendil-works/pi-coding-agent, this test must pass (AGENTS.md, Bumping pi): the guard's resolver mirrors pi's, and it is compared with the installed devDependency only.
test("the guard's resolver agrees with pi's own on a table of inputs (file://, @, ~, odd spaces, percent escapes, relative, dot-dot)", async () => {
	const pi = (await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js")).href)) as { resolveToCwd(p: string, cwd: string): string };
	const cwd = join(root, "project"), home = process.env.HOME ?? "";
	assert.ok(home, "the test process has an isolated HOME");
	const inputs = ["a/b", "./a", "../x/y", "/abs/p", `file://${cwd}/f`, "file:///etc/hosts", "file:///a%2Fb/c%20d", "@file:///x/y", "@a/b", "~", "~/x/y", "a\u00A0b", "~/a\u2003b", "x/../y", "/c/Users/x", "/mnt/c/Users/x", "~\\x", "file://localhost/etc/hosts", "."];
	for (const input of inputs) {
		let want: string | undefined, got: string | undefined;
		try { want = pi.resolveToCwd(input, cwd); } catch { want = undefined; }
		try { got = resolveArg(input, cwd, home); } catch { got = undefined; }
		assert.equal(got, want, `${JSON.stringify(input)}`);
	}
});

test("the Windows forms of a path resolve as pi resolves them on win32: /c/..., /mnt/c/..., /cygdrive/c/..., ~\\ , file:///C:/..., and are then refused by the guard's deny list", () => {
	const w = (a: string) => resolveArg(a, "C:\\proj", "C:\\Users\\u", "win32");
	assert.equal(w("/c/Users/u/.pi/agent/straw-boss/server.json"), "C:\\Users\\u\\.pi\\agent\\straw-boss\\server.json");
	assert.equal(w("/mnt/c/Users/u/x"), "C:\\Users\\u\\x");
	assert.equal(w("/cygdrive/d/x"), "D:\\x");
	assert.equal(w("~\\.pi\\agent\\auth.json"), "C:\\Users\\u\\.pi\\agent\\auth.json");
	assert.equal(w("~/.pi/agent"), "C:\\Users\\u\\.pi\\agent");
	assert.equal(w("file:///C:/Users/u/.pi/x"), "C:\\Users\\u\\.pi\\x");
	assert.equal(w("rel\\x"), win32.resolve("C:\\proj", "rel\\x"));
	assert.equal(w("//srv/share"), "\\\\srv\\share\\");
});

test("a hand run's event turn is held to the local run's list and the path denial, the boss's own turn is not, and a steer typed in an event turn does not make it theirs", async () => {
	const state = plant();
	const hand = await run([["read", { path: join(state, "server.json") }], ["bash", {}], ["read", { path: join(root, "project", "notes.txt") }]], { tools: WIDE }, server({ hand: true }), "extension");
	assert.match(hand.out[0]!, /sb server's state or a secret/, "an event's turn: the path is refused");
	assert.match(hand.out[1]!, NOT_IN_RUN, "an event's turn: no shell");
	assert.match(hand.out[1]!, /boss's own turn/);
	assert.match(hand.out[2]!, /PROJECT-LINE/, "a project file is still read");
	sessions.splice(0).forEach((s) => s.dispose());
	const boss = await run([["read", { path: join(state, "server.json") }], ["bash", {}]], { tools: WIDE }, server({ hand: true }));
	assert.match(boss.out[0]!, new RegExp(SECRET), "the boss's own turn is not held");
	assert.match(boss.out[1]!, /RAN/, "the boss's own turn keeps the shell");
	sessions.splice(0).forEach((s) => s.dispose());
	// The boss types while the model is in a turn an event started: pi runs the input handler first, and the turn stays the event's.
	const r = await rig(server({ hand: true }));
	let steered = false;
	r.faux.setResponses([(() => {
		if (!steered) { steered = true; void r.session.prompt("steer", { source: "interactive", streamingBehavior: "steer" }); }
		return call("bash", {});
	}) as never, fauxAssistantMessage("finished"), fauxAssistantMessage("finished")]);
	await r.session.prompt("go", { source: "extension" });
	await until(() => results(r.session).length >= 1, "a result");
	assert.match(results(r.session)[0]!, NOT_IN_RUN, "the steer did not lift the hold");
});

test("an ally run is held to the path denial at dispatch and at reply, its sender's gate besides, and at dispatch it keeps its shell", async () => {
	const state = plant();
	mkdirSync(join(root, "straw-boss"), { recursive: true });
	for (const level of ["dispatch", "reply"]) {
		writeFileSync(join(state, "config.json"), JSON.stringify({ link: { teams: { [TEAM]: { project: join(root, "project") } }, trust: { [DEV]: level } } }));
		const queue = [{ id: "m1", kind: "link", text: `[straw net from=Carol Mac id=link:${DEV} role=tower remote=Carol Mac device=${DEV.slice(0, 6)} team="Team One" verified=yes kind=tower_send scope=tower to=x reply=none] look` }];
		const taken: string[] = [];
		const srv = server({ kind: "ally", level, peer: PEER });
		const base = srv.ask;
		srv.ask = async (request: Request): Promise<Answer> => {
			if (request.cmd === "run-poll") {
				if (request.idle !== true) return { ok: true };
				const next = queue.find((e) => !taken.includes(e.id));
				return next ? { ok: true, event: next } : { ok: true };
			}
			if (request.cmd === "run-taken") return (taken.push(String(request.id)), { ok: true });
			return base(request);
		};
		const r = await rig(srv, { tools: WIDE });
		r.faux.setResponses([call("read", { path: join(state, "server.json") }), call("ls", { path: pathToFileURL(state).href }), call("bash", {}), fauxAssistantMessage("finished")]);
		await until(() => results(r.session).length === 3, `${level}: three results`);
		const out = results(r.session);
		// At dispatch the sender's gate is off, so the run mode's path denial is the only layer. At reply the gate asks the boss first and refuses before the path denial is reached: either layer's refusal stands, the secret is never read.
		for (const o of out.slice(0, 2)) {
			assert.doesNotMatch(o, new RegExp(SECRET), `${level}: the secret was read`);
			assert.match(o, level === "dispatch" ? /sb server's state or a secret|descend/ : /sb server's state or a secret|descend|declined a remote request/, `${level}: ${o}`);
		}
		if (level === "dispatch") assert.match(out[2]!, /RAN/, "the shell stays at dispatch");
		else assert.match(out[2]!, /declined a remote request/, "the sender's gate holds at reply");
		sessions.splice(0).forEach((s) => s.dispose());
	}
});
