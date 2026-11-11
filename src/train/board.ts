import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { FOLDER_CODE_RE, compareCodes, MAX_CAR_TICKETS, MAX_TICKET_CHARS, isCode, isObject, isoTime, jsonBytes, KINDS, MAX_SB_BYTES, type Holds, type Kind, type LoadSpec, isName, SHA_RE, kb } from "./spec.ts";
import type { Clear, FactStep, StepStatus, TrainFacts, TrainState, Wait } from "./waits.ts";

// The trainboard (docs/specs/2026-11-07-train-workers.md §10, §11.1): Straw Boss's derived state, one file per writer. A train's extension writes `<state>/trainboard/<project>/<code>/board.json` from its todo list, the integrator's
// `<state>/trainboard/<project>/yard.json` from its `train` todos, both atomically and privately. The server reads them back with the writer's own validator and bounds (at most 64 trains, 64 KB a file); a file that fails is
// shown as unreadable, never guessed at, and an unreadable board holds what it might have held (waits.ts). A board outlives its session on purpose (§10).

export const MAX_BOARD_BYTES = 64 * 1024;
export const MAX_TRAINS = 64;
export const MAX_STEPS = 256, MAX_CARS = 32, MAX_CLEARS = 64;
export const STALE_MS = 10 * 60_000;
export const KEEP_MS = 7 * 24 * 60 * 60_000;

export interface Writer { session: string; pane?: string; pid: number; started: string }
export interface CarRow { tickets: string[]; branch: string; head: string; coordinator: string; departs: string; accept: string; arrived?: string; /** The kinds the car's checked evidence shows; set by the code that checked it, never by a model (TB-F003). */ accepted?: string[]; /** The evidence could not be checked, so nothing is claimed of the car's acceptance. */ unverified?: true }
export interface BoardStep {
	id: number; kind: Kind; name: string; status: StepStatus; round: number;
	holds?: Holds; load?: LoadSpec; lock?: string; waits?: Wait[]; outcome?: "passed" | "failed" | "void"; why?: "superseded" | "skipped";
}
/** A car the current round's assemble step left out (§3.5): its ticket and why, as the page tells it. The evidence path stays in the train's own todo. */
export interface BoardRemoved { ticket: string; why: string; /** The car's head, so the yard can show whether sb has told its coordinator and the sweep can find its car file (TB-F004). */ head?: string }
export const MAX_REMOVED = 32;
export interface Board { v: 1; project: string; app: string; code: string; writer: Writer; updated: string; round: number; cars: CarRow[]; steps: BoardStep[]; clears?: Clear[]; removed?: BoardRemoved[] }
export interface YardTrain { code: string; app: string; status: "forming" | "departing" | "opened" | "refused"; session?: string; cars: CarRow[]; departs?: { maxCars: number; maxWaitMin: number; oldest: string } }
export interface Yard { v: 1; project: string; writer: Writer; updated: string; trains: YardTrain[] }

const present = (value: unknown) => value !== undefined;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const whole = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const unknown = (value: Record<string, unknown>, allowed: string[], path: string) => Object.keys(value).filter((k) => present(value[k]) && !allowed.includes(k)).map((k) => `sb: ${path}.${k} is not a field`);

const CAR_FIELDS = ["tickets", "branch", "head", "coordinator", "departs", "accept", "arrived", "accepted", "unverified"];
const CAP = { session: 128, pane: 64, ticket: MAX_TICKET_CHARS, tickets: MAX_CAR_TICKETS, branch: 255, coordinator: 128, departs: 300, accept: 1024, name: 64, kind: 32, reason: 600, by: 128, label: 64 };

function writerRefusals(w: unknown, path: string): string[] {
	if (!isObject(w)) return [`sb: ${path} must be an object`];
	const out = unknown(w, ["session", "pane", "pid", "started"], path);
	if (!text(w.session, CAP.session)) out.push(`sb: ${path}.session must be a non-empty string`);
	if (present(w.pane) && !text(w.pane, CAP.pane)) out.push(`sb: ${path}.pane must be a non-empty string`);
	if (!whole(w.pid, 1)) out.push(`sb: ${path}.pid must be a whole number from 1`);
	if (!isoTime(w.started)) out.push(`sb: ${path}.started must be an ISO time with its zone`);
	return out;
}

function carRefusals(car: unknown, path: string): string[] {
	if (!isObject(car)) return [`sb: ${path} must be an object`];
	const out = unknown(car, CAR_FIELDS, path);
	if (!(Array.isArray(car.tickets) && car.tickets.length > 0 && car.tickets.length <= CAP.tickets && car.tickets.every((t) => text(t, CAP.ticket)))) out.push(`sb: ${path}.tickets must be a list of 1 to ${CAP.tickets} tickets`);
	if (!text(car.branch, CAP.branch)) out.push(`sb: ${path}.branch must be a non-empty string`);
	if (!SHA_RE.test(String(car.head))) out.push(`sb: ${path}.head must be 40 hex`);
	if (!text(car.coordinator, CAP.coordinator)) out.push(`sb: ${path}.coordinator must be a non-empty string`);
	if (!text(car.departs, CAP.departs)) out.push(`sb: ${path}.departs must be a non-empty string`);
	if (!text(car.accept, CAP.accept)) out.push(`sb: ${path}.accept must be a non-empty string`);
	if (present(car.arrived) && !isoTime(car.arrived)) out.push(`sb: ${path}.arrived must be an ISO time with its zone`);
	if (present(car.accepted) && !(Array.isArray(car.accepted) && car.accepted.length <= 8 && car.accepted.every((k) => text(k, CAP.kind)))) out.push(`sb: ${path}.accepted must be a list of kind names`);
	if (present(car.unverified) && car.unverified !== true) out.push(`sb: ${path}.unverified must be true when given`);
	return out;
}

function waitRefusals(wait: unknown, path: string): string[] {
	const bad = [`sb: ${path} is not a wait (load, lock, lane or target)`];
	if (!isObject(wait) || Object.keys(wait).length !== 1) return bad;
	const [key, body] = Object.entries(wait)[0]!;
	if (!isObject(body)) return bad;
	const why = (v: unknown) => !present(v) || v === "stale" || v === "unreadable";
	if (key === "load") return typeof body.max === "number" && typeof body.now === "number" ? [] : bad;
	if (key === "lock") return text(body.name, 32) && (!present(body.holder) || (isObject(body.holder) && text(body.holder.train, 32) && whole(body.holder.step, 1))) ? [] : bad;
	if (key === "lane") return text(body.app, 64) && text(body.holder, 32) && why(body.why) ? [] : bad;
	if (key === "target") return text(body.target, 128) && text(body.holder, 32) && why(body.why) ? [] : bad;
	return bad;
}

function stepRefusals(step: unknown, path: string): string[] {
	if (!isObject(step)) return [`sb: ${path} must be an object`];
	const out = unknown(step, ["id", "kind", "name", "status", "round", "holds", "load", "lock", "waits", "outcome", "why"], path);
	if (!whole(step.id, 1)) out.push(`sb: ${path}.id must be a whole number from 1`);
	if (!(KINDS as readonly string[]).includes(step.kind as string)) out.push(`sb: ${path}.kind must be one of ${KINDS.join(", ")}`);
	if (!text(step.name, CAP.name)) out.push(`sb: ${path}.name must be 1 to ${CAP.name} characters`);
	if (!["pending", "in_progress", "completed"].includes(step.status as string)) out.push(`sb: ${path}.status must be pending, in_progress or completed`);
	if (!whole(step.round, 1)) out.push(`sb: ${path}.round must be a whole number from 1`);
	const holds = step.holds, load = step.load;
	if (present(holds) && !(isObject(holds) && Object.keys(holds).every((k) => (k === "lane" || k === "target") && isName(holds[k])))) out.push(`sb: ${path}.holds must be a lane or target name`);
	if (present(load) && !(isObject(load) && Object.keys(load).every((k) => ["max", "perCore", "weight"].includes(k) && typeof load[k] === "number"))) out.push(`sb: ${path}.load must be a max or perCore, with a weight`);
	if (present(step.lock) && !(typeof step.lock === "string" && /^[a-z0-9-]{1,32}$/.test(step.lock))) out.push(`sb: ${path}.lock must be a lock name`);
	if (present(step.waits)) {
		if (!Array.isArray(step.waits) || step.waits.length > 8) out.push(`sb: ${path}.waits must be a list of at most 8`);
		else step.waits.forEach((w, i) => out.push(...waitRefusals(w, `${path}.waits[${i}]`)));
	}
	if (present(step.outcome) && !["passed", "failed", "void"].includes(step.outcome as string)) out.push(`sb: ${path}.outcome must be passed, failed or void`);
	if (present(step.why) && !["superseded", "skipped"].includes(step.why as string)) out.push(`sb: ${path}.why must be superseded or skipped`);
	return out;
}

function removedRefusals(car: unknown, path: string): string[] {
	if (!isObject(car)) return [`sb: ${path} must be an object`];
	const out = unknown(car, ["ticket", "why", "head"], path);
	if (!(text(car.ticket, CAP.ticket) && !/\s/.test(car.ticket))) out.push(`sb: ${path}.ticket must be a ticket without spaces`);
	if (present(car.head) && !SHA_RE.test(String(car.head))) out.push(`sb: ${path}.head must be 40 hex`);
	if (!text(car.why, CAP.reason)) out.push(`sb: ${path}.why must be 1 to ${CAP.reason} characters`);
	return out;
}

function clearRefusals(clear: unknown, path: string): string[] {
	if (!isObject(clear)) return [`sb: ${path} must be an object`];
	const out = unknown(clear, ["lane", "target", "reason", "by", "at"], path);
	if (present(clear.lane) === present(clear.target)) out.push(`sb: ${path} needs lane or target, one of them`);
	for (const key of ["lane", "target"]) if (present(clear[key]) && !text(clear[key], 128)) out.push(`sb: ${path}.${key} must be a non-empty string`);
	if (!text(clear.reason, CAP.reason)) out.push(`sb: ${path} needs reason`);
	if (!text(clear.by, CAP.by)) out.push(`sb: ${path} needs by`);
	if (!isoTime(clear.at)) out.push(`sb: ${path}.at must be an ISO time with its zone`);
	return out;
}

/** The refusal of a board or yard that is nested too deep (never walked), not JSON, or over the file's size. */
const tooBig = (value: unknown, what: string) => {
	const size = jsonBytes(value, what, MAX_BOARD_BYTES);
	return size.refusal ? [size.refusal] : [];
};

/** What a train's board is refused for; the writer checks it before it writes and the reader after it reads, so both agree on what a board is. */
export function validateBoard(value: unknown): string[] {
	if (!isObject(value)) return ["sb: board must be an object"];
	const big = tooBig(value, "board");
	if (big.length) return big;
	const out = unknown(value, ["v", "project", "app", "code", "writer", "updated", "round", "cars", "steps", "clears", "removed"], "board");
	if (value.v !== 1) out.push("sb: board.v must be 1");
	for (const key of ["project", "app"]) if (!(typeof value[key] === "string" && isName(value[key]))) out.push(`sb: board.${key} must be a path-safe name`);
	if (!isCode(value.code)) out.push("sb: board.code must be YYYY-MM-DD-<letters>");
	out.push(...writerRefusals(value.writer, "board.writer"));
	if (!isoTime(value.updated)) out.push("sb: board.updated must be an ISO time with its zone");
	if (!whole(value.round, 1)) out.push("sb: board.round must be a whole number from 1");
	if (!Array.isArray(value.cars)) out.push("sb: board.cars must be an array");
	else if (value.cars.length > MAX_CARS) out.push(`sb: board.cars has more than ${MAX_CARS}`);
	else value.cars.forEach((car, i) => out.push(...carRefusals(car, `board.cars[${i}]`)));
	if (!Array.isArray(value.steps)) out.push("sb: board.steps must be an array");
	else if (value.steps.length > MAX_STEPS) out.push(`sb: board.steps has more than ${MAX_STEPS}`);
	else {
		const seen = new Set<unknown>();
		value.steps.forEach((step, i) => {
			out.push(...stepRefusals(step, `board.steps[${i}]`));
			const id = isObject(step) ? step.id : undefined;
			if (seen.has(id)) out.push(`sb: board.steps[${i}].id ${String(id)} twice`);
			seen.add(id);
		});
	}
	if (present(value.removed)) {
		if (!Array.isArray(value.removed) || value.removed.length > MAX_REMOVED) out.push(`sb: board.removed must be a list of at most ${MAX_REMOVED} cars`);
		else value.removed.forEach((car, i) => out.push(...removedRefusals(car, `board.removed[${i}]`)));
	}
	if (present(value.clears)) {
		if (!Array.isArray(value.clears) || value.clears.length > MAX_CLEARS) out.push(`sb: board.clears must be a list of at most ${MAX_CLEARS}`);
		else value.clears.forEach((c, i) => out.push(...clearRefusals(c, `board.clears[${i}]`)));
	}
	return out;
}

const validDeparts = (d: unknown) => isObject(d) && whole(d.maxCars, 1) && whole(d.maxWaitMin, 0) && isoTime(d.oldest) && Object.keys(d).length === 3;

/** What the integrator's yard is refused for: the forming and departed trains of one project, each with its cars. */
export function validateYard(value: unknown): string[] {
	if (!isObject(value)) return ["sb: yard must be an object"];
	const big = tooBig(value, "yard");
	if (big.length) return big;
	const out = unknown(value, ["v", "project", "writer", "updated", "trains"], "yard");
	if (value.v !== 1) out.push("sb: yard.v must be 1");
	if (!(isName(value.project))) out.push("sb: yard.project must be a path-safe name");
	out.push(...writerRefusals(value.writer, "yard.writer"));
	if (!isoTime(value.updated)) out.push("sb: yard.updated must be an ISO time with its zone");
	if (!Array.isArray(value.trains)) return [...out, "sb: yard.trains must be an array"];
	if (value.trains.length > MAX_TRAINS) return [...out, `sb: yard.trains has more than ${MAX_TRAINS}`];
	const seen = new Set<unknown>();
	value.trains.forEach((train, i) => {
		const path = `yard.trains[${i}]`;
		if (!isObject(train)) return void out.push(`sb: ${path} must be an object`);
		out.push(...unknown(train, ["code", "app", "status", "session", "cars", "departs"], path));
		if (!isCode(train.code)) out.push(`sb: ${path}.code must be YYYY-MM-DD-<letters>`);
		else if (seen.has(train.code)) out.push(`sb: ${path}.code ${train.code} twice`);
		seen.add(train.code);
		if (!(isName(train.app))) out.push(`sb: ${path}.app must be a path-safe name`);
		if (!["forming", "departing", "opened", "refused"].includes(train.status as string)) out.push(`sb: ${path}.status must be forming, departing, opened or refused`);
		if (train.status === "opened" && !text(train.session, CAP.session)) out.push(`sb: ${path}.session is required for an opened train`);
		else if (present(train.session) && !text(train.session, CAP.session)) out.push(`sb: ${path}.session must be a non-empty string`);
		if (!Array.isArray(train.cars) || train.cars.length > MAX_CARS) out.push(`sb: ${path}.cars must be a list of at most ${MAX_CARS}`);
		else train.cars.forEach((car, j) => out.push(...carRefusals(car, `${path}.cars[${j}]`)));
		if (present(train.departs) && !validDeparts(train.departs)) out.push(`sb: ${path}.departs must be maxCars, maxWaitMin and oldest`);
	});
	return out;
}

/** The integrator's `train` todo (§7.4): the cars a forming train carries and when it leaves, as the yard holds them. The guard of the integrator reads a todo with `metadata.sb` of kind `train` through this. */
export function validateTrainTodo(value: unknown, opts: { status?: string; id?: number; project?: string } = {}): string[] {
	if (!isObject(value)) return ["sb: metadata.sb must be an object"];
	const size = jsonBytes(value, "metadata.sb", MAX_SB_BYTES);
	if (size.refusal) return [size.refusal];
	const out = unknown(value, ["v", "project", "app", "train", "kind", "spec", "result"], "metadata.sb");
	if (value.v !== 1) out.push("sb: metadata.sb.v must be 1");
	for (const key of ["project", "app"]) if (!(typeof value[key] === "string" && isName(value[key]))) out.push(`sb: metadata.sb.${key} must be a path-safe name`);
	if (!isCode(value.train)) out.push("sb: metadata.sb.train must be YYYY-MM-DD-<letters> (a real date, one or two lowercase letters)");
	if (value.kind !== "train") out.push('sb: metadata.sb.kind must be train');
	const spec = value.spec;
	if (!isObject(spec)) out.push("sb: metadata.sb.spec must be an object");
	else {
		out.push(...unknown(spec, ["cars", "departs"], "metadata.sb.spec"));
		if (!Array.isArray(spec.cars) || spec.cars.length < 1 || spec.cars.length > MAX_CARS) out.push(`sb: metadata.sb.spec.cars must be a list of 1 to ${MAX_CARS} cars`);
		else spec.cars.forEach((car, i) => out.push(...carRefusals(car, `metadata.sb.spec.cars[${i}]`)));
		if (present(spec.departs) && !validDeparts(spec.departs)) out.push("sb: metadata.sb.spec.departs must be maxCars, maxWaitMin and oldest");
	}
	if (opts.project !== undefined && typeof value.project === "string" && value.project !== opts.project) out.push(`sb: step #${opts.id ?? "?"} names project ${value.project}; this integrator's is ${opts.project}`);
	if (opts.status !== undefined) {
		if (opts.status === "completed" && !present(value.result)) out.push("sb: completed needs a result in metadata.sb.result");
		else if (opts.status !== "completed" && present(value.result)) out.push("sb: metadata.sb.result is set only on completed");
	}
	if (present(value.result)) {
		const at = "metadata.sb.result", result = value.result;
		if (!isObject(result)) out.push(`sb: ${at} must be an object`);
		else {
			out.push(...unknown(result, ["outcome", "session", "refusal", "at"], at));
			if (result.outcome !== "passed" && result.outcome !== "failed") out.push(`sb: ${at}.outcome must be passed or failed`);
			else if (result.outcome === "passed" && !text(result.session, CAP.session)) out.push(`sb: passed needs result.session, the train's session id`);
			else if (result.outcome === "failed" && !text(result.refusal, CAP.reason)) out.push(`sb: failed needs result.refusal, the tower's refusal`);
			if (!isoTime(result.at)) out.push(`sb: ${at}.at must be an ISO time with its zone`);
		}
	}
	return out;
}

// ---- paths and writing

const safe = (project: string, code?: string) => {
	if (!isName(project)) throw new Error(`sb: project "${project}" is not a path-safe name`);
	if (code !== undefined && !isCode(code)) throw new Error(`sb: code "${code}" is not a train code (YYYY-MM-DD-<letters>)`);
};
export const trainboardDir = (stateDir: string) => join(stateDir, "trainboard");
export const boardPath = (stateDir: string, project: string, code: string) => (safe(project, code), join(trainboardDir(stateDir), project, code, "board.json"));
export const yardPath = (stateDir: string, project: string) => (safe(project), join(trainboardDir(stateDir), project, "yard.json"));
/** Where the car files and their notice records go (§5.5). */
export const carsDir = (stateDir: string, project: string) => (safe(project), join(trainboardDir(stateDir), project, "cars"));

let counter = 0;
/** Writes `file` whole, or not at all: a private temp file in the same folder, renamed over it. The folders it makes are 700 and the file 600. */
function writePrivate(file: string, content: string, folders: string[]) {
	for (const dir of folders) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	const temp = `${file}.${process.pid}.${counter++}.tmp`;
	try {
		writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* nothing was written */ }
		throw error;
	}
}

const refuse = (list: string[]) => {
	if (list.length) throw new Error(list.join("; "));
};

/** Writes a train's board; refuses a board its readers would refuse, and leaves the old file as it was. Returns the path. */
export function writeBoard(stateDir: string, board: Board): string {
	refuse(validateBoard(board));
	const file = boardPath(stateDir, board.project, board.code), folder = dirname(file);
	writePrivate(file, `${JSON.stringify(board)}\n`, [trainboardDir(stateDir), dirname(folder), folder]);
	return file;
}

export function writeYard(stateDir: string, yard: Yard): string {
	refuse(validateYard(yard));
	const file = yardPath(stateDir, yard.project);
	writePrivate(file, `${JSON.stringify(yard)}\n`, [trainboardDir(stateDir), dirname(file)]);
	return file;
}

const cut = (text: string, n: number) => (text.length > n ? text.slice(0, n) : text);
const bytesOf = (board: Board) => Buffer.byteLength(JSON.stringify(board));

/**
 * Cuts a board to what its readers accept, so the writer never fails on size: first every field to its cap and every list to its length (a step's waits to 8), then, while the file is still over 64 KB, the derived waits, then
 * the text of cars, clears and step names to shorter caps, then whole cars from the last. A board within every cap and the size is returned equal. Only a board whose 256 steps each hold two 64-character names stays too big for the writer to take.
 */
export function capBoard(board: Board): Board {
	const car = (c: CarRow, t: { tickets: number; ticket: number; branch: number; coordinator: number; departs: number; accept: number; accepted: number }): CarRow => {
		const { accepted, ...rest } = c;
		return { ...rest, tickets: c.tickets.slice(0, t.tickets).map((x) => cut(x, t.ticket)), branch: cut(c.branch, t.branch), coordinator: cut(c.coordinator, t.coordinator), departs: cut(c.departs, t.departs), accept: cut(c.accept, t.accept), ...(accepted ? { accepted: accepted.slice(0, t.accepted).map((k) => cut(k, CAP.kind)) } : {}) };
	};
	const full = { tickets: CAP.tickets, ticket: CAP.ticket, branch: CAP.branch, coordinator: CAP.coordinator, departs: CAP.departs, accept: CAP.accept, accepted: 8 };
	const short = { tickets: 4, ticket: 32, branch: 80, coordinator: 64, departs: 80, accept: 120, accepted: 4 };
	const build = (cars: CarRow[], carCaps: typeof full, stepName: number, reason: number, waits: boolean, by = CAP.by, ref = 128): Board => ({
		...board,
		cars: cars.slice(0, MAX_CARS).map((c) => car(c, carCaps)),
		steps: board.steps.slice(0, MAX_STEPS).map(({ waits: w, ...s }) => ({ ...s, name: cut(s.name, stepName), ...(waits && w ? { waits: w.slice(0, 8) } : {}) })),
		...(board.removed ? { removed: board.removed.slice(0, MAX_REMOVED).map((r) => ({ ticket: cut(r.ticket, CAP.ticket), why: cut(r.why, reason).trim() ? cut(r.why, reason) : "-", ...(r.head ? { head: r.head } : {}) })) } : {}),
		...(board.clears ? { clears: board.clears.slice(0, MAX_CLEARS).map((c) => ({ ...c, ...(c.lane !== undefined ? { lane: cut(c.lane, ref) } : {}), ...(c.target !== undefined ? { target: cut(c.target, ref) } : {}), reason: cut(c.reason, reason), by: cut(c.by, by) })) } : {}),
	});
	const tiers = [() => build(board.cars, full, CAP.name, CAP.reason, true), () => build(board.cars, full, CAP.name, CAP.reason, false), () => build(board.cars, short, 32, 120, false), () => build(board.cars, short, 16, 40, false, 32), () => build(board.cars, short, 8, 16, false, 16, 64)];
	let out = tiers[0]!();
	for (const tier of tiers.slice(1)) {
		if (bytesOf(out) <= MAX_BOARD_BYTES) return out;
		out = tier();
	}
	while (bytesOf(out) > MAX_BOARD_BYTES && out.cars.length > 0) out = { ...out, cars: out.cars.slice(0, -1) };
	return out;
}

// ---- reading

export type FileRead<T> = ({ ok: true } & T) | { ok: false; reason: string };

/** A byte budget a reading spends file by file (the size of each file it reads): the server's look at the trains stops reading when it is spent (TY-F003). */
export interface ReadBudget { left: number }

/**
 * A JSON file a train's session could have written, read with no trust in the path: the descriptor is opened without following a link and without waiting for a writer (a FIFO opens at once), and what the file is and how big it is
 * are asked of that descriptor, so a file swapped for a FIFO or a device between a check and the read cannot block the caller or lift the cap (TY-F004). The read itself stops at `max` bytes. Never throws; a reason is the file's own.
 */
export function readJsonFile(file: string, max: number, budget?: ReadBudget): { ok: true; value: unknown } | { ok: false; reason: string } {
	let fd: number | undefined;
	try {
		// Where the system has no O_NOFOLLOW (Windows) a link is refused by looking first.
		if (constants.O_NOFOLLOW === undefined && !lstatSync(file).isFile()) return { ok: false, reason: "not a regular file" };
		fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { ok: false, reason: "not a regular file" };
		if (stat.size > max) return { ok: false, reason: `file is ${kb(stat.size)} KB, more than ${max / 1024} KB` };
		if (budget && stat.size > budget.left) return { ok: false, reason: "the byte budget of this reading is spent" };
		if (budget) budget.left -= stat.size;
		const buffer = Buffer.allocUnsafe(max + 1);
		let length = 0;
		while (length < buffer.length) {
			const n = readSync(fd, buffer, length, buffer.length - length, length);
			if (n === 0) break;
			length += n;
		}
		if (length > max) return { ok: false, reason: `file is more than ${max / 1024} KB` };
		try {
			return { ok: true, value: JSON.parse(buffer.toString("utf8", 0, length)) };
		} catch (error) {
			return { ok: false, reason: `not JSON (${(error as Error).message})` };
		}
	} catch (error) {
		// A link opened with O_NOFOLLOW fails with ELOOP.
		const code = (error as NodeJS.ErrnoException).code;
		return { ok: false, reason: code === "ELOOP" ? "not a regular file" : `cannot read: ${code ?? (error as Error).message}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
const readFile = (file: string) => readJsonFile(file, MAX_BOARD_BYTES);

const reasonOf = (list: string[]) => list.map((r) => r.replace(/^sb: /, "")).join("; ");

/** A read never throws: whatever goes wrong in it is that file's reason, so one bad file cannot fail the others (a throw in the guard is no refusal). */
function safely<T>(read: () => FileRead<T>): FileRead<T> {
	try {
		return read();
	} catch (error) {
		return { ok: false, reason: `cannot read: ${(error as Error).message}` };
	}
}

export const readBoard = (file: string): FileRead<{ board: Board }> => safely(() => {
	const read = readFile(file);
	if (!read.ok) return read;
	const refusals = validateBoard(read.value);
	if (refusals.length) return { ok: false, reason: reasonOf(refusals) };
	const board = read.value as Board, code = basename(dirname(file)), project = basename(dirname(dirname(file)));
	if (board.code !== code) return { ok: false, reason: `code ${board.code} is not the folder's ${code}` };
	if (board.project !== project) return { ok: false, reason: `project ${board.project} is not the folder's ${project}` };
	return { ok: true, board };
});

export const readYard = (file: string): FileRead<{ yard: Yard }> => safely(() => {
	const read = readFile(file);
	if (!read.ok) return read;
	const refusals = validateYard(read.value);
	if (refusals.length) return { ok: false, reason: reasonOf(refusals) };
	const yard = read.value as Yard, project = basename(dirname(file));
	if (yard.project !== project) return { ok: false, reason: `project ${yard.project} is not the folder's ${project}` };
	return { ok: true, yard };
});

export type BoardRead = { project: string; code: string; file: string } & FileRead<{ board: Board }>;

/** The folders in a folder; one that is not there has none, and one that cannot be listed for another reason is told in `failed`. */
const dirs = (path: string, failed: string[]) => {
	try {
		return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") failed.push(`cannot list ${path}: ${code ?? (error as Error).message}`);
		return [];
	}
};

/**
 * Every train's board under the state folder, the newest `max` (64 unless asked for more) by code, then listed by project and code; `truncated` when there are more. A folder that does not read shows as unreadable with its reason. Folders that are
 * not trains (the car files, the yard) are skipped. A folder that exists and cannot be listed (a permission, a descriptor limit, an I/O error) is in `unlisted` with the reason: what is in it is unknown, which the gate takes as a refusal.
 */
export function readTrainboards(stateDir: string, opts: { project?: string; max?: number } = {}): { trains: BoardRead[]; truncated: boolean; unlisted: string[] } {
	const root = trainboardDir(stateDir), found: { project: string; code: string }[] = [], unlisted: string[] = [];
	const projects = (opts.project === undefined ? dirs(root, unlisted).filter(isName).sort() : isName(opts.project) ? [opts.project] : []);
	for (const project of projects) for (const code of dirs(join(root, project), unlisted).filter((c) => FOLDER_CODE_RE.test(c)).sort(compareCodes)) found.push({ project, code });
	const max = opts.max ?? MAX_TRAINS;
	// The newest by departure order, whatever the project; shown by project, then code.
	const kept = [...found].sort((a, b) => compareCodes(a.code, b.code) || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0)).slice(Math.max(0, found.length - max));
	const trains = kept.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : compareCodes(a.code, b.code))).map(({ project, code }): BoardRead => {
		const file = join(root, project, code, "board.json");
		const read = readBoard(file);
		return { project, code, file, ...(read.ok ? read : { ok: false, reason: read.reason.replace(/^cannot read: ENOENT$/, "no board.json") }) } as BoardRead;
	});
	return { trains, truncated: found.length > max, unlisted };
}

// ---- life of a board

export interface Life { now: number; alive: boolean }

/** Ended when its `land` step completed (a voided one is no end); stale when its writer is gone and the board is 10 minutes old; live otherwise (§10). */
export function boardState(board: Board, { now, alive }: Life): "ended" | "stale" | "live" {
	if (board.steps.some((s) => s.kind === "land" && s.status === "completed" && s.outcome !== "void")) return "ended";
	return !alive && now - Date.parse(board.updated) >= STALE_MS ? "stale" : "live";
}

/** Whether the server deletes a board: an ended one 7 days after its last update, a stale one only after a clear and the same 7 days since the later of its update and its last clear; a live one never. */
export function expired(board: Board, life: Life): boolean {
	const state = boardState(board, life);
	if (state === "live") return false;
	if (state === "ended") return life.now >= Date.parse(board.updated) + KEEP_MS;
	const clears = (board.clears ?? []).map((c) => Date.parse(c.at));
	return clears.length > 0 && life.now >= Math.max(Date.parse(board.updated), ...clears) + KEEP_MS;
}

/** A read board as the facts waits.ts reads; one that did not read holds everything of its project. */
export function factsOf(read: BoardRead, life: { now: number; alive: (writer: Writer) => boolean }): TrainFacts {
	if (!read.ok) return { project: read.project, code: read.code, state: "unreadable", steps: [] };
	const { board } = read, state: TrainState = boardState(board, { now: life.now, alive: life.alive(board.writer) });
	const steps: FactStep[] = board.steps.map((s) => ({ id: s.id, kind: s.kind, status: s.status, round: s.round, ...(s.holds ? { holds: s.holds } : {}), ...(s.load ? { load: s.load } : {}), ...(s.lock ? { lock: s.lock } : {}) }));
	return { project: board.project, code: board.code, state, steps, ...(board.clears ? { clears: board.clears } : {}) };
}
