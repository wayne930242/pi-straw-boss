import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net } from "../src/net.ts";
import { backoff, BASE_MS, createStream, MAX_ATTEMPTS, MAX_MS, type Source, STALE_MS, type Status, WATCHDOG_MS } from "../gui/stream.ts";

class FakeSource implements Source {
	closed = false;
	private fail: () => void = () => {};
	private handlers = new Map<string, (data: string) => void>();
	onError(handler: () => void) {
		this.fail = handler;
	}
	listen(type: string, handler: (data: string) => void) {
		this.handlers.set(type, handler);
	}
	close() {
		this.closed = true;
	}
	send(type: "message" | "ping" | "problem", payload: unknown = "") {
		this.raw(type, JSON.stringify(payload));
	}
	raw(type: "message" | "ping" | "problem", data: string) {
		this.handlers.get(type)?.(data);
	}
	error() {
		this.fail();
	}
}

const net = (label: string): Net => ({ bases: [{ id: label, label, mark: "idle", head: true, tower: null, tabs: [], outposts: [] }] });

/** A stream under a fake clock: timers fire only when the test advances time, and every connection is recorded. */
function setup(random = 0.5) {
	let at = 1_000_000, ids = 0, hidden = false;
	const timers = new Map<number, { due: number; run: () => void }>();
	const sources: FakeSource[] = [], nets: string[] = [], statuses: Status[] = [];
	const stream = createStream({
		open: () => sources[sources.push(new FakeSource()) - 1]!,
		now: () => at,
		setTimeout: (run, ms) => (timers.set(++ids, { due: at + ms, run }), ids),
		clearTimeout: (id) => void (id !== undefined && timers.delete(id)),
		random: () => random,
		hidden: () => hidden,
		onNet: (n) => nets.push(n.bases[0]!.label),
		onStatus: (s) => statuses.push(s),
	});
	const advance = (ms: number) => {
		const end = at + ms;
		for (;;) {
			const next = [...timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
			if (!next) break;
			timers.delete(next[0]);
			at = Math.max(at, next[1].due);
			next[1].run();
		}
		at = end;
	};
	return { stream, sources, nets, statuses, timers, advance, now: () => at, hide: (value: boolean) => (hidden = value), state: () => statuses.at(-1)! };
}

test("a snapshot makes the stream live, records when the server was last heard, and a ping keeps it live", () => {
	const t = setup();
	t.stream.start();
	assert.equal(t.sources.length, 1);
	t.sources[0]!.send("message", net("a"));
	assert.deepEqual(t.nets, ["a"]);
	assert.deepEqual([t.state().state, t.state().attempt], ["live", 0]);
	const first = t.state().lastContact;
	t.advance(15_000);
	t.sources[0]!.send("ping");
	assert.equal(t.state().lastContact, first! + 15_000);
	assert.equal(t.sources.length, 1, "pings never reconnect");
});

test("45 s without any message is a dead stream: it is closed and retried after the first backoff", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.send("message", net("a"));
	t.advance(WATCHDOG_MS - 1);
	assert.equal(t.state().state, "live");
	t.advance(1);
	assert.equal(t.sources[0]!.closed, true);
	assert.deepEqual([t.state().state, t.state().attempt], ["reconnecting", 1]);
	t.advance(BASE_MS - 1);
	assert.equal(t.sources.length, 1, "still waiting for the backoff");
	t.advance(1);
	assert.equal(t.sources.length, 2, "reconnected");
	t.sources[1]!.send("message", net("b"));
	assert.deepEqual([t.nets, t.state().state, t.state().attempt], [["a", "b"], "live", 0]);
});

test("a connection that never answers is caught by the same watchdog", () => {
	const t = setup();
	t.stream.start();
	t.advance(WATCHDOG_MS);
	assert.deepEqual([t.sources[0]!.closed, t.state().state], [true, "reconnecting"]);
});

test("backoff doubles from 1 s to a 30 s cap and is spread by ±20 %", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => backoff(n, 0.5)), [1000, 2000, 4000, 8000, 16_000, MAX_MS, MAX_MS, MAX_MS, MAX_MS]);
	const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`);
	near(backoff(1, 0), 800);
	near(backoff(1, 1), 1200);
	near(backoff(9, 1), MAX_MS * 1.2);
});

test("failures retry with growing delays, a success resets the attempt count, and an error from a replaced source is ignored", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.error();
	assert.equal(t.state().attempt, 1);
	t.advance(1000);
	t.sources[1]!.error();
	assert.equal(t.state().attempt, 2);
	t.advance(1999);
	assert.equal(t.sources.length, 2, "the second retry waits 2 s");
	t.advance(1);
	t.sources[2]!.send("message", net("a"));
	assert.deepEqual([t.state().state, t.state().attempt], ["live", 0]);
	const old = t.sources[1]!;
	old.error();
	assert.equal(t.state().state, "live", "a late error from an old source changes nothing");
	t.sources[2]!.error();
	assert.equal(t.state().attempt, 1, "counting restarts after a success");
});

test("after the retry limit it goes offline, holds no timers, and a focus brings it back with a fresh count", () => {
	const t = setup();
	t.stream.start();
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		t.sources.at(-1)!.error();
		t.advance(MAX_MS * 1.2);
	}
	t.sources.at(-1)!.error();
	assert.equal(t.state().state, "offline");
	assert.equal(t.timers.size, 0, "no retry and no watchdog while offline");
	const before = t.sources.length;
	t.advance(10 * MAX_MS);
	assert.equal(t.sources.length, before, "it stays quiet until the page is used again");
	t.stream.resume();
	assert.equal(t.sources.length, before + 1);
	t.sources.at(-1)!.send("message", net("again"));
	assert.deepEqual([t.state().state, t.state().attempt, t.nets.at(-1)], ["live", 0, "again"]);
});

test("coming back to the foreground after a quiet spell reconnects for a fresh snapshot instead of trusting the old stream", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.send("message", net("a"));
	t.advance(STALE_MS - 1_000);
	t.stream.resume();
	assert.equal(t.sources.length, 1, "heard from 19 s ago: healthy, nothing to do");
	t.advance(STALE_MS + 1_000);
	t.stream.resume();
	assert.equal(t.sources[0]!.closed, true);
	assert.equal(t.sources.length, 2);
	assert.equal(t.state().state, "reconnecting", "the page shows it is catching up");
	t.sources[1]!.send("message", net("fresh"));
	assert.deepEqual([t.nets.at(-1), t.state().state], ["fresh", "live"]);
});

test("focus, visible, pageshow, and online arriving together reconnect once", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.send("message", net("a"));
	t.advance(40_000);
	for (let i = 0; i < 4; i++) t.stream.resume();
	assert.equal(t.sources.length, 2);
});

test("a retry waiting out its backoff is cut short by a focus", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.error();
	assert.equal(t.sources.length, 1);
	t.advance(100);
	t.stream.resume();
	assert.equal(t.sources.length, 2);
	assert.equal(t.timers.size, 1, "only the new connection's watchdog remains");
});

test("a hidden page holds no retry timer: a failure waits for the page to come back", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.send("message", net("a"));
	t.hide(true);
	t.stream.hide();
	assert.equal(t.timers.size, 1, "only the watchdog");
	t.advance(WATCHDOG_MS);
	assert.deepEqual([t.state().state, t.timers.size], ["reconnecting", 0]);
	t.advance(5 * MAX_MS);
	assert.equal(t.sources.length, 1, "no reconnect while hidden");
	t.hide(false);
	t.stream.resume();
	assert.equal(t.sources.length, 2);
});

test("hiding cancels a pending retry", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.error();
	assert.equal(t.timers.size, 1);
	t.hide(true);
	t.stream.hide();
	assert.equal(t.timers.size, 0);
});

test("a problem event is shown as a problem and cleared by the next snapshot; the stream stays live", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.send("problem", "herdr is gone");
	assert.deepEqual([t.state().state, t.state().problem], ["live", "herdr is gone"]);
	t.sources[0]!.send("message", net("a"));
	assert.equal(t.state().problem, undefined);
});

test("a message the page cannot read is shown as a problem instead of throwing, and the stream stays live", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.raw("message", "{not json");
	assert.deepEqual([t.state().state, t.state().problem], ["live", "the server sent a snapshot the page cannot read"]);
	assert.deepEqual(t.nets, []);
});

test("stop closes the source and clears every timer", () => {
	const t = setup();
	t.stream.start();
	t.sources[0]!.send("message", net("a"));
	t.stream.stop();
	assert.deepEqual([t.sources[0]!.closed, t.timers.size], [true, 0]);
});
