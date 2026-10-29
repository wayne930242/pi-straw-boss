import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLink } from "../src/link/runtime.ts";
import { createRunMode } from "../src/runmode.ts";
import type { Kit } from "../src/state.ts";

// A real pi agent session (a faux model, no network) with the run mode of the extension loaded and the server it asks replaced by a function: tests/run-session.test.ts scripts it, and
// tests/run-e2e.test.ts hands it the sb server of a test world.

export type Request = Record<string, unknown>;
export type Answer = { ok: boolean; [key: string]: unknown };
/** The scratch folder of one rig: made by `scratchRoot()`, removed by the caller with `rmSync`. */
export const scratchRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "psb-run-session-")));

export async function rig(root: string, ask: (request: Request) => Promise<Answer>, sessions: AgentSession[], { flag = "RUN", herdr, glyphWaitMs = 300, lostMs = 300, gateMs = 60, sessionDir, env, entries, towerAskMs = 300 }: { towerAskMs?: number; entries?: unknown[]; env?: Record<string, string>; flag?: string | null; herdr?: (args: string[]) => Promise<string>; glyphWaitMs?: number; lostMs?: number; gateMs?: number; /** Keep the session in a file of this folder, as pi does (its file appears at the first assistant message); in memory by default. */ sessionDir?: string } = {}) {
	const agentDir = join(root, "agent"), project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
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
			for (const name of ["subagent", "subagent_resume"]) pi.registerTool({ name, label: name, description: "dispatch", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "DISPATCHED" }], details: undefined }) });
			pi.registerTool({ name: "intercom", label: "intercom", description: "send", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "SENT" }], details: undefined }) });
			// A tool the remote-turn hooks of an ally run hold to its sender's level (neither on the allowlist nor free).
			pi.registerTool({ name: "bash", label: "bash", description: "run", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "RAN" }], details: undefined }) });
			// SAFETY: the run mode reads only these fields of the kit (pi, cfg.env/now/sleep/promptDir/run, s, guiDir, tell).
			const kit = { pi, cfg: { env: { HERDR_PANE_ID: "wA:p1", HERDR_WORKSPACE_ID: "wA", HERDR_TAB_ID: "wA:t1", ...env }, now: Date.now, sleep: async () => {}, promptDir: join(import.meta.dirname, "..", "prompts"), run: herdr ?? (async () => { throw new Error("no herdr"); }), link: { gateMs, home: join(root, "home"), policy: { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } } } }, s: {}, guiDir: join(root, "straw-boss"), me: () => "", role: () => undefined, tell: (text: string) => void notes.push(text) } as unknown as Kit;
			createRunMode(kit, undefined, { ask, pollMs: 20, claimWaitMs: 200, startMs: 500, lostMs, glyphWaitMs, towerAskMs }, createLink(kit));
		}],
	});
	await loader.reload();
	if (flag !== null) loader.getExtensions().runtime.flagValues.set("sb-run", flag);
	const { session } = await createAgentSession({
		cwd: project, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "faux-1")!, resourceLoader: loader, sessionManager: (() => { const sm = sessionDir ? SessionManager.create(project, sessionDir) : SessionManager.inMemory(); for (const data of entries ?? []) sm.appendCustomEntry("straw-boss", data); return sm; })(),
		settingsManager: SettingsManager.inMemory({}),
	} as never);
	sessions.push(session);
	await session.bindExtensions({ shutdownHandler: () => void shutdowns.push(Date.now()) } as never);
	return { faux, session, notes, shutdowns, api: () => api };
}

export const call = (name: string, args: Record<string, string | number | boolean>) => fauxAssistantMessage([fauxToolCall(name, args)]);
export const results = (session: AgentSession) => session.messages.filter((m) => (m as { role: string }).role === "toolResult").map((m) => (m as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join(""));
