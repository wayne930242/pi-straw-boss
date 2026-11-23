import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type Agent, settle, World } from "./fakes.ts";

// docs/specs/2026-11-09-agent-kinds.md, phase 1: a main's kind (§2, §3), the prompt it runs (§9), and what it publishes. The dispatch gate of §2a is gone (docs/specs/2026-11-23-lite-main.md §1).

let world: World;
afterEach(() => world.stopAll());
const snap = (...tasks: { id: number; status?: string; graph?: string; sb?: unknown }[]) => ({ customType: "rpiv-todo-state", data: { nextId: tasks.length + 1, tasks: tasks.map((t) => ({ id: t.id, subject: `t${t.id}`, status: t.status ?? "pending", metadata: { ...(t.graph ? { graph: t.graph } : {}), ...(t.sb ? { sb: t.sb } : {}) } })) } });
const main = async (name: string, entries: { customType: string; data: unknown }[] = [], env: Record<string, string> = {}): Promise<Agent> => {
	const a = world.agent({ id: `m-${name}`, name, pane: "wA:p1", tab: "wA:t1", entries, env });
	await a.start();
	await a.promote();
	return a;
};
const text = async (a: Agent) => (await a.run())["straw-boss"] ?? "";
const duties = (a: Agent) => a.entries.filter((e) => e.customType === "straw-boss" && (e.data as { duty?: string }).duty !== undefined).map((e) => e.data as Record<string, unknown>);
const token = () => world.herdr.pane("wA:p1").tokens.sb_duty;
const call = (a: Agent, input: Record<string, unknown>, toolName = "subagent") => a.fireResult("tool_call", { toolName, toolCallId: "c1", input }) as Promise<{ block?: boolean; reason?: string } | undefined>;
const steers = (a: Agent) => a.sent.filter((m) => m.customType === "straw-boss").map((m) => m.content);

test("a main with no entry is a coordinator: main.md alone, kind in its first line, sb_duty=coordinator", async () => {
	world = new World();
	const a = await main("Docs");
	const t = await text(a);
	assert.match(t, /of kind coordinator/);
	assert.doesNotMatch(t, /## Dispatch|## Graph|## Kind: standing|# Integrator/);
	assert.match(t, /- Dispatch: split work by owning app/);
	assert.equal(token(), "coordinator");
});

test("boss_duty: standing writes all four fields, sets the kind, publishes, rebriefs once, and refusals have their own words", async () => {
	world = new World();
	const a = await main("Docs");
	await text(a);
	const reply = await a.tool("boss_duty", { duty: "standing", reason: "minds the v1 redis" });
	assert.match((reply.content[0] as { text: string }).text, /Your kind is now standing \(was none\)/);
	await settle();
	assert.deepEqual(Object.keys(duties(a)[0]!).sort(), ["duty", "dutyAt", "dutyFrom", "dutyWhy"]);
	assert.equal(token(), "standing");
	assert.equal(steers(a).length, 1);
	assert.match(steers(a)[0]!, /Your kind is now standing[\s\S]*## Kind: standing/);
	assert.match(await text(a), /of kind coordinator/, "the section keeps its first bytes (docs/specs/2026-11-23-lite-main.md §2)");
	assert.match(((await a.tool("boss_duty", { duty: "standing", reason: "again" })).content[0] as { text: string }).text, /already standing/);
	assert.equal(duties(a).length, 1, "nothing is written for the same kind");
	await assert.rejects(a.tool("boss_duty", { duty: "coordinator", reason: "" }), /reason is required/);
	await assert.rejects(a.tool("boss_duty", { duty: "coordinator", reason: "x".repeat(201) }), /1 to 200/);
	const back = await a.tool("boss_duty", { duty: "coordinator", reason: "line one\nline two" });
	assert.match((back.content[0] as { text: string }).text, /was standing/);
	assert.equal(duties(a).at(-1)!.dutyWhy, "line one line two");
});

test("boss_duty is refused for a member and in a remote turn; a main with no kind may declare coordinator, which ends migration", async () => {
	world = new World();
	const m1 = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await m1.start();
	const first = await main("integ later");
	assert.equal(first.id, "m-integ later");
	const member = world.agent({ id: "mem", pane: "wA:p2", tab: "wA:t1" });
	await member.start();
	await assert.rejects(member.tool("boss_duty", { duty: "standing", reason: "x" }), /Only a tab's main agent has a kind; call boss_promote first/);
});

test("migration by name: a ledger integrator named `integ FE2` gets integrator.md and the entry; names that are not the form do not match", async () => {
	world = new World();
	const a = await main("integ FE2");
	const t = await text(a);
	assert.match(t, /# Integrator/);
	assert.match(t, /of kind integrator/);
	await world.quiet();
	assert.equal(token(), "integrator");
	assert.deepEqual(duties(a).map((d) => d.dutyWhy), ["migrated: name"]);
	await text(a);
	await text(a);
	assert.equal(duties(a).length, 1, "at most one migration entry, ever");
	for (const name of ["integ tests MP-1", "integration notes", "integ"]) {
		world = new World();
		const b = await main(name);
		assert.doesNotMatch(await text(b), /# Integrator/, name);
		assert.equal(duties(b).length, 0, name);
	}
});

test("takeover: a rename to `integ v3` mid-run migrates through boss_rename, with one steer carrying integrator.md and the reply naming the kind", async () => {
	world = new World();
	const a = await main("Session 脈絡毀損接手");
	const original = await text(a);
	const reply = await a.tool("boss_rename", { name: "integ v3" });
	assert.match((reply.content[0] as { text: string }).text, /Your kind is now integrator \(migrated by name\); boss_duty changes it\./);
	await settle();
	assert.equal(steers(a).length, 1);
	assert.match(steers(a)[0]!, /# Integrator/);
	assert.equal(token(), "integrator");
	assert.equal(await text(a), original, "a rename-triggered migration is not a boss_duty declaration");
});

test("a rename through pi's session_info_changed migrates; renaming away keeps the kind", async () => {
	world = new World();
	const a = await main("Docs");
	await text(a);
	a.name = "integ FE2";
	await a.fire("session_info_changed", { name: "integ FE2" });
	await settle();
	assert.equal(token(), "integrator");
	a.name = "Something else";
	await a.fire("session_info_changed", { name: "Something else" });
	await a.tool("boss_rename", { name: "Other work" });
	assert.equal(token(), "integrator", "the duty belongs to the session");
});

test("a declared kind wins: standing stays standing under an integ name, and boss_rename says so", async () => {
	world = new World();
	const a = await main("Docs");
	await a.tool("boss_duty", { duty: "standing", reason: "watch" });
	const reply = await a.tool("boss_rename", { name: "integ FE2" });
	assert.match((reply.content[0] as { text: string }).text, /Your kind stays standing; boss_duty integrator if you now run trains\./);
	assert.equal(token(), "standing");
	assert.equal(duties(a).length, 1);
});

test("a main that declared coordinator is not migrated by a later rename", async () => {
	world = new World();
	const a = await main("Docs");
	await a.tool("boss_duty", { duty: "coordinator", reason: "plans" });
	await a.tool("boss_rename", { name: "integ FE2" });
	await text(a);
	assert.equal(token(), "coordinator");
	assert.equal(duties(a).length, 1);
});

test("restore: train todos migrate a restarted main with no declared kind; a restart keeps a declared kind", async () => {
	world = new World();
	const a = await main("Whatever", [snap({ id: 1, sb: { v: 1, kind: "train", project: "acme", app: "web", train: "2026-11-06-m" } })]);
	await text(a);
	assert.deepEqual(duties(a).map((d) => d.dutyWhy), ["migrated: train todos"]);
	world = new World();
	const b = await main("integ FE2", [{ customType: "straw-boss", data: { duty: "coordinator", dutyFrom: null, dutyWhy: "x", dutyAt: 1 } }]);
	await text(b);
	assert.equal(token(), "coordinator");
});

test("integration off: no migration entry, a declared integrator publishes coordinator and runs main.md", async () => {
	world = new World();
	const a = await main("integ FE2", [], { STRAW_BOSS_INTEGRATION: "off" });
	const t = await text(a);
	assert.equal(duties(a).length, 0);
	assert.doesNotMatch(t, /# Integrator/);
	assert.equal(token(), "coordinator");
	world = new World();
	const b = await main("Docs", [{ customType: "straw-boss", data: { duty: "integrator", dutyFrom: null, dutyWhy: "x", dutyAt: 1 } }], { STRAW_BOSS_INTEGRATION: "off" });
	await text(b);
	assert.equal(token(), "coordinator");
	await assert.rejects(b.tool("boss_duty", { duty: "integrator", reason: "x" }), /Integration is off|Expected|must be/i);
});

test("a switch away from the integrator with a pending train todo is refused", async () => {
	world = new World();
	const a = await main("integ FE2", [snap({ id: 1, status: "in_progress", sb: { v: 1, kind: "train", project: "acme", app: "web", train: "2026-11-06-m" } })]);
	await text(a);
	await assert.rejects(a.tool("boss_duty", { duty: "coordinator", reason: "done" }), /1 of your trains are forming or departing/);
});

test("every kind carries main.md's dispatch rules and no graph addendum; a graph steers nothing, and no kind is asked for a plan (docs/specs/2026-11-23-lite-main.md §1)", async () => {
	for (const name of ["Docs", "integ FE2"]) {
		world = new World();
		const i = await main(name);
		let t = await text(i);
		assert.match(t, /- Dispatch: split work by owning app/, name);
		i.entries.push(snap({ id: 1, graph: "fan-out" }));
		await i.toolResult("todo");
		assert.equal(steers(i).length, 0, name);
		t = await text(i);
		assert.doesNotMatch(t, /## Graph:|## Dispatch/, name);
		for (const agent of ["worker", "watchdog", "scout"]) assert.equal(await call(i, { agent }), undefined, `${name}: ${agent}`);
	}
});

test("AKP1-F002: a main named `integ FE2` that the subagent call itself promotes is migrated at that call; a promoted main of any name dispatches its worker", async () => {
	world = new World();
	const a = world.agent({ id: "ledger", name: "integ FE2", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	assert.equal(await call(a, { agent: "worker" }), undefined);
	await world.quiet();
	assert.equal(token(), "integrator");
	assert.deepEqual(duties(a).map((d) => d.dutyWhy), ["migrated: name"]);
	world = new World();
	const b = world.agent({ id: "plain", name: "Docs", pane: "wA:p1", tab: "wA:t1" });
	await b.start();
	assert.equal(await call(b, { agent: "worker" }), undefined, "no plan gates a worker");
});

test("AKP1-F004 (AK3-F003): a guard that was off at load keeps an integrator a coordinator even when the prompts load with integration on", async () => {
	world = new World();
	const env: Record<string, string> = { STRAW_BOSS_INTEGRATION: "off" };
	const a = world.agent({ id: "race", name: "Docs", pane: "wA:p1", tab: "wA:t1", env, entries: [{ customType: "straw-boss", data: { duty: "integrator", dutyFrom: null, dutyWhy: "x", dutyAt: 1 } }] });
	await a.start();
	await a.promote();
	a.env!.STRAW_BOSS_INTEGRATION = "on"; // a config edit lands between the two reads: prompts load on at the next start, the guard stayed off
	await a.fire("session_start", { reason: "reload" });
	await world.quiet();
	const t = await text(a);
	await world.quiet();
	assert.doesNotMatch(t, /# Integrator/);
	assert.equal(token(), "coordinator");
});

test("integration back on: the next load migrates a name that matched while integration was off", async () => {
	world = new World();
	const a = await main("integ FE2", [], { STRAW_BOSS_INTEGRATION: "off" });
	await text(a);
	assert.equal(duties(a).length, 0);
	world = new World();
	const b = await main("integ FE2");
	await text(b);
	assert.equal(duties(b).length, 1);
});

test("boss_duty: a tower has no such tool", async () => {
	world = new World();
	const tower = world.tower("tw", "wA:t9", "wA:p9");
	await tower.start();
	assert.equal(tower.tools.has("boss_duty"), false);
});

test("only a main publishes sb_duty: a member publishes none", async () => {
	world = new World();
	const m1 = world.agent({ id: "mem", name: "Docs", pane: "wA:p1", tab: "wA:t1" });
	await m1.start();
	await world.quiet();
	assert.equal(world.herdr.pane("wA:p1").tokens.sb_role, "member");
	assert.equal(world.herdr.pane("wA:p1").tokens.sb_duty, undefined);
});

test("the addenda repeat no sentence of boss_duty's description", async () => {
	world = new World();
	const a = await main("Docs");
	const description = a.tools.get("boss_duty")!.description;
	const norm = (t: string) => t.split(/(?<=[.!?:;])\s+|\n+/).map((x) => x.replace(/^[-#\s]+/, "").replace(/\s+/g, " ").trim().toLowerCase()).filter((x) => x.length > 24);
	const { readFileSync } = await import("node:fs");
	const { PROMPT_DIR } = await import("./fakes.ts");
	const mine = new Set(norm(description));
	for (const name of ["duty-standing"]) assert.deepEqual(norm(readFileSync(`${PROMPT_DIR}/${name}.md`, "utf8")).filter((x) => mine.has(x)), [], name);
});
