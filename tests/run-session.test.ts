import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRunMode, eventText } from "../src/runmode.ts";
import type { Kit } from "../src/state.ts";
import { until } from "./server-world.ts";

// A local run against the events of a real pi agent session (a faux model, no network, a scripted server): the brief in its role section, its events taken one at a time at idle, the tower tools
// that are clients of the server, `tower_done` ending it, and the `intercom` tool blocked (docs/specs/2026-10-26-sb-backend.md, Real pi session).

type Request = Record<string, unknown>;
type Answer = { ok: boolean; [key: string]: unknown };
let root = "";
const sessions: AgentSession[] = [];
beforeEach(() => void (root = realpathSync(mkdtempSync(join(tmpdir(), "psb-run-session-")))));
afterEach(() => {
	for (const s of sessions.splice(0)) s.dispose();
	rmSync(root, { recursive: true, force: true });
});

const BRIEF = "You are a run of the tower of workspace Alpha (wA); head tower: Alpha. BRIEF-MARK";
/** The server a run talks to: scripted answers, and every request kept. */
function server() {
	const requests: Request[] = [], queue: { id: string; kind: string; text: string; from?: { id: string } }[] = [], offered = new Set<string>(), taken: string[] = [];
	let commands: unknown[] = [], claimAnswer: Answer | undefined, doneAnswer: Answer | undefined, toolAnswer: Answer = { ok: true, text: "tool answer", details: { n: 1 } };
	return {
		requests, queue, taken,
		push: (id: string, text: string, kind = "intercom") => void queue.push({ id, kind, text, from: { id: "main-1" } }),
		command: (c: unknown) => void commands.push(c),
		refuseClaim: (error: string) => void (claimAnswer = { ok: false, error }),
		refuseDone: (error: string) => void (doneAnswer = { ok: false, error }),
		toolAnswers: (a: Answer) => void (toolAnswer = a),
		async ask(request: Request): Promise<Answer> {
			requests.push(request);
			switch (request.cmd) {
				case "claim": return claimAnswer ?? { ok: true, token: "TOKEN", kind: "local", run: "RUN", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: BRIEF };
				case "run-poll": {
					if (commands.length) return { ok: true, command: commands.shift() };
					if (request.idle !== true) return { ok: true };
					const next = queue.find((e) => !taken.includes(e.id));
					if (!next) return { ok: true };
					offered.add(next.id);
					return { ok: true, event: next };
				}
				case "run-taken": return (taken.push(String(request.id)), { ok: true });
				case "run-done": return doneAnswer ?? { ok: true };
				case "run-tool": return toolAnswer;
				default: return { ok: true };
			}
		},
	};
}

async function rig(srv: ReturnType<typeof server>, { flag = "RUN" }: { flag?: string | null } = {}) {
	const agentDir = join(root, "agent"), project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project);
	const faux = createFauxCore({ models: [{ id: "faux-1" }] });
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("faux", { api: faux.api as never, baseUrl: "http://faux.invalid", apiKey: "x", streamSimple: faux.streamSimple as never, models: [{ id: "faux-1", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4000 }] });
	const notes: string[] = [], shutdowns: number[] = [];
	let api!: ExtensionAPI;
	const loader = new DefaultResourceLoader({
		cwd: project, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			api = pi;
			// A stand-in for pi-intercom's tool, which a run must not be able to call.
			pi.registerTool({ name: "intercom", label: "intercom", description: "send", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "SENT" }], details: undefined }) });
			// SAFETY: the run mode reads only these fields of the kit (pi, cfg.env/now/sleep/promptDir/run, s, guiDir, tell).
			const kit = { pi, cfg: { env: { HERDR_PANE_ID: "wA:p1", HERDR_WORKSPACE_ID: "wA", HERDR_TAB_ID: "wA:t1" }, now: Date.now, sleep: async () => {}, promptDir: join(import.meta.dirname, "..", "prompts"), run: async () => { throw new Error("no herdr"); } }, s: {}, guiDir: join(root, "straw-boss"), me: () => "", role: () => undefined, tell: (text: string) => void notes.push(text) } as unknown as Kit;
			createRunMode(kit, { ask: (r: Request) => srv.ask(r), pollMs: 20, claimWaitMs: 200, startMs: 500 });
		}],
	});
	await loader.reload();
	if (flag !== null) loader.getExtensions().runtime.flagValues.set("sb-run", flag);
	const { session } = await createAgentSession({
		cwd: project, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "faux-1")!, resourceLoader: loader, sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({}),
	} as never);
	sessions.push(session);
	await session.bindExtensions({ shutdownHandler: () => void shutdowns.push(Date.now()) } as never);
	return { faux, session, notes, shutdowns, api: () => api };
}
const call = (name: string, args: Record<string, string | number>) => fauxAssistantMessage([fauxToolCall(name, args)]);
const results = (session: AgentSession) => session.messages.filter((m) => (m as { role: string }).role === "toolResult").map((m) => (m as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join(""));

test("a run claims with its run id and PID, puts the brief in its role section, and takes its events one at a time at idle, each confirmed", async () => {
	const srv = server();
	srv.push("e1", "[straw net from=main-1] EVENT-ONE");
	srv.push("e2", "[straw net from=main-1] EVENT-TWO");
	const seen: string[] = [];
	const r = await rig(srv);
	const spy = (text: string) => (context: { messages: unknown[]; systemPrompt?: string }) => (seen.push(JSON.stringify(context.messages)), fauxAssistantMessage(text));
	r.faux.setResponses([spy("one") as never, spy("two") as never]);
	await until(() => srv.taken.length === 2, "both events taken");
	const claim = srv.requests.find((q) => q.cmd === "claim")!;
	assert.equal(claim.runId, "RUN");
	assert.equal(claim.pid, process.pid);
	assert.equal(claim.pane, "wA:p1");
	await until(() => seen.length === 2, "two turns");
	assert.match(seen[0]!, /EVENT-ONE/);
	assert.doesNotMatch(seen[0]!, /EVENT-TWO/, "the second event waits for the first turn to settle");
	assert.match(seen[1]!, /EVENT-TWO/);
	assert.match(seen[0]!, /BRIEF-MARK/);
	assert.match(seen[0]!, /run of the tower of Herdr workspace Alpha/);
	const polls = srv.requests.filter((q) => q.cmd === "run-poll");
	assert.ok(polls.every((q) => q.token === "TOKEN"));
	assert.ok(polls.some((q) => q.idle === true));
	assert.ok(srv.requests.some((q) => q.cmd === "run-file"));
});

test("a refused claim ends the pi with the reason, and nothing is registered", async () => {
	const srv = server();
	srv.refuseClaim("this run was claimed already");
	const r = await rig(srv);
	assert.equal(r.shutdowns.length, 1);
	assert.match(r.notes.join("\n"), /this run cannot start: this run was claimed already/);
	assert.ok(!r.session.getAllTools().some((t) => t.name === "tower_done"));
});

test("the tower tools are clients of the server, tower_done ends the run, and a refused tower_done keeps it", async () => {
	const srv = server();
	srv.push("e1", "go");
	const r = await rig(srv);
	const names = r.session.getAllTools().map((t) => t.name);
	for (const n of ["boss_status", "call_tower", "tower_list", "board_read", "tower_send", "tower_reply", "tower_done", "boss_open_main", "boss_close_main", "boss_server"]) assert.ok(names.includes(n), `${n} is registered`);
	for (const n of ["link_request", "boss_broadcast", "board_set", "boss_rename", "boss_promote"]) assert.ok(!names.includes(n), `${n} is not`);
	srv.refuseDone("1 event still for you");
	r.faux.setResponses([call("tower_send", { message: "hello", workspace: "Beta" }), call("tower_done", { note: "routed" }), call("tower_reply", { to: "main-1", message: "ok" }), fauxAssistantMessage("finished")]);
	await until(() => srv.taken.length === 1, "the event");
	await until(() => results(r.session).length === 3, "three results");
	const tools = srv.requests.filter((q) => q.cmd === "run-tool");
	assert.deepEqual(tools.map((q) => q.tool), ["tower_send", "tower_reply"]);
	assert.deepEqual(tools[0]!.args as object, { message: "hello", workspace: "Beta" });
	assert.equal(tools[0]!.token, "TOKEN");
	assert.match(results(r.session)[0]!, /tool answer/);
	assert.match(results(r.session)[1]!, /1 event still for you/, "the refusal comes back as the tool's error");
	assert.equal(r.shutdowns.length, 0, "a refused tower_done leaves the run alive");
	assert.equal(srv.requests.filter((q) => q.cmd === "run-done").length, 1);
});

test("tower_done with the server's yes shuts pi down", async () => {
	const srv = server();
	srv.push("e1", "go");
	const r = await rig(srv);
	r.faux.setResponses([call("tower_done", { note: "routed", wakeAfter: 30 }), fauxAssistantMessage("bye")]);
	await until(() => r.shutdowns.length === 1, "shutdown");
	const done = srv.requests.find((q) => q.cmd === "run-done")!;
	assert.equal(done.note, "routed");
	assert.equal(done.wakeAfter, 30);
});

test("the intercom tool is blocked in a run with a pointer to tower_reply", async () => {
	const srv = server();
	srv.push("e1", "go");
	const r = await rig(srv);
	r.faux.setResponses([call("intercom", {}), fauxAssistantMessage("ok")]);
	await until(() => results(r.session).length === 1, "the result");
	assert.match(results(r.session)[0]!, /tower_reply/);
	assert.doesNotMatch(results(r.session)[0]!, /SENT/);
});

test("a steer command from the server starts a turn, and quit shuts pi down", async () => {
	const srv = server();
	const r = await rig(srv);
	const seen: string[] = [];
	r.faux.setResponses([(context: { messages: unknown[] }) => (seen.push(JSON.stringify(context.messages)), fauxAssistantMessage("noted")) as never]);
	srv.command({ type: "steer", text: "Call tower_done with your handoff note." });
	await until(() => seen.length === 1, "the steered turn");
	assert.match(seen[0]!, /Call tower_done with your handoff note/);
	srv.command({ type: "quit" });
	await until(() => r.shutdowns.length === 1, "quit");
});

test("a server that forgot the token (a restart) is claimed again with the run id, and a refusal then ends the run", async () => {
	const srv = server();
	let forget = true;
	const inner = srv.ask.bind(srv);
	srv.ask = async (request: Request): Promise<Answer> => (request.cmd === "run-poll" && forget ? ((forget = false), { ok: false, error: "unknown_token" }) : inner(request));
	const r = await rig(srv);
	await until(() => srv.requests.filter((q) => q.cmd === "claim").length === 2, "a second claim");
	assert.equal(srv.requests.filter((q) => q.cmd === "claim")[1]!.runId, "RUN");
	srv.refuseClaim("this run is not one the server has live");
	forget = true;
	await until(() => r.shutdowns.length === 1, "the run leaves");
});

test("without the flag and without a standing pane a pi is no run, and the events read as their kind says", async () => {
	const srv = server();
	const r = await rig(srv, { flag: null });
	assert.ok(!r.session.getAllTools().some((t) => t.name === "tower_done"));
	assert.equal(srv.requests.length, 0);
	assert.match(eventText({ kind: "boss", text: "do it" }), /instruction\]\ndo it$/);
	assert.match(eventText({ kind: "intercom", text: "[hdr] x", flag: "crash" }), /^\[possibly handled by a run that crashed: check before acting\]\n\[hdr\] x$/);
});
