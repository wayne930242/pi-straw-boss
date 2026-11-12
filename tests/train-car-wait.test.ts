import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createReturnWatch, type ReturnWait } from "../src/carwait.ts";
import { CarBook } from "../src/server/carbook.ts";
import { CarNotices, type Intercom } from "../src/server/carnotices.ts";
import { coordinatorWord } from "../src/train/cars.ts";
import { type CarCtx, type CarToolDeps, trainCar } from "../src/traincar.ts";
import { carWorld, type CarWorld, COORD, INTEG } from "./train-car-rig.ts";
import { CODE } from "./train-fixtures.ts";
import { forwardEntry, slipBlock } from "./train-guard-rig.ts";

// The integrator's wait for the notice of a car it returned (src/carwait.ts; issue #13): nothing else waits for that notice, so the session that set the state asks the server's book until it is told, and calls the tower when the server
// started again and holds the car no more. On the real book and sender, and a clock the test moves.

const worlds: CarWorld[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.done()));
const SECOND = 1000, TOWER = "sb-tower-wa";

function setup(waits: ReturnWait[] = []) {
	const w = carWorld();
	worlds.push(w);
	const sessions = [{ id: COORD, name: "docs-main" }, { id: TOWER, name: "tower" }], sent: { to: string; text: string }[] = [];
	const server = { answers: true, deliver: true, takes: true };
	const ic: Intercom = {
		listSessions: async () => sessions as never,
		send: async (to, options) => (sent.push({ to, text: options.text }), server.deliver ? { id: "m", delivered: true, delivery: "socket_delivered" } : { id: "m", delivered: false, delivery: "failed", reason: "socket closed" }) as never,
	};
	const senderOf = (book: CarBook) => new CarNotices({ book, now: w.now, intercom: () => ic, tower: () => TOWER });
	const calls: string[] = [];
	const watchOf = (session = INTEG) => createReturnWatch({
		session: () => session, now: w.now, waits,
		read: (project) => (server.answers ? w.integ.read(project) : Promise.reject(new Error("sb: the sb server did not answer (is it running?)"))),
		callTower: async (text) => { calls.push(text); if (!server.takes) throw new Error("The tower of Base A did not take the message: failed"); },
	});
	const watch = watchOf();
	const deps: CarToolDeps = { role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root, returns: watch };
	const ctxOf = (from = COORD): CarCtx => ({ cwd: "/", sessionManager: { getBranch: () => [forwardEntry(from)] } });
	/** The tower forwards the slip, to the book the server holds now. */
	const forwarded = (from = COORD) => w.cars.book.noteForward({ fwd: "e".repeat(16), from, to: [INTEG], text: slipBlock() });
	/** The tower forwards the slip and the integrator returns the car. */
	const returned = (reason = "no accept", from = COORD) => (forwarded(from), trainCar(deps, { car: "T-15", state: "returned", reason, project: "acme" }, ctxOf(from)));
	/** The sb server starts again: a new book on the same folders, which the control socket now answers from. */
	const restart = () => { const book = new CarBook({ ...w.deps } as never); w.cars.book = book; return senderOf(book); };
	return { w, sessions, sent, server, sender: senderOf(w.book), calls, watch, watchOf, deps, ctxOf, forwarded, returned, restart };
}
const handed = (why: string) => `car T-15 is returned (acme/web) and sb cannot confirm that its coordinator sess-coord-1 was told: ${why}. Tell that coordinator the notice, by its session id, or find its owner. The notice: returned: your car T-15 (aaaaaaaaaaaa): no accept`;
const LOST = handed("the sb server restarted and holds neither the car nor its notice");

test("the integrator's session waits for the notice of a car it returned: the tool says so, and a delivered notice ends the wait with no call to the tower", async () => {
	const { sender, watch, calls, returned } = setup();
	const out = await returned();
	assert.equal(out.text, "Car T-15 is returned. sb tells its coordinator (sess-coord-1) by session id and confirms the delivery; this session waits for that and calls the tower itself if the sb server loses the notice. You send no notice yourself.");
	assert.equal(watch.size(), 1);
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [1, 0], "not sent yet: the wait goes on");
	await sender.tick();
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [0, 0]);
});

test("a notice the server could not deliver and told the tower of ends the wait too: the server made that call, the session makes none", async () => {
	const { w, sessions, sent, sender, watch, calls, returned } = setup();
	sessions.splice(0, 1); // the coordinator is not live
	await returned();
	await sender.tick();
	assert.equal(sent.filter((s) => s.to === TOWER).length, 1, "the server's own blocked call");
	w.tick(5 * SECOND);
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [0, 0]);
});

test("#13: the sb server restarts before the notice was delivered, after a failed send or before any send: the session finds the book without the car and calls the tower once, with the notice", async () => {
	for (const sends of [true, false]) {
		const { w, server, sender, watch, calls, returned, restart } = setup();
		await returned();
		server.deliver = false;
		if (sends) await sender.tick(); // the first send fails; the retry is due in 30 s
		await watch.tick();
		assert.deepEqual([watch.size(), calls.length], [1, 0], "the server still holds the notice: the wait goes on");
		w.tick(10 * SECOND);
		const second = restart();
		await second.tick();
		await watch.tick();
		assert.deepEqual(calls, [LOST], `sends=${sends}`);
		assert.equal(watch.size(), 0);
		w.tick(60 * SECOND);
		await watch.tick();
		assert.equal(calls.length, 1, "told once");
	}
});

test("#13: the notice the tower is handed is the server's own line and names the session the server told: a slip whose coordinator was not its sender", async () => {
	const { calls, watch, returned, restart } = setup();
	await returned("I made this up", "sess-other");
	restart();
	await watch.tick();
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.includes("its coordinator sess-other was told"), calls[0]);
	assert.ok(calls[0]!.endsWith(`The notice: returned: your car T-15 (aaaaaaaaaaaa): ${coordinatorWord("T-15", COORD, "sess-other")}`), calls[0]);
});

test("a server that does not answer keeps the wait; a tower that does not take the call is asked again 30 s later, ten times at most", async () => {
	const { w, server, watch, calls, returned, restart } = setup();
	await returned();
	server.answers = false;
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [1, 0], "no answer is not an empty book");
	restart();
	server.answers = true;
	server.takes = false;
	await watch.tick();
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [1, 1], "not asked again at once");
	for (let i = 2; i <= 9; i++) {
		w.tick(30 * SECOND);
		await watch.tick();
		assert.deepEqual([watch.size(), calls.length], [1, i]);
	}
	w.tick(30 * SECOND);
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [0, 10], "the tenth is the last");
});

test("after a restart the slip is forwarded and answered again: the car is in the book with a state of its own, so the old wait ends with no call, and a new return is a new wait", async () => {
	const { w, watch, calls, deps, ctxOf, forwarded, returned, restart } = setup();
	await returned();
	restart();
	w.tick(60 * SECOND);
	forwarded();
	await trainCar(deps, { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" }, ctxOf());
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [0, 0]);
	const again = setup();
	await again.returned();
	again.restart();
	again.w.tick(60 * SECOND);
	await again.returned("still no accept");
	await again.watch.tick();
	assert.deepEqual([again.watch.size(), again.calls.length], [1, 0], "the first return's wait ended; the second return's notice is still to send");
});

test("a car returned again in a new life (#14) is waited for by its own return: the life before, told, ends its wait while the new one goes on", async () => {
	const { w, server, sender, watch, calls, returned } = setup();
	await returned();
	await sender.tick();
	w.tick(60 * SECOND);
	server.deliver = false;
	await returned("still no accept");
	await sender.tick();
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [1, 0], "the first return was delivered; the second is not yet");
	server.deliver = true;
	w.tick(30 * SECOND);
	await sender.tick();
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [0, 0]);
});

test("the waits are the process's own list: a module loaded again goes on with them, and another session's are left alone", async () => {
	const waits: ReturnWait[] = [];
	const { watchOf, calls, returned, restart } = setup(waits);
	await returned();
	assert.equal(waits.length, 1);
	const other = watchOf("sess-someone-else");
	restart();
	await other.tick();
	assert.deepEqual([other.size(), waits.length, calls.length], [0, 1, 0], "not this session's wait");
	const reloaded = watchOf();
	assert.equal(reloaded.size(), 1);
	await reloaded.tick();
	assert.deepEqual([waits.length, calls], [0, [LOST]]);
});

test("no wait ends in silence: a server that does not answer for a day and then comes back empty is still found out, and a notice the server left undelivered for a day is handed to the tower", async () => {
	const down = setup();
	await down.returned();
	down.server.answers = false;
	down.w.tick(30 * 3600 * SECOND);
	await down.watch.tick();
	assert.deepEqual([down.watch.size(), down.calls.length], [1, 0], "no answer is no verdict, however long");
	down.restart();
	down.server.answers = true;
	await down.watch.tick();
	assert.deepEqual(down.calls, [LOST]);
	const stuck = setup();
	await stuck.returned();
	stuck.server.deliver = false;
	await stuck.sender.tick();
	stuck.w.tick(24 * 3600 * SECOND - SECOND);
	await stuck.watch.tick();
	assert.deepEqual([stuck.watch.size(), stuck.calls.length], [1, 0]);
	stuck.w.tick(2 * SECOND);
	await stuck.watch.tick();
	assert.deepEqual(stuck.calls, [handed("the sb server has not delivered the notice in a day")]);
	assert.equal(stuck.watch.size(), 0);
});

test("a session that ends while it still waits hands the notice to the tower, once: nobody waits after it; a notice told by then is not handed over", async () => {
	const { sender, watch, calls, returned } = setup();
	await returned();
	await sender.tick();
	await watch.end();
	assert.deepEqual([watch.size(), calls.length], [0, 0], "told: nothing to hand over");
	const open = setup();
	await open.returned();
	open.server.deliver = false;
	await open.sender.tick();
	await open.watch.end();
	assert.deepEqual(open.calls, [handed("its integrator's session ends while the notice is not delivered yet (the sb server may still deliver it, and nobody else waits for it)")]);
	assert.equal(open.watch.size(), 0);
	await open.watch.end();
	assert.equal(open.calls.length, 1);
});

test("car-forward-F005: a session that ends while a look is calling the tower lets that look finish: the tower gets one blocked call, not two", async () => {
	const waits: ReturnWait[] = [], calls: string[] = [];
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>((r) => (release = r)), inside = new Promise<void>((r) => (entered = r));
	const watch = createReturnWatch({
		session: () => INTEG, now: () => 0, waits,
		read: async () => [], // the server holds nothing of the car: the look hands it to the tower
		callTower: async (text) => { calls.push(text); entered(); await gate; },
	});
	watch.add({ project: "acme", app: "web", head: "a".repeat(40), ticket: "T-15", coordinator: COORD, at: "2026-11-07T08:00:00.000Z", line: "returned: your car T-15 (aaaaaaaaaaaa): no accept" });
	const look = watch.tick();
	await inside;
	const ended = watch.end();
	release();
	await Promise.all([look, ended]);
	assert.equal(calls.length, 1, calls.join("\n"));
	assert.equal(watch.size(), 0);
});
