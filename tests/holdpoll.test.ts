import assert from "node:assert/strict";
import { test } from "node:test";
import { type HoldPoll, holdPoll, type HoldPollDeps } from "../src/holdpoll.ts";
import type { Reply } from "../src/server/socket.ts";
import { fakeClock } from "./fake-clock.ts";

// The child's long poll (docs/specs/2026-11-23-lite-b2-d-e-f.md §2.3, §2.7 test 3): the loop the retired `watch_read` ran, moved to src/holdpoll.ts for `thread_wait`. These are watch_read's tests (0.80.0 to 0.82.x) on the loop itself: the re-polls and their
// updates, an abort, a message that arrives, and a server that is down, restarts, or is older.

/** A scripted sb server on a clock the test owns: each request takes `after` ms (a hold), or the request's own timeout when that is shorter, which answers nothing. */
function server(script: (request: Record<string, unknown>, n: number, at: number) => { after?: number; reply?: Reply }, start = 1_000_000) {
	const clock = fakeClock(start), calls: { request: Record<string, unknown>; timeoutMs: number; at: number }[] = [];
	const call = async (request: Record<string, unknown>, timeoutMs: number) => {
		calls.push({ request, timeoutMs, at: clock.elapsed() });
		const { after = 0, reply } = script(request, calls.length - 1, clock.now());
		clock.advance(Math.min(after, timeoutMs));
		return after > timeoutMs ? undefined : reply;
	};
	return { clock, calls, deps: { call, now: clock.now, sleep: clock.sleep } satisfies HoldPollDeps };
}
const HOLD = 45_000;
const unchanged = (since: string, at: number): Reply => ({ ok: true, state: "unchanged", since, now: at });
/** A poll as `thread_wait` runs one: a `changed` (here any state but unchanged) ends it; the cursor is the reply's `since`. */
function poll(o: Partial<HoldPoll<string | undefined>> & { pending?: () => boolean } = {}): HoldPoll<string | undefined> {
	return {
		request: (since) => ({ cmd: "hold", ...(since === undefined ? {} : { since }) }),
		cursor: "s0",
		ends: (reply) => reply.state !== "unchanged",
		next: (reply, since) => (typeof reply.since === "string" ? reply.since : since),
		fatal: (error) => error.startsWith("not a member"),
		waitMs: 600_000,
		pending: () => false,
		...o,
	};
}

test("a reply that ends the call is returned as it is, after one request", async () => {
	const s = server((_request, _n, at) => ({ after: 3_000, reply: { ok: true, state: "posts", since: "s1", now: at + 3_000 } }));
	const held = await holdPoll(s.deps, poll());
	assert.deepEqual(held, { reply: { ok: true, state: "posts", since: "s1", now: 1_003_000 }, last: { ok: true, state: "posts", since: "s1", now: 1_003_000 }, cursor: "s0", expired: false });
	assert.deepEqual(s.calls, [{ request: { cmd: "hold", since: "s0" }, timeoutMs: 55_000, at: 0 }]);
});

test("re-polls until waitMs, each re-poll with an onUpdate and the newest cursor; a server that holds nothing is asked every 2 s", async () => {
	const s = server((request, n, at) => ({ after: HOLD, reply: unchanged(n < 3 ? String(request.since) : "s1", at + HOLD) }));
	const updates: number[] = [];
	const held = await holdPoll(s.deps, poll({ onUpdate: (polls) => updates.push(polls) }));
	assert.equal(s.clock.elapsed(), 600_000, "the wait, by the clock");
	assert.equal(s.calls.length, 14, "one hold of 45 s after another; the last is cut at the wait's end");
	assert.equal(s.calls.at(-1)!.timeoutMs, 15_000);
	assert.ok(s.calls.slice(0, -1).every((x) => x.timeoutMs === 55_000), "the request timeout is 55 s");
	assert.deepEqual(updates, Array.from({ length: 13 }, (_, i) => i + 1), "every re-poll moves the activity file");
	assert.deepEqual(s.calls.map((x) => x.request.since), ["s0", "s0", "s0", "s0", ...Array.from({ length: 10 }, () => "s1")]);
	assert.deepEqual([held.reply, held.cursor, held.expired, held.last?.since], [undefined, "s1", false, "s1"]);
	const eager = server((_request, _n, at) => ({ after: 0, reply: unchanged("s0", at) }));
	await holdPoll(eager.deps, poll({ waitMs: 10_000 }));
	assert.deepEqual(eager.calls.map((x) => x.at), [0, 2_000, 4_000, 6_000, 8_000]);
});

test("a waitMs over 50 minutes is refused before anything is asked", async () => {
	const s = server(() => ({ reply: { ok: true, state: "posts" } }));
	await assert.rejects(holdPoll(s.deps, poll({ waitMs: 3_000_001 })), /waitMs is at most 3000000/);
	assert.equal(s.calls.length, 0);
	assert.equal((await holdPoll(s.deps, poll({ waitMs: 3_000_000 }))).reply?.state, "posts");
});

test("a message that arrives during the call ends it early; one already waiting at its start does not", async () => {
	let pending = false;
	const s = server((_request, n, at) => {
		if (n === 1) pending = true; // a steer lands during the second hold
		return { after: HOLD, reply: unchanged("s0", at + HOLD) };
	});
	const early = await holdPoll(s.deps, poll({ pending: () => pending }));
	assert.equal(early.reply, undefined);
	assert.equal(s.clock.elapsed(), 90_000, "it returns with the hold the message arrived in");
	assert.equal(early.trouble, undefined);
	await holdPoll(s.deps, poll({ pending: () => pending, waitMs: 200_000 }));
	assert.equal(s.clock.elapsed(), 290_000, "a follow-up already waiting: the whole wait");
});

test("a server that restarts during a hold is asked again after 2 s, and the answer still comes", async () => {
	const s = server((request, n, at) => (n === 1 ? { after: 20_000 } : n === 2 ? { after: 0 } : n === 3 ? { after: 1_000, reply: { ok: true, state: "closed", since: "s9", now: at + 1_000 } } : { after: HOLD, reply: unchanged(String(request.since), at + HOLD) }));
	const updates: unknown[] = [];
	const held = await holdPoll(s.deps, poll({ onUpdate: (polls, trouble) => updates.push([polls, trouble?.server]) }));
	assert.deepEqual(s.calls.map((x) => x.at), [0, 45_000, 67_000, 69_000], "the hold cut off at 65 s, then 2 s apart");
	assert.equal(held.reply?.state, "closed");
	assert.deepEqual(updates, [[1, undefined], [2, "unreachable"], [3, "unreachable"]]);
});

test("a server still down at waitMs: no reply, trouble unreachable; an older one, outdated; a transient refusal is kept as the error; none fails the call", async () => {
	const down = server(() => ({ after: 0 }));
	const gone = await holdPoll(down.deps, poll({ waitMs: 60_000 }));
	assert.deepEqual([gone.reply, gone.trouble, gone.cursor], [undefined, { server: "unreachable" }, "s0"]);
	assert.equal(down.calls.length, 30, "asked every 2 s");
	const old = server(() => ({ reply: { ok: false, error: "unknown command thread-wait" } }));
	assert.deepEqual((await holdPoll(old.deps, poll({ waitMs: 60_000 }))).trouble, { server: "outdated" });
	const sick = server(() => ({ reply: { ok: false, error: "the sb server is stopping; ask again" } }));
	assert.deepEqual((await holdPoll(sick.deps, poll({ waitMs: 10_000 }))).trouble, { server: "unreachable", error: "the sb server is stopping; ask again" });
	const back = server((_request, n, at) => (n < 3 ? { after: 0 } : { after: HOLD, reply: unchanged("s0", at + HOLD) }));
	assert.equal((await holdPoll(back.deps, poll({ waitMs: 120_000 }))).trouble, undefined, "a server that came back is no longer unreachable");
	const hung = server(() => ({ after: 600_000 }));
	assert.equal((await holdPoll(hung.deps, poll({ waitMs: 120_000 }))).trouble?.server, "unreachable", "a hang for the whole request timeout counts as down");
});

test("a message that arrives while the server is unreachable or outdated ends the call at the next retry; one already waiting does not", async () => {
	for (const [reply, word] of [[undefined, "unreachable"], [{ ok: false, error: "unknown command thread-wait" }, "outdated"]] as const) {
		let pending = false;
		const s = server((_request, n) => {
			if (n === 2) pending = true; // a steer lands at the third try
			return { after: 0, ...(reply ? { reply } : {}) };
		});
		const early = await holdPoll(s.deps, poll({ pending: () => pending }));
		assert.equal(early.trouble?.server, word);
		assert.equal(s.calls.length, 3);
		await holdPoll(s.deps, poll({ pending: () => pending, waitMs: 20_000 }));
		assert.equal(s.clock.elapsed(), 24_000, "a follow-up already waiting: the whole wait");
	}
});

test("the deadline is judged by the clock even with no server: expired", async () => {
	const down = server(() => ({ after: 0 }));
	const held = await holdPoll(down.deps, poll({ deadline: 1_030_000 }));
	assert.deepEqual([held.expired, down.clock.now()], [true, 1_030_000]);
	assert.equal((await holdPoll(down.deps, poll({ deadline: 5 }))).expired, true, "a deadline already past asks nothing more");
});

test("the call fails only for a fatal refusal and an abort", async () => {
	const s = server(() => ({ reply: { ok: false, error: "not a member of T1" } }));
	await assert.rejects(holdPoll(s.deps, poll()), /^Error: not a member of T1$/);
	assert.equal(s.calls.length, 1);
	const abort = new AbortController();
	const pending = holdPoll({ call: () => new Promise<Reply | undefined>(() => {}), now: Date.now, sleep: async () => {} }, poll({ signal: abort.signal }));
	abort.abort();
	await assert.rejects(pending, /Operation aborted/);
	await assert.rejects(holdPoll(s.deps, poll({ signal: abort.signal })), /Operation aborted/, "a call under a signal already aborted");
});
