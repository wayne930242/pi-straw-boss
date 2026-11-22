import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, type DeadFacts } from "../src/dead.ts";

// The classifier table of docs/specs/2026-11-23-tower-revive.md §2: one row per state, each with its reason.
const NOW = Date.parse("2026-11-23T01:00:00Z");
const base: DeadFacts = { now: NOW, record: { role: "main" }, mtimeMs: NOW - 5 * 60_000, held: false, listed: false, recovering: false };

test("the classifier: closed, invalid, live, quit, stale, restoring, dead, each with its reason", () => {
	const rows: [string, Partial<DeadFacts>, string, RegExp][] = [
		["no record", { record: undefined }, "closed", /closed on purpose/],
		["a forged record (its file fails the checks)", { invalid: "its session file is outside pi's sessions folder" }, "invalid", /outside pi's sessions folder/],
		["the file is gone", { mtimeMs: undefined }, "invalid", /gone/],
		["a pane runs the file", { held: true }, "live", /pane runs/],
		["the broker lists it", { listed: true }, "live", /broker/],
		["the file moved 30 s ago", { mtimeMs: NOW - 30_000 }, "live", /moved in the last minute/],
		["a /quit mark", { record: { role: "main", ended: { at: NOW - 600_000, reason: "quit" } } }, "quit", /it quit \(quit\)/],
		["a /new mark", { record: { role: "main", ended: { at: NOW - 600_000, reason: "new" } } }, "quit", /it quit \(new\)/],
		["a file older than a day", { mtimeMs: NOW - 25 * 3600_000 }, "stale", /24 h/],
		["Herdr is restoring", { recovering: true }, "restoring", /restoring/],
		["seen once", { seen: { first: NOW, looks: 0 } }, "restoring", /second look/],
		["seen twice, too close together", { seen: { first: NOW - 30_000, looks: 1 } }, "restoring", /second look/],
		["seen twice a minute apart", { seen: { first: NOW - 61_000, looks: 1 } }, "dead", /no shutdown/],
		["an explicit look (no seen)", {}, "dead", /crash, a kill, or its pane or tab closed/],
		["a signal mark", { record: { role: "main", ended: { at: NOW - 600_000, reason: "signal" } } }, "dead", /signal/],
	];
	for (const [what, facts, state, reason] of rows) {
		const got = classify({ ...base, ...facts });
		assert.equal(got.state, state, what);
		assert.match(got.reason, reason, what);
	}
	assert.equal(classify(base).how, "crash");
	assert.equal(classify({ ...base, record: { role: "main", ended: { at: NOW, reason: "signal" } } }).how, "signal");
});

test("live wins over every mark: a session someone resumed is live, whatever its record says", () => {
	assert.equal(classify({ ...base, record: { role: "main", ended: { at: NOW, reason: "quit" } }, held: true }).state, "live");
	assert.equal(classify({ ...base, mtimeMs: NOW - 26 * 3600_000, listed: true }).state, "live");
});
