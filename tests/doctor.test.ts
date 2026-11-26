import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnose, type DoctorFacts, EXPECTED_TOOLS, gitInstallDir, packageName, pinOf, renderDoctor, selfCheckText, TOOL_PACKAGE } from "../src/doctor.ts";

// The doctor (docs/how-it-works.md#the-doctor) separates the ways an expected tool goes missing: H1 (its package loaded nothing in this process), H2 (registered, left inactive),
// a stale load, and healthy, where H3 (the provider does not show an active tool) is only a note, since nothing inside pi can tell it.

const HERDR = "git:github.com/wayne930242/pi-herdr-agents@67a0d75b18c86b5ad97cba38ab52c02039ed5359";
const PACKAGES = ["pi-herdr-agents", "pi-intercom", "pi-todo-ledger", "pi-loop-monitor"];
const tool = (name: string) => ({ name, exposure: "direct", source: name === "intercom" ? "npm:pi-intercom@0.19.0" : name === "todo" ? "npm:pi-todo-ledger@0.4.0" : name === "MonitorCreate" ? "npm:pi-loop-monitor@0.2.8" : HERDR });
const all = (role: keyof typeof EXPECTED_TOOLS) => EXPECTED_TOOLS[role].map(tool);
const stamp = { wrapperVersion: "3.12.1", wrapperHead: "67a0d75b18c86b5ad97cba38ab52c02039ed5359", maestroVersion: "0.1.2", generation: 1, loadedAt: "2026-11-26T12:00:00.000Z" };
const healthy = (over: Partial<DoctorFacts> = {}): DoctorFacts => ({ role: "main", packages: PACKAGES, tools: [...all("main"), { name: "read", exposure: "direct", source: "builtin" }], active: EXPECTED_TOOLS.main, stamp, installed: { pin: "67a0d75b18c86b5ad97cba38ab52c02039ed5359" }, ...over });

test("healthy: every expected tool is active and the load is the installed one", () => {
	const r = diagnose(healthy());
	assert.equal(r.verdict, "healthy");
	assert.equal(r.missing.length, 0);
	assert.equal(r.expected.length, EXPECTED_TOOLS.main.length);
	assert.equal(r.loaded[HERDR], 6);
	assert.equal(r.note, undefined);
	assert.equal(selfCheckText(r), undefined);
});

test("H1: pi-herdr-agents registered nothing in this process, and the self-check says to hand over", () => {
	const r = diagnose(healthy({ tools: all("main").filter((t) => t.source !== HERDR), active: ["intercom", "todo", "MonitorCreate"], stamp: undefined }));
	assert.equal(r.verdict, "H1");
	assert.deepEqual(r.silent, ["pi-herdr-agents"]);
	assert.deepEqual(r.missing.map((t) => [t.name, t.state]), EXPECTED_TOOLS.main.slice(0, 6).map((name) => [name, "unregistered"]));
	assert.match(r.next, /fresh session/);
	assert.match(renderDoctor(r), /no stamp/);
	const text = selfCheckText(r)!;
	assert.match(text, /`subagent` is not active \(registered: no; pi-herdr-agents loaded nothing\)/);
	assert.match(text, /Do not route around it with plain panes; run sb_doctor .* hand over to a fresh session/);
});

test("H1: a stamp that says the load threw is a load failure even with its tools listed", () => {
	const r = diagnose(healthy({ stamp: { ...stamp, failed: "slot owned by an older build" } }));
	assert.equal(r.verdict, "H1");
	assert.match(r.finding, /its load threw: slot owned by an older build/);
	assert.match(selfCheckText(r)!, /failed to load \(slot owned by an older build\)/);
});

test("H2: registered but left out of the active set", () => {
	const r = diagnose(healthy({ active: EXPECTED_TOOLS.main.filter((n) => n !== "subagent") }));
	assert.equal(r.verdict, "H2");
	assert.deepEqual(r.missing, [{ name: "subagent", package: "pi-herdr-agents", state: "inactive" }]);
	assert.match(r.next, /\/boss doctor fix/);
	assert.match(selfCheckText(r)!, /registered: yes.*follow its next step/);
});

test("a deferred tool that is not active is reachable, not missing", () => {
	const r = diagnose(healthy({ tools: all("main").map((t) => (t.name === "subagent_resume" ? { ...t, exposure: "deferred" } : t)), active: EXPECTED_TOOLS.main.filter((n) => n !== "subagent_resume") }));
	assert.equal(r.verdict, "healthy");
});

test("H3 is a note: all active through claude-bridge says to call the tool directly", () => {
	const r = diagnose(healthy({ provider: "claude-bridge", model: "claude-opus-5-5" }));
	assert.equal(r.verdict, "healthy");
	assert.match(r.note!, /call it directly, e\.g\. subagents_list/);
	assert.match(renderDoctor(r), /Model: claude-bridge\/claude-opus-5-5/);
});

test("stale: the loaded wrapper is not the installed pin, or pi is not the installed pi", () => {
	const r = diagnose(healthy({ installed: { pin: "944046dea86a06cf25bd81d5aec12ef4b8b8b25b" } }));
	assert.equal(r.verdict, "stale");
	assert.equal(r.stale, "pi-herdr-agents 67a0d75 is loaded, 944046d is installed");
	assert.match(r.next, /\/reload/);
	assert.equal(diagnose(healthy({ installed: { head: "67a0d75" } })).verdict, "healthy", "a short head matches");
	assert.equal(diagnose(healthy({ pi: { running: "1.6.0", installed: "1.6.1" } })).stale, "pi 1.6.0 runs, 1.6.1 is installed");
});

test("expected by role: a tower runs no subagent, a child adds the child protocol and drops what its launch denied", () => {
	assert.ok(!EXPECTED_TOOLS.tower.includes("subagent"));
	for (const role of ["main", "member", "train", "none"] as const) assert.deepEqual(EXPECTED_TOOLS[role], EXPECTED_TOOLS.main);
	for (const name of Object.values(EXPECTED_TOOLS).flat()) assert.ok(TOOL_PACKAGE[name], `${name} has an owning package`);
	const tower = diagnose(healthy({ role: "tower", tools: all("tower"), active: EXPECTED_TOOLS.tower }));
	assert.equal(tower.verdict, "healthy");
	const child = diagnose(healthy({ role: "child", denied: ["subagent", "subagent_resume"], tools: all("child").filter((t) => t.name !== "subagent" && t.name !== "subagent_resume"), active: EXPECTED_TOOLS.child.filter((n) => n !== "subagent" && n !== "subagent_resume") }));
	assert.equal(child.verdict, "healthy", "denied tools are not flagged");
	assert.ok(child.expected.some((t) => t.name === "caller_ping"));
	assert.equal(diagnose(healthy({ role: "member", denied: ["subagent"], active: EXPECTED_TOOLS.main.filter((n) => n !== "subagent") })).verdict, "H2", "only a child's denials count");
});

test("a child never gets the self-check message: its tools are its launch's choice (a role's tool list, auto-exit without subagent_done)", () => {
	const kept = ["read", "bash", "caller_ping"];
	const child = diagnose(healthy({ role: "child", tools: kept.map((name) => ({ name })), active: kept }));
	assert.ok(child.missing.some((t) => t.name === "intercom") && child.missing.some((t) => t.name === "subagent_done"), "the report still lists what a child lacks");
	assert.equal(selfCheckText(child), undefined);
	assert.match(selfCheckText(diagnose(healthy({ role: "main", tools: kept.map((name) => ({ name })), active: kept }))) ?? "", /sb self-check/, "a main still gets it");
});

test("a package not in the settings expects nothing; out of process (no active set) a registered tool counts", () => {
	assert.equal(diagnose(healthy({ packages: [], tools: [], active: [] })).verdict, "healthy");
	assert.equal(diagnose(healthy({ packages: [], tools: [], active: [] })).expected.length, 0);
	assert.equal(diagnose(healthy({ active: undefined })).verdict, "healthy");
});

test("settings entries name their package, pin and install folder", () => {
	assert.equal(packageName(HERDR), "pi-herdr-agents");
	assert.equal(packageName("npm:pi-intercom@0.19.0"), "pi-intercom");
	assert.equal(packageName("npm:@pify/memory@0.14.1"), "@pify/memory");
	assert.equal(packageName({ source: "npm:pi-anchorloop@3.4.0", extensions: [] }), "pi-anchorloop");
	assert.equal(packageName("../../projects/weihung-basic-agent"), "weihung-basic-agent");
	assert.equal(packageName(42), undefined);
	assert.equal(pinOf(HERDR), "67a0d75b18c86b5ad97cba38ab52c02039ed5359");
	assert.equal(pinOf("npm:pi-intercom@0.19.0"), undefined);
	assert.equal(gitInstallDir("/a", HERDR), "/a/git/github.com/wayne930242/pi-herdr-agents");
});
