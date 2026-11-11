import { readdirSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { integrationOff } from "../trainswitch.ts";
import { type BoardRead, type BoardStep, type CarRow, factsOf, readJsonFile, type ReadBudget, readTrainboards, readYard, trainboardDir, type Writer, yardPath } from "../train/board.ts";
import { carFileName, type CarState, type CarView, noticeStatus } from "../train/cars.ts";
import { isName, isObject, isoTime, MAX_TICKET_CHARS, SHA_RE } from "../train/spec.ts";
import { type FactStep, holding, stepWaits, type TrainFacts, type Wait, waitingTrains } from "../train/waits.ts";
import type { NetLoad, ProjectYard, ReasonKind, YardAccepted, YardCar, YardFormingRow, YardJoin, YardNotice, Yards, YardStep, YardTrainRow } from "../train/yardview.ts";
import { carsFolderOk, readCar } from "../trainboard.ts";
import { plain } from "./operatesanitize.ts";
import { readGate, writerAlive } from "./traingate.ts";

// The yards of the net snapshot (docs/specs/2026-11-07-train-workers.md §11.1): what the page draws of the trains, read from `<state>/trainboard/*/` on every reading of the net. The files are written by train sessions and the
// integrator, which are models, so nothing in them is trusted: a board is read with the writer's own validator and bounds (at most 64 trains, 64 KB a file, regular files only, no link followed), a file that fails shows as
// unreadable with its reason and nothing else of it is guessed, and every string that reaches the page is plain text cut to its length. Which unit of the net is a train is told by the net's own pane tokens, never by a file.
// `yards` stay on this computer: nothing here is reachable from the board message, a remote turn or the operate slice (tests/train-yard-net.test.ts).

export const MAX_PROJECTS = 64, MAX_VIEW_STEPS = 64, MAX_VIEW_CARS = 16, MAX_PROBLEMS = 8;
const MAX_EVIDENCE_COPIES = 32, MAX_EVIDENCE_BYTES = 32 * 1024;
/** What one reading of the net may read from the files of the trains (car files, notice records, evidence copies, gate files): the 2-second poll must not read without end whatever a train wrote (TY-F003). */
export const READ_BUDGET_BYTES = 4 * 1024 * 1024;

export interface YardDeps {
	stateDir: string;
	now?: () => number;
	/** Whether a board's writer is still running (see `writerAlive`). */
	alive?: (writer: Writer) => boolean;
	/** The load now: waits on the load of a step are made only with a reading. */
	load?: NetLoad;
	/** The server's own book of cars (§5.5): a car it holds is told from its record, which a train cannot write. A car it has not seen (the server restarted) is told from the journal on disk and marked so. Left out, the journal alone is read. */
	book?: { viewOf(project: string, app: string, head: string): CarView | undefined };
	/** Bytes one reading may read from car, notice, evidence and gate files (`READ_BUDGET_BYTES`; tests give less). */
	budget?: number;
}

/** What kind of failure a reader's reason text says (`ReasonKind`): read from the readers' own wording, through the prefixes this file adds; a refusal of the validators, whatever it names, is a `shape`. */
export function reasonKind(reason: string): ReasonKind {
	const inner = reason.replace(/^(yard\.json|notice file): /, "");
	if (inner !== reason) return reasonKind(inner);
	if (/^notice record: /.test(reason)) return "shape";
	if (/^the (car|train) could not be (read|shown)/.test(reason)) return "failed";
	if (/^cannot (read|list)\b/.test(reason)) return "io";
	if (reason === "not a regular file") return "notfile";
	if (/^file is (.* KB, )?more than \d+ KB$/.test(reason)) return "toobig";
	if (reason.startsWith("the byte budget")) return "budget";
	if (reason.startsWith("not JSON")) return "notjson";
	if (/ is not the folder's |^the file name is not /.test(reason)) return "misplaced";
	return "shape";
}

/** Plain text for the page: controls, escapes and bidi marks become spaces, cut to `max`; the state folder's path never leaves (a reason may name it). */
const text = (stateDir: string) => (value: string, max: number) => plain(value.split(stateDir).join("<state>"), max);

const listDirs = (path: string): { names: string[]; failed?: string } => {
	try {
		return { names: readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() && isName(e.name)).map((e) => e.name).sort() };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { names: [] } : { names: [], failed: `cannot list ${path}: ${code ?? (error as Error).message}` };
	}
};

/** The boss's words in the train's own copies of the evidence (`car-<n>.json`, §5.3), by car head and kind: regular files under 32 KB, at most 32 of them, shaped as an evidence file. Anything else adds nothing. */
function nodsOf(folder: string, clean: (value: string, max: number) => string, budget: ReadBudget): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	let names: string[] = [];
	try { names = readdirSync(folder).filter((n) => /^car-\d{1,3}\.json$/.test(n)).sort().slice(0, MAX_EVIDENCE_COPIES); } catch { return out; }
	for (const name of names) {
		const read = readJsonFile(join(folder, name), MAX_EVIDENCE_BYTES, budget);
		if (!read.ok) continue;
		const value = read.value;
		if (!isObject(value) || !isObject(value.car) || !SHA_RE.test(String(value.car.head)) || !Array.isArray(value.accepted)) continue;
		const kinds = out.get(value.car.head as string) ?? new Map<string, string>();
		for (const entry of value.accepted.slice(0, 8)) if (isObject(entry) && typeof entry.kind === "string" && typeof entry.nod === "string" && entry.nod.trim() && !kinds.has(entry.kind)) kinds.set(entry.kind, clean(entry.nod, 300));
		out.set(value.car.head as string, kinds);
	}
	return out;
}

/** What the car file of a car says of its notice: only the car's own file is read (`<app>-<head12>.json`, however many files the project holds), from a real `cars` folder. No file is no notice; a file or record that fails is `unreadable`. */
function noticeLookup(stateDir: string, project: string, budget: ReadBudget, clean: (value: string, max: number) => string, book?: YardDeps["book"]) {
	const real = carsFolderOk(stateDir, project), seen = new Map<string, YardNotice | undefined>();
	/** The notice line of a car file or the book's record of it: the newest state and whether its coordinator was told. */
	const lineOf = (view: CarView): Exclude<YardNotice, { status: "unreadable" }> | undefined => {
		const latest = view.file.states.at(-1);
		if (!latest) return undefined;
		const state: CarState = latest.state, status = noticeStatus(view.notice, state);
		return status.kind === "pending" ? { state, status: "pending", attempts: status.attempts, ...(status.last ? { last: clean(status.last, 120) } : {}) } : { state, status: status.kind, attempts: status.attempts, at: status.at };
	};
	return (app: string, head: string): YardNotice | undefined => {
		const key = `${app}\n${head}`;
		if (seen.has(key)) return seen.get(key);
		// The server's own record first (TB-F005): the disk is what a train could have written, so it speaks only for a car the book has never seen, and says so.
		const held = book?.viewOf(project, app, head);
		if (held) {
			const told = lineOf(held);
			seen.set(key, told);
			return told;
		}
		if (!real) return undefined;
		// A throw out of one car's file is that car's `unreadable`, not the snapshot's (TY-F001).
		const found = ((): YardNotice | undefined => {
			try {
				let name: string;
				try { name = carFileName(app, head); } catch { return undefined; }
				const read = readCar(stateDir, project, name, budget);
				if (!read.ok) return read.gone ? undefined : { status: "unreadable", reason: clean(read.reason, 200), kind: reasonKind(read.reason) };
				// Another car whose head starts alike shares the name: it is not this car's file.
				if (read.file.app !== app || read.file.car.head !== head) return undefined;
				if (read.noticeProblem) return { status: "unreadable", reason: clean(read.noticeProblem, 200), kind: reasonKind(read.noticeProblem) };
				const told = lineOf(read.notice ? { file: read.file, notice: read.notice } : { file: read.file });
				return told && book ? { ...told, journal: true as const } : told;
			} catch (error) {
				return { status: "unreadable", reason: clean(`the car could not be read: ${(error as Error).message}`, 200), kind: "failed" };
			}
		})();
		seen.set(key, found);
		return found;
	};
}

function cleanWait(wait: Wait, clean: (value: string, max: number) => string): Wait {
	if ("load" in wait) return { load: { max: wait.load.max, now: wait.load.now } };
	if ("lock" in wait) return { lock: { name: clean(wait.lock.name, 32), ...(wait.lock.holder ? { holder: { train: clean(wait.lock.holder.train, 32), step: wait.lock.holder.step } } : {}) } };
	if ("lane" in wait) return { lane: { app: clean(wait.lane.app, 64), holder: clean(wait.lane.holder, 32), ...(wait.lane.why ? { why: wait.lane.why } : {}) } };
	return { target: { target: clean(wait.target.target, 128), holder: clean(wait.target.holder, 32), ...(wait.target.why ? { why: wait.target.why } : {}) } };
}

/** Which unit of the net is a train: the one whose pane's token names it. With two claims the one that is the board's own writer wins; with no way to tell, none. */
function unitOf(join: YardJoin, project: string, code: string, writer?: string): string | undefined {
	const claims = join.trains.filter((u) => u.project === project && u.code === code);
	return claims.length === 1 ? claims[0]!.key : claims.find((u) => u.key === writer)?.key;
}

/**
 * The yards of the snapshot: per project the forming trains of its `yard.json` and every train of its trainboards, with the unit of the net that runs each. `undefined` when there is nothing to show (no trainboard folder, or no project in
 * it has a train or a yard). Never throws on what a file holds; a folder that cannot be listed is told in `problems`.
 */
export function readYards(deps: YardDeps, join_: YardJoin): Yards | undefined {
	const { stateDir } = deps, now = (deps.now ?? Date.now)(), isAlive = deps.alive ?? ((w: Writer) => writerAlive(w)), clean = text(stateDir);
	const root = trainboardDir(stateDir), listed = listDirs(root), problems = listed.failed ? [listed.failed] : [];
	const names = listed.names.slice(0, MAX_PROJECTS), { trains: reads, truncated, unlisted } = readTrainboards(stateDir);
	problems.push(...unlisted);
	// A board's writer is asked once, however many ways its liveness is used.
	const lives = new Map<BoardRead, boolean>();
	const live = (read: BoardRead & { ok: true }) => (lives.has(read) ? lives.get(read)! : (lives.set(read, isAlive(read.board.writer)), lives.get(read)!));
	const facts: TrainFacts[] = reads.map((read) => factsOf(read, { now, alive: () => (read.ok ? live(read) : false) }));
	const load = deps.load ? { now: deps.load.now, cores: deps.load.cores } : undefined;
	const budget: ReadBudget = { left: deps.budget ?? READ_BUDGET_BYTES };
	const projects: ProjectYard[] = [];
	for (const project of names) {
		const mine = reads.flatMap((read, i) => (read.project === project ? [{ read, fact: facts[i]! }] : []));
		const yard = readYard(yardPath(stateDir, project)), missing = !yard.ok && yard.reason === "cannot read: ENOENT";
		if (!mine.length && missing) continue;
		const noticeOf = noticeLookup(stateDir, project, budget, clean, deps.book);
		const carView = (row: CarRow, app: string, nods?: Map<string, Map<string, string>>): YardCar => {
			const accepted = (row.accepted ?? []).slice(0, 8).map((kind): YardAccepted => ((nod) => (nod ? { kind: clean(kind, 32), nod } : { kind: clean(kind, 32) }))(nods?.get(row.head)?.get(kind)));
			const notice = noticeOf(app, row.head);
			return { tickets: row.tickets.map((t) => clean(t, MAX_TICKET_CHARS)), branch: clean(row.branch, 255), head: row.head, departs: clean(row.departs, 300), ...(row.arrived ? { arrived: row.arrived } : {}), accepted, ...(row.unverified ? { unverified: true as const } : {}), ...(notice ? { notice } : {}) };
		};
		const trainRow = (read: BoardRead, fact: TrainFacts): YardTrainRow => {
			if (!read.ok) {
				const key = unitOf(join_, project, read.code);
				return { code: read.code, state: "unreadable", reason: clean(read.reason, 200), reasonKind: reasonKind(read.reason), ...(key ? { key } : {}), cars: [], steps: [] };
			}
			const { board } = read, key = unitOf(join_, project, board.code, board.writer.session), nods = nodsOf(dirname(read.file), clean, budget);
			const factSteps = new Map<number, FactStep>(fact.steps.map((s) => [s.id, s]));
			const view = (s: BoardStep): YardStep => {
				const recorded = s.status === "in_progress" ? (s.waits ?? []).filter((w) => "lock" in w) : [];
				const waits = s.status === "in_progress" ? [...stepWaits(fact, factSteps.get(s.id)!, { trains: facts, ...(load ? { load } : {}) }), ...recorded].slice(0, 8).map((w) => cleanWait(w, clean)) : [];
				const gate = s.status === "in_progress" ? readGate(join(dirname(read.file), `gate-${s.id}.json`), budget) : undefined;
				const gateOk = gate && gate.train === board.code && gate.step === s.id && isoTime(gate.since) && isoTime(gate.updated);
				return {
					id: s.id, kind: s.kind, name: clean(s.name, 64), status: s.status, round: s.round, ...(s.outcome ? { outcome: s.outcome } : {}), ...(s.why ? { why: s.why } : {}),
					...(s.load ? { load: { ...s.load } } : {}), ...(s.holds ? { holds: { ...s.holds } } : {}), waits, ...(gateOk ? { gate: { state: gate.state, since: gate.since, updated: gate.updated } } : {}),
				};
			};
			const steps = board.steps.toSorted((a, b) => a.id - b.id), shown = steps.slice(-MAX_VIEW_STEPS), held = holding(fact);
			return {
				code: board.code, app: board.app, state: fact.state === "unreadable" ? "unreadable" : fact.state, ...(key ? { key } : {}), writerLive: live(read), round: board.round, updated: board.updated,
				...(board.removed?.length ? { removed: board.removed.slice(0, MAX_VIEW_CARS).map((r) => ((notice) => ({ ticket: clean(r.ticket, 64), why: clean(r.why, 300), ...(notice ? { notice } : {}) }))(r.head ? noticeOf(board.app, r.head) : undefined)) } : {}),
				cars: board.cars.slice(0, MAX_VIEW_CARS).map((c) => carView(c, board.app, nods)), steps: shown.map(view), ...(steps.length > shown.length ? { stepsCut: steps.length - shown.length } : {}),
				...(held.lanes.length || held.targets.length ? { holds: { lanes: held.lanes, targets: held.targets } } : {}),
			};
		};
		// One train that cannot be shown is that train's `unreadable`, not the whole snapshot's (TY-F001).
		const trains = mine.map(({ read, fact }): YardTrainRow => {
			try {
				return trainRow(read, fact);
			} catch (error) {
				return { code: read.code, state: "unreadable", reason: clean(`the train could not be shown: ${(error as Error).message}`, 200), reasonKind: "failed", cars: [], steps: [] };
			}
		});
		const forming = yard.ok ? yard.yard.trains.filter((t) => t.status !== "opened").map((t): YardFormingRow => ({
			code: t.code, app: t.app, status: t.status as YardFormingRow["status"], cars: t.cars.slice(0, MAX_VIEW_CARS).map((c) => carView(c, t.app)), ...(t.departs ? { departs: { maxCars: t.departs.maxCars, maxWaitMin: t.departs.maxWaitMin, oldest: t.departs.oldest } } : {}),
		})) : [];
		projects.push({
			project, ...(yard.ok ? { integrator: { ...(join_.integrators.has(yard.yard.writer.session) ? { key: yard.yard.writer.session } : {}), live: isAlive(yard.yard.writer), ...(join_.mains.has(yard.yard.writer.session) && !join_.integrators.has(yard.yard.writer.session) ? { switched: true as const } : {}) } } : {}),
			...(!yard.ok && !missing ? { problem: clean(`yard.json: ${yard.reason}`, 200), problemKind: reasonKind(yard.reason) } : {}), forming, trains, waiting: waitingTrains(mine.map((m) => m.fact)),
		});
	}
	const cut = truncated || listed.names.length > MAX_PROJECTS;
	if (!projects.length && !problems.length && !cut) return undefined;
	return { projects, ...(cut ? { truncated: true as const } : {}), ...(problems.length ? { problems: problems.slice(0, MAX_PROBLEMS).map((p) => clean(p, 200)) } : {}) };
}

export interface TrainyardOptions {
	env: NodeJS.ProcessEnv;
	stateDir: string;
	platform?: NodeJS.Platform;
	/** The 1-minute load average and the core count (tests give their own). */
	load?: () => { now: number; cores: number };
	now?: () => number;
	alive?: (writer: Writer) => boolean;
	/** The server's book of cars; read when the page is drawn (it exists only after the server has built it). */
	book?: () => YardDeps["book"] | undefined;
}

/**
 * What the net reads the trains through. With the merge train off (`trainswitch.ts`, checked at every reading, so a switch turned on or off shows at once) nothing is read at all. A reader that fails is told in `problems`, not thrown:
 * the net stays up. The load is a whole number (a tenth moves almost every reading, and every move is a new snapshot for every page); there is none on Windows, where the system gives no load average (§16).
 */
export function trainyardSeam(o: TrainyardOptions) {
	const reading = (): NetLoad | undefined => {
		if ((o.platform ?? process.platform) === "win32") return undefined;
		const now = o.load?.() ?? { now: loadavg()[0]!, cores: availableParallelism() };
		return Number.isFinite(now.now) && now.cores > 0 ? { now: Math.round(now.now), cores: now.cores } : undefined;
	};
	const off = () => integrationOff(o.env, o.stateDir);
	return {
		yards(join_: YardJoin): Yards | undefined {
			if (off()) return undefined;
			try {
				const load = reading();
				const book = o.book?.();
				return readYards({ stateDir: o.stateDir, ...(o.now ? { now: o.now } : {}), ...(o.alive ? { alive: o.alive } : {}), ...(load ? { load } : {}), ...(book ? { book } : {}) }, join_);
			} catch (error) {
				return { projects: [], problems: [plain(`the trains could not be read: ${(error as Error).message}`.split(o.stateDir).join("<state>"), 200)] };
			}
		},
		load(): NetLoad | undefined {
			try {
				return off() ? undefined : reading();
			} catch {
				return undefined; // told once, in `yards`' problems, by the reading that failed
			}
		},
	};
}
export type Trainyard = ReturnType<typeof trainyardSeam>;
