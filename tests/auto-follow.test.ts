import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAutoMode } from "../src/server/automode.ts";
import { autoReply } from "../src/server/autoops.ts";
import { createAutoFollower, PRIMARY_UNREACHABLE } from "../src/server/autofollow.ts";
import type { Slot } from "../src/server/record.ts";

// A secondary Herdr slot follows the primary's files and forwards its asks (docs/specs/2026-11-09-auto-mode.md, §10; AMC-F002).

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "sb-follow-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const pi = { via: "pi" as const, name: "test" };
const slot = (): Slot => ({ stateDir: dir, herdr: "x", primary: true, hash: "h", slot8: "h", dir });
const setup = () => {
	const auto = createAutoMode({ dir, now: () => 1_800_000_000_000, log: () => {} });
	auto.start();
	const told: string[] = [], unparked: number[] = [], forwarded: string[] = [];
	const follower = createAutoFollower({ dir, primary: slot(), log: () => {}, returnParked: () => (unparked.push(1), { settled: Promise.resolve([]) }), tellHead: (t) => void told.push(t), call: async (r) => (forwarded.push(r.cmd), autoReply(auto, r) ?? { ok: false, error: "x" }) });
	return { auto, follower, told, unparked, forwarded };
};

test("a secondary server answers a session's auto-check from the primary's files", async () => {
	const { auto, follower } = setup();
	auto.switchOn(pi);
	const v = auto.view();
	const own = await follower.reply({ cmd: "auto-check", rev: v.rev, hash: v.hash });
	assert.deepEqual({ ok: own?.ok, own: own?.own, on: own?.on }, { ok: true, own: true, on: true });
	assert.equal((await follower.reply({ cmd: "auto-check", rev: v.rev, hash: "forged" }))?.own, false);
});

test("every other auto ask is forwarded to the primary: a note lands in its period, an off returns the report", async () => {
	const { auto, follower, forwarded } = setup();
	auto.switchOn(pi);
	follower.note({ session: "s1", tool: "ask_user_question", kind: "cancelled", gist: "db" });
	await new Promise((r) => setImmediate(r));
	assert.equal(auto.period()?.notes.length, 1);
	const off = await follower.reply({ cmd: "auto-off", name: "x" });
	assert.equal(off?.ok, true);
	assert.equal(auto.view().on, false);
	assert.ok(forwarded.includes("auto-note") && forwarded.includes("auto-off"));
	assert.equal(follower.reply({ cmd: "list" }), undefined, "a command that is not auto's is not taken");
});

test("an unreachable primary is said, never answered as ok", async () => {
	const f = createAutoFollower({ dir, primary: { ...slot(), dir: join(dir, "none"), stateDir: join(dir, "none") }, log: () => {} });
	const out = await f.reply({ cmd: "auto-on", said: "x" });
	assert.deepEqual({ ok: out?.ok, error: out?.error }, { ok: false, error: PRIMARY_UNREACHABLE });
});

test("the towers of a secondary slot follow the switch: the brief reads on, the end returns the parked cards and tells the head once", async () => {
	const { auto, follower, told, unparked } = setup();
	const changes: boolean[] = [];
	follower.onSwitch((c) => void changes.push(c.to.on));
	assert.equal(follower.view().on, false);
	auto.switchOn(pi);
	follower.tick();
	assert.equal(follower.view().on, true);
	assert.deepEqual(changes, [true]);
	assert.equal(follower.view().since, auto.view().since);
	follower.tick();
	assert.deepEqual(changes, [true], "one change per rev");
	auto.switchOff(pi);
	follower.tick();
	assert.deepEqual(changes, [true, false]);
	assert.equal(unparked.length, 1);
	assert.equal(told.length, 1);
	assert.match(told[0]!, /^Auto mode ended at /);
});

test("a foreign write is not the primary's: the follower keeps what it had", () => {
	const { auto, follower } = setup();
	auto.switchOn(pi);
	follower.tick();
	writeFileSync(join(dir, "auto.json"), "{not json");
	follower.tick();
	assert.equal(follower.view().on, true);
});
