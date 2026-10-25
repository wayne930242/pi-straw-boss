import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { holderAlive, LinkElection, outranks, type Candidate } from "../src/link/election.ts";
import { LinkStore } from "../src/link/store.ts";

// R-F026: the link holder has its own record and lock, not the GUI server's. Candidates are joined pi sessions, towers first; a newer
// pi-straw-boss takes over; when the holder ends the next candidate takes over within a tick; one long-lived tower is enough.

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-link-election-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Sessions that end by name: the fake processes of one test process share its pid. */
const gone = new Set<string>();
interface Sess { election: LinkElection; gained: number; lost: number; store: LinkStore }
function session(id: string, over: Partial<Candidate> = {}): Sess {
	const store = new LinkStore(join(root, "link"), { alive: () => true });
	store.ensure();
	const out = { gained: 0, lost: 0, store } as Sess;
	out.election = new LinkElection({
		store, alive: (r) => !gone.has(r.session), now: () => 1000,
		self: () => ({ session: id, version: "0.43.0", tower: false, pid: process.pid, ...over }),
		onGain: () => void out.gained++, onLose: () => void out.lost++,
	});
	return out;
}
afterEach(() => gone.clear());

test("outranks: a newer pi-straw-boss wins, then a tower over a session that is not one; equals never outrank", () => {
	const a = (version: string, tower: boolean) => ({ version, tower });
	assert.ok(outranks(a("0.43.1", false), a("0.43.0", true)));
	assert.ok(outranks(a("0.44.0", false), a("0.43.9", true)));
	assert.ok(outranks(a("0.43.0", true), a("0.43.0", false)));
	assert.ok(!outranks(a("0.43.0", false), a("0.43.0", true)));
	assert.ok(!outranks(a("0.43.0", true), a("0.43.0", true)));
	assert.ok(!outranks(a("0.43.0", false), a("0.43.1", true)));
});

test("one long-lived tower, the only candidate, takes the record at its first look and keeps it", async () => {
	const tower = session("tower", { tower: true });
	assert.equal(await tower.election.tick(), "holder");
	for (let i = 0; i < 5; i++) assert.equal(await tower.election.tick(), "holder");
	assert.equal(tower.gained, 1);
	assert.equal(tower.lost, 0);
	const record = tower.store.readHolder()!;
	assert.deepEqual([record.session, record.tower, record.pid, record.version], ["tower", true, process.pid, "0.43.0"]);
});

test("a tower is taken first: a session that is not a tower waits one more look before it takes a vacant record", async () => {
	const member = session("member"), tower = session("tower", { tower: true });
	assert.equal(await member.election.tick(), "candidate", "first look: the tower may still come");
	assert.equal(await tower.election.tick(), "holder");
	assert.equal(await member.election.tick(), "candidate");
	const lone = session("lone");
	rmSync(join(root, "link", "holder.json"));
	assert.equal(await lone.election.tick(), "candidate");
	assert.equal(await lone.election.tick(), "holder", "second look: nobody else came");
});

test("a live holder is left alone by an equal or lesser candidate", async () => {
	const first = session("first", { tower: true }), second = session("second", { tower: true }), member = session("member");
	await first.election.tick();
	for (let i = 0; i < 4; i++) {
		assert.equal(await second.election.tick(), "candidate");
		assert.equal(await member.election.tick(), "candidate");
	}
	assert.equal(first.store.readHolder()!.session, "first");
	assert.equal(first.gained + second.gained + member.gained, 1);
});

test("when the holder's session ends the next candidate takes over at its next look; a record whose process is gone is dead", async () => {
	const first = session("first", { tower: true }), second = session("second", { tower: true });
	await first.election.tick();
	await second.election.tick();
	gone.add("first");
	assert.equal(await second.election.tick(), "holder");
	assert.equal(second.gained, 1);
	assert.equal(second.store.readHolder()!.session, "second");
});

test("a clean end releases the record, and only the holder's own", async () => {
	const first = session("first", { tower: true }), second = session("second", { tower: true });
	await first.election.tick();
	await second.election.release();
	assert.equal(first.store.readHolder()!.session, "first", "a candidate that was never the holder removes nothing");
	await first.election.release();
	assert.equal(first.store.readHolder(), undefined);
	assert.equal(first.lost, 1);
	assert.equal(first.election.holding, false);
	assert.equal(await second.election.tick(), "holder");
});

test("a session on a newer pi-straw-boss takes over a live holder at once, and the old holder learns it at its next look", async () => {
	const old = session("old", { tower: true }), fresh = session("fresh", { version: "0.43.1" });
	await old.election.tick();
	assert.equal(await fresh.election.tick(), "holder", "a newer build does not wait, tower or not");
	assert.equal(old.election.isHolder(), false, "the record no longer names it, before it has looked");
	assert.equal(await old.election.tick(), "candidate");
	assert.equal(old.lost, 1);
	assert.equal(old.election.holding, false);
	assert.equal(await old.election.tick(), "candidate", "an older build never takes it back");
});

test("a tower takes the record from a session that is not a tower on the same build, and a session that is not a tower never takes it from a tower", async () => {
	const member = session("member"), tower = session("tower", { tower: true });
	await member.election.tick();
	await member.election.tick();
	assert.equal(member.store.readHolder()!.session, "member");
	assert.equal(await tower.election.tick(), "holder");
	assert.equal(await member.election.tick(), "candidate");
	assert.equal(member.lost, 1);
	for (let i = 0; i < 3; i++) assert.equal(await member.election.tick(), "candidate");
	assert.equal(tower.store.readHolder()!.session, "tower");
});

test("candidates that look at the same moment make one holder", async () => {
	const all = ["a", "b", "c", "d"].map((id) => session(id, { tower: true }));
	const verdicts = await Promise.all(all.map((s) => s.election.tick()));
	assert.equal(verdicts.filter((v) => v === "holder").length, 1);
	assert.equal(all.reduce((n, s) => n + s.gained, 0), 1);
	const named = all.find((s) => s.election.isHolder())!;
	assert.ok(named);
	assert.equal(all.filter((s) => s.election.isHolder()).length, 1);
});

test("holderAlive: the process lives and is the one that wrote the record (same start time), or ps cannot say", () => {
	const rec = { session: "s", version: "1", pid: 4242, started: "Mon Oct 26 00:00:00 2026", tower: true, since: 1 };
	assert.equal(holderAlive(() => true, () => "Mon Oct 26 00:00:00 2026")(rec), true);
	assert.equal(holderAlive(() => true, () => "Tue Oct 27 00:00:00 2026")(rec), false, "the pid was reused");
	assert.equal(holderAlive(() => false, () => undefined)(rec), false);
	assert.equal(holderAlive(() => true, () => undefined)(rec), true, "ps cannot say: the record stands");
	assert.equal(holderAlive(() => true, () => "anything")({ ...rec, started: undefined }), true);
});

test("SLH-F002: a holder that fails to start gives the record back, so the next look takes it again and the failure is thrown to the caller", async () => {
	const store = new LinkStore(join(root, "link"), { alive: () => true });
	store.ensure();
	let gains = 0;
	const election = new LinkElection({
		store, alive: () => true, now: () => 1000, self: () => ({ session: "tower", version: "0.43.0", tower: true, pid: process.pid }),
		onGain: () => { if (++gains === 1) throw new Error("the lock was not free"); }, onLose: () => {},
	});
	await assert.rejects(election.tick(), /the lock was not free/);
	assert.equal(election.holding, false);
	assert.equal(store.readHolder(), undefined, "the record is not kept by a holder that never ran");
	assert.equal(await election.tick(), "holder");
	assert.equal(gains, 2);
	assert.equal(store.readHolder()?.session, "tower");
});
