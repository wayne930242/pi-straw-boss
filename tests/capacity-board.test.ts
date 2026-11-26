import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { writeEntry } from "../src/board.ts";
import { boardCommand } from "../src/boardcmd.ts";
import { readBoard } from "../src/boardread.ts";
import { boardSeam } from "../src/boardview.ts";
import { capDir, type DeviceCap, writeDevice } from "../src/capacity.ts";
import type { Pane, Session } from "../src/herdr.ts";
import { sessionGlobals } from "./fake-dom.ts";

// The device capacity row where the board is read (docs/specs/2026-11-24-capacity.md): `board_read`'s rows and section `capacity`, `/boss board`'s line, and the head page's fold and rows.

sessionGlobals();
const { capText, rowCapText } = await import("../gui/board.ts");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** A board folder of its own: the capacity folder sits beside it. */
const dir = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-capboard-"))), join(dirs.at(-1)!, "board"));
const MIN = 60_000, NOW = Date.parse("2026-11-24T10:00:00Z");
const session = (id: string, name: string, p: string, status = "idle"): Session => ({ id, name, status, herdrLocation: { status: "current", paneId: p, workspace: { id: "wA", label: "Alpha" }, tab: { id: `t-${id}`, label: `${name}-tab` } } } as Session);
const pane = (id: string): Pane => ({ pane_id: id, tab_id: "t", workspace_id: "wA", cwd: "/proj", tokens: { sb_role: "main" } });
const net = { sessions: [session("m1", "billing", "wA:p1", "working"), session("m2", "reports", "wA:p2")], ps: [pane("wA:p1"), pane("wA:p2")] };
const device = (over: Partial<DeviceCap> = {}): DeviceCap => ({
	v: 1, at: NOW - MIN, points: 3, budget: 10, load1: 0.5, cores: 8, ready: 2, minReady: 1, open: 5, unattended: true, under: NOW - 15 * MIN,
	mains: [
		{ session: "m1", name: "billing", workspace: "wA", points: 3, ready: 2, minReady: 1, open: 4, stale: true },
		{ session: "m2", name: "reports", workspace: "wA", points: 0, ready: 0, open: 1, paused: { until: NOW + 90 * MIN } },
	],
	...over,
});

test("board_read: each main's row carries its points, ready todos and pause, the server's stale mark replaces the board's own, and section capacity has the numbers", async () => {
	const d = dir();
	writeEntry(d, "m1", { now: "api", items: [] }, NOW - 5 * MIN);
	writeEntry(d, "m2", { now: "old", items: [] }, NOW - 5 * 60 * MIN); // idle 5 h: the board's own rule says stale, the server says paused
	writeDevice(capDir(d), device());
	const out = await readBoard({ dir: d, now: NOW, net, link: { boards: async () => [], remoteScope: () => undefined }, scope: "local" }) as { local: Record<string, unknown>[]; capacity: Record<string, unknown> };
	assert.deepEqual(out.local.map((r) => [r.main, r.points, r.ready, r.paused, r.stale]), [["billing", 3, 2, undefined, true], ["reports", 0, 0, (out.local[1]!.paused as string), undefined]]);
	assert.match(out.local[1]!.paused as string, /^quota · resumes (\d+\/\d+ )?\d\d:\d\d$/);
	assert.deepEqual(out.capacity, { points: 3, budget: 10, load1: 0.5, cores: 8, ready: 2, minReady: 1, open: 5, unattended: true, underMinutes: 15, paused: [{ main: "reports", until: new Date(NOW + 90 * MIN).toISOString() }], secondsAgo: 60 });
	const remote = await readBoard({ dir: d, now: NOW, net, link: { boards: async () => [], remoteScope: () => ({ teams: ["t"], project: "/elsewhere" }) }, scope: "local" }) as { local: unknown[]; capacity: { paused: unknown[] } };
	assert.deepEqual([remote.local.length, remote.capacity.paused], [0, []], "a remote turn names no paused main it cannot see");
	writeDevice(capDir(d), device({ at: NOW - 6 * MIN }));
	const stale = await readBoard({ dir: d, now: NOW, net, link: { boards: async () => [], remoteScope: () => undefined }, scope: "local" }) as { local: Record<string, unknown>[]; capacity?: unknown };
	assert.equal(stale.capacity, undefined, "a row over 5 minutes old is no reading");
	assert.deepEqual(stale.local.map((r) => r.stale), [undefined, true], "without a reading the board's own rule stands");
});

test("the supply tray's unit names reach the head page's rows only: board_read's rows and section capacity carry none", async () => {
	const d = dir(), units = [{ name: "api-build", points: 2 }, { name: "web-test", points: 1 }];
	writeEntry(d, "m1", { now: "api", items: [] }, NOW - 5 * MIN);
	writeDevice(capDir(d), device({ mains: [{ session: "m1", name: "billing", workspace: "wA", points: 3, ready: 2, open: 4, workers: ["api-build", "web-test"], units }] }));
	const rows = boardSeam({ dir: d, now: () => NOW }).rows({ bases: [{ id: "wA", label: "Alpha", mark: "idle", tower: null, tabs: [{ id: "t", label: "billing-tab", units: [{ id: "m1", key: "m1", control: true, name: "billing", role: "main", mark: "working", subs: [] }] }], outposts: [], outside: [] }] } as never)!;
	assert.deepEqual(rows.find((r) => r.session === "m1")?.units, units);
	const out = await readBoard({ dir: d, now: NOW, net, link: { boards: async () => [], remoteScope: () => undefined }, scope: "local" });
	for (const word of ["api-build", "web-test", "units", "workers"]) assert.ok(!JSON.stringify(out).includes(word), `board_read carries no ${word}`);
});

test("/boss board prints the device line under its head and the numbers on each row", () => {
	const d = dir();
	writeEntry(d, "m1", { now: "api", items: [] }, NOW - 5 * MIN);
	writeDevice(capDir(d), device());
	const text = boardCommand({ dir: d, now: NOW, net });
	assert.match(text, /^capacity 3 \/ 10 pts · load 0\.5 \/ 8 cores · ready 2 · under 15 min · 1 paused$/m);
	assert.match(text, /^Alpha › billing-tab · billing · working · api · 5 min ago · 3 pts · 2 ready · stale$/m);
	assert.match(text, /^Alpha › reports-tab · reports · idle · no line · 0 pts · quota · resumes (\d+\/\d+ )?\d\d:\d\d$/m);
});

test("the head page: the fold carries the device's numbers, each row its own, in both languages", () => {
	const d = dir();
	writeDevice(capDir(d), device());
	const seam = boardSeam({ dir: d, now: () => NOW }), cap = seam.capacity()!;
	assert.deepEqual(cap, { points: 3, budget: 10, load1: 0.5, cores: 8, ready: 2, underMinutes: 15, paused: 1 });
	assert.equal(capText(cap), "3 / 10 pts · load 0.5 / 8 cores · 2 ready · capacity idle 15 min · 1 paused");
	assert.equal(capText({ ...cap, budget: undefined, underMinutes: undefined, paused: 0 }, { locale: "zh-TW" }), "3 點 · 負載 0.5 / 8 核 · 可接 2");
	const base = { session: "m2", workspace: "Alpha", tab: "t", main: "reports", state: "idle", items: [] };
	assert.equal(rowCapText({ ...base, points: 2, ready: 1 }), "2 pts · 1 ready");
	assert.match(rowCapText({ ...base, points: 0, paused: "quota", pausedUntil: NOW + 90 * MIN }, { locale: "zh-TW" }), /^0 點 · 額度停機 · 預計 \d\d:\d\d 恢復$/);
	assert.equal(rowCapText(base), "");
});

test("device holds in the views (docs/specs/2026-11-26-device-hold.md): board_read's held and holds sections, /boss board's lines, and the head page's fold in both languages", async () => {
	const { writeHold } = await import("../src/hold.ts");
	const d = dir(), mac = "a".repeat(26), box = "c".repeat(25) + "a";
	writeEntry(d, "m1", { now: "api", items: [] }, NOW - 5 * MIN);
	writeDevice(capDir(d), device());
	writeHold(capDir(d), { v: 1, at: NOW - MIN, held: { team: "0f".repeat(16), device: mac, label: "mac", short: "aaaaaa", by: "0123456789abcdef", byName: "work-on", since: NOW - 12 * MIN }, holds: [{ device: box, label: "box 2", short: "cccccc", main: "billing", since: NOW - 3 * MIN, honoured: true, boxBoardSecondsAgo: 40 }] });
	const out = await readBoard({ dir: d, now: NOW, net, link: { boards: async () => [], remoteScope: () => undefined }, scope: "local" }) as Record<string, unknown>;
	assert.deepEqual(out.held, { device: mac, label: "mac", short: "aaaaaa", main: "work-on", sinceSecondsAgo: 720 });
	assert.deepEqual(out.holds, [{ device: box, label: "box 2", short: "cccccc", main: "billing", honoured: true, boxBoardSecondsAgo: 40, sinceSecondsAgo: 180 }]);
	const text = boardCommand({ dir: d, now: NOW, net });
	assert.match(text, /^held by main "work-on" on "mac" \(aaaaaa\) since 12 min$/m);
	assert.match(text, /^holds "box 2" \(cccccc\) · billing · honoured$/m);
	const cap = boardSeam({ dir: d, now: () => NOW }).capacity()!;
	assert.deepEqual([cap.held, cap.holds], [{ label: "mac", short: "aaaaaa", main: "work-on" }, [{ label: "box 2", short: "cccccc", main: "billing", honoured: true }]]);
	assert.match(capText(cap), / · held by work-on on mac · holds box 2 · billing · honoured$/);
	assert.match(capText({ ...cap, holds: [{ ...cap.holds![0]!, honoured: false }] }, { locale: "zh-TW" }), / · 由 mac 的 work-on 接管中 · 接管 box 2 · billing · 未生效$/);
	writeHold(capDir(d), { v: 1, at: NOW - 6 * MIN });
	assert.deepEqual(Object.keys(await readBoard({ dir: d, now: NOW, net, link: { boards: async () => [], remoteScope: () => undefined }, scope: "local" })).filter((k) => k.startsWith("hold") || k === "held"), [], "a stale file shows nothing");
});
