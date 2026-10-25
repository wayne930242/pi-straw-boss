import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createFauxCore, type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { createRemoteTurns } from "../src/link/hooks.ts";
import { MESSAGE_TYPE } from "../src/link/turn.ts";
import { bob, TEAM_HEX } from "./link/holder-world.ts";
import { shortId } from "../src/link/device.ts";

// The run classification against the events of a real pi agent session (a faux model, no network): a delivery that starts a run, a message steered into a
// local run, a follow-up that continues a run, and a retry, each ending in the single agent_settled (docs/specs/2026-10-25-straw-link.md, What makes a turn remote).

let root = "", project = "";
const sessions: AgentSession[] = [];
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "psb-link-session-")));
	project = join(root, "project");
	mkdirSync(project);
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", project, ...args], { stdio: "ignore" });
	git("init", "-q");
	writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(project, "secret.txt"), "untracked\n");
	git("add", "a.ts");
	git("commit", "-q", "-m", "init");
});
afterEach(() => {
	for (const s of sessions.splice(0)) s.dispose();
	rmSync(root, { recursive: true, force: true });
});

async function rig(trust: [string, "reply" | "forward" | "dispatch"][] = []) {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const faux = createFauxCore({ models: [{ id: "faux-1" }] });
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("faux", { api: faux.api as never, baseUrl: "http://faux.invalid", apiKey: "x", streamSimple: faux.streamSimple as never, models: [{ id: "faux-1", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4000 }] });
	const events: string[] = [], hooks: { on(event: string, fn: () => void): void } = { on: () => {} };
	const listeners = new Map<string, (() => void)[]>();
	hooks.on = (event, fn) => void listeners.set(event, [...(listeners.get(event) ?? []), fn]);
	let api!: ExtensionAPI;
	const loader = new DefaultResourceLoader({
		cwd: project, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			api = pi;
			createRemoteTurns({
				pi, now: Date.now, config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "project" }]]), trust: new Map(trust), problems: [] }),
				policy: { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } }, home: join(root, "home"), agentDir, linkDir: join(agentDir, "straw-boss", "link"), gateMs: 40,
				setOrigin: () => {}, tower: () => "tower", log: () => {}, tell: () => {}, ask: async () => ({ ok: false, error: "no holder in this test" }),
			});
			for (const t of ["agent_end", "agent_settled", "message_start", "tool_execution_start", "turn_end"]) pi.on(t as never, ((e: { message?: { role?: string; customType?: string }; toolName?: string }) => {
				events.push(`${t}${e.message ? `:${e.message.customType ?? e.message.role}` : ""}${e.toolName ? `:${e.toolName}` : ""}`);
				for (const fn of listeners.get(t) ?? []) fn();
			}) as never);
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: project, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "faux-1")!, resourceLoader: loader, sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 50 } } as never), tools: ["bash"],
	} as never);
	sessions.push(session);
	const settled = (n: number) => new Promise<void>((resolve) => {
		const check = () => events.filter((e) => e === "agent_settled").length >= n && resolve();
		hooks.on("agent_settled", check);
		check();
	});
	const remote = (id = "1".padStart(32, "0"), from = bob.id) => ({ customType: MESSAGE_TYPE, content: `[straw net …] REMOTE-TEXT-${id}`, display: true, details: { id, team: TEAM_HEX, from, label: "bob-mac", short: shortId(from) } });
	/** The text the bash calls of the session came back with, in order. */
	const outcomes = () => session.messages.filter((m) => (m as { role: string }).role === "toolResult").map((m) => ((m as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("")).trim());
	return { faux, session, events, api: () => api, hooks, settled, remote, outcomes };
}
const bash = (cmd: string) => fauxAssistantMessage([fauxToolCall("bash", { command: cmd })]);
const BLOCKED = /declined a remote request/;

test("a delivery sent with triggerTurn into an idle tower starts a remote turn: its tool calls are held, and the next local prompt's are not", async () => {
	const r = await rig();
	r.faux.setResponses([bash("echo one"), fauxAssistantMessage("done")]);
	r.api().sendMessage(r.remote(), { triggerTurn: true });
	await r.settled(1);
	assert.match(r.outcomes()[0]!, BLOCKED);
	assert.deepEqual(r.events.filter((e) => /^message_start:straw-link|agent_settled/.test(e)), ["message_start:straw-link", "agent_settled"]);
	r.faux.setResponses([bash("echo two"), fauxAssistantMessage("done")]);
	await r.session.prompt("now locally");
	await r.settled(2);
	assert.equal(r.outcomes()[1], "two", "a run that no straw-link message entered runs its calls");
});

test("N1 steering: a straw-link message steered into a run that began local makes it remote from the next tool call; the call already running was local", async () => {
	const r = await rig();
	let steered = false;
	r.hooks.on("tool_execution_start", () => void (!steered && ((steered = true), r.api().sendMessage(r.remote(), { triggerTurn: true }))));
	r.faux.setResponses([bash("echo before"), bash("echo after"), fauxAssistantMessage("done")]);
	await r.session.prompt("start locally");
	await r.settled(1);
	const out = r.outcomes();
	assert.equal(out[0], "before", "the call that began before the message joined");
	assert.match(out[1]!, BLOCKED, "the run turned remote when the message entered it");
	assert.ok(r.events.indexOf("message_start:straw-link") > r.events.indexOf("tool_execution_start:bash"), "the message entered after the run began");
	assert.equal(r.events.filter((e) => e === "agent_settled").length, 1);
});

test("N1 continuation: a queued follow-up that continues the run without a new before_agent_start leaves it remote until the single agent_settled", async () => {
	const r = await rig();
	let queued = false;
	r.hooks.on("turn_end", () => void (!queued && ((queued = true), r.api().sendUserMessage("and once more", { deliverAs: "followUp" }))));
	r.faux.setResponses([bash("echo one"), fauxAssistantMessage("first done"), bash("echo two"), fauxAssistantMessage("second done")]);
	r.api().sendMessage(r.remote(), { triggerTurn: true });
	await r.settled(1);
	const out = r.outcomes();
	assert.equal(out.length, 2);
	assert.match(out[0]!, BLOCKED);
	assert.match(out[1]!, BLOCKED, "the follow-up's turn is still the remote turn");
	assert.equal(r.events.filter((e) => e === "agent_settled").length, 1, "one run, one settle");
});

test("N1 retry: a transient error and the automatic retry (a second agent_end inside the run) leave the run remote", async () => {
	const r = await rig();
	r.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error: try later" }), bash("echo retried"), fauxAssistantMessage("done")]);
	r.api().sendMessage(r.remote(), { triggerTurn: true });
	await r.settled(1);
	assert.ok(r.events.filter((e) => e === "agent_end").length >= 2, `the run ended and was retried (${r.events.join(" ")})`);
	assert.match(r.outcomes().at(-1)!, BLOCKED);
	assert.equal(r.events.filter((e) => e === "agent_settled").length, 1);
});

test("R-F023 with the real context event: the model of a later local run is not shown the peer's text, only a marker; the run the message started is shown it", async () => {
	const r = await rig();
	const seen: string[] = [];
	const spy = (text: string): FauxResponseStep => (context) => ((seen.push(JSON.stringify(context.messages)), fauxAssistantMessage(fauxText(text))));
	r.faux.setResponses([spy("ok")]);
	r.api().sendMessage(r.remote("2".padStart(32, "0")), { triggerTurn: true });
	await r.settled(1);
	r.faux.setResponses([spy("ok again")]);
	await r.session.prompt("what did they want?");
	await r.settled(2);
	assert.match(seen[0]!, /REMOTE-TEXT-0+2/, "the remote turn reads the request");
	assert.doesNotMatch(seen[1]!, /REMOTE-TEXT/, "the next local turn does not");
	assert.match(seen[1]!, /request from the teammate device bob-mac/);
});

test("the level comes from the sender's device id: bob at dispatch runs his calls", async () => {
	const r = await rig([[bob.id, "dispatch"]]);
	r.faux.setResponses([bash("echo go"), fauxAssistantMessage("done")]);
	r.api().sendMessage(r.remote(), { triggerTurn: true });
	await r.settled(1);
	assert.equal(r.outcomes()[0], "go");
});
