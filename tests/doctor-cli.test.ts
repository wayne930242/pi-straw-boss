import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { doctorFor, type FreshLoad, freshLoad, readSession, runDoctor } from "../src/server/doctorcli.ts";
import { parseArgs, UsageError } from "../src/server/cli.ts";

// `cli.mjs doctor --session` (docs/how-it-works.md#the-doctor): another session's doctor from outside it, from a fresh load, its session file, and its pane.

const root = mkdtempSync(join(tmpdir(), "sb-doctor-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));
const HERDR = "git:github.com/wayne930242/pi-herdr-agents@67a0d75b18c86b5ad97cba38ab52c02039ed5359";
const ID = "01a2130c-b6fb-72a9-b04f-bed99d365c74";
const DISPATCH = ["subagent", "subagent_cancel", "subagent_send", "subagent_resume", "subagent_interrupt", "subagents_list"];

function world(name: string, { refusedAt = "2026-11-26T11:17:37.494Z", packages = [HERDR] as unknown[] } = {}) {
	const agentDir = join(root, name), cwd = join(agentDir, "work"), sessions = join(agentDir, "sessions", "--work--");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }));
	const file = join(sessions, `2026-11-25T14-12-10-108Z_${ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: ID, cwd },
		{ type: "message", timestamp: "2026-11-26T10:00:00.000Z", message: { role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5" } },
		{ type: "message", timestamp: refusedAt, message: { role: "toolResult", content: [{ type: "text", text: "<tool_use_error>Error: No such tool available: mcp__custom-tools__subagent</tool_use_error>" }] } },
		{ type: "message", timestamp: refusedAt, message: { role: "toolResult", content: [{ type: "text", text: "No such tool available: frobnicate" }] } },
	];
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const install = join(agentDir, "git", "github.com", "wayne930242", "pi-herdr-agents");
	mkdirSync(join(install, ".git"), { recursive: true });
	writeFileSync(join(install, ".git", "HEAD"), "67a0d75b18c86b5ad97cba38ab52c02039ed5359\n");
	utimesSync(join(install, ".git", "HEAD"), new Date("2026-11-26T06:10:53Z"), new Date("2026-11-26T06:10:53Z"));
	const pane = { pane_id: "wJQ:p28K", tab_id: "wJQ:t1", agent_status: "done", agent_session: { value: file }, tokens: { sb_role: "main" } };
	const run = async (args: string[]) => (args[1] === "list" ? JSON.stringify({ result: { panes: [pane] } }) : JSON.stringify({ result: { process_info: { foreground_process_group_id: 4242 } } }));
	return { agentDir, cwd, file, run, env: { PI_CODING_AGENT_DIR: agentDir } };
}
const healthyLoad = async (): Promise<FreshLoad> => ({ pi: "1.6.1", errors: [], tools: DISPATCH.map((name) => ({ name, exposure: "direct", source: HERDR })) });
const headOf = async () => "67a0d75b18c86b5ad97cba38ab52c02039ed5359";

test("readSession finds the expected tools pi refused, with when, and the model", () => {
	const w = world("read");
	const s = readSession(w.file);
	assert.equal(s.id, ID);
	assert.equal(s.cwd, w.cwd);
	assert.deepEqual(s.refused, [{ tool: "subagent", at: "2026-11-26T11:17:37.494Z" }], "frobnicate is no expected tool");
	assert.equal(s.provider, "claude-bridge");
});

test("a fresh load that has the tool, and a session refused it after its pi started: H1-or-H3, with the start before the install named", async () => {
	const w = world("live");
	for (const query of [ID.slice(0, 13), "wJQ:p28K"]) {
		const r = await doctorFor(query, { env: w.env, run: w.run, load: healthyLoad, headOf, startOf: async () => Date.parse("2026-11-25T14:12:09Z") });
		assert.equal(r.verdict, "H1-or-H3");
		assert.equal(r.role, "main");
		assert.equal(r.session.pane, "wJQ:p28K");
		assert.match(r.finding, /refused subagent \(last 2026-11-26T11:17:37\.494Z\)/);
		assert.match(r.stale!, /started 2026-11-25T14:12:09\.000Z, before pi-herdr-agents 67a0d75 was installed 2026-11-26T06:10:53\.000Z/);
		assert.match(r.next, /fresh session/);
	}
});

test("a refusal before the process started is history, not a fault; a process started after the install is healthy", async () => {
	const w = world("old", { refusedAt: "2026-11-20T00:00:00.000Z" });
	const r = await doctorFor(ID, { env: w.env, run: w.run, load: healthyLoad, headOf, startOf: async () => Date.parse("2026-11-26T07:00:00Z") });
	assert.equal(r.verdict, "healthy");
	assert.deepEqual(r.refused, []);
	const lines: string[] = [];
	assert.equal(await runDoctor({ session: ID, json: true }, { env: w.env, run: w.run, load: healthyLoad, headOf, startOf: async () => Date.parse("2026-11-26T07:00:00Z") }, { out: (t) => lines.push(t), err: (t) => lines.push(t) }), 0);
	assert.equal(JSON.parse(lines[0]!).verdict, "healthy");
});

test("an unknown or ambiguous prefix fails with the reason; doctor needs --session", async () => {
	const w = world("miss");
	const errs: string[] = [];
	assert.equal(await runDoctor({ session: "ffff" }, { env: w.env, run: w.run, load: healthyLoad }, { out: () => {}, err: (t) => errs.push(t) }), 1);
	assert.match(errs[0]!, /no session file .* starting with ffff/);
	assert.throws(() => parseArgs(["doctor"]), UsageError);
	assert.deepEqual(parseArgs(["doctor", "--session", "01a2", "--json"]).flags, { session: "01a2", json: true });
});

test("the fresh load is pi's own loader: a package whose factory throws is named in the errors", async () => {
	const w = world("throws");
	const pkg = join(w.agentDir, "broken-pkg");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "broken-pkg", version: "1.0.0", type: "module", keywords: ["pi-package"], pi: { extensions: ["./index.ts"] } }));
	writeFileSync(join(pkg, "index.ts"), 'export default function () { throw new Error("slot owned by an older build"); }\n');
	writeFileSync(join(w.agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
	const bin = fileURLToPath(new URL("../node_modules/.bin", import.meta.url));
	const fresh = await freshLoad({ ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HERDR_PANE_ID: "w1:p1" })(w.cwd, w.agentDir);
	assert.ok(fresh.errors.some((e) => e.path.includes("broken-pkg") && /slot owned by an older build/.test(e.error)), JSON.stringify(fresh.errors));
	assert.ok(fresh.pi, "pi's version");
});
