import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { enc, str } from "../src/link/canon.ts";
import { requestBytes, verifyBytes } from "../src/link/crypto.ts";
import { buildEnvelope, encodeEnvelope } from "../src/link/envelope.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { BadRequestError, ConflictError, ForbiddenError, NetworkError, NotFoundError, PayloadTooLargeError, ProtocolError, RateLimitedError, RelayError, ServerError, UnauthorizedError, UnprocessableError } from "../src/link/errors.ts";
import { RelayClient } from "../src/link/relay.ts";
import { entryHash, encodeEntry } from "../src/link/roster.ts";
import { DEVICES, TEAM, mainLog, teamKey } from "./link/scenario.ts";
import { json, noSleep, scriptedFetch, type Answer } from "./link/fakes.ts";

const A = DEVICES.alice, URL_ = "http://127.0.0.1:9999", NOW = 1_700_000_000_000, HEX = TEAM.toString("hex");
const client = (...script: Answer[]) => {
	const f = scriptedFetch(...script);
	return { ...f, c: new RelayClient({ url: URL_, device: A, fetch: f.fetch, now: () => NOW, timeoutMs: 1000 }) };
};
const entries = mainLog();
const row = (i: number) => ({ seq: i, hash: entryHash(entries[i]!).toString("hex"), entry: encodeEntry(entries[i]!).toString("base64url") });
const head = (i: number) => ({ seq: i, hash: entryHash(entries[i]!).toString("hex") });

test("every signed request carries the device, the time, and an Ed25519 signature over the spec's request bytes", async () => {
	const { c, seen } = client(json(200, { head: head(1), entries: [row(0), row(1)] }));
	await c.getRoster(TEAM, 0);
	const call = seen[0]!;
	assert.equal(call.method, "GET");
	assert.equal(call.url.pathname + call.url.search, `/v1/teams/${HEX}/roster?after=0`);
	assert.equal(call.headers.get("x-straw-device"), A.id);
	assert.equal(call.headers.get("x-straw-time"), String(NOW));
	const sig = Buffer.from(call.headers.get("x-straw-sig")!, "hex");
	assert.equal(sig.length, 64);
	assert.ok(verifyBytes(A.signPub, requestBytes({ team: TEAM, method: "GET", path: `/v1/teams/${HEX}/roster?after=0`, time: NOW, body: Buffer.alloc(0) }), sig));
	assert.ok(!verifyBytes(A.signPub, requestBytes({ team: TEAM, method: "GET", path: `/v1/teams/${HEX}/roster`, time: NOW, body: Buffer.alloc(0) }), sig), "the query is part of what is signed");
});

test("the signature covers sha256 of the body bytes that are sent", async () => {
	const { c, seen } = client(json(201, { seq: 1, hash: head(1).hash }));
	await c.appendRoster(TEAM, entries[1]!);
	const call = seen[0]!;
	assert.equal(call.method, "POST");
	assert.deepEqual(JSON.parse(call.body.toString()), { entry: encodeEntry(entries[1]!).toString("base64url") });
	const sig = Buffer.from(call.headers.get("x-straw-sig")!, "hex");
	assert.ok(verifyBytes(A.signPub, requestBytes({ team: TEAM, method: "POST", path: `/v1/teams/${HEX}/roster`, time: NOW, body: call.body }), sig));
	assert.equal(createHash("sha256").update(call.body).digest("hex").length, 64);
});

test("create team posts {team, token, entry} signed for that team, and returns the head", async () => {
	const { c, seen } = client(json(201, { team: HEX, head: head(0) }));
	const got = await c.createTeam({ team: TEAM, token: "srt1_abc", entry: entries[0]! });
	assert.equal(got.seq, 0);
	assert.ok(got.hash.equals(entryHash(entries[0]!)));
	const call = seen[0]!;
	assert.equal(call.url.pathname, "/v1/teams");
	assert.deepEqual(JSON.parse(call.body.toString()), { team: HEX, token: "srt1_abc", entry: encodeEntry(entries[0]!).toString("base64url") });
	assert.ok(verifyBytes(A.signPub, requestBytes({ team: TEAM, method: "POST", path: "/v1/teams", time: NOW, body: call.body }), Buffer.from(call.headers.get("x-straw-sig")!, "hex")));
});

test("roster read decodes every entry and checks its hash and seq against what the relay said", async () => {
	const { c } = client(json(200, { head: head(2), entries: [row(0), row(1), row(2)] }));
	const got = await c.getRoster(TEAM);
	assert.equal(got.head.seq, 2);
	assert.deepEqual(got.entries.map((e) => e.seq), [0, 1, 2]);
	assert.ok(got.entries[1]!.hash.equals(entryHash(entries[1]!)));
	assert.equal(got.entries[2]!.entry.op, "add");
	const bad = client(json(200, { head: head(1), entries: [{ ...row(0), hash: "00".repeat(32) }] }));
	await assert.rejects(bad.c.getRoster(TEAM), ProtocolError);
	const junk = client(json(200, { head: head(0), entries: [{ seq: 0, hash: head(0).hash, entry: "AAAA" }] }));
	await assert.rejects(junk.c.getRoster(TEAM), ProtocolError);
});

test("a roster append that lost the race is a ConflictError carrying the head", async () => {
	const { c } = client(json(409, { error: "conflict", head: head(3) }));
	const error = await c.appendRoster(TEAM, entries[1]!).catch((e) => e);
	assert.ok(error instanceof ConflictError);
	assert.equal(error.status, 409);
	assert.equal(error.code, "conflict");
	assert.equal(error.head?.seq, 3);
	assert.ok(error.head!.hash.equals(entryHash(entries[3]!)));
});

test("every status the relay answers with becomes its own typed error", async () => {
	const cases: [number, unknown, new (...args: never[]) => RelayError, Record<string, string>?][] = [
		[400, { error: "bad-json" }, BadRequestError],
		[401, { error: "not-member" }, UnauthorizedError],
		[403, { error: "not-signer" }, ForbiddenError],
		[404, { error: "no-invite" }, NotFoundError],
		[409, { error: "invite-used" }, ConflictError],
		[413, { error: "body-too-large" }, PayloadTooLargeError],
		[422, { error: "bad-epoch", seq: 4 }, UnprocessableError],
		[429, { error: "rate-limited" }, RateLimitedError, { "retry-after": "60" }],
		[500, { error: "internal" }, ServerError],
		[503, "upstream down", ServerError],
	];
	for (const [status, body, type, headers] of cases) {
		const { c } = client(json(status, body, headers));
		const error = await c.postEnvelope(TEAM, Buffer.from("x")).catch((e) => e);
		assert.ok(error instanceof type, `${status} → ${error?.constructor?.name}`);
		assert.equal(error.status, status);
		assert.equal(error.code, typeof body === "object" ? (body as { error: string }).error : "unknown");
		assert.ok(error instanceof RelayError);
	}
	const limited = await client(json(429, { error: "team-full" }, { "retry-after": "60" })).c.postEnvelope(TEAM, Buffer.from("x")).catch((e) => e);
	assert.equal(limited.retryAfterMs, 60_000);
	const refused = await client(json(422, { error: "bad-epoch", seq: 4 })).c.postEnvelope(TEAM, Buffer.from("x")).catch((e) => e);
	assert.equal(refused.seq, 4);
});

test("a call that never gets an answer is a NetworkError, and a slow one times out as one", async () => {
	const down = client(new TypeError("fetch failed"));
	await assert.rejects(down.c.getRoster(TEAM), NetworkError);
	const slow = scriptedFetch(({ signal }) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))));
	const c = new RelayClient({ url: URL_, device: A, fetch: slow.fetch, now: () => NOW, timeoutMs: 30 });
	await assert.rejects(c.getRoster(TEAM), NetworkError);
});

test("a caller's abort is not wrapped: it comes out as the abort", async () => {
	const slow = scriptedFetch(({ signal }) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))));
	const c = new RelayClient({ url: URL_, device: A, fetch: slow.fetch, now: () => NOW, timeoutMs: 5000 });
	const controller = new AbortController();
	const p = c.getRoster(TEAM, undefined, controller.signal).catch((e) => e);
	controller.abort();
	const error = await p;
	assert.ok(!(error instanceof RelayError));
	assert.equal(error.name, "AbortError");
});

test("a success body that is not what the relay documents is a ProtocolError", async () => {
	await assert.rejects(client(new Response("<html>", { status: 200 })).c.getRoster(TEAM), ProtocolError);
	await assert.rejects(client(json(201, { seq: "x" })).c.appendRoster(TEAM, entries[1]!), ProtocolError);
});

test("an envelope is posted as base64url of its bytes; the result tells a duplicate from a stale ephemeral", async () => {
	const env = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: { seq: 0, hash: entryHash(entries[0]!) }, from: A, seq: 1, ts: NOW, kind: "tower", to: [DEVICES.bob.id], plaintext: encodePlaintext("tower", { fromWorkspace: "w", toWorkspace: "", replyExpected: false, text: "hi" }) });
	const id = env.header.id.toString("hex");
	const { c, seen } = client(json(201, { id, duplicate: false }), json(200, { id, duplicate: true }), json(200, { id, duplicate: false, stale: true }));
	const first = await c.postEnvelope(TEAM, env);
	assert.deepEqual({ ...first, id: first.id.toString("hex") }, { id, duplicate: false, stale: false });
	assert.deepEqual(JSON.parse(seen[0]!.body.toString()), { envelope: encodeEnvelope(env).toString("base64url") });
	assert.equal((await c.postEnvelope(TEAM, env)).duplicate, true);
	assert.equal((await c.postEnvelope(TEAM, env)).stale, true);
});

test("acks go out in batches of at most 500 ids", async () => {
	const ids = Array.from({ length: 1100 }, () => randomBytes(16));
	const { c, seen } = client(json(200, { acked: 500 }), json(200, { acked: 500 }), json(200, { acked: 100 }));
	assert.equal(await c.ack(TEAM, ids), 1100);
	assert.deepEqual(seen.map((s) => JSON.parse(s.body.toString()).ids.length), [500, 500, 100]);
	assert.equal(seen[0]!.url.pathname, `/v1/teams/${HEX}/acks`);
	assert.equal(JSON.parse(seen[0]!.body.toString()).ids[0], ids[0]!.toString("hex"));
});

test("an invite is held by its hash with an expiry, signed; a join request needs no signature", async () => {
	const secret = randomBytes(32), h = createHash("sha256").update(secret).digest();
	const { c, seen } = client(json(201, { expires: NOW + 600_000 }), json(202, { queued: true }));
	assert.equal(await c.createInvite({ team: TEAM, hash: h, expires: NOW + 600_000 }), NOW + 600_000);
	assert.deepEqual(JSON.parse(seen[0]!.body.toString()), { team: HEX, h: h.toString("hex"), expires: NOW + 600_000 });
	assert.ok(seen[0]!.headers.get("x-straw-sig"));
	await c.join(h, Buffer.from("sealed"));
	assert.equal(seen[1]!.url.pathname, `/v1/invites/${h.toString("hex")}/join`);
	assert.deepEqual(JSON.parse(seen[1]!.body.toString()), { request: Buffer.from("sealed").toString("base64url") });
	assert.equal(seen[1]!.headers.get("x-straw-sig"), null);
});

test("waitForMembership polls the roster until the relay stops answering not-member, and stops on any other refusal", async () => {
	const notYet = () => json(401, { error: "not-member" });
	const ok = json(200, { head: head(1), entries: [row(0), row(1)] });
	const { c, seen } = client(notYet(), notYet(), ok);
	const got = await c.waitForMembership(TEAM, { intervalMs: 1, sleep: noSleep });
	assert.equal(seen.length, 3);
	assert.equal(got.entries.length, 2);
	const forged = client(notYet(), json(401, { error: "bad-signature" }));
	await assert.rejects(forged.c.waitForMembership(TEAM, { intervalMs: 1, sleep: noSleep }), UnauthorizedError);
	const controller = new AbortController(), aborted = client(notYet());
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(aborted.c.waitForMembership(TEAM, { intervalMs: 5, signal: controller.signal }), { name: "AbortError" });
});

test("a relay URL with a path is refused: the signed target is the path the relay sees", () => {
	assert.throws(() => new RelayClient({ url: "https://relay.example/prefix", device: A }), /path/);
	assert.doesNotThrow(() => new RelayClient({ url: "https://relay.example/", device: A }));
	assert.throws(() => new RelayClient({ url: "not a url", device: A }));
	assert.equal(enc(str("x")).length, 5);
});

test("Retry-After is whole seconds only, and a huge one is clamped so a timer cannot overflow", async () => {
	const after = async (value: string) => (await client(json(429, { error: "rate-limited" }, { "retry-after": value })).c.postEnvelope(TEAM, Buffer.from("x")).catch((e) => e)).retryAfterMs;
	assert.equal(await after("60"), 60_000);
	assert.equal(await after("99999999"), 600_000);
	for (const odd of ["1e3", "0x10", "-5", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", ""]) assert.equal(await after(odd), undefined, JSON.stringify(odd));
});

test("a relay URL has to be http or https", () => {
	for (const url of ["file:///etc/passwd", "ws://relay.example", "wss://relay.example", "ftp://relay.example"]) assert.throws(() => new RelayClient({ url, device: A }), /http/, url);
	assert.doesNotThrow(() => new RelayClient({ url: "http://127.0.0.1:9999", device: A }));
});

const bodyOf = (chunks: number, size: number, status = 200) => new Response(new ReadableStream<Uint8Array>({
	pull(c) {
		if (chunks-- <= 0) return c.close();
		c.enqueue(new Uint8Array(size).fill(0x20));
	},
}), { status });

test("an ordinary answer or error body over 64 KiB is a ProtocolError, read only as far as the cap", async () => {
	let pulled = 0;
	const endless = () => new Response(new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(16_384).fill(0x20)); } }), { status: 200 });
	const ok = await client(endless).c.postEnvelope(TEAM, Buffer.from("x")).catch((e) => e);
	assert.ok(ok instanceof ProtocolError, String(ok));
	assert.ok(pulled < 20, `read ${pulled} chunks of an endless body`);
	const failed = await client(() => bodyOf(8, 16_384, 500)).c.postEnvelope(TEAM, Buffer.from("x")).catch((e) => e);
	assert.ok(failed instanceof ProtocolError, "an error body over the cap");
});

test("a roster answer may be larger, up to 16 MiB", async () => {
	const pad = " ".repeat(200_000);
	const { c } = client(() => new Response(JSON.stringify({ head: head(1), entries: [row(0), row(1)] }) + pad));
	assert.equal((await c.getRoster(TEAM)).entries.length, 2, "200 KB is over the ordinary cap but not the roster's");
	const huge = client(() => bodyOf(20, 1024 * 1024));
	await assert.rejects(huge.c.getRoster(TEAM), ProtocolError);
});
