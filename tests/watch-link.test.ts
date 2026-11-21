import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeviceUnits } from "../src/link/holder.ts";
import type { MainStatus } from "../src/link/kinds.ts";
import type { Net, Unit } from "../src/net.ts";
import type { LinkWait } from "../src/server/linkwaits.ts";
import { parseLinkKey } from "../src/server/linkwatch.ts";
import type { Reply } from "../src/server/socket.ts";
import { runWatch } from "../src/server/watchcli.ts";
import { watchdogReply } from "../src/server/watchdogops.ts";
import { createWatchRead, type WatchNet } from "../src/server/watchread.ts";
import { STANDING_HINT, registerStandingHint, startsWatch } from "../src/standinghint.ts";
import { fakeClock } from "./fake-clock.ts";

// Item D of docs/specs/2026-11-21-box-mac-waits.md (§5, §9 anchors 8 and 9): `link:` keys read a teammate device from the Link holder's latest `unit-status`, and the verdicts `offline`, `waiting`, and `idle` join the route, in the order
// gone, expired, offline, waiting, changed, load, idle, stalled. The CLI `watch` prints one line per verdict that is not `unchanged`; a coordinator that starts a watch gets the standing hint once. Every wait is on a clock the test moves.

const DEV = "a".repeat(26), T0 = 1_700_000_000_000, H = "0123456789abcdef";
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
type Answer = Reply & { state?: string; since?: string; unit?: Record<string, unknown>; waits?: unknown[] };
const main = (over: Partial<MainStatus> = {}): MainStatus => ({ handle: H, unit: "moldplan", name: "work-on", state: "working", by: "b".repeat(26), stopping: false, kind: "coordinator", ...over });
const wait = (over: Partial<LinkWait> = {}): LinkWait => ({ n: 3, dir: "out", kind: "wait", device: DEV, team: "t", label: "mac", short: "aaaaaa", owner: "work-on", what: "merge !13", text: "", handle: H, since: T0, at: T0, state: "told", ...over });
const localUnit = (over: Partial<Unit> = {}): Unit => ({ id: "s1", key: "u1", control: true, name: "coord", role: "main", mark: "working", subs: [], ...over });
const netOf = (units: Unit[]): Net => ({ bases: [{ id: "w1", label: "w", mark: "working", tower: null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }] });

function world() {
	const clock = fakeClock(T0), listeners = new Set<(net: Net) => void>();
	let status: (DeviceUnits & { label: string }) | undefined = { team: "t", device: DEV, label: "ci-box", units: [{ unit: "moldplan", state: "running", monitors: [], report: "running the train\nmore" }], mains: [main()], at: T0 };
	let waits: LinkWait[] = [], net = netOf([localUnit()]);
	const watchNet: WatchNet = { onRead: (cb) => (listeners.add(cb), () => void listeners.delete(cb)), last: () => net, lookup: (key) => (key === "u1" ? { key, base: "w1", name: "coord", role: "main", live: true } : undefined), read: async () => net };
	const timer = (ms: number, fn: () => void) => { let live = true; clock.at(clock.elapsed() + ms, () => live && fn()); return () => void (live = false); };
	const watch = createWatchRead({ net: watchNet, now: clock.now, timer, link: { units: () => (status ? [status] : []), waits: () => waits } });
	const w = {
		clock, watch,
		set: (next: { status?: typeof status; waits?: LinkWait[]; net?: Net }) => void ("status" in next && (status = next.status), next.waits && (waits = next.waits), next.net && (net = next.net)),
		patch: (over: Partial<DeviceUnits>) => void (status = { ...status!, ...over }),
		/** One reading of the GUI host `ms` later. */
		async beat(ms = 2000) { clock.advance(ms); for (const cb of listeners) cb(net); await settle(); },
		async ask(q: Record<string, unknown>): Promise<Answer> { let got: Answer | undefined; void watch.read(q as never).then((r) => (got = r as Answer)); await settle(); assert.ok(got, "answered at once"); return got!; },
		/** A client's loop: holds one after another with a reading every 2 s, until a reply is not `unchanged` or `ms` passed. */
		async follow(q: Record<string, unknown>, ms: number, each?: (i: number) => void): Promise<Answer | undefined> {
			let since = q.since as string | undefined, got: Answer | undefined;
			const hold = () => void watch.read({ ...q, since } as never).then((r) => (got = r as Answer));
			hold();
			for (let i = 1; i <= ms / 2000; i++) {
				each?.(i);
				await w.beat();
				if (got && got.state !== "unchanged") return got;
				if (got) [since, got] = [got.since, undefined], hold();
			}
			return undefined;
		},
	};
	return w;
}

test("link keys parse as a device, a unit, or a main by handle; anything else is a key of the net", () => {
	assert.deepEqual(parseLinkKey("link:aaaaaa"), { short: "aaaaaa" });
	assert.deepEqual(parseLinkKey("link:aaaaaa/moldplan"), { short: "aaaaaa", unit: "moldplan" });
	assert.deepEqual(parseLinkKey(`link:aaaaaa/main/${H}`), { short: "aaaaaa", handle: H });
	for (const bad of ["u1", "link:", "link:AAAA", "link:aaaaaa/main/xyz"]) assert.equal(parseLinkKey(bad), undefined, bad);
});

test("a main key reads unit-status from the holder; a wait it raised gives `waiting` before `changed`, a state change `changed`, a stale status `offline` once per spell, and a main that left `gone`", async () => {
	const w = world(), key = `link:aaaaaa/main/${H}`;
	const first = await w.ask({ key });
	assert.equal(first.state, "changed");
	assert.deepEqual(first.unit, { device: "ci-box", short: "aaaaaa", ageMs: 0, state: "working", name: "work-on", kind: "coordinator", unit: "moldplan", waits: [] });
	w.set({ waits: [wait()] });
	w.patch({ mains: [main({ state: "blocked" })] });
	const both = await w.follow({ key, since: first.since }, 4000);
	assert.equal(both?.state, "waiting", "the order puts waiting before changed");
	assert.deepEqual((both?.unit as { waits: unknown[] }).waits, [{ id: "L3", dir: "out", what: "merge !13", state: "told" }]);
	const changed = await w.follow({ key, since: both!.since }, 4000);
	assert.equal(changed?.state, "changed");
	const offline = await w.follow({ key, since: changed!.since }, 4 * 60_000);
	assert.equal(offline?.state, "offline", "a status over 3 min old");
	assert.equal(await w.follow({ key, since: offline!.since }, 30_000), undefined, "once per spell");
	w.patch({ at: w.clock.now(), mains: [] });
	assert.equal((await w.follow({ key, since: offline!.since }, 4000))?.state, "gone");
	assert.match(String((await w.ask({ key: "link:bbbbbb" })).error), /^unknown key/);
});

test("`idleMs` gives `idle` once per idle spell, for a device key and for a main of this computer; a local main's link wait gives `waiting`", async () => {
	const w = world(), key = "link:aaaaaa";
	w.patch({ units: [{ unit: "moldplan", state: "standing", monitors: [], report: "" }], mains: [main({ state: "idle" })] });
	const first = await w.ask({ key, idleMs: 60_000 });
	assert.equal(first.state, "changed");
	let since = first.since;
	const idle = await w.follow({ key, since, idleMs: 60_000 }, 120_000, () => w.patch({ at: w.clock.now() }));
	assert.equal(idle?.state, "idle");
	since = idle!.since;
	assert.equal(await w.follow({ key, since, idleMs: 60_000 }, 120_000, () => w.patch({ at: w.clock.now() })), undefined, "once per spell");
	w.patch({ mains: [main({ state: "working" })] });
	since = (await w.follow({ key, since, idleMs: 60_000 }, 4000))!.since;
	w.patch({ mains: [main({ state: "idle" })] });
	since = (await w.follow({ key, since, idleMs: 60_000 }, 4000))!.since;
	assert.equal((await w.follow({ key, since, idleMs: 60_000 }, 120_000, () => w.patch({ at: w.clock.now() })))?.state, "idle", "a new spell is told again");
	// A main of this computer: the waits it raised come on its key.
	const local = await w.ask({ key: "u1" });
	w.set({ waits: [wait({ dir: "out", raiser: { id: "s1", name: "coord" } })] });
	const waiting = await w.follow({ key: "u1", since: local.since }, 4000);
	assert.equal(waiting?.state, "waiting");
	assert.deepEqual(waiting?.waits, [{ id: "L3", dir: "out", what: "merge !13", state: "told" }]);
	w.set({ net: netOf([localUnit({ mark: "idle" })]) });
	const changed = await w.follow({ key: "u1", since: waiting!.since, idleMs: 60_000 }, 4000);
	assert.equal(changed?.state, "changed");
	assert.equal((await w.follow({ key: "u1", since: changed!.since, idleMs: 60_000 }, 120_000))?.state, "idle");
	assert.equal(watchdogReply({ read: w.watch, report: { report: async () => ({ ok: true }) } }, { cmd: "watch-read", key, idleMs: 1000 }) instanceof Promise, true);
	assert.match(String((await watchdogReply({ read: w.watch, report: { report: async () => ({ ok: true }) } }, { cmd: "watch-read", key, idleMs: 1000 }))?.error), /idleMs is at least 60000/);
});

test("cli watch prints one JSON line per verdict, none for unchanged, chains since, says once that the server is gone, and ends on gone", async () => {
	const lines: string[] = [], asked: Record<string, unknown>[] = [];
	const replies: (Reply | undefined)[] = [{ ok: true, state: "changed", since: "s1", now: 1 }, { ok: true, state: "unchanged", since: "s2", now: 2 }, undefined, undefined, { ok: true, state: "idle", since: "s3", now: 3 }, { ok: true, state: "gone", since: "s4", now: 4 }];
	const code = await runWatch(undefined, { key: "link:aaaaaa", idle: "20m" }, { out: (t) => void lines.push(t), err: () => {}, sleep: async () => {}, call: async (q) => (asked.push(q), replies.shift()) });
	assert.equal(code, 0);
	assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ key: "link:aaaaaa", state: "changed", now: 1 }, { server: "unreachable" }, { key: "link:aaaaaa", state: "idle", now: 3 }, { key: "link:aaaaaa", state: "gone", now: 4 }]);
	assert.deepEqual(asked.map((q) => q.since ?? null), [null, "s1", "s2", "s2", "s2", "s3"]);
	assert.equal(asked[0]!.idleMs, 20 * 60_000);
	assert.equal(await runWatch(undefined, { key: "u1", idle: "30s" }, { out: () => {}, err: () => {}, call: async () => undefined }), 2, "an idle under a minute is a usage error");
	assert.equal(await runWatch(undefined, { key: "zz" }, { out: () => {}, err: () => {}, call: async () => ({ ok: false, error: "unknown key zz" }) }), 1);
});

test("a coordinator that dispatches a watchdog or runs the CLI's watch under a monitor gets the standing hint once; a standing main never does", () => {
	assert.equal(startsWatch("subagent", { agent: "watchdog" }), true);
	assert.equal(startsWatch("subagent", { agent: "worker" }), false);
	assert.equal(startsWatch("MonitorCreate", { command: "node '/x/dist/server/cli.mjs' watch link:aaaaaa --idle 20m" }), true);
	assert.equal(startsWatch("MonitorCreate", { command: "npm test" }), false);
	for (const [kind, expect] of [["coordinator", [true, false]], ["standing", [false, false]]] as const) {
		const handlers: ((e: unknown) => unknown)[] = [];
		const pi = { on: (name: string, fn: (e: unknown) => unknown) => void (name === "tool_result" && handlers.push(fn)) } as never;
		registerStandingHint(pi, () => kind);
		const result = () => handlers[0]!({ toolName: "subagent", input: { agent: "watchdog" }, isError: false, content: [{ type: "text", text: "started" }] }) as { content: { text: string }[] } | undefined;
		assert.deepEqual([result(), result()].map((r) => r?.content.at(-1)?.text === STANDING_HINT), expect, kind);
	}
});

test("BMWR-F007: a box in two teams is one device: its link keys read the rows and mains of both teams' reports", async () => {
	const { readLinkKey } = await import("../src/server/linkwatch.ts");
	const a = { team: "t1", device: DEV, label: "ci-box", units: [{ unit: "moldplan", state: "running", monitors: [], report: "" }], mains: [main()], at: T0 };
	const b = { team: "t2", device: DEV, label: "ci-box", units: [{ unit: "skald", state: "standing", monitors: [], report: "" }], mains: [main(), main({ handle: "fedcba9876543210", unit: "skald", name: "skald-main" })], at: T0 + 5000 };
	const deps = { units: () => [a, b], waits: () => [] };
	const device = readLinkKey({ short: "aaaaaa" }, deps, T0 + 6000);
	assert.ok(device, "the device reads");
	assert.deepEqual((device!.view.units as { unit: string }[]).map((u) => u.unit), ["moldplan", "skald"]);
	assert.deepEqual((device!.view.mains as { handle: string }[]).map((m) => m.handle), [H, "fedcba9876543210"]);
	assert.equal(device!.view.ageMs, 1000, "the newest report");
	assert.ok(readLinkKey({ short: "aaaaaa", unit: "skald" }, deps, T0 + 6000));
	assert.ok(readLinkKey({ short: "aaaaaa", handle: "fedcba9876543210" }, deps, T0 + 6000));
	assert.equal(readLinkKey({ short: "aaaa" }, { units: () => [a, { ...b, device: "a".repeat(25) + "b" }], waits: () => [] }, T0), undefined, "two devices under one short id stay unknown");
});

test("BMWR-F012: a malformed --idle or --quiet is a usage error, not dropped", async () => {
	const call = async () => ({ ok: false, error: "unknown key u1" });
	for (const flags of [{ idle: "20min" }, { quiet: "soon" }, { idle: true }] as Record<string, string | true>[]) assert.equal(await runWatch(undefined, { key: "u1", ...flags }, { out: () => {}, err: () => {}, call }), 2, JSON.stringify(flags));
});

test("BMWR-F010: a remote turn whose senders are of several teams gets no waits, as it gets no remote boards", async () => {
	const { readBoard } = await import("../src/boardread.ts");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "psb-board-waits-"));
	try {
		const read = (teams: string[]) => readBoard({ dir, now: T0, net: { sessions: [], ps: [] }, link: { boards: async () => [], remoteScope: () => ({ teams, project: "/x" }) } as never, scope: "all", waits: async () => [{ id: "L1" }] });
		assert.deepEqual((await read(["t1"])).waits, [{ id: "L1" }]);
		assert.equal((await read(["t1", "t2"])).waits, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
