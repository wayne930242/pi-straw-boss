import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer as listen } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { slotOf } from "../src/server/record.ts";
import { callControl, type Control, ControlError, endpointFor, helloOf, listenControl, newSecret, proofOf, secretMatches } from "../src/server/socket.ts";

// docs/specs/2026-10-26-sb-backend.md, The control socket: every connection opens with hello { secret }, compared in constant time; a connection whose first frame is not a
// matching hello is closed with no answer, and told at most once a minute.

let root = "";
const open: Control[] = [];
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-sock-"))));
afterEach(async () => {
	await Promise.all(open.splice(0).map((c) => c.close()));
	rmSync(root, { recursive: true, force: true });
});
const SECRET = "ab".repeat(32);

async function serve(over: Partial<Parameters<typeof listenControl>[0]> = {}) {
	const refused: string[] = [];
	const control = await listenControl({ endpoint: join(root, "s.sock"), secret: SECRET, hello: () => ({ pid: 7, ready: true }), handle: (r) => ({ ok: true, echo: r.cmd }), refused: (why) => void refused.push(why), ...over });
	open.push(control);
	return { control, refused };
}
/** What a raw connection gets for the lines it writes: the lines back, and whether the server closed the connection. */
function raw(endpoint: string, lines: string[], waitMs = 150) {
	return new Promise<{ got: string[]; closed: boolean }>((resolve) => {
		let got = "", closed = false;
		const conn = createConnection(endpoint).setEncoding("utf8");
		conn.on("connect", () => conn.write(lines.map((l) => `${l}\n`).join("")));
		conn.on("data", (c: string) => (got += c));
		conn.on("close", () => (closed = true));
		conn.on("error", () => {});
		setTimeout(() => (conn.destroy(), resolve({ got: got.split("\n").filter(Boolean), closed })), waitMs);
	});
}

test("a connection with the secret gets the server's facts, then an answer per request, in order", async () => {
	const { control } = await serve({ handle: async (r) => ({ ok: true, echo: r.cmd, n: r.n }) });
	const { proof, ...facts } = (await callControl(control.endpoint, SECRET, undefined)).hello;
	assert.deepEqual(facts, { ok: true, pid: 7, ready: true });
	assert.match(String(proof), /^[0-9a-f]{64}$/, "the answer proves the secret (R8-F004)");
	const { hello, reply } = await callControl(control.endpoint, SECRET, { cmd: "status", n: 1 });
	assert.equal(hello.pid, 7);
	assert.deepEqual(reply, { ok: true, echo: "status", n: 1 });
	const two = await raw(control.endpoint, [JSON.stringify({ cmd: "hello", secret: SECRET }), JSON.stringify({ cmd: "a", n: 1 }), JSON.stringify({ cmd: "b", n: 2 })]);
	assert.deepEqual(two.got.map((l) => JSON.parse(l).echo), [undefined, "a", "b"]);
});

test("sbr-F010: a connection that sends a few KB without a newline before hello is closed; a request after hello may be longer", async () => {
	const { control, refused } = await serve();
	const big = await new Promise<{ closed: boolean }>((resolve) => {
		const conn = createConnection(control.endpoint);
		conn.on("connect", () => conn.write("x".repeat(8192)));
		conn.on("close", () => resolve({ closed: true }));
		conn.on("error", () => {});
		setTimeout(() => (conn.destroy(), resolve({ closed: false })), 300);
	});
	assert.equal(big.closed, true);
	assert.ok(refused.length >= 1);
	const ok = await raw(control.endpoint, [JSON.stringify({ cmd: "hello", secret: SECRET }), JSON.stringify({ cmd: "a", pad: "y".repeat(10_000) })]);
	assert.deepEqual(ok.got.map((l) => JSON.parse(l).echo), [undefined, "a"]);
});

test("sbr-F002: listening at a socket that accepts a connection fails and leaves it be; a socket file nobody listens at is replaced", async () => {
	const { control } = await serve();
	await assert.rejects(listenControl({ endpoint: control.endpoint, secret: SECRET, hello: () => ({ pid: 8 }), handle: () => ({ ok: true }) }), /live|already/);
	assert.equal((await helloOf(control.endpoint, SECRET))?.pid, 7);
	await control.close();
	writeFileSync(control.endpoint, "left by a server that died");
	const again = await listenControl({ endpoint: control.endpoint, secret: SECRET, hello: () => ({ pid: 9 }), handle: () => ({ ok: true }) });
	open.push(again);
	assert.equal((await helloOf(again.endpoint, SECRET))?.pid, 9);
});

test("a wrong secret, or a first frame that is not hello, is closed with no answer", async () => {
	const { control, refused } = await serve();
	await assert.rejects(callControl(control.endpoint, "00".repeat(32), { cmd: "status" }), (e: unknown) => e instanceof ControlError && e.failure === "refused");
	assert.equal(await helloOf(control.endpoint, "wrong"), undefined);
	const noHello = await raw(control.endpoint, [JSON.stringify({ cmd: "status" })]);
	assert.deepEqual(noHello, { got: [], closed: true });
	const notJson = await raw(control.endpoint, ["not json"]);
	assert.deepEqual(notJson, { got: [], closed: true });
	const wrong = await raw(control.endpoint, [JSON.stringify({ cmd: "hello", secret: "nope" }), JSON.stringify({ cmd: "status" })]);
	assert.deepEqual(wrong, { got: [], closed: true }, "no answer to the request that came behind it either");
	assert.ok(refused.length >= 1);
});

test("refused connections are told at most once a minute, without the secret", async () => {
	let now = 1_000_000;
	const { control, refused } = await serve({ now: () => now });
	for (let i = 0; i < 4; i++) await helloOf(control.endpoint, `bad${i}`);
	assert.equal(refused.length, 1);
	assert.ok(refused.every((why) => !why.includes("bad") && !why.includes(SECRET)));
	now += 61_000;
	await helloOf(control.endpoint, "later");
	assert.equal(refused.length, 2);
});

test("a handler that throws answers an error and the connection goes on", async () => {
	const { control } = await serve({ handle: (r) => { if (r.cmd === "boom") throw new Error("it broke"); return { ok: true }; } });
	assert.deepEqual((await callControl(control.endpoint, SECRET, { cmd: "boom" })).reply, { ok: false, error: "it broke" });
	assert.deepEqual((await callControl(control.endpoint, SECRET, { cmd: "fine" })).reply, { ok: true });
});

test("the socket is mode 600, a leftover file is replaced, and closing removes it", async () => {
	const endpoint = join(root, "s.sock");
	const first = await serve();
	assert.equal(statSync(endpoint).mode & 0o777, 0o600);
	await first.control.close();
	assert.equal(existsSync(endpoint), false);
	const again = await serve();
	assert.ok(await helloOf(again.control.endpoint, SECRET));
});

test("nothing listening is no-server, and a silent server times out", async () => {
	await assert.rejects(callControl(join(root, "none.sock"), SECRET, undefined, 500), (e: unknown) => e instanceof ControlError && e.failure === "no-server");
	const { control } = await serve({ handle: () => new Promise(() => {}) });
	await assert.rejects(callControl(control.endpoint, SECRET, { cmd: "hang" }, 300), (e: unknown) => e instanceof ControlError && e.failure === "timeout");
});

test("the secret is 32 random bytes in hex, made anew each time, and compared whole", () => {
	assert.match(newSecret(), /^[0-9a-f]{64}$/);
	assert.notEqual(newSecret(), newSecret());
	assert.equal(secretMatches(SECRET, SECRET), true);
	assert.equal(secretMatches(`${SECRET}0`, SECRET), false);
	assert.equal(secretMatches(SECRET.slice(1), SECRET), false);
	assert.equal(secretMatches(undefined, SECRET), false);
	assert.equal(secretMatches("", ""), false, "an empty secret opens nothing");
});

test("the endpoint: server.sock in the slot's folder; a pipe with a random name on Windows; a short private folder when the path is too long for a socket", () => {
	const slot = slotOf(root, { HOME: "/h" }, "linux");
	assert.equal(endpointFor(slot, "linux"), join(root, "server.sock"));
	assert.match(endpointFor(slot, "win32"), /^\\\\\.\\pipe\\sb-[0-9a-f]{16}$/);
	assert.notEqual(endpointFor(slot, "win32"), endpointFor(slot, "win32"));
	const deep = slotOf(join(root, "x".repeat(120)), { HOME: "/h" }, "linux");
	const short = endpointFor(deep, "linux");
	assert.ok(Buffer.byteLength(short) <= 100, short);
	assert.match(short, /^\/tmp\/sb-\d+\/[0-9a-f]{16}\.sock$/);
	assert.equal(statSync(join(short, "..")).mode & 0o077, 0, "the folder is the user's alone");
	assert.equal(endpointFor(deep, "linux"), short, "the same slot always gets the same path");
	assert.notEqual(endpointFor(slotOf(join(root, "y".repeat(120)), { HOME: "/h" }, "linux"), "linux"), short);
	rmSync(short, { force: true });
});

// --- R8-F004: the hello answer proves the secret ---

test("R8-F004: the proof is an HMAC of the client's nonce and the pid under the secret: it differs by secret, nonce and pid; a client with no nonce gets none", async () => {
	assert.equal(proofOf("s", "n", 7), proofOf("s", "n", 7));
	for (const other of [proofOf("t", "n", 7), proofOf("s", "m", 7), proofOf("s", "n", 8)]) assert.notEqual(other, proofOf("s", "n", 7));
	const { control } = await serve({ handle: async () => ({ ok: true }) });
	const bare = await raw(control.endpoint, [JSON.stringify({ cmd: "hello", secret: SECRET })]);
	assert.ok(!JSON.stringify(bare).includes("proof"));
});

test("R8-F004: a responder at the endpoint that does not know the secret (no proof, or a proof under another secret) is refused by the client, not taken for the server", async () => {
	for (const make of [() => ({ ok: true, pid: 7, ready: true }), (nonce: string) => ({ ok: true, pid: 7, ready: true, proof: proofOf("not the secret", nonce, 7) }), (nonce: string) => ({ ok: true, pid: 7, ready: true, proof: proofOf(SECRET, nonce, 8) })]) {
		const dir = mkdtempSync(join(tmpdir(), "psb-fake-"));
		const endpoint = join(dir, "fake.sock");
		const fake = listen((conn) => conn.on("data", (chunk) => conn.write(`${JSON.stringify(make(String(JSON.parse(String(chunk).split("\n")[0]!).nonce)))}\n`)));
		await new Promise<void>((resolve) => fake.listen(endpoint, resolve));
		try {
			await assert.rejects(callControl(endpoint, SECRET, undefined, 1000), (e: unknown) => (e as { failure?: string }).failure === "refused" && /does not prove/.test((e as Error).message));
			assert.equal(await helloOf(endpoint, SECRET, 1000), undefined);
		} finally {
			await new Promise<void>((resolve) => fake.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
