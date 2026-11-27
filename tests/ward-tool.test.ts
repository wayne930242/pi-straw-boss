import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CONTROL } from "../src/closemain.ts";
import { WARD_ENTRY } from "../src/wardtool.ts";
import { World } from "./fakes.ts";

// The session's side of the ward (docs/how-it-works.md#ward-a-plain-pane): sb_ward is registered at the join, active for a main only, refused for anyone else; it registers the control channel the wake comes on (as boss_watch does),
// asks the server for a watch on `ward:<pane>` with the registration secret of its pi process (ward-review F003, boss decision (a)), and records the ward in the main's session.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");

test("sb_ward: active for a main only; it listens, asks the server for the ward, and records it in the main's session", async () => {
	const asked: Record<string, unknown>[] = [];
	let restarted = false;
	world.ask = async (request) => {
		asked.push(request);
		if (request.cmd === "cars-register") return { ok: true, secret: `sec-${String(request.session)}-${asked.filter((r) => r.cmd === "cars-register").length}` };
		// A server that started again knows only the secret handed after it (the second registration).
		if (request.cmd !== "watch-list" && request.secret !== undefined && restarted && request.secret !== "sec-main-1-2") return { ok: false, error: "sb: this request is not from a registered session: a ward is set, listed, and stopped from the main's own pi session with the sb_ward tool" };
		if (request.cmd === "watch-list") return { ok: true, watches: [] };
		if (request.cmd === "ward-add") return { ok: true, watch: { key: request.key, until: 0, line: "ward %7: unchanged: it works." }, ward: { pane: "%7", file: "/s/w.jsonl", item: "MP-1" } };
		if (request.cmd === "watch-stop") return { ok: true };
		return { ok: false, error: "no server" };
	};
	world.tower("tower-wA", "wA:t7", "wA:p7");
	const m = world.agent({ id: "main-1", name: "box main", pane: "wA:p1", tab: "wA:t1" });
	const member = world.agent({ id: "mem-1", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all(world.agents.map((a) => a.start()));
	await m.promote();
	await world.quiet();
	await m.run();
	await member.run();
	assert.ok(m.active?.includes("sb_ward"), "active for the main");
	assert.ok(!(member.active ?? []).includes("sb_ward"), "not for a member");
	await assert.rejects(member.tool("sb_ward", { pane: "%7" }), /Only a tab's main/);
	await assert.rejects(m.tool("sb_ward", { pane: "%7" }), /tower runs are off/);
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true } }));
	await assert.rejects(m.tool("sb_ward", { pane: "%7", until: "30s" }), /until is 1m to 48h/);
	const done = await m.tool("sb_ward", { pane: "%7", item: "MP-1", until: "2h" });
	assert.match(textOf(done), /Warding %7 \(session \/s\/w\.jsonl\)/);
	const add = asked.find((r) => r.cmd === "ward-add")!;
	assert.deepEqual([add.session, add.workspace, add.key, add.untilMs, add.ward, add.secret], ["main-1", undefined, "ward:%7", 7_200_000, { item: "MP-1" }, "sec-main-1-1"], "the server takes the workspace and the main's pane from its own reading; the secret proves the process");
	assert.deepEqual(asked.filter((r) => r.cmd === "cars-register").map((r) => [r.session, r.pid, r.pane]), [["main-1", process.pid, "wA:p1"]]);
	assert.ok(m.regs.get(CONTROL), "listens for the wake");
	assert.deepEqual(m.entries.filter((e) => e.customType === WARD_ENTRY).map((e) => e.data), [{ ward: "%7", sessionFile: "/s/w.jsonl", item: "MP-1" }]);
	await m.tool("sb_ward", { pane: "%7", stop: true });
	assert.deepEqual(asked.at(-1), { cmd: "watch-stop", session: "main-1", key: "ward:%7", secret: "sec-main-1-1" });
	await m.tool("boss_watch", { key: "ward:%7", stop: true });
	assert.deepEqual(asked.at(-1), { cmd: "watch-stop", session: "main-1", key: "ward:%7", secret: "sec-main-1-1" }, "boss_watch's stop of a ward carries the secret too");
	restarted = true; // the server forgot the secret: the tool registers again, once, and asks again
	await m.tool("sb_ward", { pane: "%7", stop: true });
	assert.deepEqual(asked.slice(-3).map((r) => [r.cmd, r.secret]), [["watch-stop", "sec-main-1-1"], ["cars-register", undefined], ["watch-stop", "sec-main-1-2"]]);
});
