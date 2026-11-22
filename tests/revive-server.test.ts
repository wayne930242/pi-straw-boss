import assert from "node:assert/strict";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import type { Towers } from "../src/server/towers.ts";
import { readLedger } from "../src/revive.ts";
import { recordPath } from "../src/roles.ts";

// boss_revive_main in the sb server's tower runs (docs/specs/2026-11-23-tower-revive.md §4): a local run lists and revives the dead mains of its workspace as the tower identity; an ally run is refused by its kind;
// a tower_reply to a dead main is kept for its revive handoff.

let world: TowerWorld;
let towers: Towers | undefined;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	towers = undefined;
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string; text?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const started = async () => {
	const s = await world.start({ towers: { ...world.options().options.towers, expose: (t: Towers) => (towers = t) } });
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
const localToken = async (s: Running) => {
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "m0", content: { text: "go" } });
	await until(() => world.pis.size === 1, "the run");
	const [id, pi] = [...world.pis.entries()][0]!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	return String(got!.token);
};
const tool = (s: Running, token: unknown, name: string, args: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: name, args });
const DEAD = "d1ad0000-0000-4000-8000-0000000000aa";
const crash = () => {
	const checkout = realpathSync(world.root);
	world.herdr.workspaces[0]!.worktree = { checkout_path: checkout };
	const dir = join(world.env.PI_CODING_AGENT_DIR!, "sessions", "--alpha--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-11-23T00-14-00-000Z_${DEAD}.jsonl`), at = Date.now() - 600_000;
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: DEAD, cwd: checkout })}\n${JSON.stringify({ type: "session_info", name: "dnd main" })}\n`);
	utimesSync(file, at / 1000, at / 1000);
	mkdirSync(join(world.stateDir, "roles"), { recursive: true });
	writeFileSync(recordPath(world.stateDir, file), JSON.stringify({ role: "main", pane: "wA:p40", tab: "wA:t40", workspace: "wA", file, at }));
	return file;
};

test("a local run lists the dead main, revives it as the tower identity, and the revived pi gets the handoff", async () => {
	const file = crash();
	const s = await started();
	const token = await localToken(s);
	// Right after the server starts, Herdr's recovery window is open: the main is `restoring` until it closes.
	let listed: Reply | undefined;
	await until(async () => /: dead/.test(String((listed = await tool(s, token, "boss_revive_main", { action: "list" })).text)), "the recovery window to close");
	assert.equal(listed!.ok, true, JSON.stringify(listed));
	assert.match(String(listed!.text), /main "dnd main" \(session d1ad0000, kind none, tab wA:t40, opened by the boss\): dead/);
	// Herdr starts the pi in the new pane: it joins as the main of its tab under the dead id.
	const inner = world.herdr.onAgentStart;
	world.herdr.onAgentStart = (pane, args) => {
		inner?.(pane, args);
		if (!args.includes("--session")) return;
		pane.agent_session = { value: file };
		pane.tokens.sb_role = "main";
		world.sessions = [...world.sessions, { id: DEAD, name: "dnd main", herdrLocation: { status: "current", workspace: { id: "wA", label: "Alpha" }, tab: { id: pane.tab_id, label: "dnd main" }, paneId: pane.pane_id } }];
	};
	// The broker listed nobody under the dead id until the start: the revive's second look sees it dead still.
	const done = await tool(s, token, "boss_revive_main", { action: "revive", session: "dnd main", reason: "its work is not done" });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.match(String(done.text), /Revived main dnd main \(session d1ad0000-0000-4000-8000-0000000000aa\) in tab .* as the same session/);
	const start = world.herdr.commands("agent", "start").find((c) => c.includes("--session"))!;
	assert.deepEqual(start.slice(-2), ["--session", file]);
	const handoff = world.client("sb-tower-wa")!.sent.find((m) => m.to === DEAD);
	assert.match(String(handoff?.text), /Tower tower · Alpha \(session sb-tower-wa\) revived it in tab/);
	assert.equal(readLedger(world.stateDir, file).attempts.at(-1)?.by, "sb-tower-wa");
});

test("an ally run is refused boss_revive_main by its kind, and a tower_reply to a dead main is kept for its revive", async () => {
	const file = crash();
	const s = await started();
	const ally = towers!.runs.mint("wA", { kind: "ally", device: "d1", level: "dispatch", team: "team-1" });
	assert.match(String((await tool(s, ally, "boss_revive_main", { action: "list" })).error), /not available in an ally run/);
	const token = await localToken(s);
	let kept: Reply | undefined;
	await until(async () => /is dead/.test(String((kept = await tool(s, token, "tower_reply", { to: "dnd main", message: "the boss said: ship it" })).error)), "the recovery window to close");
	assert.equal(kept!.ok, false);
	assert.match(String(kept!.error), /Not delivered: dnd main \(session d1ad0000\) is dead: .* The message is kept, and its revive handoff carries it; revive it with boss_revive_main/);
	assert.ok(readLedger(world.stateDir, file).missed.every((m) => m.text === "the boss said: ship it"));
});
