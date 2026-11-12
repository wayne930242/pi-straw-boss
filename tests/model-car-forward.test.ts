import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createReturnWatch, type ReturnWatch } from "../src/carwait.ts";
import { CarBook } from "../src/server/carbook.ts";
import { CarNotices, type Intercom } from "../src/server/carnotices.ts";
import { noticeStatus } from "../src/train/cars.ts";
import { type CarCtx, type CarToolDeps, trainCar } from "../src/traincar.ts";
import { appBase, carWorld, type CarWorld, COORD, git, INTEG, repo } from "./train-car-rig.ts";
import { CODE, SHA_A } from "./train-fixtures.ts";
import { cleanup, forwardEntry, MANIFEST_HEADER, rig, slipBlock } from "./train-guard-rig.ts";

// Replays of the bug paths of the car model (docs/models/car-forward/report.md): each test walks the shortest path TLC gave for a rule that breaks, one step of the path per numbered comment, on the real book, sender and `train_car` tool,
// and then asserts the rule in the reader's words. They were red on 191ccfa1 and are green with the fixes of #13, #14 and #15; a step a fix may refuse is an attempt, so a fix that refuses it, or answers it, turns the test green.
// Two paths were made true to the fixed flow when the fixes came: path A drives the step #13 added (the integrator's session waits for the notice of a car it returned), and path C gives the car a real head that the train pushes to the base
// (the check of #15 reads the car's head on the base's remote branch, and the first version's made-up head was never there).

const worlds: CarWorld[] = [];
afterEach(() => (worlds.splice(0).forEach((w) => w.done()), cleanup()));

type Answer = { delivered: boolean; delivery?: "socket_delivered" | "queued" | "failed" | "unknown"; reason?: string };
/** The broker: it outlives a restart of the sb server, so one of it serves the sender of the first server and of the second. */
class Broker implements Intercom {
	sessions: { id: string; name?: string }[] = [{ id: COORD, name: "docs-main" }, { id: TOWER, name: "tower" }];
	sent: { to: string; text: string; delivered: boolean }[] = [];
	answers: Answer[] = [];
	listSessions = async () => this.sessions as never;
	send = async (to: string, options: { text: string; messageId?: string }) => {
		const answer = this.answers.shift() ?? { delivered: true, delivery: "socket_delivered" as const };
		this.sent.push({ to, text: options.text, delivered: answer.delivered && answer.delivery === "socket_delivered" });
		return { id: options.messageId ?? "m", ...answer };
	};
	/** The notices of one state that reached the coordinator's socket. */
	told(state: string) { return this.sent.filter((s) => s.to === COORD && s.delivered && new RegExp(`\\] ${state}\\b`).test(s.text)); }
	tower() { return this.sent.filter((s) => s.to === TOWER); }
}
const TOWER = "sb-tower-wa", SECOND = 1000;
const senderOf = (book: CarBook, w: CarWorld, broker: Broker) => new CarNotices({ book, now: w.now, intercom: () => broker, tower: (workspace) => `sb-tower-${workspace.toLowerCase()}` });
const integrator = (w: CarWorld, returns?: ReturnWatch): CarToolDeps => ({ role: () => "main", train: () => undefined, manifest: () => undefined, client: w.integ, home: w.root, ...(returns ? { returns } : {}) });
/** The integrator's wait for the notices of the cars it returned (carwait.ts): the memory of its own pi process, which a restart of the sb server leaves alone. It reads the server's book as the session does, and its `blocked` call reaches the tower through the broker. */
const waitOf = (w: CarWorld, broker: Broker) => createReturnWatch({
	session: () => INTEG, read: (project) => w.integ.read(project), now: w.now, waits: [],
	callTower: async (text) => { if (!(await broker.send(TOWER, { text })).delivered) throw new Error("the tower did not take it"); },
});
/** The integrator's branch: the tower's forward of the slip is on it, and stays there whatever the server forgets. */
const branch: CarCtx = { cwd: "/", sessionManager: { getBranch: () => [forwardEntry(COORD)] } };
/** The sb server starts again: a new book on the same folders (the journal on disk is still there), which the control socket now answers from. */
function restart(w: CarWorld): CarBook {
	const book = new CarBook({ ...w.deps } as never);
	w.cars.book = book;
	return book;
}
/** A step after the restart: what it gave, or the refusal a fix may answer it with. */
const attempt = async <T>(step: () => Promise<T> | T): Promise<T | Error> => { try { return await step(); } catch (error) { return error as Error; } };

test("car model, NoCarLeftInTheDark: a car the integrator returned still ends with its coordinator or the tower told, when the sb server restarts before the notice was delivered", async () => {
	const w = carWorld();
	worlds.push(w);
	const broker = new Broker(), first = senderOf(w.book, w, broker), wait = waitOf(w, broker);
	// 1. the coordinator sends the car's slip to the tower
	const slip = slipBlock();
	// 2. the tower forwards the slip to the integrator (runtools.ts notes the forward it stamped)
	w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text: slip });
	// 3. the integrator returns the car; its session waits for the notice from here on (#13)
	const returned = await trainCar(integrator(w, wait), { car: "T-15", state: "returned", reason: "the accept evidence is missing", project: "acme" }, branch);
	assert.match(returned.text, /^Car T-15 is returned\. sb tells its coordinator \(sess-coord-1\)/);
	// 4. the notice is not delivered at the first send
	broker.answers = [{ delivered: false, delivery: "failed", reason: "socket closed" }];
	await first.tick();
	assert.deepEqual(noticeStatus(w.book.read("acme")[0]!.notice, "returned"), { kind: "pending", attempts: 1, last: "socket closed" });
	await wait.tick();
	assert.deepEqual([broker.told("returned").length, broker.tower().length, wait.size()], [0, 0, 1], "nobody is told yet: the retry is due in 30 s, and the integrator's session waits");
	// 5. the sb server restarts
	w.tick(10 * SECOND);
	const second = senderOf(restart(w), w, broker);
	// The coordinator waits for sb's notice (prompts/main.md), and the new server holds nothing to send. The integrator's session still waits: at its next looks it finds the book without the car. Every retry of the first server would have come and gone, and a day passes.
	for (const ms of [20 * SECOND, 120 * SECOND, 300 * SECOND, 3600 * SECOND, 23 * 3600 * SECOND]) {
		w.tick(ms);
		await second.tick();
		await wait.tick();
	}
	assert.ok(
		broker.told("returned").length > 0 || broker.tower().length > 0,
		`the coordinator ${COORD} was never told its car T-15 is returned, and the tower was never told that it could not be: after the restart sb sent ${broker.sent.length - 1} message(s), and its book holds ${w.cars.book.read("acme").length} car(s) and ${w.cars.book.pending().length} pending notice(s)`,
	);
});

test("car model, LandedToldOnce: the coordinator of a car is told landed once, when its slip is forwarded again after the sb server restarted", async () => {
	const w = carWorld();
	worlds.push(w);
	// The car's head is a commit only the train's clone holds until the train pushes it (`local`); the app lands on develop (apps.json of the tower's checkout).
	const { local: head } = repo(w);
	appBase(w);
	const broker = new Broker(), first = senderOf(w.book, w, broker);
	const manifest = rig({ manifest: `${MANIFEST_HEADER}  base: develop\n${slipBlock({ head })}\n` });
	const branch: CarCtx = { cwd: "/", sessionManager: { getBranch: () => [forwardEntry(COORD, slipBlock({ head }))] } };
	const trainDeps = (code: string, client: CarWorld["train"]): CarToolDeps => ({ role: () => "train", train: () => ({ project: "acme", code }), manifest: (ctx) => manifest.guard.manifestOf(ctx as never), client, home: w.root });
	// 1. the coordinator sends the car's slip to the tower
	const slip = slipBlock({ head });
	// 2. the tower forwards the slip to the integrator
	w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text: slip });
	// 3. the coordinator sends the same slip again; it waits at the tower
	const again = slip;
	// 4. the integrator sets the car received
	await trainCar(integrator(w), { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" }, branch);
	// 5. the coordinator gets the notice
	await first.tick();
	assert.equal(broker.told("received").length, 1);
	// 6. the tower opens a train with the car
	await w.opened("develop", [head]);
	// 7. the train merges the car to the base: it pushes the head to develop of the remote
	git(w.work, "push", "-q", "origin", `${head}:develop`);
	// 8. the train sets the car landed
	const landed = await trainCar(trainDeps(CODE, w.train), { car: "T-15", state: "landed", version: "1.2.0", commit: head }, manifest.ctx as unknown as CarCtx);
	assert.match(landed.text, /^Car T-15 is landed\./);
	// 9. the coordinator gets the notice
	await first.tick();
	assert.equal(broker.told("landed").length, 1, "told landed, once");
	// 10. the sb server restarts
	w.tick(60 * SECOND);
	const book = restart(w), second = senderOf(book, w, broker);
	// 11. the tower forwards the slip to the integrator (the one that waited at the tower)
	await attempt(() => book.noteForward({ fwd: "f".repeat(16), from: COORD, to: [INTEG], text: again }));
	// 12. the integrator sets the car received, for the next train
	const CODE2 = "2026-11-07-n", TRAIN2 = "sess-train-2";
	const received = await attempt(() => trainCar(integrator(w), { car: "T-15", state: "received", train: CODE2, departs: "next train", project: "acme" }, branch));
	// 13. the coordinator gets the notice
	await second.tick();
	// 14. the tower opens a train with the car
	w.looks.set(TRAIN2, { id: TRAIN2, name: "train 1107n", role: "train", train: { project: "acme", code: CODE2 }, pane: "wA:p3", workspace: "wA", cwd: w.work, foreground: [333] });
	const url = await book.remoteOf(w.checkout);
	book.noteTrain({ project: "acme", code: CODE2, session: TRAIN2, pane: "wA:p3", integrator: INTEG, base: "develop", heads: [head], ...(url ? { url } : {}) });
	// 15. the train sets the car landed (its commit is on the base already)
	const relanded = await attempt(() => trainCar(trainDeps(CODE2, w.client(TRAIN2, 333, "wA:p3")), { car: "T-15", state: "landed", version: "1.3.0", commit: head }, manifest.ctx as unknown as CarCtx));
	// 16. the coordinator gets the notice
	await second.tick();
	const lines = broker.told("landed").map((s) => s.text.replace(/^\[[^\]]*\] /, ""));
	const said = (out: unknown) => (out instanceof Error ? `refused (${out.message})` : (out as { text: string }).text.split(". ")[0]);
	assert.equal(
		lines.length, 1,
		`the coordinator ${COORD} was told landed ${lines.length} times for one car (${lines.join(" / ")}); after the restart, received was: ${said(received)}; landed was: ${said(relanded)}`,
	);
});

test("car model, NoCarLeftInTheDark: a slip sent again for a car that was returned gets an answer from sb, to its coordinator or to the tower", async () => {
	const w = carWorld();
	worlds.push(w);
	const broker = new Broker(), sender = senderOf(w.book, w, broker);
	// 1. the coordinator sends the car's slip to the tower
	const slip = slipBlock({ accept: undefined });
	// 2. the tower forwards the slip to the integrator
	w.book.noteForward({ fwd: "e".repeat(16), from: COORD, to: [INTEG], text: slip });
	// 3. the integrator returns the car
	await trainCar(integrator(w), { car: "T-15", state: "returned", reason: "the slip names no accept evidence", project: "acme" }, { cwd: "/", sessionManager: { getBranch: () => [forwardEntry(COORD, slip)] } });
	// 4. the coordinator gets the notice
	await sender.tick();
	assert.equal(broker.told("returned").length, 1);
	// 5. the coordinator sends the same head again, its slip put right
	w.tick(600 * SECOND);
	const again = slipBlock();
	// 6. the tower forwards the slip to the integrator
	w.book.noteForward({ fwd: "f".repeat(16), from: COORD, to: [INTEG], text: again });
	const before = broker.sent.length;
	// 7. the integrator answers the slip, either way: sb refuses both, the car already ended
	const second: CarCtx = { cwd: "/", sessionManager: { getBranch: () => [forwardEntry(COORD, slip), forwardEntry(COORD, again)] } };
	const received = await attempt(() => trainCar(integrator(w), { car: "T-15", state: "received", train: CODE, departs: "next train", project: "acme" }, second));
	const returned = await attempt(() => trainCar(integrator(w), { car: "T-15", state: "returned", reason: received instanceof Error ? received.message : "no room on this train", project: "acme" }, second));
	// Nobody has a step left: no state was set, so the sender has nothing to send, and the coordinator waits for sb's notice (prompts/main.md).
	for (const ms of [5 * SECOND, 30 * SECOND, 120 * SECOND, 300 * SECOND, 3600 * SECOND]) {
		w.tick(ms);
		await sender.tick();
	}
	const said = (out: unknown) => (out instanceof Error ? `refused (${out.message})` : "set");
	assert.ok(
		broker.sent.length > before,
		`the coordinator ${COORD} sent head ${SHA_A.slice(0, 12)} again and sb told nobody anything of it: received was ${said(received)}; returned was ${said(returned)}; sb sent ${broker.sent.length - before} message(s) after the second forward`,
	);
});
