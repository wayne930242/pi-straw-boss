import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeHerdr } from "./fakes.ts";
import { createDeadWatch } from "../src/server/deadwatch.ts";
import { readLedger, updateLedger } from "../src/revive.ts";
import { recordPath } from "../src/roles.ts";

// The resident tower's sweep (docs/specs/2026-11-23-tower-revive.md §3): a crash (a record with no `ended` mark, the board file left, no pane) becomes one `main_died` notice per death, after two looks a
// minute apart and never inside Herdr's recovery window.

function world() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-deadwatch-")));
	const stateDir = join(root, "state"), sessions = join(root, "agent", "sessions"), checkout = join(root, "alpha");
	mkdirSync(join(stateDir, "roles"), { recursive: true });
	mkdirSync(join(sessions, "--alpha--"), { recursive: true });
	mkdirSync(checkout, { recursive: true });
	const herdr = new FakeHerdr();
	let now = Date.parse("2026-11-23T00:30:00Z"), recovering = false;
	const notices: { workspace: string; text: string; key: string }[] = [], logs: string[] = [];
	const watch = createDeadWatch({
		stateDir, run: herdr.runFor("none"), now: () => now, sessions: async () => [], root: sessions, recovering: () => recovering,
		workspaces: async () => [{ workspace: "wA", checkout }], notice: (workspace, text, key) => (notices.push({ workspace, text, key }), true), log: (event) => void logs.push(event),
	});
	const crash = (id: string, record: Record<string, unknown> = {}) => {
		const file = join(sessions, "--alpha--", `2026-11-23T00-14-00-000Z_${id}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: checkout })}\n${JSON.stringify({ type: "session_info", name: `main ${id.slice(0, 4)}` })}\n`);
		utimesSync(file, (now - 600_000) / 1000, (now - 600_000) / 1000);
		writeFileSync(recordPath(stateDir, file), JSON.stringify({ role: "main", pane: "wA:p40", tab: "wA:t40", workspace: "wA", file, at: now - 600_000, ...record }));
		return file;
	};
	return { herdr, stateDir, watch, notices, logs, crash, step: (ms: number) => void (now += ms), recover: (on: boolean) => void (recovering = on), now: () => now };
}

test("a crash raises one main_died per death, after two looks a minute apart", async () => {
	const w = world();
	const file = w.crash("d1ad0000-0000-4000-8000-000000000001");
	await w.watch.sweep();
	assert.equal(w.notices.length, 0, "the first look only notes it");
	w.step(30_000);
	await w.watch.sweep();
	assert.equal(w.notices.length, 0, "a second look 30 s later is too soon");
	w.step(31_000);
	await w.watch.sweep();
	assert.equal(w.notices.length, 1, "confirmed a minute after the first look");
	assert.equal(w.notices[0]!.workspace, "wA");
	assert.match(w.notices[0]!.text, /^main_died: main "main d1ad" \(session d1ad0000, kind none, tab wA:t40, opened by the boss\): dead: it ended with no shutdown/);
	assert.match(w.notices[0]!.text, /boss_revive_main \{action: "revive", session: "d1ad0000-0000-4000-8000-000000000001", reason\}/);
	assert.match(w.notices[0]!.key, /^main_died:[0-9a-f]{16}$/);
	w.step(60_000);
	await w.watch.sweep();
	assert.equal(w.notices.length, 1, "once per death");
	assert.equal(readLedger(w.stateDir, file).detections.length, 1);
	assert.match(w.watch.rows("wA").map((r) => r.verdict.state).join(), /dead/, "the brief's section lists it");
});

test("nothing is raised inside Herdr's recovery window, and its looks do not count", async () => {
	const w = world();
	w.crash("d1ad0000-0000-4000-8000-000000000002");
	w.recover(true);
	for (let i = 0; i < 3; i++) (await w.watch.sweep(), w.step(61_000));
	assert.equal(w.notices.length, 0);
	w.recover(false);
	await w.watch.sweep();
	assert.equal(w.notices.length, 0, "the first look after the window");
	w.step(61_000);
	await w.watch.sweep();
	assert.equal(w.notices.length, 1);
});

test("a quit, a live pane, a member (no record), and a death within 10 minutes of a revive raise nothing", async () => {
	const w = world();
	w.crash("d1ad0000-0000-4000-8000-000000000003", { ended: { at: w.now() - 500_000, reason: "quit" } });
	const held = w.crash("d1ad0000-0000-4000-8000-000000000004");
	w.herdr.addPane("wA:p50", "wA:t50", "pi").agent_session = { value: held };
	const looping = w.crash("d1ad0000-0000-4000-8000-000000000005");
	// Revived 5 minutes before it last wrote its file: it died again at once.
	updateLedger(w.stateDir, looping, w.now(), (l) => void l.attempts.push({ at: w.now() - 900_000, key: "old", by: "sb-tower-wa", outcome: "revived" }));
	await w.watch.sweep();
	w.step(61_000);
	await w.watch.sweep();
	assert.deepEqual(w.notices, []);
	assert.ok(w.logs.includes("main-died-loop"), "the loop is logged, not raised");
	assert.deepEqual(w.watch.rows("wA").map((r) => r.verdict.state).sort(), ["dead", "quit"], "the brief lists the quit and the looping one; the live one is left out");
});

test("RVR-F003: a session whose revive failed in the last 24 h is listed, not raised, though its death has a new key", async () => {
	const w = world();
	const failed = w.crash("d1ad0000-0000-4000-8000-000000000006");
	updateLedger(w.stateDir, failed, w.now(), (l) => void l.attempts.push({ at: w.now() - 3 * 3600_000, key: "an-older-death", by: "sb-tower-wa", outcome: "failed", error: "did not join" }));
	await w.watch.sweep();
	w.step(61_000);
	await w.watch.sweep();
	assert.deepEqual(w.notices, []);
	assert.ok(w.logs.includes("main-died-failed"), "logged, not raised");
	assert.deepEqual(w.watch.rows("wA").map((r) => r.verdict.state), ["dead"], "the brief still lists it");
	// A day later the boss's retry is a fresh death again.
	w.step(24 * 3600_000);
	const again = w.crash("d1ad0000-0000-4000-8000-000000000006");
	assert.equal(again, failed);
	await w.watch.sweep();
	w.step(61_000);
	await w.watch.sweep();
	assert.equal(w.notices.length, 1);
});

test("RVR-F004: a main that handed over is neither raised nor listed when its tab is closed in Herdr", async () => {
	const w = world();
	w.crash("d1ad0000-0000-4000-8000-000000000007", { handedOver: { at: w.now() - 700_000, to: "next-main-0001" } });
	await w.watch.sweep();
	w.step(61_000);
	await w.watch.sweep();
	assert.deepEqual(w.notices, []);
	assert.deepEqual(w.watch.rows("wA"), []);
});
