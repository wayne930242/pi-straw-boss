import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runBus, runRow } from "./run-probe.ts";
import { LOAD_STAMP_KEY } from "../src/doctor.ts";
import { DOCTOR_MESSAGE, registerDoctor } from "../src/doctorlive.ts";

// The doctor in a process (docs/how-it-works.md#the-doctor): the self-check at the first turn after each session start, the sb_doctor tool, and /boss doctor fix.

const dir = mkdtempSync(join(tmpdir(), "sb-doctor-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const HERDR = "git:github.com/wayne930242/pi-herdr-agents@67a0d75b18c86b5ad97cba38ab52c02039ed5359";
writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [HERDR, "npm:pi-intercom@0.19.0", "npm:pi-todo-ledger@0.4.0", "npm:pi-loop-monitor@0.2.8"] }));
const env = { PI_CODING_AGENT_DIR: dir };
const DISPATCH = ["subagent", "subagent_cancel", "subagent_send", "subagent_resume", "subagent_interrupt", "subagents_list"];

type Handler = (event: unknown, ctx: unknown) => unknown;
function fakePi(names: string[]) {
	const handlers = new Map<string, Handler[]>(), tools = new Map<string, { name: string; execute?: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: { verdict: string } }> }>();
	for (const name of names) tools.set(name, { name });
	let active: string[] | undefined;
	const api = {
		on: (type: string, h: Handler) => void handlers.set(type, [...(handlers.get(type) ?? []), h]),
		registerTool: (t: { name: string }) => void tools.set(t.name, t as never),
		getAllTools: () => [...tools.values()].map((t) => ({ name: t.name, exposure: "direct", sourceInfo: { source: DISPATCH.includes(t.name) ? HERDR : "npm:other@1.0.0" } })),
		getActiveTools: () => active ?? [...tools.keys()],
		setActiveTools: (list: string[]) => void (active = list),
	};
	const fire = (type: string, ctx: unknown = {}) => (handlers.get(type) ?? []).map((h) => h({ type }, ctx));
	return { api, tools, fire, setActive: (list: string[]) => void (active = list) };
}
const ALL = [...DISPATCH, "intercom", "todo", "MonitorCreate"];

test("session_start with subagent absent: one message at the next turn, none after it, and one again after a reload", () => {
	const p = fakePi(ALL.filter((n) => !DISPATCH.includes(n)));
	const told: string[] = [];
	registerDoctor(p.api as never, { env, role: () => "main", tell: (t) => told.push(t) });
	p.fire("session_start");
	const [first] = p.fire("before_agent_start") as { message: { customType: string; content: string } }[];
	assert.equal(first?.message.customType, DOCTOR_MESSAGE);
	assert.match(first!.message.content, /`subagent` is not active \(registered: no; pi-herdr-agents loaded nothing\)/);
	assert.equal(told.length, 1, "a visible warning too");
	assert.deepEqual(p.fire("before_agent_start"), [undefined], "no repeat within a session start");
	p.fire("session_start");
	assert.equal((p.fire("before_agent_start")[0] as { message?: unknown })?.message !== undefined, true, "a reload checks again");
});

test("on reload with the tools present, no message", () => {
	const p = fakePi(ALL);
	registerDoctor(p.api as never, { env, role: () => "main" });
	p.fire("session_start");
	assert.deepEqual(p.fire("before_agent_start"), [undefined]);
});

test("a child whose launch denied subagent is not flagged", () => {
	const p = fakePi([...ALL.filter((n) => n !== "subagent"), "caller_ping", "subagent_done"]);
	registerDoctor(p.api as never, { env: { ...env, PI_DENY_TOOLS: "subagent" }, role: () => "child" });
	p.fire("session_start");
	assert.deepEqual(p.fire("before_agent_start"), [undefined]);
});

test("sb_doctor reports the live tracked-run source and count, never zero for unknown", async () => {
	const slot = globalThis as Record<symbol, unknown>, key = Symbol.for("pi-subagents/runtime");
	const p = fakePi(ALL);
	const pi = { ...p.api, events: runBus() };
	const doctor = registerDoctor(pi as never, { env, role: () => "main", headOf: () => undefined });
	doctor.addTool();
	const text = async () => (await p.tools.get("sb_doctor")!.execute!("id", {})).content[0]!.text;
	try {
		assert.match(await text(), /Tracked runs: unknown$/m);
		slot[key] = { runningSubagents: new Map() };
		assert.match(await text(), /Tracked runs: legacy \(0\)/);
		pi.events = runBus(() => [runRow("live")]);
		assert.match(await text(), /Tracked runs: snapshot \(1\)/);
	} finally { delete slot[key]; }
});

test("sb_doctor lists each worker revive that waits for proof of who has its run's session, and nothing when none waits", async () => {
	const p = fakePi(ALL);
	let waits: string[] = ["worker-a (sessionPath /s/x_r1.jsonl): an .exit is there while its own pi still runs"];
	const doctor = registerDoctor({ ...p.api, events: runBus(() => []) } as never, { env, role: () => "main", headOf: () => undefined, revives: () => waits });
	doctor.addTool();
	const text = async () => (await p.tools.get("sb_doctor")!.execute!("id", {})).content[0]!.text;
	assert.match(await text(), /^Revive waits: worker-a \(sessionPath \/s\/x_r1\.jsonl\): an \.exit is there while its own pi still runs$/m);
	waits = [];
	assert.doesNotMatch(await text(), /Revive waits/);
});

test("sb_doctor reports the load stamp and the stale check; /boss doctor fix makes an inactive tool active again", async () => {
	const p = fakePi(ALL);
	const slot = globalThis as Record<symbol, unknown>;
	slot[LOAD_STAMP_KEY] = { wrapperVersion: "3.12.1", wrapperHead: "944046dea86a06cf25bd81d5aec12ef4b8b8b25b", generation: 2, loadedAt: "2026-11-26T12:00:00.000Z" };
	try {
		const doctor = registerDoctor(p.api as never, { env, role: () => "main", headOf: () => "67a0d75b18c86b5ad97cba38ab52c02039ed5359", piInstalled: () => "9.9.9" });
		doctor.addTool();
		doctor.addTool(); // once
		const tool = p.tools.get("sb_doctor")!;
		const result = await tool.execute!("id", {}, undefined, undefined, { model: { provider: "claude-bridge", id: "claude-opus-5-5" } });
		assert.equal(result.details.verdict, "stale");
		assert.match(result.content[0]!.text, /pi-herdr-agents 944046d is loaded, 67a0d75 is installed/);
		assert.match(result.content[0]!.text, /generation 2/);
		p.setActive(ALL.filter((n) => n !== "subagent"));
		assert.equal(doctor.report(undefined).verdict, "H2");
		assert.deepEqual(doctor.fix(), ["subagent"]);
		assert.ok(p.api.getActiveTools().includes("subagent"));
		assert.deepEqual(doctor.fix(), [], "nothing left to fix");
	} finally {
		delete slot[LOAD_STAMP_KEY];
	}
});
