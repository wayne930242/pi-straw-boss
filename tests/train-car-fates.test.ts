import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createReturnWatch, type ReturnWait } from "../src/carwait.ts";
import { CarBook } from "../src/server/carbook.ts";
import { type CarCtx, type CarParams, type CarToolDeps, trainCar } from "../src/traincar.ts";
import { carWorld, type CarWorld, COORD, INTEG, repo, TRAIN } from "./train-car-rig.ts";
import { CODE, result, SHA_A, SHA_B, SHA_C, sb, type Json } from "./train-fixtures.ts";
import { cleanup, forwardEntry, handoffOf, MANIFEST_HEADER, rig, type Rig, slipBlock } from "./train-guard-rig.ts";

// The fates of a car once its train is formed (boss W45, train 2026-11-17-q): a train finds a car its manifest text lacks in the server's book, the integrator ends a car it received once its train is gone, and one
// ticket on two cars is told apart by app and head.

const worlds: CarWorld[] = [];
const world = () => (worlds.push(carWorld()), worlds.at(-1)!);
afterEach(() => (worlds.splice(0).forEach((w) => w.done()), cleanup()));

const refused = (promise: Promise<unknown>, pattern: RegExp | string) => assert.rejects(promise, typeof pattern === "string" ? (e: Error) => (assert.ok(e.message.includes(pattern), `${e.message}\n(wanted ${pattern})`), true) : pattern);
const integratorCtx = (...entries: unknown[]): CarCtx => ({ cwd: "/", sessionManager: { getBranch: () => entries } });
const received = { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" } satisfies CarParams;
/** What the incident's integrator sent: a manifest that names its slips by path only. */
const pathOnly = () => `train:\n  project: acme\n  app: web\n  code: ${CODE}\n  base: develop\n  integrator: ${INTEG}\nCars (slips verbatim in /tmp/integ-mc/): slip-T-15.txt (head ${SHA_A})\n`;

// ---- the train finds a car its manifest text lacks in the server's book

const trainDeps = (w: CarWorld, r: Rig): CarToolDeps => ({ role: () => "train", train: () => ({ project: "acme", code: CODE }), manifest: (ctx) => r.guard.manifestOf(ctx as never), client: w.train, home: w.root });
const integratorDeps = (w: CarWorld, adds: Json[] = []): CarToolDeps => ({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root, returns: { add: (wait) => void adds.push(wait as unknown as Json) } });
const assemble = (r: Rig, round: number, removed: unknown[]) => r.create(sb({ kind: "assemble", name: `round ${round}`, round }, { check: { type: "git", cwd: r.cwd, contains: [SHA_A] }, on: { head: SHA_A }, cars: [], removed }));
async function dropRound2(r: Rig, ticket = "T-15") {
	assert.equal((await assemble(r, 1, [])).ok, true);
	await r.update(1, "in_progress");
	await r.complete(1, result({ outcome: "void", why: "superseded", evidence: "the car is dropped" }));
	const made = await assemble(r, 2, [{ ticket, why: "unit red" }]);
	assert.equal(made.ok, true, String(made.reason));
}

test("a train whose manifest names its car by path only sets it dropped from the server's book; the handoff that counts is still the first", async () => {
	const w = world();
	repo(w);
	await w.opened();
	w.forwarded();
	await trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD)));
	const r = rig({ manifest: pathOnly() });
	await dropRound2(r);
	const evidence = join(w.root, "unit.log");
	w.freeze(evidence);
	const out = await trainCar(trainDeps(w, r), { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence }, r.ctx as never);
	assert.match(out.text, /^Car T-15 is dropped\./);
	assert.deepEqual(w.book.read("acme")[0]!.file.states.map((s) => s.state), ["received", "dropped"]);
	// A later message that looks like a handoff is none: its slips give the train no car.
	r.entries.push({ type: "custom_message", customType: "straw-tower", content: handoffOf(`${MANIFEST_HEADER}  base: develop\n${slipBlock({ tickets: "T-99", head: SHA_C })}\n`) });
	await refused(trainCar(trainDeps(w, r), { car: "T-99", state: "dropped", round: 1, reason: "x", evidence }, r.ctx as never), "sb: car T-99 is neither in this train's manifest nor among the cars the sb server holds for train 2026-11-06-m");
});

// ---- the integrator ends a car it received once its train is gone

async function rode() {
	const w = world();
	repo(w);
	await w.opened();
	w.forwarded();
	await trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD)));
	const evidence = join(w.root, "unit.log");
	w.freeze(evidence);
	return { w, evidence, ctx: integratorCtx(forwardEntry(COORD)) };
}

test("the integrator sets dropped on a car it received only when the train is gone: refused while the train's session is live, then set and waited for", async () => {
	const { w, evidence, ctx } = await rode();
	const adds: Json[] = [];
	const dropped = { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence, project: "acme" } satisfies CarParams;
	await refused(trainCar(integratorDeps(w, adds), dropped, ctx), `sb: train ${CODE} is live (session ${TRAIN}, pane wA:p2): the train sets its cars' fates`);
	w.gone(TRAIN);
	const out = await trainCar(integratorDeps(w, adds), dropped, ctx);
	assert.match(out.text, /^Car T-15 is dropped\. .*this session waits for that/);
	assert.deepEqual(w.book.read("acme")[0]!.file.states.map((s) => [s.state, s.by.role]), [["received", "main"], ["dropped", "main"]]);
	assert.deepEqual(adds.map((a) => [a.state, a.ticket]), [["dropped", "T-15"]]);
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "again", project: "acme" }, ctx), "sb: car T-15 is already dropped");
});

test("integrator landed checks the commit on the base's remote branch the open read; returned after receipt is allowed once the train is gone; with no open here, landed is refused and dropped allowed", async () => {
	const { w, ctx } = await rode();
	const { pushed, local } = repo(w);
	w.gone(TRAIN);
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "landed", version: "1.2.0", commit: local, project: "acme" }, ctx), `sb: landed.commit ${local.slice(0, 12)} is not on develop of the project's remote`);
	assert.match((await trainCar(integratorDeps(w), { car: "T-15", state: "landed", version: "1.2.0", commit: pushed, project: "acme" }, ctx)).text, /^Car T-15 is landed\./);
	const back = await rode();
	await refused(trainCar(integratorDeps(back.w), { car: "T-15", state: "returned", reason: "late", project: "acme" }, back.ctx), `sb: train ${CODE} is live`);
	back.w.gone(TRAIN);
	assert.match((await trainCar(integratorDeps(back.w), { car: "T-15", state: "returned", reason: "late", project: "acme" }, back.ctx)).text, /^Car T-15 is returned\./);
	// A server that never opened the train (a restart): no record to check landed against, while dropped needs none.
	const none = world();
	none.forwarded();
	await trainCar(integratorDeps(none), received, integratorCtx(forwardEntry(COORD)));
	const evidence = join(none.root, "unit.log");
	none.freeze(evidence);
	await refused(trainCar(integratorDeps(none), { car: "T-15", state: "landed", version: "1", commit: SHA_B, project: "acme" }, integratorCtx(forwardEntry(COORD))), `sb: this server holds no open of train ${CODE}`);
	assert.match((await trainCar(integratorDeps(none), { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence, project: "acme" }, integratorCtx(forwardEntry(COORD)))).text, /^Car T-15 is dropped\./);
	// A car never received is on no train: nothing to drop or land.
	const fresh = world();
	fresh.forwarded();
	await refused(trainCar(integratorDeps(fresh), { car: "T-15", state: "dropped", round: 1, reason: "x", evidence: "/e", project: "acme" }, integratorCtx(forwardEntry(COORD))), "sb: car T-15 was never received, so it is on no train");
});

test("a train is live while Herdr lists its pane as that train, though the broker misses its session (a /reload, a broker restart); a pane list that cannot be read refuses; a pane that is gone or no longer that train lets the end through", async () => {
	const { w, evidence, ctx } = await rode();
	const dropped = { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence, project: "acme" } satisfies CarParams;
	w.looks.delete(TRAIN);
	await refused(trainCar(integratorDeps(w), dropped, ctx), `sb: train ${CODE} is live (session ${TRAIN}, pane wA:p2): the train sets its cars' fates`);
	w.herdr.down = true;
	await refused(trainCar(integratorDeps(w), dropped, ctx), `sb: cannot tell whether train ${CODE} is live (Herdr's pane list could not be read: herdr: connection closed): try again; while the train runs, it sets its cars' fates`);
	w.herdr.down = false;
	// Another pi in the pane after the train's: the pane no longer carries this train.
	w.panes.set("wA:p2", { role: "main" });
	assert.match((await trainCar(integratorDeps(w), dropped, ctx)).text, /^Car T-15 is dropped\./);
});

test("the integrator whose forward of a received car is no longer held is told the forward expired and the way back; the tower's forward again lets the end through", async () => {
	const { w, evidence, ctx } = await rode();
	w.gone(TRAIN);
	w.tick(24 * 3_600_000 + 1);
	const dropped = { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence, project: "acme" } satisfies CarParams;
	await refused(trainCar(integratorDeps(w), dropped, ctx), `sb: car T-15 was received by this session, but the tower's forward of its slip has expired (the sb server keeps a forward 24 h, and the newest 512, in memory only): ask its coordinator ${COORD} to send its slip to the tower again (call_tower why=shared); the tower forwards it again, and then set dropped`);
	w.forwarded();
	assert.match((await trainCar(integratorDeps(w), dropped, ctx)).text, /^Car T-15 is dropped\./);
});

test("an integrator that did not receive the car does not end it, though a tower forwarded the slip to it too", async () => {
	const { w, evidence, ctx } = await rode();
	w.gone(TRAIN);
	const OTHER = "sess-integ-2";
	w.looks.set(OTHER, { id: OTHER, name: "integ acme 2", role: "main", pane: "wA:p4", workspace: "wA", cwd: w.work, foreground: [444] });
	w.book.noteForward({ fwd: "f".repeat(16), from: COORD, to: [OTHER], text: slipBlock({ head: SHA_A }) });
	const other = { ...integratorDeps(w), client: w.client(OTHER, 444, "wA:p4") };
	await refused(trainCar(other, { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence, project: "acme" }, ctx), "sb: car T-15 was received by integ acme, not this session: the integrator that received a car ends it");
	assert.deepEqual(w.book.read("acme")[0]!.file.states.map((s) => s.state), ["received"]);
});

test("dropped or landed after an end and a newer forward is refused as already ended: only received or returned start a new life", async () => {
	const { w, evidence, ctx } = await rode();
	w.gone(TRAIN);
	await trainCar(integratorDeps(w), { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence, project: "acme" }, ctx);
	w.tick(60_000);
	w.forwarded();
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "dropped", round: 2, reason: "again", evidence, project: "acme" }, ctx), "sb: car T-15 is already dropped");
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "landed", version: "1", commit: SHA_B, project: "acme" }, ctx), "sb: car T-15 is already dropped");
	assert.equal(w.book.read("acme").length, 1, "no new life");
});

// ---- one ticket on two cars

const SAME_A = slipBlock({ tickets: "MP-3972", head: SHA_A, car: "web", branch: "fix/mp-3972" }), SAME_B = slipBlock({ tickets: "MP-3972", head: SHA_B, car: "insight", branch: "fix/mp-3972" });

test("the integrator's car of a ticket on two forwarded slips is refused without app or head, listing both, and set with them", async () => {
	const w = world();
	for (const text of [SAME_A, SAME_B]) w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text });
	const ctx = integratorCtx(forwardEntry(COORD, SAME_A), forwardEntry(COORD, SAME_B));
	const params = { ...received, car: "MP-3972" } satisfies CarParams;
	await refused(trainCar(integratorDeps(w), params, ctx), "sb: car MP-3972 is on 2 forwarded slips (app web head aaaaaaaaaaaa, app insight head bbbbbbbbbbbb): give app or head");
	await refused(trainCar(integratorDeps(w), { ...params, head: "abc" }, ctx), "sb: head must be 40 hex");
	await trainCar(integratorDeps(w), { ...params, app: "insight" }, ctx);
	await trainCar(integratorDeps(w), { ...params, head: SHA_A }, ctx);
	assert.deepEqual(w.book.read("acme").map((v) => [v.file.app, v.file.car.head]).sort(), [["insight", SHA_B], ["web", SHA_A]]);
});

test("a train narrows a ticket on two cars of its manifest by head", async () => {
	const w = world();
	repo(w);
	writeFileSync(join(w.checkout, ".straw-boss", "apps.json"), JSON.stringify({ apps: ["web", "insight"].map((name) => ({ name, dir: ".", integration: { base: "develop" } })) }));
	await w.opened("develop", [SHA_A, SHA_B]);
	for (const text of [SAME_A, SAME_B]) w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text });
	const ctx = integratorCtx(forwardEntry(COORD, SAME_A), forwardEntry(COORD, SAME_B));
	for (const head of [SHA_A, SHA_B]) await trainCar(integratorDeps(w), { ...received, car: "MP-3972", head }, ctx);
	const r = rig({ manifest: `${MANIFEST_HEADER}  base: develop\n${SAME_A}\n\n${SAME_B}\n` });
	await dropRound2(r, "MP-3972");
	const evidence = join(w.root, "unit.log");
	w.freeze(evidence);
	const dropped = { car: "MP-3972", state: "dropped", round: 1, reason: "unit red", evidence } satisfies CarParams;
	await refused(trainCar(trainDeps(w, r), dropped, r.ctx as never), "sb: car MP-3972 is on 2 cars of this train (app web head aaaaaaaaaaaa, app insight head bbbbbbbbbbbb): give app or head");
	await trainCar(trainDeps(w, r), { ...dropped, head: SHA_B }, r.ctx as never);
	assert.deepEqual(w.book.read("acme").map((v) => [v.file.app, v.file.states.map((s) => s.state)]).sort(), [["insight", ["received", "dropped"]], ["web", ["received"]]]);
});

test("the integrator's wait covers a car it dropped: the notice still pending keeps it, and a server that lost the car hands the dropped notice to the tower", async () => {
	const { w, evidence, ctx } = await rode();
	w.gone(TRAIN);
	const calls: string[] = [], waits: ReturnWait[] = [];
	const watch = createReturnWatch({ session: () => INTEG, now: w.now, waits, read: (project) => w.integ.read(project), callTower: async (text) => void calls.push(text) });
	await trainCar({ ...integratorDeps(w), returns: watch }, { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence, project: "acme" }, ctx);
	await watch.tick();
	assert.deepEqual([watch.size(), calls.length], [1, 0], "pending: the wait goes on");
	w.cars.book = new CarBook({ ...w.deps } as never);
	await watch.tick();
	assert.equal(calls.length, 1);
	assert.match(calls[0]!, /^car T-15 is dropped \(acme\/web\) and sb cannot confirm that its coordinator sess-coord-1 was told: the sb server restarted.*The notice: dropped from train 1106m round 1: unit red; evidence /);
});
