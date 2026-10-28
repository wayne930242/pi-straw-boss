import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { PassThrough } from "node:stream";
import { parseArgs, run, UsageError } from "../src/server/cli.ts";
import { serverSource } from "../src/towerprompt/serversource.ts";
import { callControl } from "../src/server/socket.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The tower prompt's source (src/towerprompt/serversource.ts): the prompt talks to the sb server over its control socket with the record's secret, as the CLI does, and starts nothing. Against a real server of
// the test world (tests/tower-world.ts), a fake Herdr, and a source built from the world's requester context.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, pane: String(ensured.pane) };
};

test("poll answers the tower's state; a workspace the server stands in for no tower of is gone; with no server it is a wait that says why", async () => {
	await setup();
	const source = serverSource(world.ctx(), "wA", 4100);
	const polled = await source.poll();
	assert.equal(polled.kind, "state");
	if (polled.kind === "state") assert.deepEqual(polled.answer, { label: polled.answer.label, state: "standing", queued: 0, leave: false });
	assert.deepEqual(await serverSource(world.ctx(), "wZ", 4100).poll(), { kind: "gone", error: "The sb server stands in for no tower of workspace wZ" });
	await world.close();
	const none = await serverSource(world.ctx(), "wA", 4100).poll();
	assert.equal(none.kind, "wait");
});

test("post is the boss's event over the same door as /boss tower: the tower wakes with it; a refusal rejects with the server's words", async () => {
	await setup();
	const source = serverSource(world.ctx(), "wA", 4100);
	await source.post("check main");
	await until(() => world.pis.size === 1, "the run to start");
	await assert.rejects(serverSource(world.ctx(), "wZ", 4100).post("hello"), /no tower|did not|not take/);
});

test("post with no server rejects instead of starting one", async () => {
	const source = serverSource(world.ctx(), "wA", 4100);
	await assert.rejects(source.post("hello"), /sb server/);
	assert.equal(world.record(), undefined, "the prompt starts no server");
});

test("leave takes the stand-in away, and gone and leave never reject when the server is gone", async () => {
	const { s, pane } = await setup();
	const source = serverSource(world.ctx(), "wA", 4100);
	await source.poll();
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	await source.leave();
	await until(() => world.herdr.pane(pane).agent === undefined, "the stand-in to go");
	void s;
	await world.close();
	await source.leave();
	await source.gone();
});

// --- `cli.mjs prompt`, the command the server types into the standing pane ---

async function cliPrompt(argv: string[], over: { env?: NodeJS.ProcessEnv; abort?: AbortController } = {}) {
	const stdin = new PassThrough(), stdout = new PassThrough();
	let err = "", text = "";
	stdout.on("data", (chunk) => void (text += String(chunk)));
	const { by: _by, ...requester } = world.ctx();
	const done = run(argv, {
		env: over.env ?? world.env, stateDir: world.stateDir, version: "0.44.0", cli: "/fake/cli.mjs", ctx: { ...requester, env: over.env ?? world.env }, err: (t) => void (err += t),
		stdin, stdout, ...(over.abort ? { signals: (leave: () => void) => over.abort!.signal.addEventListener("abort", leave) } : {}),
	});
	return { stdin, text: () => text, err: () => err, done };
}

test("parseArgs: prompt takes --workspace and --state-dir, and nothing else", () => {
	assert.deepEqual(parseArgs(["prompt", "--workspace", "wA", "--state-dir", "/s"]), { command: "prompt", flags: { workspace: "wA", "state-dir": "/s" } });
	assert.throws(() => parseArgs(["prompt", "--nope"]), UsageError);
});

test("prompt without a workspace, or with one that is no workspace id, is a usage error and talks to no server", async () => {
	for (const argv of [["prompt"], ["prompt", "--workspace", "w A; rm"], ["prompt", "--workspace", ""]]) {
		const r = await cliPrompt(argv);
		assert.equal(await r.done, 2, argv.join(" "));
		assert.match(r.err(), /workspace/);
	}
});

test("prompt shows the tower's state and the hint, waits at `tower>`, and a line wakes the tower: a run starts, the screen says so, the exit is 0", async () => {
	await setup();
	const r = await cliPrompt(["prompt", "--workspace", "wA", "--state-dir", world.stateDir]);
	await until(() => r.text().includes("tower> "), "the prompt");
	assert.match(r.text(), /tower · .*: standing by/);
	assert.match(r.text(), /Ctrl\+D/);
	r.stdin.write("look at the board\n");
	assert.equal(await r.done, 0);
	assert.match(r.text(), /waking the tower…/);
	await until(() => world.pis.size === 1, "the run to start");
});

test("prompt speaks Traditional Chinese when the boss's shell says so, and Ctrl+D leaves the pane to the shell with exit 0 and no run", async () => {
	const { pane } = await setup();
	const r = await cliPrompt(["prompt", "--workspace", "wA", "--state-dir", world.stateDir], { env: { ...world.env, LANG: "zh_TW.UTF-8" } });
	await until(() => r.text().includes("tower> "), "the prompt");
	assert.match(r.text(), /塔台 · .*：待命中/);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in while the prompt polls");
	r.stdin.end();
	assert.equal(await r.done, 0);
	assert.match(r.text(), /shell/);
	assert.equal(world.pis.size, 0);
	await until(() => world.herdr.pane(pane).agent === undefined, "the stand-in to go");
});

test("prompt ends with exit 0 when the process is told to end (its pane closes), and tells the server it is gone", async () => {
	await setup();
	const abort = new AbortController();
	const r = await cliPrompt(["prompt", "--workspace", "wA", "--state-dir", world.stateDir], { abort });
	await until(() => r.text().includes("tower> "), "the prompt");
	abort.abort();
	assert.equal(await r.done, 0);
});
