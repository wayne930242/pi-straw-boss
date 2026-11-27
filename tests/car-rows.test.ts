import assert from "node:assert/strict";
import { test } from "node:test";
import { CAR_ROWS_EVENT, type CarRowV1, carRows, carsText, duration, factLine } from "../src/carline.ts";
import { REMIND_MS, registerCarRows, UNRECEIVED } from "../src/carrows.ts";
import { carsReply } from "../src/server/carops.ts";
import type { CarFact } from "../src/train/carfacts.ts";

// Car rows in a session (docs/specs/2026-11-28-car-rows.md): the facts the server answers `cars-rows` with, worded in the session's language ("ladder", boss 2026-11-28), placed under the todo that names the car's
// ticket, answered on `straw-boss:car-rows:v1`, `/boss cars`, and the one reminder for a slip nobody received in 15 minutes.

const MIN = 60_000, NOW = Date.parse("2026-11-27T10:00:00Z");
const ME = "01a21221-b15a-75be-8619-f7ab0167be41", INTEG = "01a207a3-5b88-764f-b60f-cac61f4c150c";
const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40), SHA_C = "c".repeat(40);
const fact = (over: Partial<CarFact> = {}): CarFact => ({ id: `mp/rest-api-v3-${SHA_A.slice(0, 12)}#1`, project: "mp", app: "rest-api-v3", head: SHA_A, tickets: ["MP-5801"], coordinator: ME, integrator: INTEG, phase: "riding", train: "2026-11-27-l", since: NOW - 12 * MIN, stage: { kind: "merge", at: 4, of: 7, attempt: 1 }, ...over });
const todo = (id: number, subject: string, status = "pending", uid?: string) => ({ id, subject, status, ...(uid ? { uid } : {}) });
const branch = (tasks: ReturnType<typeof todo>[]) => [{ type: "custom", customType: "todo/v1", data: { v: 1, tasks, nextId: tasks.length + 1 } }];

test("the ladder: the train's short code, the stages done of the app's ladder, the stage now, and what it waits for after the time", () => {
	assert.deepEqual(factLine(fact(), "zh-TW", NOW), { line: "🚂 1127l ▰▰▰▱▱▱▱ merge", tone: "ok" }, "the stage is the train's own id in every language (boss 2026-11-28)");
	assert.deepEqual(factLine(fact(), "en", NOW), { line: "🚂 1127l ▰▰▰▱▱▱▱ merge", tone: "ok" });
	const waits = fact({ stage: { kind: "merge", at: 4, of: 7, attempt: 2 }, waits: [{ lane: { app: "rest-api-v3", holder: "2026-11-27-j" } }] });
	assert.deepEqual(factLine(waits, "zh-TW", NOW), { line: "🚂 1127l ▰▰▰▱▱▱▱ merge（第 2 次）", wait: "等 1127j", tone: "wait" });
	assert.deepEqual(factLine(waits, "en", NOW), { line: "🚂 1127l ▰▰▰▱▱▱▱ merge (try 2)", wait: "waits 1127j", tone: "wait" });
	assert.deepEqual(factLine(fact({ stage: { kind: "review", at: 2, of: 7, attempt: 1, between: true } }), "zh-TW", NOW).line, "🚂 1127l ▰▰▱▱▱▱▱ review ✓");
	assert.deepEqual(factLine(fact({ stage: { kind: "rollback", attempt: 1 } }), "zh-TW", NOW).line, "🚂 1127l rollback", "off the ladder: the stage alone");
	assert.deepEqual(factLine(fact({ stale: true }), "zh-TW", NOW), { line: "🚂 1127l ▰▰▰▱▱▱▱ merge", wait: "火車停滯", tone: "warn" });
	const lane = fact({ waits: [{ lane: { app: "rest-api-v3", holder: "2026-11-27-j" } }] }), todos = [todo(1, "MP-5801 fix")];
	assert.equal(carsText(carRows({ facts: [lane], sent: [], todos, me: ME, lang: "en", now: NOW }), todos, ME, "en", NOW), "Cars\n#1 MP-5801 fix\n  🚂 1127l ▰▰▰▱▱▱▱ merge 12m · waits 1127j", "the boss's own example");
});

test("the other phases: waiting with the departure rule, landed with its version, returned and dropped with the reason", () => {
	const waiting = fact({ phase: "waiting", train: "2026-11-27-m", app: "fe2", stage: undefined, departs: { maxCars: 4, maxWaitMin: 60, oldest: new Date(NOW - 37 * MIN).toISOString() } });
	assert.deepEqual(factLine(waiting, "zh-TW", NOW), { line: "🚉 fe2 等發車", wait: "滿 4 節或 60 分（還 23 分）", tone: "wait" });
	assert.deepEqual(factLine({ ...waiting, departs: { ...waiting.departs!, oldest: new Date(NOW - 61 * MIN).toISOString() } }, "en", NOW).wait, "leaves at 4 cars or 60 min (time is up)");
	assert.deepEqual(factLine(fact({ phase: "landed", version: "1.62.0-beta.24", stage: undefined }), "zh-TW", NOW), { line: "✅ 1127l 已落地 1.62.0-beta.24", tone: "ok" });
	assert.deepEqual(factLine(fact({ phase: "returned", train: undefined, reason: "head is not the tip", stage: undefined }), "zh-TW", NOW), { line: "↩ 退回", wait: "head is not the tip", tone: "bad" });
	assert.deepEqual(factLine(fact({ phase: "dropped", reason: "unit red", stage: undefined }), "en", NOW), { line: "✖ 1127l dropped", wait: "unit red", tone: "bad" });
	assert.deepEqual([duration(42_000), duration(12 * MIN + 5_000), duration(65 * MIN)], ["42s", "12m", "1h05m"]);
});

test("a row goes under the open todo that names its ticket: the one in progress among several, its uid else <session8>#<id>; none puts it in Other cars with its ticket; the integrator's trains are Trains", () => {
	const facts = [fact(), fact({ id: "b", head: SHA_B, tickets: ["MP-5803"], phase: "waiting", stage: undefined }), fact({ id: "c", head: SHA_C, tickets: ["MP-5790"] }), fact({ id: "t", head: "d".repeat(40), tickets: ["MP-6000"], coordinator: "someone", integrator: ME, train: "2026-11-27-k" })];
	const todos = [todo(1, "MP-5801 完成率欄位錯誤修正", "pending", "t_aaaaaaaaaa"), todo(2, "review mp-5801 fix", "in_progress"), todo(3, "MP-5803 報價明細排序"), todo(4, "MP-58012 not this one", "pending"), todo(5, "MP-5790 done", "completed")];
	const rows = carRows({ facts, sent: [], todos, me: ME, lang: "zh-TW", now: NOW });
	const by = (id: string) => rows.find((r) => r.id === id)!;
	assert.equal(by(fact().id).item, `${ME.slice(0, 8)}#2`, "two todos name MP-5801: the one in progress, which has no uid");
	assert.equal(by("b").item, `${ME.slice(0, 8)}#3`);
	assert.deepEqual([by("c").item, by("c").group, by("c").wait], [undefined, "其他車廂", "MP-5790"], "a completed todo takes no row");
	const train = rows.find((r) => r.id === "train:mp/2026-11-27-k")!;
	assert.deepEqual([train.group, train.line, train.wait, train.tickets], ["火車", "🚂 1127k rest-api-v3 ▰▰▰▱▱▱▱ merge", "MP-6000", ["MP-6000"]]);
	const one = carRows({ facts: [fact()], sent: [], todos: [todo(1, "MP-5801 fix", "pending", "t_aaaaaaaaaa")], me: ME, lang: "en", now: NOW })[0]!;
	assert.deepEqual(one, { id: fact().id, item: "t_aaaaaaaaaa", tickets: ["MP-5801"], phase: "riding", tone: "ok", line: "🚂 1127l ▰▰▰▱▱▱▱ merge", since: NOW - 12 * MIN } satisfies CarRowV1);
});

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;
function world(answer: () => CarFact[] | undefined = () => []) {
	const handlers = new Map<string, Handler[]>(), bus = new Map<string, ((d: unknown) => void)[]>(), sent: { message: Record<string, unknown>; options: unknown }[] = [], asked: Record<string, unknown>[] = [];
	let clock = NOW, tasks = [todo(1, "MP-5810 料號欄位", "in_progress")];
	const pi = {
		events: { on: (c: string, h: (d: unknown) => void) => (bus.set(c, [...(bus.get(c) ?? []), h]), () => {}), emit: (c: string, d: unknown) => (bus.get(c) ?? []).forEach((h) => h(d)) },
		on: (type: string, h: Handler) => void handlers.set(type, [...(handlers.get(type) ?? []), h]),
		sendMessage: (message: Record<string, unknown>, options: unknown) => void sent.push({ message, options }),
	};
	const rows = registerCarRows({
		pi: pi as never, me: () => ME, enabled: () => true, branch: () => branch(tasks), lang: () => "zh-TW", now: () => clock, every: 0, held: new Map(),
		call: async (request) => (asked.push(request), ((cars) => (cars ? { ok: true, cars } : undefined))(answer())),
	});
	const fire = (type: string, event: Record<string, unknown>) => (handlers.get(type) ?? []).forEach((h) => h(event));
	const probe = () => { const p: { rows?: { version: number; rows: CarRowV1[] } } = {}; pi.events.emit(CAR_ROWS_EVENT, p); return p.rows; };
	const slip = `car: rest-api-v3 | tickets: MP-5810\nbranch: agent/mp-5810\nhead: ${SHA_C}\ncoordinator: ${ME}\ndeparts: next\naccept: none`;
	return { rows, fire, probe, sent, asked, slip, tick: (ms: number) => void (clock += ms), todos: (list: ReturnType<typeof todo>[]) => void (tasks = list), shared: (message: string, extra: Record<string, unknown> = {}) => fire("tool_result", { toolName: "call_tower", input: { message, why: "shared" }, isError: false, ...extra }) };
}

test("the probe answers version 1 with this session's rows, from the server's facts; an object that is no probe is left alone", async () => {
	const w = world(() => [fact({ tickets: ["MP-5810"] })]);
	assert.deepEqual(w.probe(), { version: 1, rows: [] }, "nothing asked yet: no rows");
	await w.rows.refresh();
	assert.deepEqual(w.asked, [{ cmd: "cars-rows", session: ME }]);
	const rows = w.probe()!.rows;
	assert.deepEqual(rows.map((r) => [r.item, r.line]), [[`${ME.slice(0, 8)}#1`, "🚂 1127l ▰▰▰▱▱▱▱ merge"]]);
});

test("a slip sent with call_tower shows as sent until the server holds its car, and is told once to the coordinator 15 minutes after it was sent, never at 14", async () => {
	let held: CarFact[] = [];
	const w = world(() => held);
	w.shared(w.slip);
	w.shared(w.slip.replace(ME, "someone-else").replace(SHA_C, SHA_B), {}); // another coordinator's slip is not this session's
	w.fire("tool_result", { toolName: "call_tower", input: { message: w.slip.replace(SHA_C, SHA_A), why: "shared" }, isError: true }); // the tower did not take it
	await w.rows.refresh();
	const [row] = w.probe()!.rows;
	assert.deepEqual([w.probe()!.rows.length, row!.id, row!.phase, row!.line, row!.wait, row!.tone, row!.item, row!.since], [1, `sent:rest-api-v3-${SHA_C.slice(0, 12)}`, "sent", "📮 已送出", "調度員還沒收", "wait", `${ME.slice(0, 8)}#1`, NOW]);
	w.tick(REMIND_MS - MIN);
	await w.rows.refresh();
	assert.equal(w.sent.length, 0, "14 minutes: no reminder");
	w.tick(MIN);
	await w.rows.refresh();
	assert.equal(w.sent.length, 1, "15 minutes: one reminder");
	assert.equal(w.sent[0]!.message.customType, UNRECEIVED);
	assert.match(String(w.sent[0]!.message.content), /MP-5810.*cccccccccccc.*15 minutes/s);
	assert.match(String(w.sent[0]!.message.content), /call_tower/);
	assert.deepEqual(w.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(w.probe()!.rows[0]!.tone, "warn");
	await w.rows.refresh();
	assert.equal(w.sent.length, 1, "once");
	held = [fact({ head: SHA_C, tickets: ["MP-5810"], phase: "waiting", stage: undefined })];
	await w.rows.refresh();
	assert.deepEqual(w.probe()!.rows.map((r) => r.phase), ["waiting"], "the server holds it: the sent row goes");
});

test("a slip the server received before 15 minutes is never told; a server that does not answer tells nothing", async () => {
	let held: CarFact[] | undefined = undefined;
	const w = world(() => held);
	w.shared(w.slip);
	w.tick(REMIND_MS + MIN);
	await w.rows.refresh();
	assert.equal(w.sent.length, 0, "no answer from the server: it cannot say the slip was not received");
	held = [fact({ head: SHA_C, tickets: ["MP-5810"], phase: "returned", reason: "no", stage: undefined })];
	await w.rows.refresh();
	held = [];
	w.tick(MIN);
	await w.rows.refresh();
	assert.equal(w.sent.length, 0);
	assert.deepEqual(w.probe()!.rows, []);
});

test("/boss cars prints the rows with their times under their todos, Other cars and Trains; with none it says so", async () => {
	const w = world(() => [fact({ tickets: ["MP-5810"], waits: [{ load: { max: 28, now: 31 } }] }), fact({ id: "x", head: SHA_B, tickets: ["MP-5790"], phase: "waiting", app: "fe2", stage: undefined })]);
	const text = await w.rows.text();
	assert.equal(text, ["車廂", "#1 MP-5810 料號欄位", "  🚂 1127l ▰▰▰▱▱▱▱ merge 12m · 等負載 ≤28（現在 31）", "其他車廂", "  🚉 fe2 等發車 12m · MP-5790"].join("\n"));
	const none = world(() => []);
	assert.match(await none.rows.text(), /沒有車廂/);
});

test("the server's cars-rows takes a session id and answers the rows of that session alone", async () => {
	const rows = (session: string) => [fact(), fact({ id: "o", coordinator: "other", integrator: "x" })].filter((c) => c.coordinator === session || c.integrator === session);
	const cars = { book: {} as never, notices: {} as never, rows };
	assert.deepEqual(await carsReply(cars, { cmd: "cars-rows", session: ME }), { ok: true, cars: [fact()] });
	assert.deepEqual(await carsReply(cars, { cmd: "cars-rows", session: 42 } as never), { ok: false, error: "sb: cars-rows needs a session id" });
});
