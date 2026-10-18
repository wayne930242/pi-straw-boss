import assert from "node:assert/strict";
import { test } from "node:test";
import * as mirror from "../src/mirror.ts";
import { CALM_MS, createMirrors, FAILS, FAST_MS, FRESH_MS, MAX_ROW, MAX_ROWS, PANES, PER_STREAM, sanitize, SLOW_MS, type Timer, WHOLE_MS } from "../src/mirror.ts";
import type { Found } from "../src/net.ts";
import { settle } from "./fakes.ts";

const FILE = "/s/2026_sess.jsonl";
/** A clock whose timers run only when it is advanced, one due timer at a time, letting the reads they start settle. */
function clock() {
	let t = 1_000_000, n = 0;
	const due = new Map<number, { at: number; run: () => void }>();
	const timer: Timer = { now: () => t, set: (run, ms) => (due.set(++n, { at: t + ms, run }), n), clear: (id) => void due.delete(id as number) };
	return {
		timer,
		pending: () => due.size,
		async advance(ms: number) {
			await settle(); // a reader's first read starts at once, not on a timer
			const end = t + ms;
			for (;;) {
				const next = [...due].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				due.delete(next[0]);
				t = next[1].at;
				next[1].run();
				await settle();
			}
			t = end;
		},
	};
}

/** Mirrors over a fake Herdr pane whose screen the test sets; every socket call is recorded. */
function setup({ secret = false } = {}) {
	const c = clock(), calls: string[] = [], state = { screen: ["one", "two"], width: 80, secret, fail: false, agent: "pi", file: FILE, live: true, pane: "", hold: {} as Partial<Record<"secret" | "pane.get" | "pane.read", Promise<void>>> };
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push(`${method} ${params.pane_id}`);
		await state.hold[method as "pane.get"];
		if (state.fail) throw new Error("socket");
		if (method === "pane.get") return { pane: { pane_id: params.pane_id, agent: state.agent, agent_session: { value: state.file } } };
		if (method === "pane.layout") return { layout: { panes: [{ pane_id: "other", rect: { width: 3 } }, { pane_id: params.pane_id, rect: { width: state.width } }] } };
		return { read: { text: state.screen.join("\r\n") } };
	};
	const lookup = (key: string): Found | undefined => (key.startsWith("s") ? { key, base: "w", name: key, role: "main", file: FILE, pane: state.pane || `p-${key}`, live: state.live } : undefined);
	const m = createMirrors({ call, lookup, secret: async () => (await state.hold.secret, state.secret), canonical: (f) => f, timer: c.timer });
	const frames = new Map<string, Record<string, unknown>[]>();
	const stream = (id: string) => (m.open(id, (event, data) => (assert.equal(event, "mirror"), frames.set(id, [...(frames.get(id) ?? []), data as Record<string, unknown>]))), id);
	const reads = () => calls.filter((x) => x.startsWith("pane.read")).length;
	return { c, m, calls, state, frames: (id: string) => frames.get(id) ?? [], stream, reads, on: (id: string, key = "s1") => m.toggle(key, { stream: id, on: true }), off: (id: string, key = "s1") => m.toggle(key, { stream: id, on: false }) };
}

test("the sanitizer keeps SGR and drops cursor moves, OSC links, other escapes, C0 and C1, and never ends inside an escape", () => {
	assert.equal(sanitize("\x1b[0m\x1b[38;2;249;226;175m│\x1b[1;4mok\x1b[m"), "\x1b[0m\x1b[38;2;249;226;175m│\x1b[1;4mok\x1b[m", "Herdr's own SGR passes");
	assert.equal(sanitize("model\x1b[3Gwritten"), "modelwritten", "a cursor move written by the model");
	assert.equal(sanitize("\x1b]8;;https://evil.test\x07link\x1b]8;;\x1b\\ end"), "link end", "OSC 8 with BEL and ST");
	assert.equal(sanitize("a\x1b]0;title"), "a", "an OSC that never ends takes the rest of the row");
	assert.equal(sanitize("a\x1bP1$r\x1b\\b\x1b_apc\x07c"), "abc", "DCS and APC");
	assert.equal(sanitize("x\x1b[38;5"), "x", "an SGR split at the end of the row");
	assert.equal(sanitize("x\x1b[38\x1b[0my"), "x\x1b[0my", "an SGR cut short by the next escape");
	assert.equal(sanitize("\x1b[?25l\x1b[2J\x1b[1;1H\x1b[0 q\x1b7\x1b(Bz"), "z", "private, erase, position, intermediates, ESC 7, charset");
	assert.equal(sanitize("a\x00b\x07c\x08d\te\x7ff\u0085g\u009b31mh\u009d0;x\r"), "abcdefg31mh0;x", "C0, DEL, and C1 (8-bit CSI and OSC lose their introducer)");
	assert.equal(sanitize(`\x1b[${"1;".repeat(40)}m`), "", "an SGR with an absurd parameter list");
	assert.equal(sanitize("a\x1b"), "a");
	const long = sanitize(`${"é".repeat(3000)}\x1b[31m`);
	assert.ok(Buffer.byteLength(long) <= MAX_ROW && !long.endsWith("\ufffd"), "4 KB at most, never half a character");
	assert.equal(sanitize(`${"x".repeat(MAX_ROW - 3)}\x1b[31m`), "x".repeat(MAX_ROW - 3), "the cut never leaves half an SGR");
});

test("the module reads rows for display only: it exports no predicate over them", () => {
	assert.deepEqual(Object.keys(mirror).filter((k) => typeof (mirror as Record<string, unknown>)[k] === "function").sort(), ["createMirrors", "sanitize"]);
	const m = createMirrors({ lookup: () => undefined, secret: async () => false, canonical: (f) => f });
	assert.deepEqual(Object.keys(m).sort(), ["active", "close", "fresh", "open", "stop", "toggle"], "fresh() looks at streams and time, never at what the rows say");
});

test("one reader serves every stream on the session: every row on attach, then only the rows that change, at 4 a second while it changes and once a second when calm", async () => {
	const { c, stream, on, frames, reads, state } = setup();
	const a = stream("A"), b = stream("B");
	assert.deepEqual(on(a), { status: 200, body: { attached: true } });
	assert.equal(on(a).status, 200, "the same page again while the first read is on its way starts no second loop");
	await c.advance(0);
	assert.deepEqual(frames(a)[0], { key: "s1", seq: 1, rows: 2, cols: 80, whole: true, set: [[0, "one"], [1, "two"]] });
	on(b);
	assert.deepEqual(frames(b), [{ key: "s1", seq: 1, rows: 2, cols: 80, whole: true, set: [[0, "one"], [1, "two"]] }], "a page joining gets every row at once, without another read");
	assert.equal(reads(), 1);
	state.screen = ["one", "TWO"];
	await c.advance(FAST_MS);
	assert.equal(reads(), 2, "shared: one read for both streams");
	assert.deepEqual([frames(a).at(-1), frames(b).at(-1)], [{ key: "s1", seq: 2, rows: 2, cols: 80, set: [[1, "TWO"]] }, { key: "s1", seq: 2, rows: 2, cols: 80, set: [[1, "TWO"]] }]);
	await c.advance(CALM_MS);
	assert.equal(reads(), 2 + CALM_MS / FAST_MS, "4 reads a second within 2 s of a change");
	const before = reads();
	await c.advance(3 * SLOW_MS);
	assert.equal(reads(), before + 3, "1 read a second once calm");
	assert.ok(frames(a).slice(-3).every((f) => (f.set as unknown[]).length === 0), "an unchanged screen sends an empty frame once a second, so the page knows it is current");
});

test("every row again on a resize, a change of row count, and every 10 s", async () => {
	const { c, stream, on, frames, state } = setup();
	const a = stream("A");
	on(a);
	await c.advance(0);
	state.width = 100;
	await c.advance(2 * SLOW_MS);
	const resized = frames(a).find((f) => f.cols === 100);
	assert.equal(resized?.whole, true, "a new width sends every row");
	state.screen = ["one", "two", "three"];
	await c.advance(SLOW_MS);
	assert.deepEqual(frames(a).at(-1), { key: "s1", seq: 2, rows: 3, cols: 100, whole: true, set: [[0, "one"], [1, "two"], [2, "three"]] });
	const n = frames(a).filter((f) => f.whole).length;
	await c.advance(WHOLE_MS);
	assert.equal(frames(a).filter((f) => f.whole).length, n + 1, "one whole frame in 10 s of a calm screen");
	state.screen = Array.from({ length: 200 }, (_, i) => `r${i}`);
	await c.advance(SLOW_MS);
	assert.equal(frames(a).at(-1)!.rows, MAX_ROWS, "at most 120 rows, the bottom ones");
	assert.deepEqual((frames(a).at(-1)!.set as [number, string][]).at(-1), [MAX_ROWS - 1, "r199"]);
});

test("the reads stop at once when the last stream detaches or closes, and the reader is shared until then", async () => {
	const { c, m, stream, on, off, reads } = setup();
	const a = stream("A"), b = stream("B");
	on(a);
	on(b);
	await c.advance(0);
	off(a);
	await c.advance(SLOW_MS);
	const n = reads();
	assert.ok(n >= 2, "B still reads");
	m.close(b);
	await c.advance(5 * SLOW_MS);
	assert.equal(reads(), n, "no reads with no stream attached");
	assert.deepEqual([m.active(), c.pending()], [[], 0]);
});

test("a stream is current only while it holds the mirror and was sent a frame in the last 3 s", async () => {
	const { c, m, stream, on, off, state } = setup();
	const a = stream("A"), b = stream("B");
	assert.equal(m.fresh(a, "s1"), false, "not attached");
	on(a);
	await c.advance(0);
	assert.equal(m.fresh(a, "s1"), true);
	assert.equal(m.fresh(b, "s1"), false, "another stream of the same page set is not current");
	assert.equal(m.fresh(a, "s2"), false, "another session");
	state.fail = true;
	await c.advance(FRESH_MS + 1);
	assert.equal(m.fresh(a, "s1"), false, "failing reads send nothing, so the stream goes stale");
	state.fail = false;
	await c.advance(SLOW_MS);
	assert.equal(m.fresh(a, "s1"), true);
	off(a);
	assert.equal(m.fresh(a, "s1"), false);
});

test("at most two mirrors per stream and six panes per server, refused with 429; a bad body or an unknown stream is 400", async () => {
	const { m, stream, on } = setup();
	const a = stream("A");
	for (let i = 1; i <= PER_STREAM; i++) assert.equal(on(a, `s${i}`).status, 200);
	assert.equal(on(a, "s1").status, 200, "the same one again is fine");
	assert.deepEqual([on(a, "s9").status, (on(a, "s9").body as { error: string }).error], [429, "too_many"]);
	for (let i = 3; i <= PANES; i++) assert.equal(on(stream(`S${i}`), `s${i}`).status, 200);
	assert.equal(on(stream("Z"), "s7").status, 429, "a seventh pane");
	assert.equal(on(stream("Y"), "s1").status, 200, "a pane already mirrored can take another stream");
	assert.equal(m.toggle("s1", { stream: "nope", on: true }).status, 400);
	assert.equal(m.toggle("s1", { stream: a, on: "yes" }).status, 400);
	assert.equal(on(a, "x-not-in-registry").status, 409);
});

test("while the file's open call is secret_drop nothing is read: the streams hear hidden, and every row comes back after", async () => {
	const { c, stream, on, frames, reads, state, calls } = setup({ secret: true });
	const a = stream("A");
	on(a);
	await c.advance(3 * SLOW_MS);
	assert.equal(calls.length, 0, "not even the size");
	assert.deepEqual(frames(a).at(-1), { key: "s1", hidden: true });
	assert.ok(frames(a).every((f) => !("set" in f)));
	state.secret = false;
	await c.advance(SLOW_MS);
	assert.equal(reads(), 1);
	assert.equal(frames(a).at(-1)!.whole, true);
});

test("a mirror ends after 10 failed reads, when the key leaves the net, or when the pane runs something else", async () => {
	for (const [change, reason] of [[(s: { fail: boolean }) => (s.fail = true), /could not be read/], [(s: { live: boolean }) => (s.live = false), /no longer live/], [(s: { agent: string }) => (s.agent = "shell"), /something else/]] as const) {
		const { c, m, stream, on, frames, state } = setup();
		const a = stream("A");
		on(a);
		await c.advance(0);
		change(state as never);
		await c.advance(FAILS * 1000 + 2 * SLOW_MS);
		assert.match(String(frames(a).at(-1)!.ended), reason);
		assert.deepEqual([m.active(), c.pending()], [[], 0]);
		assert.equal(on(a).status, state.live ? 200 : 409, "a page can open it again while the session lives");
	}
});

test("stop ends every reader: no timer and no read after it", async () => {
	const { c, m, stream, on, reads } = setup();
	on(stream("A"));
	on(stream("B"), "s2");
	await c.advance(SLOW_MS);
	const n = reads();
	m.stop();
	assert.equal(c.pending(), 0, "no timer left at once");
	await c.advance(5 * SLOW_MS);
	assert.deepEqual([reads(), c.pending(), m.active()], [n, 0, []]);
});

test("turning a mirror on and off over and over keeps 4 reads a second for the session, and a detached reader calls Herdr no more", async () => {
	const { c, stream, on, off, reads } = setup();
	const a = stream("A");
	const churn = () => {
		for (let i = 0; i < 20; i++) {
			on(a);
			off(a);
		}
	};
	churn();
	await c.advance(0);
	assert.equal(reads(), 0, "every reader left before its first read");
	on(a);
	await c.advance(0);
	off(a);
	churn();
	on(a);
	await c.advance(FAST_MS - 1);
	assert.equal(reads(), 1, "the next reader waits out the 250 ms since the last read began");
	await c.advance(1);
	assert.equal(reads(), 2);
});

test("a page joining after the session moved to another pane does not get the old pane's rows: the old mirror ends and a new one reads the new pane", async () => {
	const { c, m, stream, on, frames, calls, state } = setup();
	const a = stream("A"), b = stream("B");
	on(a);
	await c.advance(0);
	state.pane = "p-elsewhere"; // the registry now places s1 on another pane, before the reader's next look
	assert.equal(on(b).status, 200);
	assert.match(String(frames(a).at(-1)!.ended), /moved/, "the old mirror ends for its page");
	assert.equal(frames(b).length, 0, "no cached rows of the old pane");
	await c.advance(FAST_MS);
	assert.equal(frames(b)[0]!.whole, true);
	assert.deepEqual(calls.filter((x) => x.startsWith("pane.read")), ["pane.read p-s1", "pane.read p-elsewhere"]);
	assert.deepEqual(m.active(), ["s1"]);
});

test("a reader detached in the middle of its read makes no further Herdr call", async () => {
	for (const at of ["secret", "pane.get"] as const) {
		const { c, stream, on, off, calls, state } = setup();
		let release!: () => void;
		state.hold[at] = new Promise<void>((resolve) => (release = resolve));
		const a = stream("A");
		on(a);
		await c.advance(0);
		const before = calls.length;
		off(a);
		release();
		await c.advance(5 * SLOW_MS);
		assert.deepEqual(calls.slice(before).filter((x) => x.startsWith("pane.read") || at === "secret"), [], `held at ${at}`);
	}
});

test("a read on its way when the mirror ends delivers nothing after the end", async () => {
	const { c, stream, on, frames, state } = setup();
	const a = stream("A"), b = stream("B");
	on(a);
	await c.advance(0);
	let release!: () => void;
	state.hold["pane.read"] = new Promise<void>((resolve) => (release = resolve));
	state.screen = ["old", "pane"];
	await c.advance(FAST_MS);
	state.pane = "p-elsewhere";
	on(b);
	assert.ok("ended" in frames(a).at(-1)!);
	release();
	await c.advance(0);
	assert.ok("ended" in frames(a).at(-1)!, "the old pane's rows never follow the end");
});
