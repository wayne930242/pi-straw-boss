import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { addIgnored, endOf, holdOf, readHold, readIgnored, writeHold } from "../src/hold.ts";
import type { AllySeen } from "../src/server/capwatch.ts";

// The box's judge of a teammate's hold (src/hold.ts, docs/specs/2026-11-26-device-hold.md, Who may hold), as a table: only an unattended box is held, only by an attended member at `dispatch` whose board is
// at most 30 minutes old and whose hours have not run out, and not one the boss ended here; the hold in force stays, else the first `since` wins, and the rest are contested.

const NOW = Date.parse("2026-11-26T02:00:00Z"), MIN = 60_000, TEAM = "0f".repeat(16);
const MAC = "a".repeat(25) + "a", PC = "b".repeat(25) + "a";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ally = (device: string, claim: Partial<NonNullable<AllySeen["claim"]>> | undefined, team = TEAM): AllySeen => ({
	key: `${team}:${device}`, label: device === MAC ? "mac" : "pc", short: device.slice(0, 6), online: true, boardAgeMs: 0, timed: true, open: false, team, device,
	mains: [{ id: "0123456789abcdef", name: "work-on" }],
	...(claim ? { claim: { by: "0123456789abcdef", since: NOW - 10 * MIN, ts: NOW - MIN, attended: true, level: "dispatch", ...claim } } : {}),
});
const judge = (allies: AllySeen[], o: { unattended?: boolean; ignored?: { device: string; since: number }[]; was?: { device: string; since: number } } = {}) =>
	holdOf(allies, { unattended: o.unattended ?? true, now: NOW, ignored: o.ignored ?? [], ...(o.was ? { was: o.was } : {}) });

test("who may hold: the table", () => {
	const rows: [string, AllySeen[], Parameters<typeof judge>[1], string | undefined][] = [
		["an attended member at dispatch, a fresh board", [ally(MAC, {})], {}, MAC],
		["this device is attended", [ally(MAC, {})], { unattended: false }, undefined],
		["the sender is unattended in the roster", [ally(MAC, { attended: false })], {}, undefined],
		["trust forward", [ally(MAC, { level: "forward" })], {}, undefined],
		["no trust", [ally(MAC, { level: "none" })], {}, undefined],
		["its board is 31 minutes old by its own clock", [ally(MAC, { ts: NOW - 31 * MIN })], {}, undefined],
		["its board is 30 minutes old", [ally(MAC, { ts: NOW - 30 * MIN })], {}, MAC],
		["its hours ran out", [ally(MAC, { until: NOW })], {}, undefined],
		["its hours have not run out", [ally(MAC, { until: NOW + MIN })], {}, MAC],
		["the boss ended it here", [ally(MAC, {})], { ignored: [{ device: MAC, since: NOW - 10 * MIN }] }, undefined],
		["the boss ended an earlier hold of the same device", [ally(MAC, {})], { ignored: [{ device: MAC, since: NOW - 60 * MIN }] }, MAC],
		["no claim", [ally(MAC, undefined)], {}, undefined],
		["two claims: the first since wins", [ally(PC, { since: NOW - 5 * MIN }), ally(MAC, { since: NOW - 9 * MIN })], {}, MAC],
		["two claims: the hold in force stays", [ally(PC, { since: NOW - 5 * MIN }), ally(MAC, { since: NOW - 9 * MIN })], { was: { device: PC, since: NOW - 5 * MIN } }, PC],
	];
	for (const [name, allies, o, want] of rows) assert.equal(judge(allies, o).held?.device, want, name);
	const v = judge([ally(PC, { since: NOW - 5 * MIN }), ally(MAC, { since: NOW - 9 * MIN })]);
	assert.deepEqual(v.contested, [{ label: "pc", short: PC.slice(0, 6) }], "the second holder is contested");
	assert.deepEqual(v.held, { team: TEAM, device: MAC, label: "mac", short: MAC.slice(0, 6), by: "0123456789abcdef", byName: "work-on", since: NOW - 9 * MIN });
	assert.equal(judge([ally(MAC, {}, TEAM), ally(MAC, { ts: NOW - 2 * MIN }, "1f".repeat(16))]).contested.length, 0, "one device in two teams is one claim");
});

test("why a hold ended, and the box's file and ignored marks", () => {
	const was = { device: MAC, since: NOW - 10 * MIN };
	assert.equal(endOf([ally(MAC, undefined)], was, NOW, []), "released");
	assert.equal(endOf([ally(MAC, { since: NOW })], was, NOW, []), "released", "a new hold replaced it");
	assert.equal(endOf([ally(MAC, { ts: NOW - 40 * MIN })], was, NOW, []), "lapsed");
	assert.equal(endOf([ally(MAC, { level: "reply" })], was, NOW, []), "revoked");
	assert.equal(endOf([], was, NOW, []), "revoked", "no longer a teammate");
	assert.equal(endOf([ally(MAC, {})], was, NOW, [was]), "ended here");
	const dir = mkdtempSync(join(tmpdir(), "psb-hold-"));
	dirs.push(dir);
	const held = judge([ally(MAC, {})]).held!;
	writeHold(dir, { v: 1, at: NOW, held });
	assert.deepEqual(readHold(dir, NOW + 5 * MIN), held);
	assert.equal(readHold(dir, NOW + 5 * MIN + 1), undefined, "fresh for 5 minutes");
	assert.deepEqual(readHold(dir, NOW + 60 * MIN, true), held, "any age when asked");
	addIgnored(dir, NOW, was);
	assert.deepEqual(readIgnored(dir, NOW + MIN), [{ ...was, at: NOW }]);
	assert.deepEqual(readIgnored(dir, NOW + 7 * 24 * 60 * MIN), [], "kept 7 days");
});
