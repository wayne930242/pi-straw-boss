import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnvelope, decodeEnvelope, encodeEnvelope } from "../src/link/envelope.ts";
import { ForbiddenError, NetworkError, PayloadTooLargeError, ProtocolError, RateLimitedError, RelayError, ServerError, UnauthorizedError, UnprocessableError } from "../src/link/errors.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { AckQueue, Outbox, type QueuedEnvelope } from "../src/link/outbox.ts";
import { entryHash } from "../src/link/roster.ts";
import { DEVICES, mainLog, TEAM, teamKey } from "./link/scenario.ts";
import { until } from "./link/fakes.ts";

const mainLogHead = () => ({ seq: 0, hash: entryHash(mainLog()[0]!) });
const build = (seq: number) =>
	buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: mainLogHead(), from: DEVICES.alice, seq, ts: 1_700_000_000_000, kind: "tower", to: [DEVICES.bob.id], plaintext: encodePlaintext("tower", { fromWorkspace: "w", toWorkspace: "", replyExpected: false, text: `m${seq}` }) });
const seqOf = (bytes: Buffer) => decodeEnvelope(bytes).header.seq;

/** An outbox over a fake relay: `post` is scripted per call (resolve or throw) and every call is recorded. */
function rig(script: (call: number, seq: number) => Promise<void> | void = () => undefined, reserve: () => number | Promise<number> = (() => { let n = 0; return () => ++n; })()) {
	const posted: number[] = [], attempts: number[] = [], retries: { seq: number; delayMs: number }[] = [], rejected: { seq: number; error: unknown }[] = [], halts: number[] = [], landed: number[] = [];
	let calls = 0;
	const outbox = new Outbox({
		reserveSeq: reserve,
		post: async (bytes) => {
			const seq = seqOf(bytes);
			attempts.push(seq);
			await script(++calls, seq);
			posted.push(seq);
		},
		sleep: async () => undefined,
		backoff: (n) => n * 10,
		onPosted: (i) => void landed.push(i.seq),
		onRetry: (i, _e, delayMs) => void retries.push({ seq: i.seq, delayMs }),
		onRejected: (i, error) => void rejected.push({ seq: i.seq, error }),
		onHalt: (i) => void halts.push(i.seq),
	});
	return { outbox, posted, attempts, retries, rejected, halts, landed };
}

test("seq is reserved, saved, and only then used to build: a reservation that is still saving holds the build", async () => {
	const order: string[] = [];
	let finishSaving!: () => void;
	const o = new Outbox({
		reserveSeq: async () => { order.push("reserve"); await new Promise<void>((r) => { finishSaving = r; }); order.push("saved"); return 7; },
		post: async () => undefined,
	});
	const p = o.submit((seq) => { order.push(`build ${seq}`); return build(seq); });
	await until(() => finishSaving, 1000, "reserve called");
	assert.deepEqual(order, ["reserve"]);
	finishSaving();
	await p;
	assert.deepEqual(order, ["reserve", "saved", "build 7"]);
});

test("concurrent submits get seqs in submit order, whatever the saves' latency", async () => {
	const delays = [30, 1, 10], seqs: number[] = [];
	let n = 0, k = 0;
	const { outbox, posted } = rig(undefined, async () => { const d = delays[k++ % 3]!; await new Promise((r) => setTimeout(r, d)); return ++n; });
	await Promise.all([1, 2, 3].map((i) => outbox.submit((seq) => { seqs.push(seq); return build(seq); }).then(() => i)));
	await outbox.idle();
	assert.deepEqual(seqs, [1, 2, 3]);
	assert.deepEqual(posted, [1, 2, 3]);
});

test("envelopes are posted one at a time: the next is not posted until the one before has landed", async () => {
	const gates = new Map<number, () => void>();
	const { outbox, attempts, posted } = rig((_c, seq) => new Promise<void>((r) => void gates.set(seq, r)));
	await Promise.all([1, 2, 3].map(() => outbox.submit(build)));
	await until(() => gates.has(1), 1000, "first in flight");
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(attempts, [1]);
	gates.get(1)!();
	await until(() => gates.has(2), 1000, "second in flight");
	assert.deepEqual(attempts, [1, 2]);
	assert.deepEqual(posted, [1]);
	gates.get(2)!();
	await until(() => gates.has(3), 1000, "third in flight");
	gates.get(3)!();
	await outbox.idle();
	assert.deepEqual(posted, [1, 2, 3]);
});

test("one envelope is retried until it lands before the next is tried: a lost connection, a 5xx, a cap", async () => {
	const failures: unknown[] = [new NetworkError("down"), new ServerError(502, "bad-gateway"), new RateLimitedError(429, "rate-limited", undefined, 4000)];
	const { outbox, attempts, retries, posted } = rig((_c, seq) => { if (seq === 1 && failures.length) throw failures.shift(); });
	await outbox.submit(build);
	await outbox.submit(build);
	await outbox.idle();
	assert.deepEqual(attempts, [1, 1, 1, 1, 2], "seq 2 waited for seq 1 through three failures");
	assert.deepEqual(posted, [1, 2]);
	assert.deepEqual(retries, [{ seq: 1, delayMs: 10 }, { seq: 1, delayMs: 20 }, { seq: 1, delayMs: 4000 }]);
});

test("an envelope the relay refuses for good leaves the queue and the next one goes on", async () => {
	const { outbox, attempts, rejected, landed } = rig((_c, seq) => { if (seq === 2) throw new UnprocessableError(422, "bad-epoch", undefined, undefined); if (seq === 3) throw new ForbiddenError(403, "from-mismatch"); });
	for (let i = 0; i < 4; i++) await outbox.submit(build);
	await outbox.idle();
	assert.deepEqual(attempts, [1, 2, 3, 4], "no retry of a refusal");
	assert.deepEqual(rejected.map((r) => [r.seq, (r.error as UnprocessableError).code]), [[2, "bad-epoch"], [3, "from-mismatch"]]);
	assert.deepEqual(landed, [1, 4]);
	assert.equal(outbox.size, 0);
});

test("an envelope over the relay's cap is answered 413 and is refused, not retried", async () => {
	const { outbox, attempts, rejected } = rig(() => { throw new PayloadTooLargeError(413, "envelope-too-large"); });
	await outbox.submit(build);
	await outbox.idle();
	assert.deepEqual(attempts, [1]);
	assert.equal(rejected.length, 1);
});

test("a 401 halts the outbox with its queue intact; resume tries the same envelope again", async () => {
	let removed = true;
	const { outbox, attempts, halts, posted } = rig((_c, seq) => { if (seq === 1 && removed) throw new UnauthorizedError(401, "bad-time"); });
	await outbox.submit(build);
	await outbox.submit(build);
	await outbox.idle();
	assert.deepEqual(attempts, [1]);
	assert.deepEqual(halts, [1]);
	assert.equal(outbox.haltedBy?.code, "bad-time");
	assert.deepEqual(outbox.pending().map((i) => i.seq), [1, 2]);
	await outbox.submit(build);
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(attempts, [1], "halted: a new envelope waits too");
	removed = false;
	outbox.resume();
	await outbox.idle();
	assert.deepEqual(posted, [1, 2, 3]);
	assert.equal(outbox.haltedBy, undefined);
});

test("envelopes kept from before a restart are queued as they are, in seq order; a seq that does not rise is refused", async () => {
	const { outbox, posted } = rig();
	const kept = (seq: number): QueuedEnvelope => { const e = build(seq); return { seq, id: e.header.id, bytes: encodeEnvelope(e) }; };
	assert.throws(() => outbox.enqueue({ ...kept(5), seq: 0 }), RangeError);
	outbox.enqueue(kept(5));
	assert.throws(() => outbox.enqueue(kept(5)), RangeError);
	assert.throws(() => outbox.enqueue(kept(4)), RangeError);
	outbox.enqueue(kept(6));
	await outbox.idle();
	assert.deepEqual(posted, [5, 6]);
});

test("an envelope built with a seq other than the reserved one is refused, and the outbox goes on", async () => {
	const { outbox, posted } = rig();
	await assert.rejects(outbox.submit(() => build(99)), RangeError);
	await outbox.submit(build);
	await outbox.idle();
	assert.deepEqual(posted, [2], "seq 1 was reserved and never used: a gap, which receivers accept");
});

test("an ephemeral envelope has no place in the queue", async () => {
	const { outbox } = rig();
	await assert.rejects(outbox.submit((seq) => buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: mainLogHead(), from: DEVICES.alice, seq, ts: 1, kind: "presence", to: [], plaintext: encodePlaintext("presence", { label: "a", headSeq: 0, headHash: mainLogHead().hash, workspaces: [] }) })), RangeError);
});

test("stop cuts a retry wait short and keeps what is unsent readable", async () => {
	const waiting = new Outbox({
		reserveSeq: () => 1,
		post: async () => { throw new NetworkError("down"); },
		sleep: (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }); }),
		backoff: () => 60_000,
	});
	await waiting.submit(build);
	await new Promise((r) => setTimeout(r, 20));
	await waiting.stop();
	assert.deepEqual(waiting.pending().map((i) => i.seq), [1]);
});

// ---- Acknowledgements ----------------------------------------------------------------------------------------------------------------

const id = (n: number) => Buffer.alloc(16, n);

test("nothing is acknowledged until the caller adds an id; ids added together go in one request", async () => {
	const requests: string[][] = [];
	const q = new AckQueue({ ack: async (ids) => void requests.push(ids.map((i) => i.toString("hex"))), delayMs: 10 });
	await new Promise((r) => setTimeout(r, 30));
	assert.deepEqual(requests, []);
	q.add(id(1));
	q.add(id(2));
	q.add(id(1));
	await q.flush();
	assert.deepEqual(requests, [[id(1).toString("hex"), id(2).toString("hex")]]);
	await q.stop();
});

test("a failed acknowledgement is retried while the relay is unreachable, and keeps the ids", async () => {
	const requests: number[] = [];
	let fail = 2;
	const q = new AckQueue({ ack: async (ids) => { requests.push(ids.length); if (fail-- > 0) throw new NetworkError("down"); }, delayMs: 1, backoff: () => 1, sleep: async () => undefined });
	q.add(id(1));
	await q.flush();
	assert.deepEqual(requests, [1, 1, 1]);
	await q.stop();
});

test("a refused acknowledgement drops its ids and reports them; stop sends one last request and gives up", async () => {
	const dropped: Buffer[][] = [], errors: unknown[] = [];
	const refused = new AckQueue({ ack: async () => { throw new ForbiddenError(403, "nope"); }, delayMs: 1, onError: (e, ids) => { errors.push(e); dropped.push(ids); } });
	refused.add(id(1));
	await refused.flush();
	assert.equal(dropped.length, 1);
	assert.ok(errors[0] instanceof ForbiddenError);
	await refused.stop();

	let tries = 0;
	const down = new AckQueue({ ack: async () => { tries++; throw new NetworkError("down"); }, delayMs: 60_000, onError: (e, ids) => void dropped.push(ids) });
	down.add(id(2));
	await down.stop();
	assert.equal(tries, 1, "one last attempt, no retries");
	assert.equal(dropped.length, 2);
});

test("resume() called from inside onHalt restarts the pump once the halting pass returns", async () => {
	const posted: number[] = [];
	let halts = 0;
	const outbox: Outbox = new Outbox({
		reserveSeq: (() => { let n = 0; return () => ++n; })(),
		post: async (bytes) => {
			if (halts === 0) throw new UnauthorizedError(401, "bad-time");
			posted.push(seqOf(bytes));
		},
		sleep: async () => undefined,
		onHalt: () => { halts++; outbox.resume(); },
	});
	await outbox.submit(build);
	await until(() => posted.length === 1, 1000, "the envelope posted after the resume");
	assert.equal(outbox.size, 0);
	assert.equal(outbox.haltedBy, undefined);
	await outbox.stop();
});

test("an envelope enqueued one microtask after the last onPosted is still posted", async () => {
	const posted: number[] = [];
	let queued = false;
	const outbox: Outbox = new Outbox({
		reserveSeq: (() => { let n = 0; return () => ++n; })(),
		post: async (bytes) => void posted.push(seqOf(bytes)),
		sleep: async () => undefined,
		onPosted: () => {
			if (queued) return;
			queued = true;
			queueMicrotask(() => outbox.enqueue({ seq: 2, id: Buffer.alloc(16, 2), bytes: encodeEnvelope(build(2)) }));
		},
	});
	await outbox.submit(build);
	await until(() => posted.length === 2, 1000, "the second envelope posted");
	await outbox.idle();
	assert.equal(outbox.size, 0);
	await outbox.stop();
});

test("a 408 and a post answer this client cannot read are retried on the same envelope", async () => {
	const failures: unknown[] = [new RelayError(408, "request-timeout"), new ProtocolError(200, "an envelope answer out of shape")];
	const { outbox, attempts, posted, rejected } = rig((call) => { if (call <= failures.length) throw failures[call - 1]; });
	await outbox.submit(build);
	await outbox.idle();
	assert.deepEqual(attempts, [1, 1, 1]);
	assert.deepEqual(posted, [1]);
	assert.equal(rejected.length, 0);
});

test("SLH-F005: reserve, build and save run as one atomic step, and the envelope is queued only after it was saved", async () => {
	const order: string[] = [];
	const o = new Outbox({
		reserveSeq: () => (order.push("reserve"), 3),
		atomically: async (step) => { order.push("lock"); try { return await step(); } finally { order.push("unlock"); } },
		save: (item) => void order.push(`save ${item.seq}`),
		post: async () => void order.push("post"),
	});
	await o.submit((seq) => (order.push(`build ${seq}`), build(seq)));
	await o.idle();
	assert.deepEqual(order, ["lock", "reserve", "build 3", "save 3", "unlock", "post"]);
});
