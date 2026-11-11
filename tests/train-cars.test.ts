import assert from "node:assert/strict";
import { test } from "node:test";
import { addState, CAR_STATES, type CarFile, carFileName, emptyCar, noticeSatisfied, noticeStatus, type NoticeRecord, noticeText, RETRY_MS, type Setter, TERMINAL_STATES, validateCarFile, validateStateFields } from "../src/train/cars.ts";
import { CODE, SHA_A, SHA_B, SHA_C } from "./train-fixtures.ts";

// §5.5: a car's states and what each carries, the car file's shape, the text of each notice, and when a notice counts as told. The sender is the sb server (task 5a); nothing here sends.

const by: Setter = { role: "train", name: "train 1106m", session: "sess-train-1" };
const integ: Setter = { role: "main", name: "integ acme", session: "sess-integ-1" };
const car = (): CarFile => emptyCar({ project: "acme", app: "web", tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1" });
const AT = "2026-11-07T08:00:00Z";
const set = (file: CarFile, state: Parameters<typeof addState>[1]["state"], fields: Record<string, unknown>, who: Setter = by) => addState(file, { state, fields, by: who, at: AT });

test("the four states, three of them terminal", () => {
	assert.deepEqual([...CAR_STATES], ["received", "returned", "dropped", "landed"]);
	assert.deepEqual([...TERMINAL_STATES], ["returned", "dropped", "landed"]);
});

test("each state's fields: received needs the train and its departure words, returned a reason, dropped a round, reason and evidence, landed a version and a 40-hex commit", () => {
	const cases: [Parameters<typeof validateStateFields>[0], Record<string, unknown>, RegExp | null][] = [
		["received", { train: CODE, departs: "when 4 cars or 60 minutes" }, null],
		["received", { departs: "x" }, /received needs train/], ["received", { train: "1106m", departs: "x" }, /received\.train must be/], ["received", { train: CODE }, /received needs departs/],
		["returned", { reason: "sb: the train runs no acceptance: car T-15 asks for UAT" }, null],
		["returned", {}, /returned needs reason/], ["returned", { reason: "" }, /returned needs reason/], ["returned", { reason: "r".repeat(601) }, /returned\.reason must be 1 to 600 characters/],
		["dropped", { round: 1, reason: "unit red", evidence: "/r/unit.log" }, null],
		["dropped", { reason: "x", evidence: "/e" }, /dropped needs round/], ["dropped", { round: 0, reason: "x", evidence: "/e" }, /dropped\.round must be a whole number from 1/],
		["dropped", { round: 1, evidence: "/e" }, /dropped needs reason/], ["dropped", { round: 1, reason: "x" }, /dropped needs evidence/],
		["landed", { version: "1.62.0", commit: SHA_B }, null],
		["landed", { commit: SHA_B }, /landed needs version/], ["landed", { version: "1" }, /landed needs commit/], ["landed", { version: "1", commit: "abc" }, /landed\.commit must be 40 hex/],
		["landed", { version: "1", commit: SHA_B, extra: 1 }, /landed\.extra is not a field/],
	];
	for (const [state, fields, pattern] of cases) {
		const out = validateStateFields(state, fields);
		if (pattern === null) assert.deepEqual(out, [], `${state} ${JSON.stringify(fields)}`);
		else assert.ok(out.some((r) => pattern.test(r)), `${state} ${JSON.stringify(fields)}: ${JSON.stringify(out)}`);
	}
	assert.ok(validateStateFields("bogus" as never, {}).some((r) => /state "bogus" is not one of received, returned, dropped, landed/.test(r)));
});

test("a car file starts empty, takes a state with who set it and when, and one terminal state only", () => {
	let file = car();
	assert.deepEqual(file.states, []);
	file = set(file, "received", { train: CODE, departs: "next train" }, integ);
	file = set(file, "landed", { version: "1.62.0", commit: SHA_B });
	assert.deepEqual(file.states.map((s) => s.state), ["received", "landed"]);
	assert.deepEqual(file.states[1], { state: "landed", at: AT, by, version: "1.62.0", commit: SHA_B });
	assert.equal(car().states.length, 0, "the original is not changed");
	assert.throws(() => set(file, "dropped", { round: 1, reason: "x", evidence: "/e" }), /^Error: sb: car T-15 is already landed$/);
	assert.throws(() => set(file, "returned", { reason: "x" }), /sb: car T-15 is already landed/);
	assert.throws(() => set(file, "landed", { version: "2", commit: SHA_B }), /sb: car T-15 is already landed/);
	assert.throws(() => set(car(), "landed", { version: "1", commit: "bad" }), /landed\.commit must be 40 hex/);
	assert.throws(() => addState(car(), { state: "returned", fields: { reason: "r" }, by, at: "yesterday" }), /sb: at must be an ISO time with its zone/);
	assert.throws(() => set(file, "received", { train: CODE, departs: "x" }), /sb: car T-15 is already received|already landed/);
	const twice = set(car(), "received", { train: CODE, departs: "x" });
	assert.throws(() => set(twice, "received", { train: CODE, departs: "y" }), /sb: car T-15 is already received/);
	const returned = set(car(), "returned", { reason: "no accept" }, integ);
	assert.deepEqual(returned.states.map((s) => s.state), ["returned"], "a car can be returned at receipt without being received");
	assert.throws(() => set(returned, "received", { train: CODE, departs: "x" }), /already returned/);
});

test("a car file validates and names its file after the app and the first 12 hex of its head", () => {
	assert.equal(carFileName("web", SHA_A), "web-aaaaaaaaaaaa.json");
	assert.throws(() => carFileName("../x", SHA_A), /app/);
	assert.throws(() => carFileName("web", "abc"), /head/);
	const full = set(set(car(), "received", { train: CODE, departs: "x" }, integ), "landed", { version: "1", commit: SHA_B });
	assert.deepEqual(validateCarFile(full), []);
	assert.deepEqual(validateCarFile(JSON.parse(JSON.stringify(full))), []);
	const bad: [unknown, RegExp][] = [
		[{ ...car(), v: 2 }, /car\.v must be 1/], [{ ...car(), coordinator: "" }, /car\.coordinator/], [{ ...car(), car: undefined }, /car\.car/],
		[{ ...car(), states: [{ state: "landed", at: AT, by, version: "1" }] }, /states\[0\]: landed needs commit/],
		[{ ...car(), states: [{ state: "landed", at: "now", by, version: "1", commit: SHA_B }] }, /states\[0\]\.at must be an ISO time/],
		[{ ...car(), states: [{ state: "landed", at: AT, by: { role: "boss", name: "x", session: "s" }, version: "1", commit: SHA_B }] }, /states\[0\]\.by\.role must be train or main/],
		[{ ...car(), states: [{ state: "landed", at: AT, by, version: "1", commit: SHA_B }, { state: "dropped", at: AT, by, round: 1, reason: "x", evidence: "/e" }] }, /states\[1\]: car T-15 is already landed/],
		[{ ...car(), extra: 1 }, /car\.extra is not a field/], ["x", /car file must be an object/],
		[{ ...car(), project: ".." }, /car\.project must be a path-safe name/], [{ ...car(), app: "a/b" }, /car\.app must be a path-safe name/], [{ ...car(), states: "x" }, /car\.states must be an array/],
		[{ ...car(), car: { tickets: [], branch: "b", head: SHA_A } }, /car\.car\.tickets must be a list of 1 to 64 tickets/], [{ ...car(), car: { tickets: Array.from({ length: 65 }, (_, i) => `T-${i}`), branch: "b", head: SHA_A } }, /car\.car\.tickets must be a list of 1 to 64/], [{ ...car(), car: { tickets: ["T-15"], branch: "", head: SHA_A } }, /car\.car\.branch/], [{ ...car(), car: { tickets: ["T-15"], branch: "b", head: "x" } }, /car\.car\.head must be 40 hex/],
		[{ ...car(), states: ["x"] }, /states\[0\] must be an object/], [{ ...car(), states: [{ state: "returned", at: AT, reason: "r" }] }, /states\[0\]\.by must name the session that set it/],
	];
	for (const [value, pattern] of bad) assert.ok(validateCarFile(value).some((r) => pattern.test(r)), `${pattern}: ${JSON.stringify(validateCarFile(value))}`);
});

test("the notice text of each state is the line of the table", () => {
	const ctx = { ticket: "T-15", head: SHA_A, train: CODE };
	assert.equal(noticeText("received", { ...ctx, departs: "when 4 cars or 60 minutes" }), "received: your car T-15 (aaaaaaaaaaaa) rides train 1106m; it departs when 4 cars or 60 minutes");
	assert.equal(noticeText("returned", { ...ctx, reason: "sb: the train runs no acceptance" }), "returned: your car T-15 (aaaaaaaaaaaa): sb: the train runs no acceptance");
	assert.equal(noticeText("dropped", { ...ctx, round: 2, reason: "unit red", evidence: "/r/unit.log" }), "dropped from train 1106m round 2: unit red; evidence /r/unit.log");
	assert.equal(noticeText("landed", { ...ctx, version: "1.62.0", commit: SHA_B }), `landed in 1.62.0, your commit is ${SHA_B}`);
	assert.throws(() => noticeText("landed", ctx), /landed needs version/);
});

test("a notice counts as told when delivered or escalated; queued, failed and unknown attempts do not, and retries come at 30 s, 2 min and 5 min", () => {
	assert.deepEqual([...RETRY_MS], [30_000, 120_000, 300_000]);
	const rec = (landed: object): NoticeRecord => ({ v: 1, states: { landed } as NoticeRecord["states"] });
	assert.deepEqual(noticeStatus(undefined, "landed"), { kind: "pending", attempts: 0 });
	assert.deepEqual(noticeStatus(rec({ attempts: [{ at: AT, outcome: "queued", answer: "queued" }] }), "landed"), { kind: "pending", attempts: 1, last: "queued" });
	assert.deepEqual(noticeStatus(rec({ attempts: [{ at: AT, outcome: "failed", answer: "socket closed" }, { at: AT, outcome: "queued" }] }), "landed"), { kind: "pending", attempts: 2, last: "queued" });
	assert.deepEqual(noticeStatus(rec({ attempts: [{ at: AT, outcome: "delivered", answer: "socket_delivered" }], deliveredAt: AT }), "landed"), { kind: "delivered", attempts: 1, at: AT });
	assert.deepEqual(noticeStatus(rec({ attempts: [{ at: AT, outcome: "failed", answer: "socket closed" }] }), "landed"), { kind: "pending", attempts: 1, last: "socket closed" }, "the broker's own words win over our label");
	assert.equal(noticeStatus(rec({ attempts: [], escalatedAt: "garbage" }), "landed").kind, "pending", "an escalation without a time is none");
	assert.deepEqual(noticeStatus(rec({ attempts: [{ at: AT, outcome: "not-live" }], escalatedAt: AT }), "landed"), { kind: "escalated", attempts: 1, at: AT });
	assert.equal(noticeStatus(rec({ attempts: [{ at: AT, outcome: "queued" }], deliveredAt: "garbage" }), "landed").kind, "pending", "a delivery without a time is none");
	assert.deepEqual(noticeStatus(rec({ attempts: [], deliveredAt: AT, escalatedAt: AT }), "landed").kind, "delivered", "delivered wins over escalated");
	assert.equal(noticeStatus(rec({ attempts: [] }), "returned").kind, "pending", "records are per state");
});

test("the notice check: every named car's terminal state is the one asked and its notice is told", () => {
	const landed = set(car(), "landed", { version: "1", commit: SHA_B });
	const other = emptyCar({ project: "acme", app: "web", tickets: ["T-16"], branch: "b", head: SHA_B, coordinator: "c2" });
	const otherLanded = set(other, "landed", { version: "1", commit: SHA_B });
	const told: NoticeRecord = { v: 1, states: { landed: { attempts: [{ at: AT, outcome: "delivered" }], deliveredAt: AT } } as NoticeRecord["states"] };
	const esc: NoticeRecord = { v: 1, states: { landed: { attempts: [], escalatedAt: AT } } as NoticeRecord["states"] };
	const run = (cars: { file: CarFile; notice?: NoticeRecord }[], tickets: string[], state: "landed" | "returned" | "dropped" = "landed") => noticeSatisfied(cars, tickets, state);
	assert.deepEqual(run([{ file: landed, notice: told }, { file: otherLanded, notice: esc }], ["T-15", "T-16"]), []);
	assert.match(run([{ file: landed }], ["T-15"]).join("\n"), /^sb: waits for sb to tell sess-coord-1 that car T-15 is landed \(0 attempts\)$/);
	assert.match(run([{ file: landed, notice: { v: 1, states: { landed: { attempts: [{ at: AT, outcome: "queued", answer: "queued" }] } } as NoticeRecord["states"] } }], ["T-15"]).join("\n"), /\(1 attempts?, last: queued\)/);
	assert.match(run([{ file: car(), notice: told }], ["T-15"]).join("\n"), /car T-15 has no terminal state yet/);
	assert.match(run([{ file: landed, notice: told }], ["T-15"], "returned").join("\n"), /car T-15 is landed, not returned/);
	assert.match(run([{ file: landed, notice: told }], ["T-15", "T-99"]).join("\n"), /car T-99 has no car file/);
	assert.deepEqual(run([], []), [], "no cars asked, nothing to wait for");
});

test("F006: two car files of one ticket: the newest life counts, a tie is refused, and an app narrows the choice", () => {
	const at = (n: number) => `2026-11-07T0${n}:00:00Z`;
	const told = (state: "landed" | "returned"): NoticeRecord => ({ v: 1, states: { [state]: { attempts: [], deliveredAt: at(9) } } as NoticeRecord["states"] });
	const old = addState(car(), { state: "returned", fields: { reason: "no accept" }, by: integ, at: at(1) });
	const fresh = addState(emptyCar({ project: "acme", app: "web", tickets: ["T-15"], branch: "fix/t-15", head: SHA_B, coordinator: "sess-coord-1" }), { state: "landed", fields: { version: "1", commit: SHA_C }, by, at: at(5) });
	for (const order of [[old, fresh], [fresh, old]]) assert.deepEqual(noticeSatisfied(order.map((file) => ({ file, notice: told(file === old ? "returned" : "landed") })), ["T-15"], "landed"), [], "the new car's land passes whatever the read order");
	const twin = { ...fresh, car: { ...fresh.car, head: SHA_A } };
	assert.match(noticeSatisfied([{ file: fresh, notice: told("landed") }, { file: twin, notice: told("landed") }], ["T-15"], "landed").join("\n"), /^sb: car T-15 has 2 car files with the same latest state/);
	const api = addState(emptyCar({ project: "acme", app: "api", tickets: ["T-15"], branch: "b", head: SHA_C, coordinator: "c" }), { state: "returned", fields: { reason: "x" }, by, at: at(7) });
	assert.match(noticeSatisfied([{ file: fresh, notice: told("landed") }, { file: api }], ["T-15"], "landed").join("\n"), /is returned, not landed/, "without an app the newest wins");
	assert.deepEqual(noticeSatisfied([{ file: fresh, notice: told("landed") }, { file: api }], ["T-15"], "landed", { app: "web" }), []);
});

test("F011: a wrong-typed reason or evidence says what it must be, not that it is too long", () => {
	assert.match(validateStateFields("returned", { reason: 5 }).join("\n"), /returned\.reason must be 1 to 600 characters/);
	assert.match(validateStateFields("dropped", { round: 1, reason: ["x"], evidence: "/e" }).join("\n"), /dropped\.reason must be 1 to 600 characters/);
	assert.match(validateStateFields("dropped", { round: 1, reason: "x", evidence: 5 }).join("\n"), /dropped\.evidence must be a path of 1 to 1024 characters/);
	assert.match(validateStateFields("returned", { reason: "r".repeat(601) }).join("\n"), /returned\.reason must be 1 to 600 characters/);
});
