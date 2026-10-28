import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { fileOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { baseId, hashOf, openSeen, SEEN_KEEP_MS, SEEN_MAX } from "../src/server/towerseen.ts";
import { readQueue, towerDir } from "../src/server/towerstore.ts";

// The queue of the tower service (docs/specs/2026-10-26-sb-backend.md, Queueing and concurrency; B5): the receipt goes after the fsync, a retry already taken is not queued twice and still gets its
// receipt, the same base id with other text is dropped, and the file `seen.jsonl` is seeded from what B4 queued (no `seen.jsonl`, `~r<n>` kept in the ids, events a day old).

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const started = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await world.start(over);
	await s.handle.ready;
	return s;
};
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });

test("the receipt `queued` goes only after the event is on disk, and registration promises receipts", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const tower = world.client("sb-tower-wa")!;
	assert.equal(tower.registered?.acknowledgesReceipts, true);
	const queuedAtReceipt: number[] = [];
	tower.onReceipt = () => queuedAtReceipt.push(readQueue(world.slot, "wA").length);
	tower.incoming(from, msg("m1", "hello"));
	await until(() => tower.receipts.length === 1, "the receipt");
	assert.deepEqual(tower.receipts.map((r) => [r.messageId, r.status]), [["m1", "queued"]]);
	assert.deepEqual(queuedAtReceipt, [1], "the file was there when the receipt went");
});

test("a retry already taken is not queued again and still gets its receipt; the same base id with other text is dropped, logged, and not receipted", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const tower = world.client("sb-tower-wa")!;
	tower.incoming(from, msg("m1", "first"));
	await until(() => tower.receipts.length === 1, "first receipt");
	tower.incoming(from, msg("m1~r1", "first"));
	await until(() => tower.receipts.length === 2, "the retry's receipt");
	assert.equal(tower.receipts[1]!.messageId, "m1~r1");
	assert.equal(readQueue(world.slot, "wA").length, 1);
	tower.incoming(from, msg("m1~r2", "other text entirely"));
	await sleep(60);
	assert.equal(readQueue(world.slot, "wA").length, 1, "dropped");
	assert.equal(tower.receipts.length, 2, "no receipt for a dropped message");
	assert.match(logText(), /tower-dropped/);
	assert.ok(!logText().includes("other text entirely"));
	// Another sender with the same id is another message.
	tower.incoming({ id: "main-2" }, msg("m1", "first"));
	await until(() => readQueue(world.slot, "wA").length === 2, "another sender's message queued");
});

test("a server killed between the event and its receipt: the sender's retry, after the restart, is delivered once", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const tower = world.client("sb-tower-wa")!;
	tower.sendMessageReceipt = () => { throw new Error("socket gone"); }; // the process dies here
	tower.incoming(from, msg("m7", "do the thing"));
	await until(() => readQueue(world.slot, "wA").length === 1, "queued");
	await s.handle.shutdown(0);
	await s.handle.done;
	world.clients.length = 0;
	const second = await world.start();
	await second.handle.ready;
	const again = world.clients.find((c) => c.sessionId === "sb-tower-wa")!;
	again.incoming(from, msg("m7~r1", "do the thing"));
	await until(() => again.receipts.length === 1, "the retry's receipt");
	assert.equal(readQueue(world.slot, "wA").length, 1, "one event");
});

test("B4's backlog: events queued without a seen.jsonl, with the ~r<n> kept in their ids, seed the dedupe at the service's start", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const tower = world.client("sb-tower-wa")!;
	tower.incoming(from, msg("m9~r1", "backlog text")); // what B4 would have written: the id as received, no seen.jsonl
	await until(() => readQueue(world.slot, "wA").length === 1, "queued");
	await s.handle.shutdown(0);
	await s.handle.done;
	writeFileSync(join(towerDir(world.slot, "wA"), "seen.jsonl"), ""); // B4 wrote none
	world.clients.length = 0;
	const second = await world.start();
	await second.handle.ready;
	const again = world.clients.find((c) => c.sessionId === "sb-tower-wa")!;
	again.incoming(from, msg("m9", "backlog text"));
	await until(() => again.receipts.length === 1, "receipt");
	assert.equal(readQueue(world.slot, "wA").length, 1, "the retry's base id is known");
});

// --- towerseen.ts ----------------------------------------------------------------------------------------------------------------------------------------------------

test("baseId strips only the retry suffix", () => {
	assert.equal(baseId("straw-boss-x-1-2~r3"), "straw-boss-x-1-2");
	assert.equal(baseId("a~r1b"), "a~r1b");
	assert.equal(baseId("a~r"), "a~r");
});

test("seen keeps 48 h and 5,000 entries, oldest first out, and the file survives a reopen", () => {
	const slot = world.slot;
	mkdirSync(towerDir(slot, "wA"), { recursive: true });
	let now = 1_000_000_000_000;
	const seen = openSeen(slot, "wA", () => now);
	seen.add("a", "old", "t");
	now += SEEN_KEEP_MS + 1;
	seen.add("a", "new", "t");
	assert.equal(seen.check("a", "old", "t"), "new", "the old one aged out");
	assert.equal(seen.check("a", "new~r1", "t"), "seen");
	assert.equal(seen.check("a", "new", "other"), "conflict");
	assert.equal(openSeen(slot, "wA", () => now).check("a", "new", "t"), "seen", "read back from the file");
	const big = openSeen(world.slot, "wB", () => now);
	for (let n = 0; n < SEEN_MAX + 5; n++) big.add("a", `m${n}`, "t");
	assert.equal(big.size(), SEEN_MAX);
	assert.equal(big.check("a", "m0", "t"), "new");
	assert.equal(big.check("a", `m${SEEN_MAX + 4}`, "t"), "seen");
	appendFileSync(join(towerDir(slot, "wB"), "seen.jsonl"), "not json\n");
	assert.equal(openSeen(slot, "wB", () => now).size(), SEEN_MAX, "a bad line is skipped");
	assert.equal(hashOf("x").length, 64);
});
