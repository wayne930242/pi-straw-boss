import type { CarRow, YardTrain } from "./board.ts";
import { type CarFile, type CarState, endOf } from "./cars.ts";
import { compareCodes, type Kind } from "./spec.ts";
import type { Wait } from "./waits.ts";
import type { YardStep, YardTrainRow } from "./yardview.ts";

// Where each car is (docs/specs/2026-11-28-car-rows.md): one fact per car of a project, joined from the server's book of cars (or the journal after a restart) and the trainboards the yard reads. The session words
// them for the todo panel and `/boss cars` (carline.ts), the page for a main's unit card (gui/trains.ts). Pure: the reader hands in what it read; nothing here reads a file or a clock.

/** How long a car that ended still shows (boss 2026-11-28): 30 minutes after it landed, was returned or was dropped. */
export const KEEP_ENDED_MS = 30 * 60_000;

export type CarPhase = "waiting" | "riding" | "landed" | "returned" | "dropped";
/** Where a riding car's train is: the kind of its step, its place on the app's ladder (`at` of `of`, absent when the app has no landed train or the kind is off its ladder), the attempt at that kind, and `between` when no step runs (the last one done is shown). */
export interface StageFact { kind: Kind; at?: number; of?: number; attempt: number; between?: true }
export interface CarFact {
	/** `<project>/<app>-<head12>#<life>`: stable for one life of the car. */
	id: string;
	project: string; app: string; head: string; tickets: string[];
	/** The session every notice of the car goes to. */
	coordinator: string;
	/** The session that received the car (the integrator), when known. */
	integrator?: string;
	phase: CarPhase;
	/** The train the car rides, or was received for. */
	train?: string;
	/** When the current stage began, ms since the epoch: the step's start, the receipt of a waiting car, the end of an ended one. */
	since: number;
	stage?: StageFact;
	/** The train stalled (its session is gone and its board is old). */
	stale?: true;
	/** What the step in progress waits for. */
	waits?: Wait[];
	/** The departure rule of the forming train a waiting car is in. */
	departs?: { maxCars: number; maxWaitMin: number; oldest: string };
	/** A landed car's version; a returned or dropped car's reason, its first line. */
	version?: string; reason?: string;
}

/** One life of a car as the book or the journal holds it, and how many lives the car has had. */
export interface Life { file: CarFile; lives: number }
export interface FactInput {
	project: string;
	now: number;
	/** `yard.json`: its writer (the integrator) and its trains. */
	yard?: { writer: string; trains: readonly YardTrain[] };
	/** Each train that read: its view (steps with waits and gate times) and the cars of its board as written, coordinators included. */
	trains: readonly { view: YardTrainRow; cars: readonly CarRow[]; /** The heads of the cars a round left out (the board's `removed`). */ removed?: readonly string[] }[];
	/** The current life of a car, from the book, else the journal. */
	life(app: string, head: string): Life | undefined;
	/** The book's cars that no board and no yard lists (a car returned at receipt). */
	others: readonly Life[];
	/** When the reader first saw `key`, in ms (a step in progress whose gate recorded no start). */
	seen(key: string): number;
}

const TERMINAL: readonly CarState[] = ["landed", "returned", "dropped"];
const firstLine = (text: unknown) => (typeof text === "string" ? text.split(/\r?\n/)[0]!.trim().slice(0, 200) : undefined);
const ms = (iso: string | undefined) => { const t = iso === undefined ? NaN : Date.parse(iso); return Number.isFinite(t) ? t : undefined; };
const landedTrain = (t: YardTrainRow) => t.steps.some((s) => s.kind === "land" && s.status === "completed" && s.outcome !== "void" && s.outcome !== "failed");

/** The stages of the app's last train that landed: the kinds of its last round, in order, each once. Undefined when no train of the app landed. */
export function ladderOf(trains: readonly YardTrainRow[], app: string): Kind[] | undefined {
	const last = trains.filter((t) => t.app === app && t.state !== "unreadable" && landedTrain(t)).sort((a, b) => compareCodes(b.code, a.code))[0];
	if (!last) return undefined;
	const round = last.round ?? Math.max(...last.steps.map((s) => s.round));
	const kinds: Kind[] = [];
	for (const s of last.steps.toSorted((a, b) => a.id - b.id)) if (s.round === round && s.outcome !== "void" && !kinds.includes(s.kind)) kinds.push(s.kind);
	return kinds;
}

/** Where a train is on the ladder: its step in progress (the newest), else the last one done; superseded steps do not count, and a kind run again is its next attempt. */
export function stageOf(view: YardTrainRow, ladder: readonly Kind[] | undefined, seen: (key: string) => number, project: string): { stage?: StageFact; since?: number; waits?: Wait[] } {
	const steps = view.steps.filter((s) => s.outcome !== "void").toSorted((a, b) => a.id - b.id);
	const live = steps.filter((s) => s.status === "in_progress").at(-1), cur: YardStep | undefined = live ?? steps.filter((s) => s.status === "completed").at(-1);
	if (!cur) return {};
	const index = ladder?.indexOf(cur.kind) ?? -1, attempt = steps.filter((s) => s.kind === cur.kind && s.id <= cur.id).length;
	const stage: StageFact = { kind: cur.kind, ...(index >= 0 ? { at: index + 1, of: ladder!.length } : {}), attempt, ...(live ? {} : { between: true as const }) };
	const key = `${project}/${view.code}/${cur.id}${live ? "" : "/done"}`;
	const since = (live && ms(live.gate?.since)) ?? seen(key);
	return { stage, since, ...(live?.waits.length ? { waits: live.waits } : {}) };
}

/** The facts of a project's cars: every car a board, the yard or the book lists, once, in the life it lives now; an ended car only for `KEEP_ENDED_MS` after its end. */
export function carFacts(input: FactInput): CarFact[] {
	const { project, now } = input, out: CarFact[] = [], done = new Set<string>();
	const views = input.trains.map((t) => t.view);
	const ladders = new Map<string, Kind[] | undefined>(), ladder = (app: string) => (ladders.has(app) ? ladders.get(app) : (ladders.set(app, ladderOf(views, app)), ladders.get(app)));
	/** The boards that carry a head, newest first. */
	const boardsOf = (app: string, head: string) => input.trains.filter((t) => t.view.app === app && t.view.state !== "unreadable" && t.cars.some((c) => c.head === head)).sort((a, b) => compareCodes(b.view.code, a.view.code));
	const formingOf = (app: string, head: string) => input.yard?.trains.find((t) => t.app === app && t.status !== "opened" && t.cars.some((c) => c.head === head));
	const one = (app: string, head: string, row?: CarRow) => {
		const key = `${app}\n${head}`;
		if (done.has(key)) return;
		done.add(key);
		const life = input.life(app, head), file = life?.file, received = file?.states.find((s) => s.state === "received");
		const coordinator = file?.coordinator ?? row?.coordinator, tickets = file?.car.tickets ?? row?.tickets;
		if (!coordinator || !tickets?.length) return;
		const integrator = received?.by.session ?? input.yard?.writer, code = typeof received?.train === "string" ? received.train : undefined;
		const base = { id: `${project}/${app}-${head.slice(0, 12)}#${life?.lives ?? 1}`, project, app, head, tickets: [...tickets], coordinator, ...(integrator ? { integrator } : {}) };
		const end = file ? endOf(file) : undefined;
		if (end && TERMINAL.includes(end.state)) {
			const at = ms(end.at);
			if (at === undefined || now - at > KEEP_ENDED_MS) return;
			const word = end.state === "landed" ? { ...(typeof end.version === "string" ? { version: end.version.slice(0, 128) } : {}) } : ((r) => (r ? { reason: r } : {}))(firstLine(end.reason));
			return void out.push({ ...base, phase: end.state as CarPhase, ...(code ? { train: code } : {}), since: at, ...word });
		}
		const boards = boardsOf(app, head), board = boards.find((b) => b.view.code === code) ?? boards[0];
		if (board) {
			const view = board.view, ended = view.state === "ended";
			if (ended && now - (ms(view.updated) ?? 0) > KEEP_ENDED_MS) return;
			const { stage, since, waits } = stageOf(view, ladder(app), input.seen, project);
			return void out.push({ ...base, phase: "riding", train: view.code, since: since ?? ms(received?.at) ?? input.seen(`${project}/${view.code}`), ...(stage ? { stage } : {}), ...(view.state === "stale" ? { stale: true as const } : {}), ...(waits ? { waits } : {}) });
		}
		const forming = formingOf(app, head), arrived = ms(forming?.cars.find((c) => c.head === head)?.arrived);
		if (!forming && !received) return;
		out.push({ ...base, phase: "waiting", ...(forming ? { train: forming.code } : code ? { train: code } : {}), since: ms(received?.at) ?? arrived ?? input.seen(`${project}/${app}-${head}`), ...(forming?.departs ? { departs: { ...forming.departs } } : {}) });
	};
	for (const t of input.trains) if (t.view.app) for (const c of t.cars) one(t.view.app, c.head, c);
	for (const t of input.yard?.trains ?? []) for (const c of t.cars) one(t.app, c.head, c);
	// A car a round left out is told by its own life (dropped, with the reason), which the book or the journal holds.
	for (const t of input.trains) if (t.view.app) for (const head of t.removed ?? []) one(t.view.app, head);
	for (const l of input.others) one(l.file.app, l.file.car.head);
	return out;
}
