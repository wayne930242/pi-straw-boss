import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MONITORS, MONITOR_TEXT, monitorsOk, trackMonitors } from "../src/monitors.ts";

function bus() {
	const hs = new Map<string, Set<(d: unknown) => void>>();
	return {
		emit: (c: string, d: unknown) => hs.get(c)?.forEach((h) => h(d)),
		on: (c: string, h: (d: unknown) => void) => (hs.set(c, (hs.get(c) ?? new Set()).add(h)), () => void hs.get(c)!.delete(h)),
		count: () => [...hs.values()].reduce((n, s) => n + s.size, 0),
	};
}

test("monitors: pi-loop-monitor's events become each monitor's state, its last line, and how it ended", () => {
	let now = 1_000, changes = 0;
	const b = bus(), t = trackMonitors(b, () => changes++, { now: () => now, throttleMs: 0 });
	b.emit("monitor:started", { monitorId: "1", command: "npm test", description: "unit tests", timestamp: now });
	b.emit("monitor:started", { monitorId: "2", command: "vite --port 5199" });
	b.emit("monitor:output", { monitorId: "1", line: "\u001b[32mok\u001b[0m 41 passed", outputLines: 12 });
	assert.deepEqual(t.list().map(({ id, what, status, last, lines }) => ({ id, what, status, last, lines })), [
		{ id: "2", what: "vite --port 5199", status: "running", last: undefined, lines: 0 },
		{ id: "1", what: "unit tests", status: "running", last: "ok 41 passed", lines: 12 },
	], "newest first; a description over the command; terminal escapes gone");
	now = 2_000;
	b.emit("monitor:finished", { monitorId: "1", status: "error", exitCode: 1, outputLines: 13 });
	b.emit("monitor:finished", { monitorId: "2", status: "stopped", reason: "timeout", outputLines: 0 });
	const [two, one] = t.list();
	assert.deepEqual([one!.status, one!.exit, one!.ended, two!.status], ["error", 1, 2_000, "stale"], "a stop for inactivity reads stale");
	b.emit("monitor:started", { monitorId: "3", command: "sleep 9" });
	b.emit("monitor:finished", { monitorId: "3", status: "stopped", reason: "manual" });
	b.emit("monitor:started", { monitorId: "4", command: "true" });
	b.emit("monitor:finished", { monitorId: "4", status: "completed", exitCode: 0 });
	assert.deepEqual(t.list().map((m) => m.status), ["done", "stopped", "stale", "error"]);
	assert.ok(changes >= 8);
	t.off();
	assert.equal(b.count(), 0, "off unsubscribes");
});

test("monitors: running ones first, ended ones kept 15 minutes, at most six, text cut, junk ignored", () => {
	let now = 0;
	const b = bus(), t = trackMonitors(b, () => {}, { now: () => now, throttleMs: 0 });
	b.emit("monitor:started", { monitorId: "old", command: "x" });
	b.emit("monitor:finished", { monitorId: "old", status: "completed", exitCode: 0 });
	for (let i = 0; i < 7; i++) b.emit("monitor:started", { monitorId: `r${i}`, command: `${"c".repeat(400)}${i}` });
	b.emit("monitor:started", { monitorId: 5 });
	b.emit("monitor:output", { monitorId: "nobody", line: "x" });
	const list = t.list();
	assert.equal(list.length, MAX_MONITORS);
	assert.ok(list.every((m) => m.status === "running" && m.what.length <= MONITOR_TEXT && m.what.endsWith("…")));
	assert.ok(monitorsOk(list));
	now = 15 * 60_000 + 1;
	for (let i = 0; i < 7; i++) b.emit("monitor:finished", { monitorId: `r${i}`, status: "completed", exitCode: 0 });
	assert.ok(!t.list().some((m) => m.id === "old"), "an ended monitor goes after 15 minutes, as pi-loop-monitor prunes it");
	t.clear();
	assert.deepEqual(t.list(), []);
});

test("monitors: the hub takes only well-formed lists", () => {
	const ok = { id: "1", what: "npm test", status: "running", lines: 0, at: 1 };
	assert.ok(monitorsOk([ok, { ...ok, id: "2", status: "error", exit: 1, last: "boom", ended: 2 }]));
	for (const bad of [[{ ...ok, status: "weird" }], [{ ...ok, what: "x".repeat(MONITOR_TEXT + 1) }], [{ ...ok, last: "a\u0007b" }], Array(MAX_MONITORS + 1).fill(ok), [{ ...ok, lines: -1 }], "x", [null]])
		assert.equal(monitorsOk(bad), false, JSON.stringify(bad).slice(0, 50));
});
