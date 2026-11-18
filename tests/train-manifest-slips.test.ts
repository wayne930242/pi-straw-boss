import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { COORD, INTEG } from "./train-car-rig.ts";
import type { CarView } from "../src/train/cars.ts";
import { CODE, SHA_A, SHA_B, SHA_C, type Json } from "./train-fixtures.ts";
import { cleanup, forwardEntry, rig, type Rig, slipBlock } from "./train-guard-rig.ts";

// The integrator's departure (src/manifestslips.ts; boss W45, train 2026-11-17-q): the manifest it sends the tower carries every car's forwarded slip because sb appends it, so the train's own manifest check finds the cars.

afterEach(() => cleanup());

const SLIP_A = slipBlock(), SLIP_B = slipBlock({ tickets: "T-16", branch: "fix/t-16", head: SHA_B, accept: "none" });
const car = (tickets: string[], head: string, branch: string): Json => ({ tickets, branch, head, coordinator: COORD, departs: "next", accept: "none" });
const trainTodo = (cars: Json[], code = CODE): Json => ({ v: 1, project: "acme", app: "web", train: code, kind: "train", spec: { cars } });
/** What the incident's integrator sent: a manifest that names its slips by path only. */
const pathOnly = (code = CODE) => `train:\n  project: acme\n  app: web\n  code: ${code}\n  base: develop\n  integrator: ${INTEG}\nCars (slips verbatim in /tmp/integ-mc/): slip-T-15.txt (head ${SHA_A}), slip-T-16.txt (head ${SHA_B})\n`;

/** A life of a car in the server's book: received by the integrator, then the states after it. */
const life = (ticket: string, head: string, after: { state: "returned" | "dropped"; at: string }[] = [], received = "2026-11-07T08:01:00Z"): CarView => ({
	file: { v: 1, project: "acme", app: "web", car: { tickets: [ticket], branch: `fix/${ticket.toLowerCase()}`, head }, coordinator: COORD, states: [{ state: "received", at: received, by: { role: "main", name: "integ acme", session: INTEG }, train: CODE, departs: "next" }, ...after.map((s) => ({ ...s, by: { role: "main" as const, name: "integ acme", session: INTEG }, ...(s.state === "returned" ? { reason: "late" } : { round: 1, reason: "unit red", evidence: "/r/unit.log" }) }))] } as never,
});

async function integrator(cars = [car(["T-15"], SHA_A, "fix/t-15"), car(["T-16"], SHA_B, "fix/t-16")], forwards = [SLIP_A, SLIP_B], book: { views: CarView[]; error?: string } | null = { views: [] }) {
	const r = rig({ main: true, train: false, ...(book ? { cars: book } : {}) });
	for (const text of forwards) r.entries.push(forwardEntry(COORD, text));
	const made = await r.create(trainTodo(cars));
	assert.equal(made.ok, true, String(made.reason));
	return r;
}
async function callTower(r: Rig, message: string, why = "shared") {
	const input: Json = { message, why };
	const out = await r.fire("tool_call", { toolName: "call_tower", toolCallId: "ct1", input });
	return { blocked: out?.block === true ? String(out.reason) : undefined, message: String(input.message) };
}

test("the integrator's call_tower with a path-only manifest gets every car's forwarded slip appended verbatim, and the train's parseManifest of the handoff finds the cars", async () => {
	const r = await integrator();
	const out = await callTower(r, pathOnly());
	assert.equal(out.blocked, undefined);
	assert.ok(out.message.startsWith(pathOnly()), "the integrator's words stay first, as written");
	assert.ok(out.message.includes(`\n\n${SLIP_A}\n`) && out.message.endsWith(`\n\n${SLIP_B}\n`), out.message);
	const train = rig({ manifest: out.message });
	assert.deepEqual(train.guard.manifestOf(train.ctx as never)!.cars.map((c) => [c.ticket, c.head]), [["T-15", SHA_A], ["T-16", SHA_B]]);
});

test("a slip the manifest already holds verbatim is not appended again; one that differs from the forward, or names a head the train todo lacks, is refused and nothing is sent", async () => {
	const r = await integrator();
	const holds = await callTower(r, `${pathOnly()}\n${SLIP_A}\n`);
	assert.equal(holds.blocked, undefined);
	assert.equal(holds.message.split(SLIP_A).length - 1, 1, "T-15 once");
	assert.ok(holds.message.endsWith(`\n\n${SLIP_B}\n`));
	const differs = await callTower(r, `${pathOnly()}\n${slipBlock({ departs: "alone" })}\n`);
	assert.match(String(differs.blocked), /^sb: the manifest's slip of car T-15 \(aaaaaaaaaaaa\) differs from the slip the tower forwarded/);
	const stranger = await callTower(r, `${pathOnly()}\n${slipBlock({ tickets: "T-99", head: SHA_C })}\n`);
	assert.match(String(stranger.blocked), /^sb: the manifest's slip of car T-99 names head cccccccccccc, which is no car of the train todo of 2026-11-06-m/);
});

test("no train todo for the manifest's code, or a car row with no forward on the branch, refuses the call; another why, or a session that is no integrator, is left alone", async () => {
	const r = await integrator();
	assert.match(String((await callTower(r, pathOnly("2026-11-06-n"))).blocked), /^sb: no train todo of project acme names train 2026-11-06-n/);
	const lacking = await integrator(undefined, [SLIP_A]);
	assert.match(String((await callTower(lacking, pathOnly())).blocked), /^sb: car T-16 \(bbbbbbbbbbbb\) of the train todo has no forward by the tower on this branch/);
	assert.deepEqual(await callTower(r, pathOnly(), "milestone"), { blocked: undefined, message: pathOnly() });
	const other = rig({ main: true, train: false, duty: "plain" });
	other.entries.push(forwardEntry(COORD, SLIP_A));
	assert.deepEqual(await callTower(other, pathOnly()), { blocked: undefined, message: pathOnly() });
});


test("a car the integrator ended before its train opens is refused at the manifest's call, naming it, and nothing is sent; a car sent again and received in a new life rides; a book that cannot be read refuses", async () => {
	const returned = await integrator(undefined, undefined, { views: [life("T-15", SHA_A), life("T-16", SHA_B, [{ state: "returned", at: "2026-11-07T08:05:00Z" }])] });
	const out = await callTower(returned, pathOnly());
	assert.equal(out.blocked, "sb: car T-16 (bbbbbbbbbbbb) of the train todo is returned in the sb server's book (set 2026-11-07T08:05:00Z): an ended car rides no train, so take it off the train todo, then call again");
	assert.equal(out.message, pathOnly(), "nothing appended, nothing sent");
	const again = await integrator(undefined, undefined, { views: [life("T-16", SHA_B, [{ state: "dropped", at: "2026-11-07T08:05:00Z" }]), life("T-16", SHA_B, [], "2026-11-07T09:00:00Z")] });
	assert.equal((await callTower(again, pathOnly())).blocked, undefined);
	const down = await integrator(undefined, undefined, { views: [], error: "connect ECONNREFUSED" });
	assert.match(String((await callTower(down, pathOnly())).blocked), /^sb: the sb server did not answer for the cars of project acme \(connect ECONNREFUSED\); try again/);
	const unlinked = await integrator(undefined, undefined, null);
	assert.match(String((await callTower(unlinked, pathOnly())).blocked), /^sb: this guard has no link to the sb server/);
});
