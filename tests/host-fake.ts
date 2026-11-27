import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A small stand-in for Pi's ExtensionAPI for the host tests: what sb's host entry and Maestro call, recorded. `getCommands()` lists every registration,
// the way Pi's lists them before any dedupe (a second `/subagent` as `subagent:2`), and `getAllTools()` the first registration of each name, as Pi's does.

type Handler = (event: unknown, ctx: unknown) => unknown;
export interface Registration { name: string; path: string; tool?: { name: string; parameters: unknown; description?: string; execute: (...args: unknown[]) => unknown } }

export function fakePi(selfPath: string) {
	const handlers = new Map<string, Handler[]>(), bus = new Map<string, ((data: unknown) => void)[]>();
	const commands: Registration[] = [], tools: Registration[] = [], renderers: string[] = [], notices: { text: string; level?: string }[] = [], sent: unknown[] = [];
	const ui = { notify: (text: string, level?: string) => void notices.push({ text, level }), setWidget() {}, setStatus() {}, theme: {} };
	const ctx = { hasUI: false, ui, cwd: process.cwd(), modelRegistry: { getAvailable: () => [], find: () => undefined, getAll: () => [] }, sessionManager: { getSessionFile: () => undefined, getSessionDir: () => tmpdir(), getSessionId: () => "s", getEntries: () => [], getBranch: () => [] }, model: undefined };
	const pi = {
		on: (event: string, handler: Handler) => (handlers.set(event, [...(handlers.get(event) ?? []), handler]), () => {}),
		registerTool: (tool: Registration["tool"] & object) => void tools.push({ name: tool.name, path: selfPath, tool }),
		registerCommand: (name: string) => void commands.push({ name, path: selfPath }),
		registerMessageRenderer: (type: string) => void renderers.push(type),
		registerShortcut() {},
		registerFlag() {},
		events: {
			on: (channel: string, fn: (data: unknown) => void) => (bus.set(channel, [...(bus.get(channel) ?? []), fn]), () => bus.set(channel, (bus.get(channel) ?? []).filter((f) => f !== fn))),
			emit: (channel: string, data: unknown) => void (bus.get(channel) ?? []).forEach((fn) => fn(data)),
		},
		getCommands: () => {
			const counts = new Map<string, number>(), seen = new Map<string, number>();
			for (const c of commands) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
			return commands.map((c) => {
				const n = (seen.get(c.name) ?? 0) + 1;
				seen.set(c.name, n);
				return { name: (counts.get(c.name) ?? 0) > 1 ? `${c.name}:${n}` : c.name, source: "extension", sourceInfo: { path: c.path } };
			});
		},
		getAllTools: () => tools.filter((t, i) => tools.findIndex((x) => x.name === t.name) === i).map((t) => ({ name: t.name, sourceInfo: { path: t.path } })),
		getActiveTools: () => tools.map((t) => t.name),
		getThinkingLevel: () => "medium",
		getSettings: () => ({}),
		sendMessage: (message: unknown) => void sent.push(message),
		sendUserMessage() {},
		appendEntry() {},
	};
	/** Another extension's registration, as Pi records it whatever the order it loaded in. */
	const foreign = (path: string, what: { tool?: string; command?: string }) => {
		if (what.command) commands.push({ name: what.command, path });
		if (what.tool) tools.push({ name: what.tool, path, tool: { name: what.tool, parameters: {}, execute: () => undefined } });
	};
	const emit = async (event: string, payload: unknown = { type: event, reason: "startup" }) => {
		for (const h of [...(handlers.get(event) ?? [])]) await h(payload, ctx);
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, commands, tools, renderers, notices, sent, ctx, foreign, emit, bus };
}

/** A package folder named `name` with an extension entry file, as an npm install or a checkout lays it out. */
export function fakePackage(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `${name}-`));
	mkdirSync(join(dir, "pi-extension", "subagents"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
	const entry = join(dir, "pi-extension", "subagents", "index.ts");
	writeFileSync(entry, "export default () => {};\n");
	return entry;
}
