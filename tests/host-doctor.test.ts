import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { diagnose, renderDoctor } from "../src/doctor.ts";
import { maestroPin, pinText } from "../src/host/pin.ts";

// sb_doctor and /boss doctor say which host registered subagent: sb's (active, with the Maestro commit from the lock), stood down for pi-herdr-agents
// (and why), or off; under sb's host they expect its four tools, not pi-herdr-agents' six. pi-intercom is the sb server's need, not the host's.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tool = (name: string, source: string) => ({ name, exposure: "direct", source });
const SB = ["subagent", "subagent_cancel", "subagent_resume", "subagents_list"].map((n) => tool(n, "npm:pi-straw-boss@0.110.0"));
const SHARED = [tool("todo", "npm:pi-todo-ledger"), tool("MonitorCreate", "npm:pi-loop-monitor")];

test("the Maestro commit comes from the lock npm wrote, the same one package.json pins", () => {
	const pin = maestroPin(ROOT), spec = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).dependencies["@nubl/maestro"] as string;
	assert.equal(pin.sha, spec.split("#")[1]);
	assert.match(pinText(pin), /^Maestro \d+\.\d+\.\d+ @[0-9a-f]{7} \(/);
});

test("with sb's host active: its four tools are expected from pi-straw-boss, none of the dropped ones, and the host line names it with its Maestro build", () => {
	const r = diagnose({ role: "main", packages: ["pi-todo-ledger", "pi-loop-monitor"], tools: [...SB, ...SHARED], active: [...SB, ...SHARED].map((t) => t.name), host: { state: { state: "active", from: "default" }, maestro: "Maestro 0.1.2 @0e1dd78 (/x)" } });
	assert.equal(r.verdict, "healthy", r.finding);
	assert.deepEqual(r.expected.filter((t) => t.package === "pi-straw-boss").map((t) => t.name), ["subagent", "subagent_cancel", "subagent_resume", "subagents_list"]);
	const text = renderDoctor(r);
	assert.match(text, /Subagent host: active: sb registered subagent, subagent_cancel, subagent_resume and subagents_list/);
	assert.match(text, /Maestro 0\.1\.2 @0e1dd78/);
	assert.match(text, /pi-intercom is not installed: the sb server, the net and the GUI need it .*; the subagent host works without it\./);
	assert.doesNotMatch(text, /subagent_send|subagent_interrupt/);
});

test("stood down: the doctor says why, and expects pi-herdr-agents' tools from pi-herdr-agents", () => {
	const herdr = ["subagent", "subagent_cancel", "subagent_send", "subagent_resume", "subagent_interrupt", "subagents_list"].map((n) => tool(n, "git:github.com/wayne930242/pi-herdr-agents@abc"));
	const r = diagnose({ role: "main", packages: ["pi-herdr-agents", "pi-intercom"], tools: [...herdr, tool("intercom", "npm:pi-intercom")], active: [...herdr.map((t) => t.name), "intercom"], host: { state: { state: "stood-down", from: "default", why: "pi-herdr-agents registered /subagent and the subagent tool (/p/index.ts), so sb's subagent host registered nothing in this pi", others: ["/p/index.ts"] } } });
	assert.equal(r.verdict, "healthy");
	assert.equal(r.host.owner, "pi-herdr-agents");
	assert.ok(r.expected.some((t) => t.name === "subagent_send" && t.package === "pi-herdr-agents"));
	assert.match(renderDoctor(r), /Subagent host: stood down: pi-herdr-agents registered \/subagent/);
	assert.equal(r.intercom, undefined);
});

test("sb's host selected but its subagent missing is H1 against pi-straw-boss", () => {
	const r = diagnose({ role: "member", packages: [], tools: SHARED, active: SHARED.map((t) => t.name), host: { state: { state: "failed", from: "default", error: "boom" } } });
	assert.equal(r.verdict, "H1");
	assert.match(r.finding, /^subagent, subagent_cancel, subagent_resume, subagents_list not registered/);
	assert.match(renderDoctor(r), /Subagent host: failed to load: boom/);
});
