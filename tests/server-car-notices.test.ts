import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fieldsOf } from "../src/header.ts";
import { CarBook } from "../src/server/carbook.ts";
import { CarNotices, type Intercom } from "../src/server/carnotices.ts";
import { noticeStatus, noticeSatisfied } from "../src/train/cars.ts";
import { forwardEntry, slipBlock } from "./train-guard-rig.ts";
import { type CarCtx, trainCar } from "../src/traincar.ts";
import { carWorld, type CarWorld, COORD, INTEG, repo } from "./train-car-rig.ts";
import { SHA_A } from "./train-fixtures.ts";

// The sender of car notices (docs/specs/2026-11-07-train-workers.md §5.5, D14): one intercom message per (car, state) to the coordinator's session id, the broker's answer recorded, retries at 30 s, 2 min and 5 min on a clock the test moves, one `blocked` to the
// tower when the coordinator is not live or the retries are spent, and a restart that resumes from the records.

const worlds: CarWorld[] = [];
afterEach(() => worlds.splice(0).forEach((w) => w.done()));
type Answer = { delivered: boolean; delivery?: "socket_delivered" | "queued" | "failed" | "unknown"; reason?: string } | Error;
class FakeIntercom implements Intercom {
	sessions: { id: string; name?: string }[] = [{ id: COORD, name: "docs-main" }, { id: "sb-tower-wa", name: "tower" }];
	sent: { to: string; text: string; messageId?: string }[] = [];
	answers: Answer[] = [];
	fallback: Answer = { delivered: true, delivery: "socket_delivered" };
	listing: Error | undefined;
	lists = 0;
	listSessions = async () => { this.lists++; if (this.listing) throw this.listing; return this.sessions as never; };
	send = async (to: string, options: { text: string; messageId?: string }) => {
		this.sent.push({ to, text: options.text, ...(options.messageId ? { messageId: options.messageId } : {}) });
		const answer = this.answers.shift() ?? this.fallback;
		if (answer instanceof Error) throw answer;
		return { id: options.messageId ?? "m", ...answer };
	};
	to(id: string) { return this.sent.filter((s) => s.to === id); }
}
async function setup() {
	const w = carWorld();
	worlds.push(w);
	repo(w);
	await w.opened();
	w.forwarded();
	const ic = new FakeIntercom();
	const sender = new CarNotices({ book: w.book, now: w.now, intercom: () => ic, tower: (ws) => `sb-tower-${ws.toLowerCase()}` });
	const ctx: CarCtx = { cwd: "/", sessionManager: { getBranch: () => [forwardEntry(COORD)] } };
	await trainCar({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root }, { car: "T-15", state: "received", train: "2026-11-06-m", departs: "next train", project: "acme" }, ctx);
	const status = () => noticeStatus(w.book.read("acme")[0]!.notice, "received");
	return { w, ic, sender, status };
}
const SECOND = 1000;

test("one message per (car, state), to the coordinator's session id, under a car_notice header that names the session that set the state; the broker's socket_delivered is recorded as delivered", async () => {
	const { w, ic, sender, status } = await setup();
	await sender.tick();
	assert.equal(ic.sent.length, 1);
	const sent = ic.sent[0]!;
	assert.equal(sent.to, COORD, "addressed by session id");
	const fields = fieldsOf(sent.text)!;
	assert.deepEqual([fields.from, fields.id, fields.role, fields.kind, fields.scope, fields.reply], ["integ acme", INTEG, "main", "car_notice", "session", "none"]);
	assert.match(sent.text, /\] received: your car T-15 \(a{12}\) rides train 1106m; it departs next train$/);
	const view = w.book.read("acme")[0]!;
	assert.equal(status().kind, "delivered");
	assert.equal(view.notice!.states.received!.attempts.length, 1);
	assert.deepEqual(view.notice!.states.received!.attempts[0]!.outcome, "delivered");
	assert.ok(view.notice!.states.received!.id, "the message id is kept");
	await sender.tick();
	w.tick(10 * 60 * SECOND);
	await sender.tick();
	assert.equal(ic.sent.length, 1, "told once, then never again");
});

test("a coordinator that is a subagent session is reached by the id the slip named, never by a name", async () => {
	const { w, ic, sender } = await setup();
	ic.sessions = [{ id: COORD, name: "subagent-chat-4f2a" }, { id: "sb-tower-wa" }];
	await sender.tick();
	assert.equal(ic.to(COORD).length, 1);
	assert.ok(ic.sent.every((s) => s.to === COORD || s.to === "sb-tower-wa"));
	assert.ok(!ic.sent.some((s) => s.to === "subagent-chat-4f2a" || s.to === "docs-main"));
	void w;
});

test("queued, a failure, and an unknown outcome are not delivered: tried again at 30 s, 2 min and 5 min, then the tower is told once and the wait ends (escalated)", async () => {
	const { w, ic, sender, status } = await setup();
	ic.answers = [{ delivered: true, delivery: "queued" }, { delivered: false, delivery: "failed", reason: "session gone" }, { delivered: false, delivery: "unknown", reason: "no answer" }, { delivered: true, delivery: "queued" }];
	await sender.tick();
	assert.equal(ic.to(COORD).length, 1);
	assert.deepEqual(status(), { kind: "pending", attempts: 1, last: "queued" });
	w.tick(29 * SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 1, "not before 30 s");
	w.tick(SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 2);
	assert.deepEqual(status(), { kind: "pending", attempts: 2, last: "session gone" });
	w.tick(119 * SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 2, "not before 2 min");
	w.tick(SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 3);
	assert.equal(ic.to("sb-tower-wa").length, 0, "the tower is told after the last retry, not before");
	w.tick(300 * SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 4, "the third retry, at 5 min");
	const tower = ic.to("sb-tower-wa");
	assert.equal(tower.length, 1, "one blocked call");
	const fields = fieldsOf(tower[0]!.text)!;
	assert.deepEqual([fields.kind, fields.why, fields.reply, fields.from, fields.id], ["call_tower", "blocked", "none", "integ acme", INTEG]);
	assert.match(tower[0]!.text, /car T-15 is received \(acme\/web\) and its coordinator sess-coord-1 could not be told: 4 sends were not delivered \(last: queued\)\. The notice: received: your car T-15/);
	assert.equal(status().kind, "escalated");
	assert.deepEqual(noticeSatisfied([w.book.read("acme")[0]!], ["T-15"], "returned"), ["sb: car T-15 has no terminal state yet"]);
	w.tick(3600 * SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 4, "no fifth send");
	assert.equal(ic.to("sb-tower-wa").length, 1, "and no second blocked");
});

test("a coordinator that is not live: one blocked to the tower naming the car, the state and the coordinator's id; escalated is recorded; coming back live it still gets the notice, once", async () => {
	const { w, ic, sender, status } = await setup();
	ic.sessions = [{ id: "sb-tower-wa" }];
	await sender.tick();
	assert.equal(ic.to(COORD).length, 0, "nothing sent to a session that is not there");
	const tower = ic.to("sb-tower-wa");
	assert.equal(tower.length, 1);
	assert.match(tower[0]!.text, /car T-15 is received \(acme\/web\) and its coordinator sess-coord-1 could not be told: coordinator sess-coord-1 is not live/);
	assert.equal(status().kind, "escalated");
	for (let i = 0; i < 5; i++) (w.tick(60 * SECOND), await sender.tick());
	assert.equal(ic.to("sb-tower-wa").length, 1, "once");
	assert.equal(ic.to(COORD).length, 0);
	ic.sessions = [{ id: COORD }, { id: "sb-tower-wa" }];
	w.tick(10 * 60 * SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 1);
	assert.deepEqual(w.book.read("acme")[0]!.notice!.states.received!.deliveredAt !== undefined, true);
	assert.equal(status().kind, "delivered");
	await sender.tick();
	assert.equal(ic.to(COORD).length, 1, "once");
});

test("the broker cannot be asked: nothing is recorded and nothing is escalated; a tower that does not take the call is asked again 30 s later", async () => {
	const { w, ic, sender, status } = await setup();
	ic.listing = new Error("not connected");
	await sender.tick();
	assert.deepEqual([ic.sent.length, status()], [0, { kind: "pending", attempts: 0 }]);
	ic.listing = undefined;
	ic.sessions = [{ id: "sb-tower-wa" }];
	ic.answers = [{ delivered: false, delivery: "failed", reason: "tower busy" }];
	await sender.tick();
	assert.equal(ic.to("sb-tower-wa").length, 1);
	assert.equal(status().kind, "pending", "not escalated until the tower has the call");
	w.tick(10 * SECOND);
	await sender.tick();
	assert.equal(ic.to("sb-tower-wa").length, 1);
	w.tick(20 * SECOND);
	await sender.tick();
	assert.equal(ic.to("sb-tower-wa").length, 2);
	assert.equal(status().kind, "escalated");
});

test("a server restart forgets: what the disk holds is read by nobody, nothing is sent from it, and nothing is sent from it (CR-F003)", async () => {
	const { w, ic, sender } = await setup();
	await sender.tick();
	assert.equal(ic.sent.length, 1, "delivered");
	const again = new CarBook({ ...w.deps } as never);
	const ic2 = new FakeIntercom();
	const second = new CarNotices({ book: again, now: w.now, intercom: () => ic2, tower: (ws) => `sb-tower-${ws}` });
	w.tick(3600 * SECOND);
	await second.tick();
	assert.equal(ic2.sent.length, 0, "the journal is display only: the new server sends nothing it did not set itself");
	assert.deepEqual(again.read("acme"), []);
});

test("a coordinator that stays away is looked for less and less often: listing the sessions backs off instead of running every tick for 24 h (CR-F005)", async () => {
	const { w, ic, sender } = await setup();
	ic.sessions = [{ id: "sb-tower-wa" }];
	for (let i = 0; i < 120; i++) (w.tick(5 * SECOND), await sender.tick());
	assert.ok(ic.lists <= 20, `${ic.lists} listings in ten minutes`);
	ic.sessions = [{ id: COORD }, { id: "sb-tower-wa" }];
	w.tick(15 * 60 * SECOND);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 1, "a coordinator that comes back is still told, within the back-off");
});

test("an attempt is written before the send: a server that stops in the middle leaves an unknown outcome and retries, never a send nobody wrote down", async () => {
	const { w, ic, sender } = await setup();
	ic.send = async () => { throw new Error("process killed"); };
	await sender.tick();
	const record = w.book.read("acme")[0]!.notice!.states.received!;
	assert.equal(record.attempts.length, 1);
	assert.equal(record.attempts[0]!.outcome, "failed");
	assert.equal(record.deliveredAt, undefined);
	void SHA_A;
});

test("each state of a car is told on its own: landed after received is a second message, with its own record", async () => {
	const { w, ic, sender } = await setup();
	await sender.tick();
	assert.equal(ic.sent.length, 1);
	const { pushed } = repo(w);
	const { rig, MANIFEST_HEADER, slipBlock } = await import("./train-guard-rig.ts").then((m) => ({ rig: m.rig, MANIFEST_HEADER: m.MANIFEST_HEADER, slipBlock: m.slipBlock }));
	const r = rig({ manifest: `${MANIFEST_HEADER}  base: develop\n${slipBlock()}\n` });
	await trainCar({ role: () => "train", train: () => ({ project: "acme", code: "2026-11-06-m" }), manifest: (c) => r.guard.manifestOf(c as never), client: w.train, home: w.root }, { car: "T-15", state: "landed", version: "1.2.0", commit: pushed }, r.ctx as never);
	await sender.tick();
	assert.equal(ic.to(COORD).length, 2);
	assert.match(ic.to(COORD)[1]!.text, new RegExp(`\\] landed in 1\\.2\\.0, your commit is ${pushed}$`));
	assert.equal(fieldsOf(ic.to(COORD)[1]!.text)!.role, "train");
	assert.deepEqual(noticeSatisfied([w.book.read("acme")[0]!], ["T-15"], "landed"), []);
});

test("the message ids of a notice are the state's own: a car returned again in a new life (#14), or set again after a restart, goes out under ids the broker has not seen (it delivers no id twice)", async () => {
	const w = carWorld();
	worlds.push(w);
	const ic = new FakeIntercom();
	const senderOf = (book: CarBook) => new CarNotices({ book, now: w.now, intercom: () => ic, tower: (ws) => `sb-tower-${ws.toLowerCase()}` });
	const ctx: CarCtx = { cwd: "/", sessionManager: { getBranch: () => [forwardEntry(COORD)] } };
	// The same slip, returned with the same words each time: only the moment differs.
	const returned = (book: CarBook) => (book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text: slipBlock() }), trainCar({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root }, { car: "T-15", state: "returned", reason: "no accept", project: "acme" }, ctx));
	const first = senderOf(w.book);
	await returned(w.book);
	await first.tick();
	w.tick(60 * SECOND);
	await returned(w.book);
	await first.tick();
	w.tick(60 * SECOND);
	const again = new CarBook({ ...w.deps } as never);
	w.cars.book = again;
	await returned(again);
	await senderOf(again).tick();
	const told = ic.to(COORD);
	assert.deepEqual(told.map((s) => s.text.replace(/^\[[^\]]*\] /, "")), Array.from({ length: 3 }, () => "returned: your car T-15 (aaaaaaaaaaaa): no accept"));
	assert.ok(told.every((s) => /^car-[0-9a-f]{12}-returned-1$/.test(s.messageId ?? "")), told.map((s) => s.messageId).join(" "));
	assert.equal(new Set(told.map((s) => s.messageId)).size, 3, told.map((s) => s.messageId).join(" "));
});
