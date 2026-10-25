import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnvelope, encodeEnvelope } from "../src/link/envelope.ts";
import { NetworkError, RateLimitedError, ServerError, UnauthorizedError } from "../src/link/errors.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { decodeRelayEvent, EventStream, SseParser, type RelayEvent, type SseMessage, type StreamState } from "../src/link/sse.ts";
import { encodeEntry, entryHash } from "../src/link/roster.ts";
import { DEVICES, TEAM, mainLog, teamKey } from "./link/scenario.ts";
import { liveStream, until } from "./link/fakes.ts";

const entries = mainLog();
const rosterData = (i: number) => JSON.stringify({ seq: i, hash: entryHash(entries[i]!).toString("hex"), entry: encodeEntry(entries[i]!).toString("base64url") });
const envelope = (seq: number, kind: "tower" | "presence" = "tower") =>
	buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: { seq: 0, hash: entryHash(entries[0]!) }, from: DEVICES.alice, seq, ts: 1_700_000_000_000 + seq, kind, to: kind === "tower" ? [DEVICES.bob.id] : [], plaintext: kind === "tower" ? encodePlaintext("tower", { fromWorkspace: "w", toWorkspace: "", replyExpected: false, text: `m${seq}` }) : encodePlaintext("presence", { label: "a", headSeq: 0, headHash: entryHash(entries[0]!), workspaces: [] }) });
const envelopeData = (e = envelope(1)) => JSON.stringify({ id: e.header.id.toString("hex"), from: e.header.from, ephemeral: e.header.ephemeral, envelope: encodeEnvelope(e).toString("base64url") });
const frame = (id: number | string, name: string, data: string) => `id: ${id}\nevent: ${name}\ndata: ${data}\n\n`;
const msg = (m: Partial<SseMessage> & { event: string; data: string }): SseMessage => m;

// ---- The parser ----------------------------------------------------------------------------------------------------------------------

test("the parser reads id, event, and data lines and dispatches on a blank line", () => {
	const p = new SseParser();
	assert.deepEqual(p.push("id: 7\nevent: roster\ndata: {\"a\":1}\n\n").messages, [{ id: "7", event: "roster", data: '{"a":1}' }]);
	assert.deepEqual(p.push("data: x\n\n").messages, [{ id: "7", event: "message", data: "x" }], "the id persists until another id line");
});

test("the parser joins data lines with a newline, strips one leading space, and ignores unknown fields and NUL ids", () => {
	const p = new SseParser();
	assert.deepEqual(p.push("data:  two spaces\ndata\ndata: z\nretry: 5\nid: a\0b\nbogus: 1\n\n").messages, [{ event: "message", data: " two spaces\n\nz" }]);
});

test("the parser counts comment lines, which is what a keepalive is, and a blank line alone dispatches nothing", () => {
	const p = new SseParser();
	const out = p.push(": keepalive\n\n: keepalive\n\n");
	assert.equal(out.comments, 2);
	assert.deepEqual(out.messages, []);
});

test("the parser takes LF, CRLF, and CR line ends, and a CRLF split across chunks counts once", () => {
	const wire = "id: 1\r\nevent: a\r\ndata: x\r\n\r\nid: 2\revent: b\rdata: y\r\r";
	const whole = new SseParser().push(wire).messages;
	assert.deepEqual(whole, [{ id: "1", event: "a", data: "x" }, { id: "2", event: "b", data: "y" }]);
	const bytewise: SseMessage[] = [];
	const p = new SseParser();
	for (const ch of wire) bytewise.push(...p.push(ch).messages);
	assert.deepEqual(bytewise, whole);
});

test("the parser drops a BOM at the start and keeps half a line until its end arrives", () => {
	const p = new SseParser();
	assert.deepEqual(p.push("\ufeffdata: he").messages, []);
	assert.deepEqual(p.push("llo\n\n").messages, [{ event: "message", data: "hello" }]);
});

// ---- Decoding relay events -----------------------------------------------------------------------------------------------------------

test("a roster event decodes to the entry and checks seq and hash against its bytes", () => {
	const ev = decodeRelayEvent(msg({ id: "5", event: "roster", data: rosterData(1) }));
	assert.equal(ev?.type, "roster");
	assert.ok(ev?.type === "roster" && ev.eid === 5 && ev.seq === 1 && ev.entry.op === "add" && ev.hash.equals(entryHash(entries[1]!)));
	const wrongHash = JSON.stringify({ ...JSON.parse(rosterData(1)), hash: "00".repeat(32) });
	assert.deepEqual(decodeRelayEvent(msg({ id: "5", event: "roster", data: wrongHash })), { type: "malformed", eid: 5, name: "roster", reason: "hash does not match the entry" });
	const wrongSeq = JSON.stringify({ ...JSON.parse(rosterData(1)), seq: 2 });
	assert.equal(decodeRelayEvent(msg({ id: "5", event: "roster", data: wrongSeq }))?.type, "malformed");
});

test("an envelope event decodes; an id, sender, or flag that disagrees with the bytes is malformed and still names the id", () => {
	const e = envelope(1), ev = decodeRelayEvent(msg({ id: "9", event: "envelope", data: envelopeData(e) }));
	assert.ok(ev?.type === "envelope" && ev.eid === 9 && ev.from === DEVICES.alice.id && !ev.ephemeral && ev.id.equals(e.header.id) && ev.envelope.header.seq === 1);
	const other = envelope(2), wrongId = JSON.parse(envelopeData(e));
	wrongId.envelope = encodeEnvelope(other).toString("base64url");
	const bad = decodeRelayEvent(msg({ id: "9", event: "envelope", data: JSON.stringify(wrongId) }));
	assert.ok(bad?.type === "malformed" && bad.id?.equals(e.header.id));
	const flag = decodeRelayEvent(msg({ id: "9", event: "envelope", data: JSON.stringify({ ...JSON.parse(envelopeData(e)), ephemeral: true }) }));
	assert.equal(flag?.type, "malformed");
	const junk = decodeRelayEvent(msg({ id: "9", event: "envelope", data: JSON.stringify({ ...JSON.parse(envelopeData(e)), envelope: "AAAA" }) }));
	assert.ok(junk?.type === "malformed" && junk.reason === "envelope does not decode" && junk.id?.equals(e.header.id));
});

test("a join event decodes; unknown event names are skipped; a missing or non-numeric id, or bad JSON, is malformed", () => {
	const hash = "ab".repeat(32), request = Buffer.from("sealed").toString("base64url");
	const ev = decodeRelayEvent(msg({ id: "3", event: "join", data: JSON.stringify({ hash, request }) }));
	assert.ok(ev?.type === "join" && ev.hash.toString("hex") === hash && ev.request.toString() === "sealed");
	assert.equal(decodeRelayEvent(msg({ id: "3", event: "future-thing", data: "{}" })), null);
	assert.equal(decodeRelayEvent(msg({ event: "roster", data: rosterData(0) }))?.type, "malformed");
	assert.equal(decodeRelayEvent(msg({ id: "x", event: "roster", data: rosterData(0) }))?.type, "malformed");
	assert.equal(decodeRelayEvent(msg({ id: "3", event: "join", data: "not json" }))?.type, "malformed");
	assert.equal(decodeRelayEvent(msg({ id: "3", event: "join", data: "[1]" }))?.type, "malformed");
	assert.equal(decodeRelayEvent(msg({ id: "3", event: "join", data: JSON.stringify({ hash: "zz", request }) }))?.type, "malformed");
});

// ---- The reader ----------------------------------------------------------------------------------------------------------------------

/** A scripted relay for EventStream: each `open` takes the next connection; the test drives its bytes. */
function harness(o: Partial<ConstructorParameters<typeof EventStream>[0]> = {}) {
	const opens: { lastEventId: number | undefined; conn: ReturnType<typeof liveStream> }[] = [];
	const refusals: unknown[] = [];
	const events: RelayEvent[] = [], acked: string[] = [], states: StreamState[] = [], delays: number[] = [];
	const stream = new EventStream({
		open: async (lastEventId, signal) => {
			const refusal = refusals.shift();
			if (refusal) throw refusal;
			const conn = liveStream(signal);
			opens.push({ lastEventId, conn });
			return conn.response;
		},
		onEvent: (e) => void events.push(e),
		onAck: (id) => void acked.push(id.toString("hex")),
		onState: (s) => {
			states.push(s);
			if (s.state === "retrying") delays.push(s.delayMs);
		},
		sleep: async () => undefined,
		backoff: (n) => n * 10,
		...o,
	});
	return { stream, opens, refusals, events, acked, states, delays };
}

test("events are handed over in order and the cursor follows the last one handled", async () => {
	const h = harness();
	h.stream.start();
	const conn = (await until(() => h.opens[0], 1000, "open")).conn;
	conn.push(frame(1, "roster", rosterData(0)) + frame(2, "roster", rosterData(1)));
	await until(() => h.events.length === 2, 1000, "two events");
	assert.deepEqual(h.events.map((e) => e.type === "roster" && e.seq), [0, 1]);
	assert.equal(h.stream.lastEventId, 2);
	assert.equal(h.opens[0]!.lastEventId, undefined);
	await h.stream.stop();
});

test("a frame split across reads is one event", async () => {
	const h = harness();
	h.stream.start();
	const conn = (await until(() => h.opens[0], 1000, "open")).conn, text = frame(4, "roster", rosterData(0));
	conn.push(text.slice(0, 20));
	conn.push(text.slice(20));
	await until(() => h.events.length === 1, 1000, "the event");
	await h.stream.stop();
});

test("the next event waits for the handler: it is not read, let alone handed over, until the handler returns", async () => {
	let release!: () => void;
	const seen: number[] = [];
	const h = harness({ onEvent: async (e) => { seen.push(e.eid); if (e.eid === 1) await new Promise<void>((r) => { release = r; }); } });
	h.stream.start();
	const conn = (await until(() => h.opens[0], 1000, "open")).conn;
	conn.push(frame(1, "roster", rosterData(0)) + frame(2, "roster", rosterData(1)));
	await until(() => seen.length === 1, 1000, "the first");
	await new Promise((r) => setTimeout(r, 30));
	assert.deepEqual(seen, [1]);
	assert.equal(h.stream.lastEventId, undefined, "an event in the handler's hands has not been taken yet");
	release();
	await until(() => seen.length === 2, 1000, "the second");
	await h.stream.stop();
});

test("an envelope is acknowledged only after the handler says so: not on receipt, not for keep, not for an ephemeral one", async () => {
	let release!: (d: "ack" | "keep") => void;
	const e1 = envelope(1), e2 = envelope(2), e3 = envelope(3, "presence");
	const h = harness({ onEvent: (e) => (e.type === "envelope" && e.envelope.header.seq === 1 ? new Promise<"ack" | "keep">((r) => { release = r; }) : e.type === "envelope" && e.envelope.header.seq === 2 ? "keep" : "ack") });
	h.stream.start();
	const conn = (await until(() => h.opens[0], 1000, "open")).conn;
	conn.push(frame(1, "envelope", envelopeData(e1)));
	await until(() => release, 1000, "handler running");
	await new Promise((r) => setTimeout(r, 30));
	assert.deepEqual(h.acked, [], "received but not yet delivered");
	release("ack");
	await until(() => h.acked.length === 1, 1000, "the ack");
	assert.deepEqual(h.acked, [e1.header.id.toString("hex")]);
	conn.push(frame(2, "envelope", envelopeData(e2)) + frame(3, "envelope", envelopeData(e3)));
	await until(() => h.stream.lastEventId === 3, 1000, "all handled");
	assert.deepEqual(h.acked, [e1.header.id.toString("hex")], "keep and ephemeral are never acknowledged");
	await h.stream.stop();
});

test("a malformed envelope the handler wants gone is acknowledged by its id", async () => {
	const e = envelope(1), bad = { ...JSON.parse(envelopeData(e)), envelope: "AAAA" };
	const h = harness({ onEvent: () => "ack" });
	h.stream.start();
	(await until(() => h.opens[0], 1000, "open")).conn.push(frame(1, "envelope", JSON.stringify(bad)));
	await until(() => h.acked.length === 1, 1000, "ack");
	assert.equal(h.acked[0], e.header.id.toString("hex"));
	await h.stream.stop();
});

test("when the relay ends a stream the reader reconnects with Last-Event-ID and backs off", async () => {
	const h = harness();
	h.stream.start();
	const first = (await until(() => h.opens[0], 1000, "open")).conn;
	first.push(frame(11, "roster", rosterData(0)));
	await until(() => h.events.length === 1, 1000, "event");
	first.end();
	const second = await until(() => h.opens[1], 1000, "reopen");
	assert.equal(second.lastEventId, 11);
	second.conn.end();
	await until(() => h.opens[2], 1000, "reopen again");
	assert.deepEqual(h.delays, [10, 20], "the wait grows when connections end at once");
	await h.stream.stop();
});

test("a connection that stayed up starts the backoff over", async () => {
	const h = harness({ stableMs: 0 });
	h.stream.start();
	(await until(() => h.opens[0], 1000, "open")).conn.end();
	(await until(() => h.opens[1], 1000, "reopen")).conn.end();
	await until(() => h.opens[2], 1000, "reopen again");
	assert.deepEqual(h.delays, [10, 10]);
	await h.stream.stop();
});

test("a stream resumes from the cursor it was given", async () => {
	const h = harness({ lastEventId: 40 });
	h.stream.start();
	assert.equal((await until(() => h.opens[0], 1000, "open")).lastEventId, 40);
	await h.stream.stop();
});

test("a failed open is retried: a network error, a 5xx, and a 429 whose Retry-After sets the floor of the wait", async () => {
	const h = harness();
	h.refusals.push(new NetworkError("down"), new ServerError(503, "unavailable"), new RateLimitedError(429, "rate-limited", undefined, 5000));
	h.stream.start();
	await until(() => h.opens[0], 1000, "connected after three failures");
	assert.deepEqual(h.delays, [10, 20, 5000]);
	await h.stream.stop();
});

test("a refusal that retrying cannot change ends the stream: 401 is how a removed device learns it", async () => {
	const h = harness();
	h.refusals.push(new UnauthorizedError(401, "not-member"));
	const end = await h.stream.start();
	assert.equal(end.reason, "refused");
	assert.ok(end.reason === "refused" && end.error instanceof UnauthorizedError);
	assert.equal(h.opens.length, 0);
	assert.equal(h.states.at(-1)?.state, "closed");
});

test("a quiet connection is dropped after the keepalive timeout and reopened from the cursor", async () => {
	const h = harness({ keepaliveTimeoutMs: 40 });
	h.stream.start();
	const first = await until(() => h.opens[0], 1000, "open");
	first.conn.push(frame(8, "roster", rosterData(0)));
	const second = await until(() => h.opens[1], 1000, "reopen after the silence");
	assert.equal(second.lastEventId, 8);
	await h.stream.stop();
});

test("keepalive comments hold a connection open past the timeout", async () => {
	const h = harness({ keepaliveTimeoutMs: 60 });
	h.stream.start();
	const conn = (await until(() => h.opens[0], 1000, "open")).conn;
	for (let i = 0; i < 6; i++) {
		conn.push(": keepalive\n\n");
		await new Promise((r) => setTimeout(r, 25));
	}
	assert.equal(h.opens.length, 1, "150 ms of comments every 25 ms, a 60 ms timeout: one connection");
	await h.stream.stop();
});

test("a slow handler is not mistaken for a quiet connection", async () => {
	const h = harness({ keepaliveTimeoutMs: 30, onEvent: async () => void (await new Promise((r) => setTimeout(r, 100))) });
	h.stream.start();
	const conn = (await until(() => h.opens[0], 1000, "open")).conn;
	conn.push(frame(1, "roster", rosterData(0)));
	await until(() => h.stream.lastEventId === 1, 1000, "handled");
	assert.equal(h.opens.length, 1);
	await h.stream.stop();
});

test("stop aborts the connection and the wait, resolves 'stopped', and opens nothing more", async () => {
	const h = harness({ sleep: (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }); }), backoff: () => 60_000 });
	h.stream.start();
	const first = await until(() => h.opens[0], 1000, "open");
	first.conn.end();
	await until(() => h.states.some((s) => s.state === "retrying"), 1000, "waiting to retry");
	const end = await h.stream.stop();
	assert.deepEqual(end, { reason: "stopped" });
	assert.equal(h.opens.length, 1);
	assert.equal(h.states.at(-1)?.state, "closed");
	const again = harness();
	again.stream.start();
	await until(() => again.opens[0], 1000, "open");
	assert.deepEqual(await again.stream.stop(), { reason: "stopped" }, "stopping a live connection ends it without an error");
});

test("a handler that throws ends the stream as failed and leaves the cursor before that event", async () => {
	const boom = new Error("inbox is full");
	const h = harness({ onEvent: (e) => { if (e.eid === 2) throw boom; } });
	h.stream.start();
	(await until(() => h.opens[0], 1000, "open")).conn.push(frame(1, "roster", rosterData(0)) + frame(2, "roster", rosterData(1)));
	const end = await h.stream.done;
	assert.ok(end.reason === "failed" && end.error === boom);
	assert.equal(h.stream.lastEventId, 1);
});

test("an event name the client does not know advances the cursor and reaches no handler", async () => {
	const h = harness();
	h.stream.start();
	(await until(() => h.opens[0], 1000, "open")).conn.push(frame(5, "from-the-future", "{}"));
	await until(() => h.stream.lastEventId === 5, 1000, "cursor");
	assert.deepEqual(h.events, []);
	await h.stream.stop();
});
