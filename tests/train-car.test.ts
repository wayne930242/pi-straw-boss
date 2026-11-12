import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { coordinatorWord, landedWord, noticeSatisfied, receivedTold } from "../src/train/cars.ts";
import { type CarCtx, type CarParams, type CarToolDeps, trainCar } from "../src/traincar.ts";
import { cleanup, forwardEntry, MANIFEST_HEADER, rig, type Rig, slipBlock } from "./train-guard-rig.ts";
import { CODE, result, SHA_A, SHA_B, sb } from "./train-fixtures.ts";
import { appBase, carWorld, type CarWorld, COORD, git, INTEG, PUBLIC_URL, repo, TRAIN } from "./train-car-rig.ts";

// `train_car` and the server's book of cars (docs/specs/2026-11-07-train-workers.md §5.5, §24; todo #125 task 5a): what each state needs, what the tool checks in the session, and what the server checks itself.

const worlds: CarWorld[] = [];
const world = () => (worlds.push(carWorld()), worlds.at(-1)!);
afterEach(() => (worlds.splice(0).forEach((w) => w.done()), cleanup()));

const integratorDeps = (w: CarWorld): CarToolDeps => ({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root });
const integratorCtx = (...entries: unknown[]): CarCtx => ({ cwd: "/", sessionManager: { getBranch: () => entries } });
const trainDeps = (w: CarWorld, r: Rig): CarToolDeps => ({ role: () => "train", train: () => ({ project: "acme", code: CODE }), manifest: (ctx) => r.guard.manifestOf(ctx as never), client: w.train, home: w.root });
const MANIFEST = `${MANIFEST_HEADER}  base: develop\n${slipBlock()}\n`;
const refused = (promise: Promise<unknown>, pattern: RegExp | string) => assert.rejects(promise, typeof pattern === "string" ? (e: Error) => (assert.ok(e.message.includes(pattern), `${e.message}\n(wanted ${pattern})`), true) : pattern);
const received = { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" } satisfies CarParams;

/** The integrator received T-15 (the tower forwarded its slip from the coordinator): the state every train's car starts from. */
async function receive(w: CarWorld) {
	w.forwarded();
	const out = await trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD)));
	return out;
}

// ---- the integrator

test("received: the slip is a tower's forward whose sender is the coordinator; the car file and a pending notice follow, and the tool says sb sends it", async () => {
	const w = world();
	const out = await receive(w);
	assert.match(out.text, /^Car T-15 is received\. sb tells its coordinator \(sess-coord-1\) by session id and confirms the delivery; the train todo waits for that before the manifest goes to the tower\. You send no notice yourself\.$/);
	const view = w.book.read("acme");
	assert.equal(view.length, 1);
	const file = view[0]!.file;
	assert.deepEqual([file.app, file.car.tickets, file.car.branch, file.car.head, file.coordinator], ["web", ["T-15"], "fix/t-15", SHA_A, COORD]);
	assert.deepEqual(file.states.map((s) => [s.state, s.by.role, s.by.name, s.by.session, s.by.workspace, s.train, s.departs]), [["received", "main", "integ acme", INTEG, "wA", CODE, "next train"]]);
	const journal = join(w.stateDir, "trainboard", "acme", "cars", `web-${SHA_A.slice(0, 12)}.json`);
	assert.deepEqual(JSON.parse(readFileSync(journal, "utf8")), file, "the server writes the car file as its journal");
	assert.equal(w.book.pending().length, 1);
});

test("received needs the tool's own checks: a state's fields, a slip on the branch, and a coordinator the forward names", async () => {
	const w = world();
	w.forwarded();
	const ctx = integratorCtx(forwardEntry(COORD));
	await refused(trainCar(integratorDeps(w), { ...received, departs: undefined }, ctx), "sb: received needs departs");
	await refused(trainCar(integratorDeps(w), { ...received, train: "1106m" }, ctx), "sb: received.train must be YYYY-MM-DD-<letters>");
	await refused(trainCar(integratorDeps(w), { ...received, reason: "x" }, ctx), "sb: received.reason is not a field");
	await refused(trainCar(integratorDeps(w), { ...received, car: "T-99" }, ctx), "sb: car T-99 is on no forwarded slip of this session");
	await refused(trainCar(integratorDeps(w), received, integratorCtx()), "sb: car T-15 is on no forwarded slip of this session");
	await refused(trainCar(integratorDeps(w), { ...received, project: undefined }, ctx), "sb: give project");
	// The slip names a coordinator other than the session the forward says sent it: refused with the word, and nothing is recorded.
	await refused(trainCar(integratorDeps(w), received, integratorCtx(forwardEntry("sess-other"))), coordinatorWord("T-15", COORD, "sess-other"));
	assert.equal(w.book.read("acme").length, 0);
	// A message that only looks like a forward (the broker's sender is not the header's id, it is no tower's, or it is another kind) is none.
	for (const entry of [forwardEntry(COORD, slipBlock(), { sender: COORD }), forwardEntry(COORD, slipBlock(), { role: "main" }), forwardEntry(COORD, slipBlock(), { kind: "call_tower" })]) {
		await refused(trainCar(integratorDeps(w), received, integratorCtx(entry)), "is on no forwarded slip of this session");
	}
});

test("a slip with 24 tickets is forwarded, then received or returned whole: the forward keeps every ticket and the integrator's full list matches it (v3 car, 0.74.0)", async () => {
	const tickets = Array.from({ length: 24 }, (_, i) => `MP-${3600 + i}`);
	const text = slipBlock({ tickets: tickets.join(", ") });
	for (const state of ["received", "returned"] as const) {
		const w = world();
		w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text });
		const params = state === "received" ? { car: tickets[0]!, state, train: CODE, departs: "next train", project: "acme" } : { car: tickets[0]!, state, reason: "sb: the train runs no acceptance: car MP-3600 asks for UAT", project: "acme" };
		const out = await trainCar(integratorDeps(w), params, integratorCtx(forwardEntry(COORD, text)));
		assert.match(out.text, new RegExp(`^Car MP-3600 is ${state}\\.`));
		assert.deepEqual(w.book.read("acme")[0]!.file.car.tickets, tickets, "the car's identity is the whole list, not its first 16");
	}
});

test("returned at receipt: a slip whose coordinator is not its sender is returned to the sender, with the word; a good one is returned to its coordinator", async () => {
	const w = world();
	w.forwarded("sess-other");
	// The tool lets a return through (the integrator returns what it refuses); the server records the sender as the coordinator and writes the word itself.
	const out = await trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "I made this up", project: "acme" }, integratorCtx(forwardEntry("sess-other")));
	assert.match(out.text, /^Car T-15 is returned\./);
	const file = w.book.read("acme")[0]!.file;
	assert.equal(file.coordinator, "sess-other", "the notice goes to fwd-from, the session that really sent it");
	assert.equal(file.states[0]!.reason, coordinatorWord("T-15", COORD, "sess-other"), "the word is the server's, not the integrator's");
	const w2 = world();
	w2.forwarded();
	await trainCar(integratorDeps(w2), { car: "T-15", state: "returned", reason: "sb: the train runs no acceptance: car T-15 asks for UAT", project: "acme" }, integratorCtx(forwardEntry(COORD)));
	assert.equal(w2.book.read("acme")[0]!.file.coordinator, COORD);
});

test("a car already received is not returned by the integrator, and one state per car: a second terminal state or a second receipt is refused", async () => {
	const w = world();
	await receive(w);
	await refused(trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD))), "sb: car T-15 is already received");
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "late", project: "acme" }, integratorCtx(forwardEntry(COORD))), "sb: car T-15 is already received; the integrator returns a car at receipt only");
	const w2 = world();
	w2.forwarded();
	await trainCar(integratorDeps(w2), { car: "T-15", state: "returned", reason: "no accept", project: "acme" }, integratorCtx(forwardEntry(COORD)));
	await refused(trainCar(integratorDeps(w2), { car: "T-15", state: "returned", reason: "again", project: "acme" }, integratorCtx(forwardEntry(COORD))), "sb: car T-15 is already returned");
	await refused(trainCar(integratorDeps(w2), received, integratorCtx(forwardEntry(COORD))), "sb: car T-15 is already returned");
});

test("the server needs its own forward: a slip no tower forwarded to this session is refused even when the tool's checks are bypassed", async () => {
	const w = world();
	// The branch shows a forward (the tool is satisfied), but the server never stamped one: a header the model wrote itself proves nothing.
	await refused(trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD))), `sb: no forward by a tower carries head ${SHA_A.slice(0, 12)} to this session`);
	// A forward to another session is not this session's.
	w.book.noteForward({ fwd: "d".repeat(16), from: COORD, to: ["sess-someone-else"], text: slipBlock() });
	await refused(trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD))), "carries head");
	assert.equal(w.book.read("acme").length, 0);
});

test("train_car is for a train and the integrator: another session, and a state the role does not set, are refused", async () => {
	const w = world();
	w.forwarded();
	const ctx = integratorCtx(forwardEntry(COORD));
	await refused(trainCar({ ...integratorDeps(w), role: () => undefined }, received, ctx), "sb: train_car is for a train and for the integrator");
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "landed", version: "1", commit: SHA_B }, ctx), "sb: only a train sets landed");
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "dropped", round: 1, reason: "x", evidence: "/e" }, ctx), "sb: only a train sets dropped");
	const r = rig({ manifest: MANIFEST });
	await refused(trainCar(trainDeps(w, r), received, r.ctx as never), "sb: a train does not set received");
});

// ---- the train

async function ridden() {
	const w = world();
	repo(w);
	await w.opened();
	await receive(w);
	const r = rig({ manifest: MANIFEST });
	return { w, r, deps: trainDeps(w, r), ctx: r.ctx as unknown as CarCtx };
}
const assemble = (r: Rig, round: number, removed: unknown[]) => r.create(sb({ kind: "assemble", name: `round ${round}`, round }, { check: { type: "git", cwd: r.cwd, contains: [SHA_A] }, on: { head: SHA_A }, cars: [], removed }));

test("landed: the commit is on the remote branch of the manifest's base, read by the server's git; one only in the train's clone is refused", async () => {
	const { w, deps, ctx } = await ridden();
	const { pushed, local } = repo(w);
	await refused(trainCar(deps, { car: "T-15", state: "landed", version: "1.2.0", commit: local }, ctx), `sb: landed.commit ${local.slice(0, 12)} is not on develop of the project's remote`);
	assert.deepEqual(w.book.read("acme")[0]!.file.states.map((s) => s.state), ["received"]);
	const out = await trainCar(deps, { car: "T-15", state: "landed", version: "1.2.0", commit: pushed }, ctx);
	assert.match(out.text, /^Car T-15 is landed\. sb tells its coordinator \(sess-coord-1\) by session id and confirms the delivery; the land step waits for that\./);
	const file = w.book.read("acme")[0]!.file;
	assert.deepEqual(file.states.map((s) => [s.state, s.by.role, s.by.session]), [["received", "main", INTEG], ["landed", "train", TRAIN]]);
	assert.equal(file.states[1]!.commit, pushed);
	assert.equal(w.book.pending().filter((p) => p.entry.state === "landed").length, 1);
});

test("landed: the base is the manifest's, held by the server from the open; a train that names none, or a server that did not open it, cannot land a car", async () => {
	const w = world();
	const { pushed } = repo(w);
	await w.opened(null);
	await receive(w);
	const r = rig({ manifest: MANIFEST });
	await refused(trainCar(trainDeps(w, r), { car: "T-15", state: "landed", version: "1", commit: pushed }, r.ctx as never), "sb: the manifest of train 2026-11-06-m names no usable base (base: <branch>)");
	const w2 = world();
	w2.forwarded();
	await trainCar(integratorDeps(w2), received, integratorCtx(forwardEntry(COORD)));
	const r2 = rig({ manifest: MANIFEST });
	// The train's pane token says it is train CODE, but this server did not open that train for this session.
	await refused(trainCar(trainDeps(w2, r2), { car: "T-15", state: "landed", version: "1", commit: pushed }, r2.ctx as never), `sb: this server did not open train ${CODE} of project acme for session ${TRAIN}`);
});

test("a car not in the train's manifest, one the integrator never received, and one received for another train are refused", async () => {
	const { w, r, deps, ctx } = await ridden();
	const { pushed } = repo(w);
	await refused(trainCar(deps, { car: "T-99", state: "landed", version: "1", commit: pushed }, ctx), "sb: car T-99 is not in this train's manifest");
	const w2 = world();
	await w2.opened();
	await refused(trainCar(trainDeps(w2, r), { car: "T-15", state: "landed", version: "1", commit: pushed }, ctx), "is not in the book of project acme: only a car the integrator received can be set");
	// The integrator received it, but the manifest the server read at the open does not list its head: the received entry's `train` is a claim and gives no right.
	const w3 = world();
	await w3.opened("develop", [SHA_B]);
	w3.forwarded();
	await trainCar(integratorDeps(w3), received, integratorCtx(forwardEntry(COORD)));
	await refused(trainCar(trainDeps(w3, r), { car: "T-15", state: "landed", version: "1", commit: pushed }, ctx), `is not in the manifest of train ${CODE}`);
	// And the other way: the manifest alone is not enough either (RR-F003): the receipt names the train that was to carry the car.
	const w4 = world();
	repo(w4);
	await w4.opened();
	w4.forwarded();
	await trainCar(integratorDeps(w4), { ...received, train: "2026-11-06-n" }, integratorCtx(forwardEntry(COORD)));
	await refused(trainCar(trainDeps(w4, r), { car: "T-15", state: "landed", version: "1", commit: repo(w4).pushed }, ctx), `was not received for train ${CODE}`);
});

test("a second terminal state is refused: landed, then dropped or returned or landed again", async () => {
	const { w, r, deps, ctx } = await ridden();
	const { pushed } = repo(w);
	await trainCar(deps, { car: "T-15", state: "landed", version: "1", commit: pushed }, ctx);
	const evidence = join(w.root, "unit.log");
	w.freeze(evidence);
	await refused(trainCar(deps, { car: "T-15", state: "landed", version: "2", commit: pushed }, ctx), "sb: car T-15 is already landed");
	// The tool's own checks pass (round 1's assemble lists the car), so the server's refusal is what is read.
	await assemble(r, 1, [{ ticket: "T-15", why: "x" }]);
	await refused(trainCar(deps, { car: "T-15", state: "returned", reason: "x" }, ctx), "sb: car T-15 is already landed");
	const raw = (state: string, fields: Record<string, unknown>) => w.train.set({ state: state as never, car: { app: "web", head: SHA_A }, fields });
	await refused(raw("dropped", { round: 1, reason: "unit red", evidence }), "sb: car T-15 is already landed");
	await refused(raw("landed", { version: "3", commit: pushed }), "sb: car T-15 is already landed");
	assert.deepEqual(w.book.read("acme")[0]!.file.states.map((s) => s.state), ["received", "landed"]);
});

test("dropped: a failing evidence file that exists, the round the car is dropped from, and the next round's assemble that lists it as removed", async () => {
	const { w, r, deps, ctx } = await ridden();
	const evidence = join(w.root, "unit.log");
	await refused(trainCar(deps, { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence }, ctx), "sb: car T-15 is dropped from round 1 when round 2's assemble lists it in spec.removed: create that assemble first");
	assert.equal((await assemble(r, 1, [])).ok, true);
	await r.update(1, "in_progress");
	await r.complete(1, result({ outcome: "void", why: "superseded", evidence: "the car is dropped" }));
	assert.equal((await assemble(r, 2, [{ ticket: "T-15", why: "unit red", evidence }])).ok, true);
	await refused(trainCar(deps, { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence }, ctx), "dropped.evidence");
	await refused(trainCar(deps, { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence: "relative.log" }, ctx), "dropped.evidence");
	await refused(trainCar(deps, { car: "T-15", state: "dropped", round: 2, reason: "unit red", evidence }, ctx), "sb: car T-15 was out of the train before round 2");
	await refused(trainCar(deps, { car: "T-15", state: "dropped", reason: "x", evidence }, ctx), "sb: dropped needs round");
	w.freeze(evidence);
	const out = await trainCar(deps, { car: "T-15", state: "dropped", round: 1, reason: "unit red", evidence }, ctx);
	assert.match(out.text, /^Car T-15 is dropped\..*the assemble that removes it waits for that/);
	assert.deepEqual(w.book.read("acme")[0]!.file.states.map((s) => s.state), ["received", "dropped"]);
});

test("returned from the manifest: only when round 1's assemble lists the car in spec.removed; the server holds the reason", async () => {
	const { w, r, deps, ctx } = await ridden();
	const word = "sb: the train runs no acceptance: car T-15 asks for UAT (slip line uat:); rewrite its acceptance criteria and run them before loading, then send the evidence in accept:";
	await refused(trainCar(deps, { car: "T-15", state: "returned", reason: word }, ctx), "sb: car T-15 is returned from the manifest only when round 1's assemble lists it in spec.removed");
	assert.equal((await assemble(r, 1, [{ ticket: "T-15", why: word }])).ok, true);
	await refused(trainCar(deps, { car: "T-15", state: "returned" }, ctx), "sb: returned needs reason");
	await trainCar(deps, { car: "T-15", state: "returned", reason: word }, ctx);
	assert.equal(w.book.read("acme")[0]!.file.states.at(-1)!.reason, word);
	// A car removed from the train cannot land.
	await refused(trainCar(deps, { car: "T-15", state: "landed", version: "1", commit: SHA_B }, ctx), "sb: car T-15 was removed from the train, so it cannot land");
});

// ---- a car's lives (#14) and a car that is on the base already (#15)

const LATER = 60_000, CODE2 = "2026-11-06-n", TRAIN2 = "sess-train-2";
const states = (w: CarWorld) => w.book.read("acme").map((v) => v.file.states.map((s) => s.state)).sort();

test("#14: a forward the tower makes after a car was returned starts the car's new life: it is received again, the life before stays in the book with its notice, and the journal shows the new life", async () => {
	const w = world();
	w.forwarded();
	const ctx = integratorCtx(forwardEntry(COORD));
	await trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "no accept", project: "acme" }, ctx);
	// The forward the car was returned on gets no second answer.
	await refused(trainCar(integratorDeps(w), received, ctx), "sb: car T-15 is already returned");
	// Its coordinator sends the same head again and the tower forwards it: a forward newer than the car's end.
	w.tick(LATER);
	w.forwarded();
	assert.match((await trainCar(integratorDeps(w), received, ctx)).text, /^Car T-15 is received\./);
	assert.deepEqual(states(w), [["received"], ["returned"]], "two lives of one car");
	assert.deepEqual(w.book.viewOf("acme", "web", SHA_A)!.file.states.map((s) => s.state), ["received"], "the car lives the new one");
	assert.deepEqual(w.book.pending().map((p) => p.entry.state).sort(), ["received", "returned"], "the notice of the life before is still sent, beside the new one's");
	const journal = join(w.stateDir, "trainboard", "acme", "cars", `web-${SHA_A.slice(0, 12)}.json`);
	assert.deepEqual((JSON.parse(readFileSync(journal, "utf8")) as { states: { state: string }[] }).states.map((s) => s.state), ["received"], "the journal shows the life the car lives now");
	assert.deepEqual(JSON.parse(readFileSync(journal.replace(/\.json$/, ".notice.json"), "utf8")), { v: 1, states: {} }, "with a notice record of its own, not the one of the life before");
	assert.deepEqual(readdirSync(join(w.stateDir, "trainboard", "acme", "cars")).sort(), [`web-${SHA_A.slice(0, 12)}.json`, `web-${SHA_A.slice(0, 12)}.notice.json`], "the life before has no file of its own");
	// The integrator's train todo reads the life the car lives now.
	assert.deepEqual(receivedTold(await w.integ.read("acme"), { app: "web", head: SHA_A, ticket: "T-15" }), [`sb: waits for sb to tell ${COORD} that car T-15 is received (0 attempts)`]);
	// Within a life the rules are the ones of any car.
	await refused(trainCar(integratorDeps(w), received, ctx), "sb: car T-15 is already received");
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "late", project: "acme" }, ctx), "sb: car T-15 is already received; the integrator returns a car at receipt only");
});

test("#14: a car returned again in its new life is a new return: both are in the book, each with a notice to send, and the forward it was returned on still gets no second answer", async () => {
	const w = world();
	w.forwarded();
	const ctx = integratorCtx(forwardEntry(COORD));
	await trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "no accept", project: "acme" }, ctx);
	w.tick(LATER);
	w.forwarded();
	await trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "the review is missing", project: "acme" }, ctx);
	assert.deepEqual(w.book.pending().map((p) => [p.entry.state, p.entry.reason]), [["returned", "no accept"], ["returned", "the review is missing"]]);
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "again", project: "acme" }, ctx), "sb: car T-15 is already returned");
	await refused(trainCar(integratorDeps(w), received, ctx), "sb: car T-15 is already returned");
	assert.equal(w.book.read("acme").length, 2);
});

test("#14: a dropped car that is sent again rides another train in a new life; the train that dropped it still reads the state it set and cannot touch the new life", async () => {
	const { w } = await ridden();
	const { pushed } = repo(w);
	const evidence = join(w.root, "unit.log");
	w.freeze(evidence);
	const car = { app: "web", head: SHA_A };
	await w.train.set({ state: "dropped", car, fields: { round: 1, reason: "unit red", evidence } });
	w.tick(LATER);
	w.forwarded();
	// The new life rides another train: the one that dropped the car is done with it.
	await refused(trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD))), `sb: car T-15 rode train ${CODE} in an earlier life and left it; received names the train it rides now`);
	await trainCar(integratorDeps(w), { ...received, train: CODE2 }, integratorCtx(forwardEntry(COORD)));
	// The first train's assemble waits for the notice of the state it set, whatever the car does in its new life.
	const first = await w.train.read("acme");
	assert.deepEqual(first.map((v) => v.file.states.map((s) => s.state)), [["received", "dropped"]]);
	assert.deepEqual(noticeSatisfied(first, ["T-15"], ["dropped", "returned"], { app: "web" }), [`sb: waits for sb to tell ${COORD} that car T-15 is dropped (0 attempts)`]);
	await refused(w.train.set({ state: "landed", car, fields: { version: "1", commit: pushed } }), "sb: car T-15 is already dropped");
	// The next train, opened on the same head, reads and lands the new life.
	w.looks.set(TRAIN2, { id: TRAIN2, name: "train 1106n", role: "train", train: { project: "acme", code: CODE2 }, pane: "wA:p3", workspace: "wA", cwd: w.work, foreground: [333] });
	const url = await w.book.remoteOf(w.checkout);
	w.book.noteTrain({ project: "acme", code: CODE2, session: TRAIN2, pane: "wA:p3", integrator: INTEG, base: "develop", heads: [SHA_A], ...(url ? { url } : {}) });
	const next = w.client(TRAIN2, 333, "wA:p3");
	assert.deepEqual((await next.read("acme")).map((v) => v.file.states.map((s) => [s.state, s.train])), [[["received", CODE2]]]);
	await next.set({ state: "landed", car, fields: { version: "1.3.0", commit: pushed } });
	assert.deepEqual(states(w), [["received", "dropped"], ["received", "landed"]]);
});

test("#15: a car the book holds as landed is not received again when its slip comes back: the refusal is the word the integrator returns it with, and the coordinator is told that", async () => {
	const { w, deps, ctx } = await ridden();
	const { pushed } = repo(w);
	await trainCar(deps, { car: "T-15", state: "landed", version: "1.2.0", commit: pushed }, ctx);
	const mine = integratorCtx(forwardEntry(COORD));
	await refused(trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: "x", project: "acme" }, mine), "sb: car T-15 is already received; the integrator returns a car at receipt only");
	w.tick(LATER);
	w.forwarded();
	const word = landedWord("T-15", SHA_A, "landed in 1.2.0");
	assert.equal(word, "sb: car T-15 (aaaaaaaaaaaa) landed in 1.2.0, so it takes no train again: a car lands once. Return it with this word (train_car returned), which tells its coordinator");
	await assert.rejects(trainCar(integratorDeps(w), { ...received, train: CODE2 }, mine), (e: Error) => e.message === word);
	await trainCar(integratorDeps(w), { car: "T-15", state: "returned", reason: word, project: "acme" }, mine);
	assert.deepEqual(states(w), [["received", "landed"], ["returned"]]);
	assert.equal(w.book.pending().at(-1)!.entry.reason, word);
});

test("#15: received is refused for a head that is on the base's remote branch already, by the server's own git and with nothing remembered; a head that is not there is received", async () => {
	const w = world();
	const { pushed, local, remote } = repo(w);
	appBase(w);
	const forward = (ticket: string, head: string) => {
		const text = slipBlock({ tickets: ticket, head });
		w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text });
		return integratorCtx(forwardEntry(COORD, text));
	};
	const on = (ticket: string, head: string) => landedWord(ticket, head, "is on develop of the project's remote already");
	// The usual car: its head is on no base yet.
	assert.match((await trainCar(integratorDeps(w), { ...received, car: "T-20" }, forward("T-20", local))).text, /^Car T-20 is received\./);
	// The tip of the base, in a book that never saw the car (a restart, or a push made by hand).
	const tip = forward("T-21", pushed);
	await assert.rejects(trainCar(integratorDeps(w), { ...received, car: "T-21" }, tip), (e: Error) => e.message === on("T-21", pushed));
	assert.deepEqual(w.book.read("acme").map((v) => v.file.car.tickets[0]), ["T-20"], "nothing is recorded of the refused car");
	// The integrator returns it with the word, and that is what its coordinator is sent.
	await trainCar(integratorDeps(w), { car: "T-21", state: "returned", reason: on("T-21", pushed), project: "acme" }, tip);
	assert.equal(w.book.pending().at(-1)!.entry.reason, on("T-21", pushed));
	// Sent again after the base moved on: the head is an ancestor of the tip now, and the car's new life is not received either.
	git(w.work, "push", "-q", "origin", `${local}:develop`);
	w.tick(LATER);
	await assert.rejects(trainCar(integratorDeps(w), { ...received, car: "T-21" }, forward("T-21", pushed)), (e: Error) => e.message === on("T-21", pushed));
	assert.deepEqual(readdirSync(w.dir).filter((n) => n.startsWith("cars-mirror-")), [], "each check removes the mirror it made");
	// Git that cannot read the remote: the rule is that a car on the base is never received, so nothing is received unchecked.
	w.rewrites.splice(0, w.rewrites.length, [PUBLIC_URL, join(w.root, "gone.git")]);
	await refused(trainCar(integratorDeps(w), { ...received, car: "T-23" }, forward("T-23", SHA_B)), "sb: car T-23 is not received: whether its head bbbbbbbbbbbb is on develop of the project's remote already could not be checked (git ls-remote of develop from the project's remote failed");
	assert.ok(w.logs.some((l) => l.startsWith("cars-received-refused")), "the refusal is logged");
	w.rewrites.splice(0, w.rewrites.length, [PUBLIC_URL, remote]);
	assert.match((await trainCar(integratorDeps(w), { ...received, car: "T-23" }, forward("T-23", SHA_B))).text, /^Car T-23 is received\./);
});

test("#15: a project whose remote or base the server cannot read is received unchecked, and the log says so", async () => {
	// No checkout at all, then a checkout whose apps.json names no base for the app.
	const w = world();
	await receive(w);
	assert.equal(w.logs.filter((l) => l.startsWith("cars-received-unchecked")).length, 1);
	const w2 = world();
	const { pushed } = repo(w2);
	appBase(w2, "develop", "other-app");
	w2.forwarded(COORD, pushed);
	assert.match((await trainCar(integratorDeps(w2), received, integratorCtx(forwardEntry(COORD, slipBlock({ head: pushed }))))).text, /^Car T-15 is received\./);
	assert.equal(w2.logs.filter((l) => l.startsWith("cars-received-unchecked")).length, 1);
});

// ---- the proof the server asks for

test("a raw client, as a shell would be, cannot set a state: no secret, a made-up secret, and registering after the pi all fail, and nothing is recorded", async () => {
	const w = world();
	const { pushed } = repo(w);
	await w.opened();
	await receive(w);
	const raw = (secret: unknown) => w.call({ cmd: "cars-set", secret, state: "landed", car: { app: "web", head: SHA_A }, fields: { version: "1", commit: pushed } });
	for (const secret of [undefined, "", "secret-99", "0".repeat(64), { x: 1 }]) {
		const reply = await raw(secret);
		assert.equal(reply?.ok, false, JSON.stringify(secret));
		assert.match(String(reply?.error), /not from a registered session/);
	}
	// The pi registered first (the integrator's receipt above); a shell that asks later for the same process gets no secret.
	const second = await w.call({ cmd: "cars-register", session: INTEG, pid: 111, pane: "wA:p1", started: "start-111" });
	assert.equal(second?.ok, false);
	assert.match(String(second?.error), /already registered to a live process \(pid 111\); a registration is not replaced while that process runs/);
	// A shell cannot register as the train either: it is not a foreground process of the pane, and its pid is not the pi's.
	for (const pid of [4242, 111]) {
		const reply = await w.call({ cmd: "cars-register", session: TRAIN, pid, pane: "wA:p2", started: `start-${pid}` });
		assert.equal(reply?.ok, false, String(pid));
		assert.match(String(reply?.error), /is not a foreground process of pane wA:p2; only the pi of the pane registers/);
	}
	assert.equal((await w.call({ cmd: "cars-register", session: "sess-nobody", pid: 5, pane: "wX:p9" }))?.ok, false);
	assert.deepEqual(w.book.read("acme")[0]!.file.states.map((s) => s.state), ["received"], "no state was added");
});

test("the secret does not reach the model: the tool's text and details and the log never hold it", async () => {
	const w = world();
	const out = await receive(w);
	assert.ok(!JSON.stringify(out).includes("secret-"), "the tool's answer");
	assert.ok(!w.logs.join("\n").includes("secret-"), "the server's log");
	assert.ok(!readFileSync(join(w.stateDir, "trainboard", "acme", "cars", `web-${SHA_A.slice(0, 12)}.json`), "utf8").includes("secret-"), "the journal");
});

test("a pi that started again (a new pid) registers anew and the old secret stops working; a pi that moved panes is not the registered process", async () => {
	const w = world();
	await w.opened();
	await receive(w);
	const old = [...(w.integ as unknown as { ensure(): Promise<string> }).ensure ? [await w.integ.ensure()] : []][0]!;
	w.looks.set(INTEG, { ...w.looks.get(INTEG)!, foreground: [333] });
	const moved = await w.call({ cmd: "cars-set", secret: old, state: "returned", car: { app: "web", head: SHA_A }, fields: { reason: "x" } });
	assert.match(String(moved?.error), /is not the process that registered \(it ended or moved\)/, "pid 111 is no longer the pane's pi");
	const again = await w.call({ cmd: "cars-register", session: INTEG, pid: 333, pane: "wA:p1", started: "start-333" });
	assert.equal(again?.ok, true);
	assert.notEqual(again?.secret, old);
	const reply = await w.call({ cmd: "cars-set", secret: old, state: "returned", car: { app: "web", head: SHA_A }, fields: { reason: "x" } });
	assert.match(String(reply?.error), /not from a registered session/, "the old secret is gone");
});

test("a server that started again knows no secret: the client registers again once and the call goes through", async () => {
	const w = world();
	w.forwarded();
	const first = await trainCar(integratorDeps(w), received, integratorCtx(forwardEntry(COORD)));
	assert.ok(first.text);
	// The registration is lost (a restart): the client's held secret is stale. Same process, so the server hands out a new one.
	const forgotten = carWorld();
	worlds.push(forgotten);
	forgotten.forwarded();
	const stale = new Map([[`${INTEG}|111`, "stale-secret"]]);
	const client = forgotten.client(INTEG, 111, "wA:p1", stale);
	const out = await trainCar({ ...integratorDeps(forgotten), client }, received, integratorCtx(forwardEntry(COORD)));
	assert.match(out.text, /^Car T-15 is received/);
	assert.notEqual(stale.get(`${INTEG}|111`), "stale-secret");
});

test("a train's role is read by the server from Herdr, not from the request: a pane that is no train's cannot set a train's states", async () => {
	const w = world();
	await w.opened();
	await receive(w);
	const r = rig({ manifest: MANIFEST });
	w.looks.set(TRAIN, { ...w.looks.get(TRAIN)!, role: "member" });
	const { pushed } = repo(w);
	await refused(trainCar(trainDeps(w, r), { car: "T-15", state: "landed", version: "1", commit: pushed }, r.ctx as never), "sb: session train 1106m is neither a train nor a main (its role is member)");
	w.looks.set(TRAIN, { ...w.looks.get(TRAIN)!, role: "train", train: { project: "acme", code: "2026-11-06-n" } });
	await refused(trainCar(trainDeps(w, r), { car: "T-15", state: "landed", version: "1", commit: pushed }, r.ctx as never), "sb: this server did not open train 2026-11-06-n of project acme for session sess-train-1");
});

test("the car file is written for the yard and private, and a book started again reads none of it (CR-F003)", async () => {
	const w = world();
	await w.opened();
	await receive(w);
	assert.equal(existsSync(join(w.stateDir, "trainboard", "acme", "cars", `web-${SHA_A.slice(0, 12)}.json`)), true, "written");
	assert.equal((statSync(join(w.stateDir, "trainboard", "acme", "cars")).mode & 0o077), 0, "folder 700");
	const { CarBook } = await import("../src/server/carbook.ts");
	const again = new CarBook({ ...w.deps } as never);
	assert.deepEqual(again.read("acme"), []);
	assert.equal(again.forwardOf(SHA_A, INTEG), undefined);
	assert.equal(again.trainOf("acme", CODE), undefined);
});
function existsAndIsPrivate(dir: string) {
	mkdirSync(dir, { recursive: true });
	return existsSync(dir);
}
void writeFileSync;

test("a slip over the bound of a car is forwarded but refused at received and returned, with train check's word, and no car file is written", async () => {
	const cases: [string, string][] = [
		[Array.from({ length: 70 }, (_, i) => `MP-${3600 + i}`).join(", "), "70 tickets, and a car carries at most 64"],
		[`MP-3600, ${"x".repeat(200)}`, "is longer than 64 characters"],
	];
	for (const [tickets, word] of cases) for (const state of ["received", "returned"] as const) {
		const w = world(), text = slipBlock({ tickets });
		w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text });
		const params = state === "received" ? { car: "MP-3600", state, train: CODE, departs: "next train", project: "acme" } : { car: "MP-3600", state, reason: "sb: no", project: "acme" };
		await assert.rejects(trainCar(integratorDeps(w), params, integratorCtx(forwardEntry(COORD, text))), (e: Error) => e.message.includes(word));
		assert.equal(w.book.read("acme").length, 0, "nothing is held");
	}
});
