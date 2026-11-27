import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHost } from "../src/host/index.ts";
import { rivalsOf } from "../src/host/rivals.ts";
import { describeHost, hostState, setHostState } from "../src/host/state.ts";
import { fakePackage, fakePi } from "./host-fake.ts";

// F015: sb's host stands down when another extension registered `subagent`, from Pi's own record of the registrations at session start, whatever
// the order the two loaded in; a load stamp or runtime slot another host left in this process proves nothing about this load.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = `${ROOT}src/host/index.ts`;
const on = () => ({ host: "sb" as const, from: "default" });

function world() {
	const f = fakePi(SELF);
	let loads = 0;
	const starts: unknown[] = [];
	const engine = async () => (pi: ExtensionAPI) => {
		loads++;
		pi.registerTool({ name: "subagent", label: "s", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) } as never);
		pi.on("session_start", (event) => void starts.push(event));
	};
	return { ...f, engine, loads: () => loads, starts };
}

for (const order of ["before sb", "after sb"] as const) {
	test(`with pi-herdr-agents loaded ${order}, sb's host stands down at session start, registers nothing, and says so once`, async () => {
		const w = world(), herdr = fakePackage("pi-herdr-agents");
		w.ctx.hasUI = true;
		if (order === "before sb") w.foreign(herdr, { tool: "subagent", command: "subagent" });
		createHost({ choice: on, engine: w.engine, root: ROOT })(w.pi);
		if (order === "after sb") w.foreign(herdr, { tool: "subagent", command: "subagent" });
		assert.equal(hostState()?.state, "pending", "nothing is decided in the factory");
		await w.emit("session_start");
		await w.emit("session_start", { type: "session_start", reason: "new" });
		const state = hostState();
		assert.equal(state?.state, "stood-down");
		assert.match(describeHost(state), /^stood down: pi-herdr-agents registered \/subagent and the subagent tool \(.*pi-herdr-agents-.*\/index\.ts\)/);
		assert.equal(w.loads(), 0, "the engine never loaded");
		assert.equal(w.tools.filter((t) => t.path === SELF).length, 0, "sb registered no tool");
		assert.equal(w.notices.length, 1, "told once");
		assert.equal(w.notices[0]!.level, "warning");
		assert.ok(w.notices[0]!.text.includes(`pi remove ${state!.others![0]}`));
		assert.match(w.notices[0]!.text, /\/reload$/);
	});
}

for (const [lang, scope, source] of [["en", "user", "npm:pi-herdr-agents@1.2.3"], ["zh-TW", "project", "git:github.com/wayne930242/pi-herdr-agents#main"]] as const) {
	test(`headless ${lang}: name the configured ${scope} removal once per session`, async t => {
		const w = world(), path = fakePackage("pi-herdr-agents"), stderr = t.mock.method(console, "error", () => {});
		w.foreign(path, { tool: "subagent" });
		const get = w.pi.getAllTools.bind(w.pi);
		w.pi.getAllTools = () => get().map(tool => ({ ...tool, sourceInfo: { path, scope, source, origin: "package" } }));
		const before = process.env.LC_ALL;
		process.env.LC_ALL = lang;
		t.after(() => { if (before === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = before; });
		createHost({ choice: on, engine: w.engine, root: ROOT })(w.pi);
		await w.emit("session_start");
		await w.emit("session_start");
		w.ctx.sessionManager.getSessionId = () => "second";
		await w.emit("session_start");
		assert.equal(stderr.mock.callCount(), 2);
		assert.equal(w.notices.length, 0);
		const text = String(stderr.mock.calls[0]!.arguments[0]);
		assert.ok(text.includes(`pi remove ${source}${scope === "project" ? " --local" : ""}`));
		assert.match(text, lang === "en" ? /now hosts subagents.*then \/reload$/ : /現在負責執行子代理.*再執行 \/reload$/);
		t.diagnostic(text);
	});
}

test("the pre-dedupe command list alone is evidence: a rival whose subagent tool lost to another still stands sb down", async () => {
	const w = world(), first = fakePackage("pi-herdr-agents"), second = fakePackage("pi-herdr-agents");
	w.foreign(first, { tool: "subagent", command: "subagent" });
	w.foreign(second, { command: "subagent" });
	const rivals = rivalsOf(w.pi.getCommands(), w.pi.getAllTools(), ROOT);
	assert.deepEqual(rivals.map((r) => [r.pkg, r.via]), [["pi-herdr-agents", ["command", "tool"]], ["pi-herdr-agents", ["command"]]]);
	assert.ok(w.pi.getCommands().some((c) => c.name === "subagent:2"), "Pi lists the second registration as subagent:2");
});

test("another copy of pi-straw-boss that registered first is a rival too; sb's own registrations are not", () => {
	const w = world(), other = fakePackage("pi-straw-boss");
	w.foreign(other, { tool: "subagent" });
	w.foreign(SELF, { command: "subagent" });
	assert.deepEqual(rivalsOf(w.pi.getCommands(), w.pi.getAllTools(), ROOT).map((r) => r.pkg), ["pi-straw-boss"]);
});

test("a load stamp and runtime slot left by pi-herdr-agents alone never stand sb down", async () => {
	const w = world(), g = globalThis as Record<symbol, unknown>;
	g[Symbol.for("pi-herdr-agents/load-stamp")] = { wrapperRoot: "/old/pi-herdr-agents", generation: 3 };
	g[Symbol.for("pi-subagents/runtime")] ??= { runningSubagents: new Map() };
	try {
		createHost({ choice: on, engine: w.engine, root: ROOT })(w.pi);
		await w.emit("session_start");
		assert.equal(hostState()?.state, "active");
		assert.equal(w.loads(), 1);
	} finally {
		delete g[Symbol.for("pi-herdr-agents/load-stamp")];
	}
});

test("with no rival the engine loads once at the first session start, gets that start, and every later one, through its own handler", async () => {
	const w = world();
	createHost({ choice: on, engine: w.engine, root: ROOT })(w.pi);
	assert.equal(w.tools.length, 0, "the factory registers no tool");
	await w.emit("session_start", { type: "session_start", reason: "startup" });
	await w.emit("session_start", { type: "session_start", reason: "new" });
	assert.equal(w.loads(), 1);
	assert.deepEqual(w.starts.map((e) => (e as { reason: string }).reason), ["startup", "new"]);
	assert.equal(w.handlers.get("session_start")?.length, 1, "the engine's own session_start is run by the entry, not registered on Pi");
	assert.deepEqual(w.tools.map((t) => t.name), ["subagent"]);
	assert.equal(hostState()?.state, "active");
});

test("host off registers nothing and says off in the doctor", async () => {
	const w = world();
	createHost({ choice: () => ({ host: "off", from: "/x/straw-boss/host.json" }), engine: w.engine, root: ROOT })(w.pi);
	assert.equal(w.handlers.size, 0);
	assert.equal(describeHost(), "off (/x/straw-boss/host.json)");
	setHostState({ state: "pending", from: "default" });
});
