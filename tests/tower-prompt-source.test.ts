import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { PassThrough } from "node:stream";
import { parseArgs, run, UsageError } from "../src/server/cli.ts";
import { serverSource } from "../src/towerprompt/serversource.ts";
import { callControl } from "../src/server/socket.ts";
import { type Entry, iso, updateMemory } from "../src/server/towermemory.ts";
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
	if (polled.kind === "state") assert.deepEqual(polled.answer, { label: polled.answer.label, state: "standing", queued: 0, leave: false, waits: [], auto: false });
	assert.deepEqual(await serverSource(world.ctx(), "wZ", 4100).poll(), { kind: "gone", error: "The sb server stands in for no tower of workspace wZ" });
	await world.close();
	const none = await serverSource(world.ctx(), "wA", 4100).poll();
	assert.equal(none.kind, "wait");
});

test("a poll that says the boss is answering cards holds the tower's wake: the event waits and the answer says so; a poll that says they are done lets the run start", async () => {
	await setup();
	const source = serverSource(world.ctx(), "wA", 4100);
	await source.poll(true);
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "one" } });
	let held: Awaited<ReturnType<typeof source.poll>> | undefined;
	await until(async () => ((held = await source.poll(true)), held.kind === "state" && held.answer.queued === 1), "the event queued");
	assert.equal(held!.kind === "state" && held!.answer.holding, true, "the answer says the wake is held");
	assert.equal(held!.kind === "state" && held!.answer.state, "standing");
	assert.equal(world.pis.size, 0, "no run while the boss answers");
	const done = await source.poll(false);
	assert.equal(done.kind === "state" && done.answer.holding, undefined);
	await until(() => world.pis.size === 1, "the run once the boss is done");
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

async function cliPrompt(argv: string[], over: { env?: NodeJS.ProcessEnv; abort?: AbortController; tty?: boolean } = {}) {
	const stdin = new PassThrough(), stdout = over.tty ? Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 }) : new PassThrough();
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
	assert.match(r.text(), /# tower - .*\no standing by/);
	assert.match(r.text(), /Ctrl\+D/);
	r.stdin.write("look at the board\n");
	assert.equal(await r.done, 0);
	assert.match(r.text(), /waking the tower…/);
	await until(() => world.pis.size === 1, "the run to start");
});

test("prompt draws itself by the environment: on a terminal with the glyphs, colour, and clear; NO_COLOR takes the colour and STRAW_BOSS_ASCII the glyphs; a pipe gets neither", async () => {
	await setup();
	const argv = ["prompt", "--workspace", "wA", "--state-dir", world.stateDir];
	for (const [env, tty, want] of [
		[{}, true, "\u{F043B} ❯ "],
		[{ NO_COLOR: "1" }, true, "\u{F043B} ❯ "],
		[{ STRAW_BOSS_ASCII: "1" }, true, "tower> "],
		[{}, false, "tower> "],
	] as const) {
		const abort = new AbortController();
		const r = await cliPrompt(argv, { env: { ...world.env, ...env }, abort, tty });
		try {
			await until(() => r.text().includes(want), `the prompt of ${JSON.stringify(env)} tty=${tty}`);
			assert.equal(r.text().includes("\x1b[2J"), tty, "the screen is cleared on a terminal only");
			assert.equal(/\x1b\[[0-9;]*m/.test(r.text()), tty && !env.NO_COLOR, "styled on a terminal unless NO_COLOR");
			if (!tty) assert.ok(!r.text().includes("\x1b"), "no escape on a pipe");
		} finally {
			abort.abort();
		}
		assert.equal(await r.done, 0);
	}
});

test("prompt speaks Traditional Chinese when the boss's shell says so, and Ctrl+D leaves the pane to the shell with exit 0 and no run", async () => {
	const { pane } = await setup();
	const r = await cliPrompt(["prompt", "--workspace", "wA", "--state-dir", world.stateDir], { env: { ...world.env, LANG: "zh_TW.UTF-8" } });
	await until(() => r.text().includes("tower> "), "the prompt");
	assert.match(r.text(), /# 塔台 - .*\no 待命中/);
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

// The picker's own asks (docs/specs/2026-11-10-wait-cards-tui.md, §3a): token-less requests with the state folder's secret, as the posts are.
test("the picker's source reads every open card (its own tower first), presses with tower-memory, replies with `answers`, and holds the here mark; with no server each rejects instead of starting one", async () => {
	const { s } = await setup();
	const now = Date.now();
	updateMemory(world.slot, "wA", now, (m) => void m.entries.push({ id: "W1", kind: "wait", text: "Re-authorize", by: "run", via: "run", at: iso(now), run: "r1", for: "boss", state: "open", card: { type: "action", lang: "en", happened: "h", do: "Re-authorize" } } as Entry));
	const source = serverSource(world.ctx(), "wA", 4100, "wA:p1");
	const listed = await source.pick!.waits();
	assert.equal(listed.auto, false);
	assert.deepEqual(listed.towers.map((t) => [t.workspace, t.own === true, t.waits.map((w) => w.id)]), [["wA", true, ["W1"]]]);
	const reply = await source.pick!.reply({ workspace: "wA" }, "do it", "W1");
	assert.equal(reply.answered, "W1");
	await assert.rejects(source.pick!.reply({ workspace: "wZ" }, "x", "W1"), /no tower|not take|workspace/);
	const pressed = await source.pick!.press("wA", { op: "press", id: "W1", act: "done" });
	assert.equal(pressed.status, 200, JSON.stringify(pressed));
	const again = await source.pick!.press("wA", { op: "press", id: "W1", act: "done" });
	assert.equal(again.status, 409, "the server's refusal comes back as the memory route's status");
	assert.match(String(again.body?.reason), /pressed already/);
	assert.equal(await source.pick!.here(async () => "held"), "held");
	await world.close();
	const gone = serverSource(world.ctx(), "wA", 4100);
	await assert.rejects(gone.pick!.waits(), /sb server/);
	await assert.rejects(gone.pick!.press("wA", { op: "press", id: "W1", act: "done" }), /sb server/);
	assert.equal(world.record(), undefined, "the picker starts no server");
	void s;
});
