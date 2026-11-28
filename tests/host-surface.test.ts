import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHost } from "../src/host/index.ts";
import { DROPPED_PARAMS, droppedParamError } from "../src/host/surface.ts";
import { hostState } from "../src/host/state.ts";
import { fakePi } from "./host-fake.ts";

// The simple surface (surface.ts) over the real Maestro engine: the four kept tools under their names and parameters, `/subagent`, and nothing of
// persistent specialists, interrupts, worktrees, accept checks or the task-model writer. A call that passes a dropped parameter is refused clearly.

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function loaded(scopedModels?: { model: { provider: string; id: string; reasoning: boolean } }[]) {
	const f = fakePi(`${ROOT}src/host/index.ts`);
	Object.assign(f.ctx, { scopedModels });
	createHost({ choice: () => ({ host: "sb", from: "default" }), root: ROOT })(f.pi);
	await f.emit("session_start");
	assert.equal(hostState()?.state, "active", JSON.stringify(hostState()));
	const tool = (name: string) => f.tools.findLast((t) => t.name === name)!.tool!;
	return { ...f, tool };
}

test("the real engine registers subagent, subagent_cancel, subagent_resume and subagents_list, and /subagent, and nothing else of Maestro's", async () => {
	const w = await loaded();
	assert.deepEqual([...new Set(w.tools.map((t) => t.name))].sort(), ["subagent", "subagent_cancel", "subagent_resume", "subagents_list"]);
	assert.deepEqual(w.commands.map((c) => c.name), ["subagent"]);
	const props = Object.keys((w.tool("subagent").parameters as { properties: object }).properties);
	for (const kept of ["name", "task", "agent", "model", "thinking", "cwd", "item", "solutionSpace"]) assert.ok(props.includes(kept), kept);
	for (const dropped of Object.keys(DROPPED_PARAMS.subagent!)) assert.ok(!props.includes(dropped), dropped);
	assert.deepEqual(Object.keys((w.tool("subagent_resume").parameters as { properties: object }).properties).sort(), ["autoExit", "message", "name", "sessionPath"]);
	assert.doesNotMatch(w.tool("subagent").description ?? "", /worktree|Core|persistent/i);
});

test("the registered launch rules point to the authenticated catalog returned by subagents_list", async () => {
	const w = await loaded();
	const guidelines = w.tool("subagent").promptGuidelines!.join("\n");
	assert.doesNotMatch(guidelines, /Authenticated subagent models/);
	assert.match(guidelines, /subagents_list/);
	assert.match(guidelines, /Keep dependent writes sequential/);
	const result = await w.tool("subagents_list").execute("list", {}, undefined, undefined, w.ctx) as { content: { text: string }[]; details: { agents: unknown[] } };
	assert.ok(Array.isArray(result.details.agents));
	assert.match(result.content.map((part) => part.text).join("\n"), /Authenticated subagent models[\s\S]*none discovered/);
});

test("subagents_list returns the session's scoped model catalog, not the previous session's", async () => {
	for (const id of ["first", "second"]) {
		const w = await loaded([{ model: { provider: "test-provider", id, reasoning: false } }]);
		assert.ok(!w.tool("subagent").promptGuidelines!.join("\n").includes(`test-provider/${id}`));
		const result = await w.tool("subagents_list").execute("list", {}, undefined, undefined, w.ctx) as { content: { text: string }[] };
		const text = result.content.map((part) => part.text).join("\n");
		assert.ok(text.includes(`test-provider/${id}`), text);
		assert.ok(!text.includes(`test-provider/${id === "first" ? "second" : "first"}`), text);
	}
});

for (const [param, value, hint] of [["worktree", { branch: "x" }, /git worktree add/], ["persistent", true, /subagent_resume/], ["notify", true, /no notices/], ["accept", { run: "true" }, /verify the result yourself/]] as const) {
	test(`a subagent call with \`${param}\` is refused with what to do instead, before Maestro sees it`, async () => {
		const w = await loaded();
		await assert.rejects(Promise.resolve().then(() => w.tool("subagent").execute("c1", { name: "x", task: "t", [param]: value }, undefined, undefined, w.ctx)), (error: Error) => {
			assert.match(error.message, new RegExp(`simple mode and does not take \`${param}\``));
			assert.match(error.message, hint);
			return true;
		});
	});
}

test("a dropped parameter passed as null or false is no use of it, and a call without one reaches Maestro", async () => {
	assert.equal(droppedParamError("subagent", { name: "x", task: "t", worktree: null, persistent: false, notify: false }), undefined);
	const w = await loaded();
	// Outside Herdr Maestro answers that it needs Herdr: the call got past the simple surface.
	const result = (await w.tool("subagent").execute("c2", { name: "scout-1", task: "look", worktree: null }, undefined, undefined, w.ctx)) as { content: { text: string }[] };
	assert.match(result.content[0]!.text, /herdr|session file/i);
});

test("a role defined as a persistent specialist is refused, and an explicit persistent: false launches it as one task", async () => {
	const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "watcher.md"), "---\nname: watcher\ndescription: watches\npersistent: true\n---\nWatch.\n");
	const w = await loaded();
	await assert.rejects(Promise.resolve().then(() => w.tool("subagent").execute("c3", { name: "w", task: "t", agent: "watcher" }, undefined, undefined, w.ctx)), /role `watcher` is defined as a persistent specialist/);
	const result = (await w.tool("subagent").execute("c4", { name: "w", task: "t", agent: "watcher", persistent: false }, undefined, undefined, w.ctx)) as { content: { text: string }[] };
	assert.match(result.content[0]!.text, /herdr|session file/i, "past the simple surface");
});
