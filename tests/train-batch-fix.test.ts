import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Contract } from "../src/train/contract.ts";
import { readMaxTrains } from "../src/trainrole.ts";
import { openRefusal, readAppIntegration } from "../src/train/appsconfig.ts";
import { readYards } from "../src/server/trainyard.ts";
import { cleanup, forwardEntry, MANIFEST_HEADER, type Reply, rig, type Rig, slipBlock } from "./train-guard-rig.ts";
import { CODE, evidence, type Json, SHA_A, SHA_B, sb } from "./train-fixtures.ts";

// The whole-batch fix round of todo #125 (batch-review.md TB-F001..F003): what the code enforces of `integration.accept` and `stages`, and what the yard says of a car's acceptance. Every case goes through the guard's real write path
// (a `train` todo, then yard.json, then the server's reading), never through a hand-written fixture.

const roots: string[] = [];
afterEach(() => { cleanup(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => (roots.push(realpathSync(mkdtempSync(join(tmpdir(), "sb-batch-")))), roots.at(-1)!);
const ok = async (promise: Promise<Reply>) => { const reply = await promise; assert.equal(reply.ok, true, reply.reason ?? ""); };
const asRefusal = (reply: Reply) => (assert.equal(reply.ok, false, "the call was blocked"), reply.reason!);
const refused = async (promise: Promise<Reply>, pattern: RegExp) => assert.match(asRefusal(await promise), pattern);
const writeApps = (dir: string, text: string) => (mkdirSync(join(dir, ".straw-boss"), { recursive: true }), writeFileSync(join(dir, ".straw-boss", "apps.json"), text));
const config = (integration: Json | undefined, name = "web") => JSON.stringify({ apps: [{ name, dir: ".", ...(integration ? { integration } : {}) }] });

const trainTodo = (over: Json = {}, car: Json = {}) => ({ v: 1, project: "acme", app: "web", train: CODE, kind: "train", spec: { cars: [{ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "none", ...car }] }, ...over });
const entry = (kind: string, log: string, over: Json = {}) => ({ kind, what: `${kind} run`, on: { head: SHA_A }, result: "passed", evidence: log, at: "2026-11-07T07:10:00Z", nod: "looks right, go", ...over });
/** An evidence file with one entry per kind, and the log each entry points at. */
function evidenceOf(dir: string, kinds: string[]): string {
	const log = join(dir, "e2e.log"), file = join(dir, "evidence.json");
	writeFileSync(log, "ok");
	writeFileSync(file, JSON.stringify({ ...evidence(), accepted: kinds.map((k) => entry(k, log)) }));
	return file;
}

// ---- the reader of apps.json (TB-F001, TB-F002)

test("readAppIntegration gives the accept list of the app and fails closed on a file, an app or an integration it cannot read", () => {
	const dir = scratch();
	assert.match((readAppIntegration(dir, "web") as { refusal: string }).refusal, /apps\.json is not there, so integration\.accept of the app is unknown/);
	writeApps(dir, "{");
	assert.match((readAppIntegration(dir, "web") as { refusal: string }).refusal, /cannot be parsed/);
	writeApps(dir, config({ base: "develop", accept: ["e2e", "uat"] }));
	assert.deepEqual(readAppIntegration(dir, "web"), { ok: true, accept: ["e2e", "uat"] });
	assert.deepEqual(readAppIntegration(dir, "web"), { ok: true, accept: ["e2e", "uat"] });
	writeApps(dir, config({ base: "develop" }));
	assert.deepEqual(readAppIntegration(dir, "web"), { ok: true, accept: [] });
	assert.match((readAppIntegration(dir, "api") as { refusal: string }).refusal, /has no app named api/);
	writeApps(dir, config(undefined));
	assert.match((readAppIntegration(dir, "web") as { refusal: string }).refusal, /app web has no integration/);
	writeApps(dir, config({ accept: "uat" }));
	assert.match((readAppIntegration(dir, "web") as { refusal: string }).refusal, /integration\.accept must be a list of kind names/);
});

test("an app whose stages still list uat is a config error that names the field and the migration (TB-F002)", () => {
	const dir = scratch();
	writeApps(dir, config({ base: "develop", stages: ["merge", "deploy", "uat"] }));
	const got = readAppIntegration(dir, "web") as { refusal: string };
	assert.match(got.refusal, /app web: stages lists "uat"; move it to integration\.accept/);
	assert.match(got.refusal, /Moving a project to 0\.65\.0/);
	assert.match(openRefusal(dir, "web")!, /stages lists "uat"/);
	assert.match(openRefusal(dir, undefined)!, /stages lists "uat"/, "a manifest that names no app checks every app with an integration");
	assert.equal(openRefusal(dir, "api"), undefined, "another app's stages are not this train's");
	assert.equal(openRefusal(join(dir, "nowhere"), "web"), undefined, "no file: the open reads nothing to refuse (as maxTrains)");
	writeApps(dir, "{");
	assert.match(openRefusal(dir, "web")!, /cannot be parsed/);
});

// ---- the integrator's guard (TB-F001, TB-F002)

test("the integrator's `train` todo is refused when accept: none meets an app that requires acceptance, whatever flag a model passed", async () => {
	const r = rig({ main: true, train: false, appAccept: ["uat"] });
	await refused(r.create(trainTodo()), /car T-15: accept: none is allowed only for an app whose integration\.accept is empty \(this app requires uat\)/);
	assert.equal(r.list.tasks.length, 0);
	const free = rig({ main: true, train: false });
	assert.equal((await free.create(trainTodo())).ok, true, "an app that requires nothing takes none");
});

test("the integrator's `train` todo is refused when the evidence lacks a kind the app requires, and passes with every kind", async () => {
	const r = rig({ main: true, train: false, appAccept: ["e2e", "uat"] });
	const dir = scratch();
	await refused(r.create(trainTodo({}, { accept: evidenceOf(dir, ["e2e"]) })), /acceptance evidence lacks a uat entry \(the app requires e2e, uat\)/);
	assert.equal(r.list.tasks.length, 0);
	assert.equal((await r.create(trainTodo({}, { accept: evidenceOf(dir, ["e2e", "uat"]) }))).ok, true);
});

test("the integrator's `train` todo fails closed when apps.json cannot be read, lacks the app, or lists uat in stages (and names the migration)", async () => {
	await refused(rig({ main: true, train: false, apps: false }).create(trainTodo()), /apps\.json is not there, so integration\.accept of the app is unknown/);
	await refused(rig({ main: true, train: false, apps: "{" }).create(trainTodo()), /apps\.json cannot be parsed/);
	await refused(rig({ main: true, train: false, apps: config({ base: "develop" }, "api") }).create(trainTodo()), /has no app named web/);
	const old = rig({ main: true, train: false, apps: config({ base: "develop", stages: ["merge", "uat"] }) });
	const reason = asRefusal(await old.create(trainTodo()));
	assert.match(reason, /stages lists "uat"/);
	assert.match(reason, /Moving a project to 0\.65\.0/);
	assert.equal(old.list.tasks.length, 0, "nothing departs");
});

// ---- the train's manifest check (TB-F001)

test("a manifest car whose evidence lacks a required kind is left out of round 1, like one that asks for acceptance; an unreadable apps.json leaves every car out", async () => {
	const dir = scratch();
	const lacking = evidenceOf(dir, ["e2e"]);
	const manifest = [MANIFEST_HEADER, slipBlock({ accept: lacking }), ""].join("\n");
	const assembleOf = (r: Rig, spec: Json = {}) => sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: r.cwd, contains: [SHA_B] }, on: { head: SHA_A }, ...spec });
	const r = rig({ manifest, appAccept: ["e2e", "uat"] });
	const bad = asRefusal(await r.create(assembleOf(r, { cars: ["T-15"] })));
	assert.match(bad, /car T-15: acceptance evidence lacks a uat entry \(the app requires e2e, uat\)/);
	assert.match(bad, /Put T-15 in this assemble's spec\.removed/);
	await ok(r.create(assembleOf(r, { cars: [], removed: [{ ticket: "T-15", why: "lacks uat" }] })));
	const full = rig({ manifest: [MANIFEST_HEADER, slipBlock({ accept: evidenceOf(scratch(), ["e2e", "uat"]) }), ""].join("\n"), appAccept: ["e2e", "uat"] });
	await ok(full.create(assembleOf(full, { cars: ["T-15"] })));
	const none = rig({ manifest: [MANIFEST_HEADER, slipBlock({ accept: "none" }), ""].join("\n"), appAccept: ["uat"] });
	assert.match(asRefusal(await none.create(assembleOf(none, { cars: ["T-15"] }))), /car T-15: accept: none is allowed only for an app whose integration\.accept is empty/);
	const broken = rig({ manifest: [MANIFEST_HEADER, slipBlock({ accept: "none" }), ""].join("\n"), apps: "{" });
	assert.match(asRefusal(await broken.create(assembleOf(broken, { cars: ["T-15"] }))), /car T-15: .*apps\.json cannot be parsed/);
});

// ---- the yard's acceptance chip (TB-F003)

const yardOf = (r: Rig) => JSON.parse(readFileSync(r.yardFile, "utf8")) as { trains: { cars: { accepted?: string[]; unverified?: true }[] }[] };

test("the yard's cars show what the checked evidence says; a model's `accepted` is refused, and an evidence file that stops reading shows as unknown", async () => {
	const dir = scratch(), file = evidenceOf(dir, ["e2e", "uat"]);
	const r = rig({ main: true, train: false, appAccept: ["e2e"] });
	await refused(r.create(trainTodo({}, { accept: file, accepted: ["e2e"] })), /car T-15: accepted is set by Straw Boss from the checked evidence/);
	await ok(r.create(trainTodo({}, { accept: file })));
	assert.deepEqual(yardOf(r).trains[0]!.cars[0], { tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: file, accepted: ["e2e", "uat"] });
	const net = readYards({ stateDir: r.stateDir, now: () => Date.parse("2026-11-07T08:00:00Z"), alive: () => true }, { trains: [], mains: new Set(), integrators: new Set() });
	assert.deepEqual(net!.projects[0]!.forming[0]!.cars[0]!.accepted, [{ kind: "e2e" }, { kind: "uat" }], "the page gets the kinds the evidence shows");
	// The file is gone by the next publish (the end of a turn): nothing is claimed.
	unlinkSync(file);
	await r.fire("turn_end", {});
	const after = yardOf(r).trains[0]!.cars[0]!;
	assert.equal(after.unverified, true);
	assert.equal(after.accepted, undefined);
	const unknown = readYards({ stateDir: r.stateDir, now: () => Date.parse("2026-11-07T08:00:00Z"), alive: () => true }, { trains: [], mains: new Set(), integrators: new Set() });
	assert.equal(unknown!.projects[0]!.forming[0]!.cars[0]!.unverified, true);
});

test("a car with accept: none on an app that requires nothing shows no acceptance required, not unknown", async () => {
	const r = rig({ main: true, train: false });
	assert.equal((await r.create(trainTodo())).ok, true);
	assert.deepEqual(yardOf(r).trains[0]!.cars[0]!.accepted, []);
	assert.equal(yardOf(r).trains[0]!.cars[0]!.unverified, undefined);
});

test("a train's board shows the kinds its manifest evidence shows, from the same checked reading", async () => {
	const dir = scratch(), file = evidenceOf(dir, ["e2e", "uat"]);
	const r = rig({ manifest: [MANIFEST_HEADER, slipBlock({ accept: file }), ""].join("\n"), appAccept: ["e2e"] });
	const made = await r.create(sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: r.cwd, contains: [SHA_A] }, on: { head: SHA_A }, cars: ["T-15"] }));
	assert.equal(made.ok, true, made.reason ?? "");
	const board = JSON.parse(readFileSync(r.boardFile, "utf8")) as { cars: { accepted?: string[]; unverified?: true }[] };
	assert.deepEqual(board.cars[0]!.accepted, ["e2e", "uat"]);
	const unread = rig({ manifest: [MANIFEST_HEADER, slipBlock({ accept: join(dir, "missing.json") }), ""].join("\n") });
	await unread.create(sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: unread.cwd, contains: [SHA_A] }, on: { head: SHA_A }, cars: ["T-15"] }));
	const board2 = JSON.parse(readFileSync(unread.boardFile, "utf8")) as typeof board;
	assert.equal(board2.cars[0]!.unverified, true);
	assert.equal(board2.cars[0]!.accepted, undefined);
	void forwardEntry;
});

// ---- the round's left-out cars stay on the board with their head (TB-F004)

test("a board keeps the cars its round removed with their heads, so the yard can show their notices and the sweep can find their files", async () => {
	const manifest = [MANIFEST_HEADER, slipBlock(), "", slipBlock({ tickets: "T-16", branch: "fix/t-16", head: SHA_B, uat: "/r/checkpoints.md" }), ""].join("\n");
	const r = rig({ manifest });
	await ok(r.create(sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: r.cwd, contains: [SHA_A] }, on: { head: SHA_A }, cars: ["T-15"], removed: [{ ticket: "T-16", why: "asks for acceptance" }] })));
	const board = JSON.parse(readFileSync(r.boardFile, "utf8")) as { cars: { head: string }[]; removed: { ticket: string; head?: string }[] };
	assert.deepEqual(board.cars.map((c) => c.head), [SHA_A]);
	assert.deepEqual(board.removed.map((c) => [c.ticket, c.head]), [["T-16", SHA_B]]);
});

// ---- the merge-train contract gate (TB-F008; the check itself is tests/train-contract.test.ts)

test("while the skills do not declare the contract the train's and the integrator's mutating calls are refused with the reason, and reads and other tools pass", async () => {
	const stale: Contract = { ok: false, refusal: "sb: the merge train needs the skills `integrating` and `deploying` to declare merge-train contract 1, and /x/skills/integrating/SKILL.md declares none; update the package that ships it and /reload, then try again" };
	let loaded: Contract = { ok: true, contract: 1 }, reads = 0;
	const train = rig({ contract: () => (reads++, loaded) });
	const step = sb({ kind: "full-check", name: "unit" }, { check: { type: "run", cwd: train.cwd, run: "true", log: join(train.cwd, "unit.log") }, on: { head: SHA_A } });
	const id = await train.begin(step);
	loaded = stale;
	await ok(train.create(step));
	assert.equal(reads, 1, "a passing answer is read at most once a minute");
	train.tick(61_000);
	await refused(train.create(step), /to declare merge-train contract 1, and \/x\/skills\/integrating\/SKILL\.md declares none/);
	await refused(train.monitor({ description: train.describe(id), command: "true", timeout: 300_000 }), /to declare merge-train contract 1/);
	assert.equal(train.list.tasks.length, 2);
	assert.equal((await train.todo({ action: "list" })).ok, true, "a read is none of the gate's");
	loaded = { ok: true, contract: 1 };
	await ok(train.create(step));
	assert.equal(reads, 4, "a refusal is read again on every call, so an update and a /reload clear it at once");
	const integrator = rig({ main: true, train: false, contract: stale });
	await refused(integrator.create(trainTodo()), /to declare merge-train contract 1/);
	assert.equal((await integrator.todo({ action: "create", subject: "plain note" })).ok, true, "a todo with no metadata.sb is none of the integrator's guard");
	const fine = rig({ main: true, train: false, contract: { ok: true, contract: 1 } });
	await ok(fine.create(trainTodo()));
});

// ---- TB2-F001: one apps.json resolver, the prompt's order

test("every apps.json reader takes .straw-boss first, then .claude/straw-boss, from the git root (TB2-F001)", () => {
	const dir = scratch();
	mkdirSync(join(dir, ".git"));
	mkdirSync(join(dir, "sub"));
	const withUat = JSON.stringify({ integration: { maxTrains: 7 }, apps: [{ name: "web", dir: ".", integration: { stages: ["uat"], accept: ["human"] } }] });
	const ok = JSON.stringify({ integration: { maxTrains: 5 }, apps: [{ name: "web", dir: ".", integration: { accept: ["human"] } }] });
	assert.match((readAppIntegration(dir, "web") as { refusal: string }).refusal, /\.straw-boss\/apps\.json or .*\.claude\/straw-boss\/apps\.json is not there/, "neither: both paths named");
	assert.equal(openRefusal(dir, "web"), undefined);
	mkdirSync(join(dir, ".claude", "straw-boss"), { recursive: true });
	writeFileSync(join(dir, ".claude", "straw-boss", "apps.json"), withUat);
	assert.match(openRefusal(join(dir, "sub"), "web")!, /\.claude\/straw-boss\/apps\.json: app web/, "only .claude: the open refuses uat");
	assert.match((readAppIntegration(dir, "web") as { refusal: string }).refusal, /\.claude\/straw-boss\/apps\.json/);
	assert.equal(readMaxTrains(dir), 7);
	writeApps(dir, ok);
	assert.deepEqual(readAppIntegration(dir, "web"), { ok: true, accept: ["human"] }, "both: .straw-boss wins");
	assert.equal(openRefusal(dir, "web"), undefined);
	assert.equal(readMaxTrains(dir), 5);
});
