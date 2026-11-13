import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import rolePack, { ROLE_DISCOVERY_EVENT, ROLES_DIR } from "../src/rolepack.ts";

// sb ships the role pack (docs/specs/2026-11-09-agent-kinds.md §9, D11; phase 2 step 5.1).
const root = fileURLToPath(new URL("..", import.meta.url));
const ROLES = ["adversarial-reviewer", "planner", "reviewer", "scout", "visual-tester", "worker"];
const text = (name: string) => readFileSync(join(root, "roles", `${name}.md`), "utf8");

/** A pi with an event bus and lifecycle handlers, as the role pack sees it. */
function fakePi() {
	const bus = new Map<string, ((data: unknown) => void)[]>(), handlers = new Map<string, (() => void)[]>();
	return {
		bus, handlers,
		pi: {
			events: { on: (channel: string, h: (data: unknown) => void) => (bus.set(channel, [...(bus.get(channel) ?? []), h]), () => bus.set(channel, (bus.get(channel) ?? []).filter((x) => x !== h))) },
			on: (type: string, h: () => void) => handlers.set(type, [...(handlers.get(type) ?? []), h]),
		},
		discover(apiVersion: number) {
			const paths: string[] = [];
			for (const h of bus.get(ROLE_DISCOVERY_EVENT) ?? []) h({ apiVersion, register: (path: string) => paths.push(path) });
			return paths;
		},
	};
}

test("the role pack registers roles/ for apiVersion 1 only, in a child too, and unsubscribes at session_shutdown", () => {
	for (const env of [{}, { PI_SUBAGENT_ID: "run-1" }]) {
		const saved = process.env.PI_SUBAGENT_ID;
		if ("PI_SUBAGENT_ID" in env) process.env.PI_SUBAGENT_ID = env.PI_SUBAGENT_ID;
		const f = fakePi();
		rolePack(f.pi as never);
		if (saved === undefined) delete process.env.PI_SUBAGENT_ID;
		else process.env.PI_SUBAGENT_ID = saved;
		assert.equal(ROLE_DISCOVERY_EVENT, "pi-herdr-subagents:roles:discover:v1");
		assert.deepEqual(f.discover(1), [ROLES_DIR], JSON.stringify(env));
		assert.equal(ROLES_DIR, join(root, "roles"));
		assert.deepEqual(f.discover(2), [], "another version is ignored");
		for (const h of f.handlers.get("session_shutdown") ?? []) h();
		assert.deepEqual(f.discover(1), [], "gone after session_shutdown");
	}
});

test("the package lists the role pack's extension and ships roles/", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[]; pi: { extensions: string[] } };
	assert.ok(manifest.pi.extensions.includes("./src/rolepack.ts"));
	assert.ok(manifest.files.includes("roles"));
	const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" })) as { files: { path: string }[] }[];
	const paths = packed[0]!.files.map((f) => f.path).filter((p) => p.startsWith("roles/")).sort();
	assert.deepEqual(paths, ROLES.map((r) => `roles/${r}.md`));
});

/** The three checks pi-herdr-agents' catalog makes (maestro/core/roles/discovery.ts:495-575), re-implemented: sb has no pi-herdr-agents devDependency. */
function shape(file: string, body: string): string[] {
	const front = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1];
	if (front === undefined) return ["no frontmatter"];
	const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim();
	const problems: string[] = [];
	if ((field("name") ?? file) !== file) problems.push("name does not match the file stem");
	if (!field("description")) problems.push("no description");
	const tools = field("tools");
	if (tools !== undefined && !/^[a-z_][a-z0-9_]*(\s*,\s*[a-z_][a-z0-9_]*)*$/.test(tools)) problems.push(`tools is not a comma list: ${tools}`);
	return problems;
}

test("every role file has the shape pi-herdr-agents' catalog accepts", () => {
	assert.deepEqual(readdirSync(join(root, "roles")).sort(), ROLES.map((r) => `${r}.md`));
	for (const role of ROLES) assert.deepEqual(shape(role, text(role)), [], role);
});

const toolsOf = (role: string) => /^tools:\s*(.*)$/m.exec(text(role).split("\n---\n")[0]!)?.[1]?.split(",").map((t) => t.trim());

test("each role carries the tools: line of §9's table (worker and adversarial-reviewer have none: every tool)", () => {
	assert.equal(toolsOf("worker"), undefined);
	assert.equal(toolsOf("adversarial-reviewer"), undefined);
	assert.deepEqual(toolsOf("scout"), ["read", "grep", "find", "ls", "bash", "mcp"]);
	assert.deepEqual(toolsOf("planner"), ["read", "grep", "find", "ls", "bash", "write", "edit", "subagent", "ask_user_question", "show_doc", "mcp"]);
	assert.deepEqual(toolsOf("reviewer"), ["read", "grep", "find", "ls", "bash", "write", "show_doc"]);
	assert.deepEqual(toolsOf("visual-tester"), ["read", "write", "bash", "show_doc", "ask_user_question", "find_roots", "observe_ui", "act_ui", "inspect_ui", "search_ui", "expand_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser"]);
});

test("what the overrides carried stays: the reviewers' Blocking line, the worker's Stay in the turn, the scout's thinking: low", () => {
	for (const role of ["reviewer", "adversarial-reviewer"]) assert.match(text(role), /Blocking: P0=<n> P1=<m>/, role);
	assert.match(text("worker"), /^## Stay in the turn$/m);
	assert.match(text("scout"), /^thinking: low$/m);
});

test("each role names its brief fields and its way to the user (§9)", () => {
	assert.match(text("worker"), /worktree/);
	assert.match(text("worker"), /caller_ping/);
	assert.match(text("scout"), /codebase-memory/);
	assert.match(text("planner"), /plan path/);
	assert.match(text("planner"), /show_doc/);
	assert.match(text("reviewer"), /show_doc/);
	assert.match(text("reviewer"), /anchor result/);
	assert.match(text("visual-tester"), /show_doc/);
	assert.match(text("visual-tester"), /playwriter session new/);
	assert.match(text("visual-tester"), /login route/);
});

// D7: concise role prompts. A sentence said twice in a file says nothing the first did not; each file stays at or under the length it had at the pack's first release (0.79.0).
const PINNED: Record<string, number> = { "adversarial-reviewer": 154, planner: 88, reviewer: 132, scout: 80, "visual-tester": 54, worker: 38 };
test("the D7 role checks: no repeated sentence within a file, and each file at or under its pinned length", () => {
	for (const role of ROLES) {
		const lines = text(role).trimEnd().split("\n").length;
		assert.ok(lines <= PINNED[role]!, `${role} has ${lines} lines, pinned at ${PINNED[role]}`);
		const sentences = text(role).replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20);
		const seen = new Set<string>();
		for (const s of sentences) {
			assert.ok(!seen.has(s), `${role} repeats: ${s}`);
			seen.add(s);
		}
	}
});

test("NOTICE.md carries the HazAT MIT notice verbatim, its lineage, and names the derived role files", () => {
	const notice = readFileSync(join(root, "NOTICE.md"), "utf8");
	const section = notice.slice(notice.indexOf("## Role definitions (`roles/`)"));
	assert.ok(notice.includes("## Role definitions (`roles/`)"));
	assert.ok(section.includes(`MIT License

Copyright (c) 2026 HazAT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`));
	for (const lineage of ["giuseppecrj/pi-herdr-agents", "c2177dff", "HazAT/pi-interactive-subagents", "0xRichardH/pi-herdr-subagents", "Copyright (c) 2026 wayne930242"]) assert.ok(section.includes(lineage), lineage);
	for (const role of ["worker", "scout", "reviewer", "visual-tester", "adversarial-reviewer"]) assert.ok(section.split("\n").some((line) => line.includes("weihung-basic-agent") && line.includes(`\`roles/${role}.md\``)), role);
	assert.match(section, /`roles\/planner\.md`[^\n]*pi-herdr-roles/);
});
