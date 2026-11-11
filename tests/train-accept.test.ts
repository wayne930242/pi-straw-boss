import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAcceptRef, checkCar, checkEvidence, checkSlip, checkStages, MAX_EVIDENCE_BYTES, parseAppAccept, parseDeparts, parseSlip } from "../src/train/accept.ts";
import { MAX_CAR_TICKETS, MAX_TICKET_CHARS } from "../src/train/spec.ts";
import { evidence, type Json, SHA_A, SHA_B, SHA_C, slip } from "./train-fixtures.ts";

// §5.1 to §5.2: the slip's `departs` and `accept` lines, `integration.accept`, and what `train check --accept` proves (and does not).

const files = new Set(["/r/e2e.log", "/r/uat-captures", "/r/delta-review.md"]);
const exists = (path: string) => files.has(path);
const ancestors = new Set([`${SHA_B}>${SHA_A}`]);
const isAncestor = (older: string, newer: string) => ancestors.has(`${older}>${newer}`);
const run = (value: unknown, appAccept: string[] = ["e2e"], head: string | null = SHA_A) => checkEvidence(typeof value === "string" ? value : JSON.stringify(value), { appAccept, head: head ?? undefined, exists, isAncestor });
const uat = (entry: Json = {}) => ({ kind: "uat", what: "order form checkpoints", on: { head: SHA_A }, result: "accepted", evidence: "/r/uat-captures", at: "2026-11-07T07:20:00Z", nod: "accepted, thanks", ...entry });

test("a complete evidence file passes: every required kind, passed, a path that exists, a nod, a time, the car's head", () => {
	assert.deepEqual(run(evidence()), []);
	assert.deepEqual(run(evidence({ accepted: [evidence().accepted, uat()].flat() }), ["e2e", "uat"]), []);
	assert.deepEqual(run(evidence({ accepted: [] }), []), [], "an app that requires nothing accepts an empty list");
	assert.deepEqual(run(evidence({}, { kind: "other", label: "load" }), ["load"]), [], "`other` with a label satisfies a required kind of that name");
});

test("a required kind with no entry is refused, and every missing kind is named", () => {
	assert.match(run(evidence(), ["e2e", "uat"]).join("\n"), /^sb: acceptance evidence lacks a uat entry \(the app requires e2e, uat\)$/);
	assert.match(run(evidence({ accepted: [] }), ["e2e", "uat"]).join("\n"), /lacks a e2e entry[^]*lacks a uat entry/);
	assert.match(run(evidence({}, { kind: "other", label: "load" }), ["e2e"]).join("\n"), /lacks a e2e entry/);
});

test("an entry's kind is e2e, uat or other with a label; its nod, evidence, time and result are checked one by one", () => {
	assert.match(run(evidence({}, { kind: "smoke" })).join("\n"), /entry 1: kind must be e2e, uat or other/);
	assert.match(run(evidence({}, { kind: "other" }), []).join("\n"), /entry 1: kind other needs a label/);
	assert.match(run(evidence({}, { nod: "" })).join("\n"), /entry 1: nod is empty/);
	assert.match(run(evidence({}, { nod: "   " })).join("\n"), /entry 1: nod is empty/);
	assert.match(run(evidence({}, { nod: undefined })).join("\n"), /entry 1: nod is empty/);
	assert.match(run(evidence({}, { evidence: "/r/missing.log" })).join("\n"), /entry 1: evidence \/r\/missing\.log does not exist/);
	assert.match(run(evidence({}, { evidence: "" })).join("\n"), /entry 1: evidence is empty/);
	assert.match(run(evidence({}, { at: "last tuesday" })).join("\n"), /entry 1: at must be an ISO time/);
	assert.match(run(evidence({}, { at: "2026-11-07T07:10:00" })).join("\n"), /entry 1: at must be an ISO time/, "a time without its zone is no time");
	assert.match(run(evidence({}, { what: "" })).join("\n"), /entry 1: what is empty/);
	assert.match(run(evidence({}, { surprise: 1 })).join("\n"), /entry 1: surprise is not a field/);
});

test("on.head must be the car's head; an ancestor passes only with a `delta` review that exists", () => {
	assert.match(run(evidence({}, { on: { head: SHA_C } })).join("\n"), /entry 1: on\.head is not the car's head/);
	assert.match(run(evidence({}, { on: { head: SHA_B } })).join("\n"), /entry 1: on\.head is not the car's head/, "an ancestor without a delta");
	assert.deepEqual(run(evidence({}, { on: { head: SHA_B }, delta: "/r/delta-review.md" })), [], "an ancestor with its delta");
	assert.match(run(evidence({}, { on: { head: SHA_B }, delta: "/r/gone.md" })).join("\n"), /entry 1: delta \/r\/gone\.md does not exist/);
	assert.match(run(evidence({}, { on: { head: SHA_C }, delta: "/r/delta-review.md" })).join("\n"), /entry 1: on\.head is not the car's head/, "a delta does not excuse a head that is no ancestor");
	assert.match(run(evidence({}, { on: undefined })).join("\n"), /entry 1: on\.head must be 40 hex/);
	assert.match(run(evidence({}, { on: { head: "abc" } })).join("\n"), /entry 1: on\.head must be 40 hex/);
	assert.match(run(evidence({}, { delta: "/r/delta-review.md" })).join("\n"), /entry 1: delta only goes with an on\.head that is an ancestor/, "a delta on the car's own head is a mistake");
});

test("the file is bounded and its car is the slip's: over 32 KB, bad JSON, a wrong version, car.head unlike the slip's", () => {
	assert.match(run(" ".repeat(MAX_EVIDENCE_BYTES + 1)).join("\n"), /^sb: evidence file is 32\.\d KB, more than 32$/);
	assert.match(run("{nope").join("\n"), /^sb: evidence file is not JSON/);
	assert.match(run("[]").join("\n"), /evidence file must be a JSON object/);
	assert.match(run(evidence({ v: 2 })).join("\n"), /evidence\.v must be 1/);
	assert.match(run(evidence({ car: { app: "web", tickets: ["T-15"], branch: "b", head: SHA_C } })).join("\n"), /car\.head is not the slip's head/);
	assert.deepEqual(run(evidence({ car: { app: "web", tickets: ["T-15"], branch: "b", head: SHA_C } }), ["e2e"], null).filter((r) => /slip's head/.test(r)), [], "no slip head given: nothing to compare");
	assert.match(run(evidence({ car: undefined })).join("\n"), /evidence\.car must be an object/);
	assert.match(run(evidence({ car: { app: "web", tickets: [], branch: "b", head: SHA_A } })).join("\n"), /car\.tickets/);
	assert.match(run(evidence({ accepted: "e2e" })).join("\n"), /evidence\.accepted must be an array/);
	const withCar = (over: Json) => evidence({ car: { app: "web", tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, ...over } });
	assert.match(run(withCar({ extra: 1 })).join("\n"), /evidence\.car\.extra is not a field/);
	assert.match(run(withCar({ app: "../x" })).join("\n"), /evidence\.car\.app must be a path-safe name/);
	assert.match(run(withCar({ app: ".." })).join("\n"), /evidence\.car\.app must be a path-safe name/);
	assert.match(run(withCar({ branch: "" })).join("\n"), /evidence\.car\.branch must be a non-empty string/);
	assert.match(run(withCar({ head: "abc" })).join("\n"), /evidence\.car\.head must be 40 hex/);
	assert.match(run(evidence({ extra: 1 })).join("\n"), /evidence\.extra is not a field/);
});

test("`accept: none` is allowed only for an app that requires no acceptance", () => {
	assert.deepEqual(checkAcceptRef("none", []), []);
	assert.deepEqual(checkAcceptRef("None", []), []);
	assert.match(checkAcceptRef("none", ["e2e", "uat"]).join("\n"), /^sb: accept: none is allowed only for an app whose integration\.accept is empty \(this app requires e2e, uat\)$/);
	assert.deepEqual(checkAcceptRef("/r/evidence.json", ["e2e"]), []);
	assert.match(checkAcceptRef("", []).join("\n"), /accept: is empty/);
	assert.match(checkAcceptRef(undefined, []).join("\n"), /the slip has no accept: line/);
});

test("`departs`: next, alone, with a car, after and by an ISO time, comma separated, one way to ride", () => {
	assert.deepEqual(parseDeparts("next"), { ok: true, departs: { mode: "next" } });
	assert.deepEqual(parseDeparts("alone"), { ok: true, departs: { mode: "alone" } });
	assert.deepEqual(parseDeparts("with T-12"), { ok: true, departs: { mode: "with", with: "T-12" } });
	assert.deepEqual(parseDeparts("with fix/t-12"), { ok: true, departs: { mode: "with", with: "fix/t-12" } });
	assert.deepEqual(parseDeparts("after 2026-11-07T09:00:00Z"), { ok: true, departs: { mode: "next", after: "2026-11-07T09:00:00Z" } }, "no ride named means next");
	assert.deepEqual(parseDeparts("alone, by 2026-11-07T18:00:00+08:00"), { ok: true, departs: { mode: "alone", by: "2026-11-07T18:00:00+08:00" } });
	assert.deepEqual(parseDeparts("with T-12, after 2026-11-07T09:00:00Z, by 2026-11-07T12:00:00Z"), { ok: true, departs: { mode: "with", with: "T-12", after: "2026-11-07T09:00:00Z", by: "2026-11-07T12:00:00Z" } });
	assert.deepEqual(parseDeparts(undefined), { ok: true, departs: { mode: "next" } }, "a slip without departs departs next");
	assert.deepEqual(parseDeparts(""), { ok: true, departs: { mode: "next" } });
	const refused = (value: string, pattern: RegExp) => {
		const out = parseDeparts(value);
		assert.equal(out.ok, false, value);
		assert.match(out.ok ? "" : out.refusal, pattern, value);
		assert.match(out.ok ? "" : out.refusal, /^sb: departs: /);
	};
	refused("soon", /"soon" is not one of next, alone, with <ticket or branch>, after <ISO time>, by <ISO time>/);
	refused("with", /"with" needs a ticket or branch/);
	refused("next, alone", /one of next, alone or with/);
	refused("alone, with T-1", /one of next, alone or with/);
	refused("after tomorrow", /after needs an ISO time/);
	refused("by 2026-11-07", /by needs an ISO time/);
	refused("after 2026-11-07T10:00:00Z, after 2026-11-07T11:00:00Z", /after twice/);
	refused("after 2026-11-07T10:00:00Z, by 2026-11-07T09:00:00Z", /after is later than by/);
});

test("the slip parser reads the block format, keeps quoted and parenthesised pipes inside their field, and keeps unknown fields", () => {
	const parsed = parseSlip(slip({ auth: `"ship it | now"`, light: "pass (a | b)", extra: "kept" } as Record<string, string>));
	assert.equal(parsed.fields.car, "web");
	assert.equal(parsed.fields.head, SHA_A);
	assert.equal(parsed.fields.auth, `"ship it | now"`);
	assert.equal(parsed.fields.light, "pass (a | b)");
	assert.equal(parsed.fields["tested-on"], SHA_B);
	assert.equal(parsed.fields.departs, "next");
	assert.equal(parsed.fields.extra, "kept");
	assert.equal(parsed.fields.accept, "/r/accept.json");
	assert.deepEqual(parsed.tickets, ["T-15"]);
	assert.deepEqual(parseSlip(slip({ tickets: "T-1, T-2 T-3" })).tickets, ["T-1", "T-2", "T-3"]);
	assert.deepEqual(parseSlip("nonsense").fields, {});
	assert.deepEqual(parseSlip(slip()).problems, [], "a plain slip has no problem");
	assert.match(parseSlip("nonsense").problems.join("\n"), /^sb: slip line 1: .*no key/);
	assert.equal(parseSlip("light: pass | light: fail").fields.light, "pass", "a key seen again is ignored");
	assert.equal(parseSlip('auth: "he said | then left" | coordinator: c').fields.coordinator, "c", "a quote closes");
});

test("the whole car: slip and evidence together, with the slip's head, the app's kinds and the slip's own departs", () => {
	const good = (s: string, e: unknown, appAccept: string[] = ["e2e"]) => checkCar(s, JSON.stringify(e), { appAccept, exists, isAncestor });
	assert.deepEqual(good(slip(), evidence()), []);
	assert.match(good(slip({ departs: "soon" }), evidence()).join("\n"), /departs: "soon"/);
	assert.match(good(slip({ head: SHA_C }), evidence()).join("\n"), /car\.head is not the slip's head/);
	assert.match(good(slip({ accept: "none" }), undefined as never).join("\n"), /accept: none is allowed only for an app whose integration\.accept is empty/);
	assert.deepEqual(checkCar(slip({ accept: "none" }), undefined, { appAccept: [], exists, isAncestor }), []);
	assert.match(good(slip(), evidence({}, { nod: "" })).join("\n"), /entry 1: nod is empty/);
	assert.match(checkCar(slip({ head: "abc" }), undefined, { appAccept: [], exists, isAncestor }).join("\n"), /slip head must be 40 hex/);
	assert.match(checkCar(slip({ head: undefined }), undefined, { appAccept: [], exists, isAncestor }).join("\n"), /slip head must be 40 hex/);
	assert.match(checkCar(slip({ accept: "/r/evidence.json" }), undefined, { appAccept: ["e2e"], exists, isAncestor }).join("\n"), /evidence file, but it was not read/);
	assert.match(good(slip({ tickets: undefined }), evidence()).join("\n"), /slip tickets/);
});

test("a slip over the bound of a car's tickets is refused with the word to split the car; the bound itself passes", () => {
	const ids = (n: number) => Array.from({ length: n }, (_, i) => `MP-${1000 + i}`).join(", ");
	assert.deepEqual(checkSlip(slip({ tickets: ids(MAX_CAR_TICKETS) }), { appAccept: [] }), []);
	const over = checkSlip(slip({ tickets: ids(MAX_CAR_TICKETS + 1) }), { appAccept: [] }).join("\n");
	assert.match(over, new RegExp(`slip tickets names ${MAX_CAR_TICKETS + 1} tickets, and a car carries at most ${MAX_CAR_TICKETS}: split the car`));
	assert.match(checkSlip(slip({ tickets: `MP-1, ${"x".repeat(MAX_TICKET_CHARS + 1)}` }), { appAccept: [] }).join("\n"), /longer than 64 characters/);
});

test("`integration.accept`: a list of kind names, default empty; a stage list has merge first and no uat", () => {
	assert.deepEqual(parseAppAccept(undefined), { ok: true, accept: [] });
	assert.deepEqual(parseAppAccept([]), { ok: true, accept: [] });
	assert.deepEqual(parseAppAccept(["e2e", "uat"]), { ok: true, accept: ["e2e", "uat"] });
	for (const bad of ["e2e", [1], [""], ["E2E"], ["a b"], ["e2e", "e2e"], [`x`.repeat(33)], { e2e: true }]) {
		const out = parseAppAccept(bad);
		assert.equal(out.ok, false, JSON.stringify(bad));
		assert.match(out.ok ? "" : out.refusal, /^sb: integration\.accept must be a list of kind names/, JSON.stringify(bad));
	}
	assert.deepEqual(checkStages(["merge"]), []);
	assert.deepEqual(checkStages(["merge", "deploy"]), []);
	assert.deepEqual(checkStages(undefined), [], "the default is merge");
	assert.match(checkStages(["merge", "deploy", "uat"]).join("\n"), /^sb: stages lists "uat"; move it to integration\.accept \(a coordinator accepts before loading\) and remove it from stages$/);
	assert.match(checkStages(["deploy"]).join("\n"), /stages must start with merge/);
	assert.match(checkStages(["merge", "build"]).join("\n"), /stage "build" is not one of merge, deploy/);
	assert.match(checkStages(["merge", "deploy", "deploy"]).join("\n"), /stage "deploy" twice/);
	assert.match(checkStages("merge").join("\n"), /stages must be a list/);
});

test("an evidence file whose car names more than MAX_CAR_TICKETS tickets is refused", () => {
	const ok = evidence() as { car: { tickets: string[] } };
	const many = { ...ok, car: { ...ok.car, tickets: Array.from({ length: MAX_CAR_TICKETS + 1 }, (_, i) => `MP-${i}`) } };
	assert.match(run(many).join("\n"), new RegExp(`evidence.car.tickets must be a list of 1 to ${MAX_CAR_TICKETS} tickets`));
	assert.doesNotMatch(run({ ...ok, car: { ...ok.car, tickets: Array.from({ length: MAX_CAR_TICKETS }, (_, i) => `MP-${i}`) } }).join("\n"), /car.tickets/);
});
