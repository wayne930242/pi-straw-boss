import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { listRuns, readRun } from "../src/server/towerrunstore.ts";
import { type PiPath, resolvePi } from "../src/server/runchild.ts";
import { towerId } from "../src/server/record.ts";

// One headless tower run with a real pi (REV-F001): the server spawns `pi --mode rpc` from the PATH, which loads this checkout's extension from the run's agent folder. The run relays pi's project-trust question as a
// dialog, claims with its PID and nonce, takes its event, and its model (a fake OpenAI-compatible endpoint in this process) calls tower_done. Every other test of headless runs uses a FakeKid, which never loads
// src/index.ts: a branch there that returns before the run's module (as 0.85.0's first build did without HERDR_PANE_ID) failed every real run and none of them. The world is a secondary Herdr slot, so a run that
// lost the server's Herdr socket would look for its server in the wrong folder.

const checkout = fileURLToPath(new URL("..", import.meta.url));
let pi: PiPath | undefined, why = "";
try { pi = resolvePi(process.env, undefined); } catch (cause) { why = (cause as Error).message; }

let world: TowerWorld | undefined, model: Server | undefined;
afterEach(async () => {
	for (const kid of world?.realKids ?? []) if (kid.exitCode === null && kid.signalCode === null) try { process.kill(-kid.pid!, "SIGKILL"); } catch { kid.kill("SIGKILL"); }
	await world?.close();
	await new Promise((r) => (model ? model.close(r) : r(undefined)));
	world = model = undefined;
});

/** What the runs wrote to stderr, for a failure's message. */
const stderrOf = (w: TowerWorld) => {
	const dir = join(w.slot.dir, "tower", "wA", "runs");
	try { return readdirSync(dir).filter((n) => n.endsWith(".stderr")).map((n) => readFileSync(join(dir, n), "utf8")).join("\n").slice(-3000); } catch { return "(no stderr)"; }
};
/** A model endpoint that calls tower_done at the first turn and says "done" after the tool's result; it keeps the bodies it was sent. */
function fakeModel(note: string, bodies: string[]): Promise<number> {
	const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const read = (req: IncomingMessage) => new Promise<string>((res) => { let body = ""; req.setEncoding("utf8"); req.on("data", (c: string) => (body += c)); req.on("end", () => res(body)); });
	model = createServer((req, res) => void read(req).then((body) => {
		bodies.push(body);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const answered = /"role":"tool"/.test(body);
		res.write(answered ? chunk({ role: "assistant", content: "done" }, null) : chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "tower_done", arguments: JSON.stringify({ note }) } }] }, null));
		res.write(chunk({}, answered ? "stop" : "tool_calls"));
		res.end("data: [DONE]\n\n");
	}));
	return new Promise((res) => model!.listen(0, "127.0.0.1", () => res((model!.address() as { port: number }).port)));
}

test("a real pi run: the server spawns pi --mode rpc, its project-trust question is a dialog, it claims with its PID and nonce, takes its event, and calls tower_done", { skip: pi ? false : `pi is not on the PATH (${why})`, timeout: 120_000 }, async () => {
	const bodies: string[] = [], port = await fakeModel("handled the real event", bodies);
	world = new TowerWorld();
	const w = world;
	w.realPi = pi;
	w.env.PATH = process.env.PATH;
	w.env.SB_TEST_ROOT = process.env.SB_TEST_ROOT;
	w.env.HERDR_SOCKET_PATH = join(w.root, "second-herdr.sock"); // a secondary slot: its folder is servers/<hash>
	w.runTimers = { claim: 60_000, lost: 60_000, idleEnd: 600_000 };
	mkdirSync(w.stateDir, { recursive: true });
	writeFileSync(join(w.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true, headless: true }, towerModel: "sbfake/fake-1" }));
	const agent = w.env.PI_CODING_AGENT_DIR!;
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: [join(checkout, "src", "index.ts"), "-builtin:mcp", "-builtin:llama.cpp", "-builtin:codemode", "-builtin:tool-search"], quietStartup: true }));
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { sbfake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "sbfake", models: [{ id: "fake-1", contextWindow: 200_000, maxTokens: 4096 }] } } }));
	// The workspace's checkout has project settings, so pi asks whether to trust it before it loads them.
	const project = join(w.root, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "settings.json"), "{}");
	w.herdr.workspaces[0]!.worktree = { checkout_path: project };
	assert.equal(w.slot.primary, false);

	const s: Running = await w.start({ pid: process.pid });
	await s.handle.ready;
	const ask = (cmd: Record<string, unknown>) => callControl(s.handle.endpoint, w.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Record<string, unknown> & { ok: boolean });
	assert.equal((await ask({ cmd: "ensure-tower", workspace: "wA", view: false })).ok, true);
	const id = towerId(w.slot, "wA");
	await until(() => w.client(id), "the tower identity to register");
	w.client(id)!.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "please look at the real thing" } });

	const kids = () => w.expose!.runs.kids()!;
	await until(() => w.realKids.length > 0, "the run's pi to spawn", 10_000);
	const child = w.realKids[0]!;
	await until(() => kids().dialogs().length > 0 || child.exitCode !== null, "pi's project-trust question as a dialog", 60_000);
	const trust = kids().dialogs()[0];
	assert.ok(trust, `the run asked nothing and exited ${child.exitCode}: ${stderrOf(w)} ${kids().ring("wA").since().lines.join("\n")}`);
	assert.equal(trust.method, "confirm");
	assert.match(trust.title, /trust/i);
	assert.equal((await ask({ cmd: "run-dialog", key: trust.key, confirmed: true })).ok, true);

	await until(() => child.exitCode !== null, "the run to end with tower_done", 90_000);
	const recs = listRuns(w.slot, "wA");
	assert.equal(recs.length, 1, JSON.stringify(recs));
	await until(() => readRun(w.slot, "wA", recs[0]!.id)?.outcome, "the run's outcome");
	const rec = readRun(w.slot, "wA", recs[0]!.id)!;
	assert.equal(rec.headless, true);
	assert.equal(rec.pid, child.pid, "claimed by the PID the server spawned");
	assert.equal(rec.outcome, "done", `${rec.outcome}: ${stderrOf(w)}`);
	assert.equal(child.exitCode, 0);
	assert.ok(bodies.some((b) => b.includes("please look at the real thing")), "the event reached the model");
	assert.ok(bodies.some((b) => /"role":"tool"/.test(b)), "tower_done ran and its result went back to the model");
});
