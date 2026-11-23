import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Session } from "../src/herdr.ts";
import { callControl } from "../src/server/socket.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// `boss_watch` end to end in the sb server (docs/specs/2026-11-23-lite-b2-d-e-f.md §3.3): `watch-add` starts a watch over the server's own readings, and its line goes out from the workspace's tower identity on the
// `straw-boss/control` channel (towers.ts `watchSend`, closemain.ts `notify`), whose answer from the main is taken.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const mainIn = (tab: string, pane: string, id: string): Session => {
	world.herdr.addTab(tab, id, pane, "pi");
	Object.assign(world.herdr.pane(pane), { agent_status: "working" });
	Object.assign(world.herdr.pane(pane).tokens, { sb_role: "main" });
	return { id, name: id, herdrLocation: { status: "current", paneId: pane, tab: { id: tab, label: id }, workspace: { id: "wA", label: "Alpha" } } as never };
};

test("a watch runs in the server: when the watched main leaves, the tower identity sends `gone` to the main that asked, which takes it, and the watch ends", async () => {
	const s = await world.start({ watches: { readMs: 50, holdMs: 300 } });
	await s.handle.ready;
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).ok, true);
	const one = mainIn("wA:t8", "wA:p8", "main-1"), two = mainIn("wA:t9", "wA:p9", "main-2");
	world.sessions = [one, two];
	const added = await ask(s, { cmd: "watch-add", session: "main-1", workspace: "wA", key: "main-2" });
	assert.equal(added.ok, true, JSON.stringify(added));
	assert.match(String((added.watch as { line: string }).line), /^watch main-2: /);
	assert.deepEqual(((await ask(s, { cmd: "watch-list", session: "main-1" })).watches as { key: string }[]).map((w) => w.key), ["main-2"]);
	world.sessions = [one];
	const tower = world.client("sb-tower-wa")!;
	const isWatch = (f: Record<string, unknown>) => f.namespace === "straw-boss/control" && (f.payload as { type?: string }).type === "watch";
	await until(() => tower.frames.some(isWatch), "the line");
	const frame = tower.frames.find(isWatch)!.payload as { to: string; reqId: string; key: string; state: string; text: string };
	assert.deepEqual([frame.to, frame.key, frame.state], ["main-1", "main-2", "gone"]);
	assert.match(frame.text, /^watch main-2: gone/);
	tower.broker({ type: "extension_message", namespace: "straw-boss/control", fromSessionId: "main-1", payload: { version: 1, type: "watch-result", to: "sb-tower-wa", reqId: frame.reqId, accepted: true } });
	await until(async () => ((await ask(s, { cmd: "watch-list", session: "main-1" })).watches as unknown[]).length === 0, "the watch ended");
});
