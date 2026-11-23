import { lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Board, carsDir, expired, KEEP_MS, readJsonFile, readTrainboards, readYard, trainboardDir, type Writer, yardPath } from "../train/board.ts";
import { carFileName } from "../train/cars.ts";
import { shortCode } from "../train/spec.ts";
import { carsFolderOk } from "../trainboard.ts";
import { writerAlive } from "./traingate.ts";

export interface SweepDeps {
	stateDir: string;
	now?: () => number;
	alive?: (writer: Writer, board: Board) => boolean;
	dryRun?: boolean;
}
export interface Sweep {
	removed: { project: string; code: string; cars: number }[];
	boards: number;
	files: number;
	ledgerFiles: number;
	problems: string[];
}

const headsOf = (board: Board): string[] => [...board.cars.map((c) => c.head), ...(board.removed ?? []).flatMap((r) => r.head ? [r.head] : [])];
const isDir = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
const countFiles = (folder: string): number => readdirSync(folder, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(join(folder, e.name)) : 1), 0);

// These indexes are written by integrators, not a schema we own. Protect a canonical or legacy short code wherever it appears (including explicit path references or map keys).
// Refuse to infer absence from an unreadable index. Do not interpret free-form stage names as proof that a train ended.
function indexReferences(value: unknown, project: string, code: string) {
	const words = new Set([code, shortCode(code)]), parts = [value];
	let ledger = false, board = false;
	while (parts.length) {
		const part = parts.pop();
		if (typeof part === "string") {
			ledger ||= part.toLowerCase().split(/[^a-z0-9-]+/).some((word) => words.has(word));
			board ||= `/${part.replaceAll("\\", "/")}/`.includes(`/trainboard/${project}/${code}/`);
		} else if (part && typeof part === "object") for (const [key, item] of Object.entries(part)) parts.push(key, item);
	}
	return { ledger, board };
}

/** Ended train folders and unreferenced per-train ledgers go together. A kept board or yard protects its shared car and notice files. */
export function sweepTrainboards(d: SweepDeps): Sweep {
	const { stateDir } = d, now = (d.now ?? Date.now)(), alive = d.alive ?? ((writer: Writer) => writerAlive(writer));
	const out: Sweep = { removed: [], boards: 0, files: 0, ledgerFiles: 0, problems: [] };
	const root = trainboardDir(stateDir), rootStat = lstatSync(root, { throwIfNoEntry: false });
	if (!rootStat) return out;
	if (!rootStat.isDirectory()) throw new Error("trainboard is not a directory");
	const { trains, unlisted } = readTrainboards(stateDir, { max: Number.MAX_SAFE_INTEGER });
	out.boards = trains.length;
	out.problems.push(...unlisted);
	if (unlisted.length) return out;
	const carried = new Set<string>(), unsure = new Set<string>(), gone = new Set<typeof trains[number]>();
	const yards = new Map<string, ReturnType<typeof readYard>>();
	const indexes = new Map<string, ReturnType<typeof readJsonFile>>();
	const carKey = (project: string, app: string, head: string) => `${project}/${carFileName(app, head)}`;
	for (const t of trains) {
		if (!t.ok) { unsure.add(t.project); continue; }
		if (t.endProblem) out.problems.push(`${t.project}/${t.code}: ${t.endProblem}`);
		if (t.endProblem || !expired(t.board, { now, alive: alive(t.board.writer, t.board), ...(t.end ? { end: t.end } : {}) })) continue;
		try {
			const yard = yards.get(t.project) ?? readYard(yardPath(stateDir, t.project));
			yards.set(t.project, yard);
			if (!yard.ok && yard.reason !== "cannot read: ENOENT") { unsure.add(t.project); continue; }
			if (yard.ok && yard.yard.trains.some((row) => row.code === t.code && row.app === t.board.app)) continue;
			if (yard.ok) for (const row of yard.yard.trains) for (const car of row.cars) carried.add(carKey(t.project, row.app, car.head));
			const folder = dirname(t.file);
			if (!isDir(dirname(folder)) || !isDir(folder)) continue;
			const ledgerRoot = join(stateDir, "trains"), project = join(ledgerRoot, t.project);
			const ledgerDir = join(project, t.board.app), ledger = join(ledgerDir, `${t.code}.json`);
			// Never walk a symlink in an ancestor. A present but unreadable ledger path leaves both parts for a later pass.
			for (const dir of [ledgerRoot, project, ledgerDir]) {
				const stat = lstatSync(dir, { throwIfNoEntry: false });
				if (!stat) break;
				if (!stat.isDirectory()) throw new Error("train ledger path is not a directory");
			}
			const st = lstatSync(ledger, { throwIfNoEntry: false });
			const file = join(project, `${t.board.app}.json`);
			const index = indexes.get(file) ?? readJsonFile(file, 8 * 1024 * 1024);
			indexes.set(file, index);
			if (!index.ok && index.reason !== "cannot read: ENOENT") throw new Error(`train index: ${index.reason}`);
			if (index.ok && (!index.value || typeof index.value !== "object" || Array.isArray(index.value))) throw new Error("train index is not an object");
			const referenced = index.ok ? indexReferences(index.value, t.project, t.code) : undefined;
			if (referenced?.board) continue;
			const dropLedger = st?.isFile() && !referenced?.ledger;
			if (dropLedger && st && now - st.mtimeMs < KEEP_MS) continue; // an integrator may still be writing a new ledger against an old board
			const files = countFiles(folder);
			if (dropLedger) {
				if (!d.dryRun) rmSync(ledger);
				out.ledgerFiles++;
			}
			if (!d.dryRun) rmSync(folder, { recursive: true });
			out.files += files;
			gone.add(t);
		} catch (error) { out.problems.push(`${t.project}/${t.code}: ${(error as Error).message}`); }
	}
	for (const t of trains) if (t.ok && !gone.has(t)) for (const head of headsOf(t.board)) carried.add(carKey(t.project, t.board.app, head));
	const handled = new Set<string>();
	for (const t of gone) {
		if (!t.ok) continue;
		let cars = 0;
		if (!unsure.has(t.project) && carsFolderOk(stateDir, t.project)) for (const head of headsOf(t.board)) {
			const key = carKey(t.project, t.board.app, head);
			if (carried.has(key) || handled.has(key)) continue;
			handled.add(key);
			try {
				const car = join(carsDir(stateDir, t.project), carFileName(t.board.app, head));
				for (const path of [car.replace(/\.json$/, ".notice.json"), car]) {
					if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) continue;
					if (!d.dryRun) rmSync(path);
					out.files++;
					if (path === car) cars++;
				}
			} catch (error) { out.problems.push(`car of ${t.project}/${t.code}: ${(error as Error).message}`); }
		}
		out.removed.push({ project: t.project, code: t.code, cars });
	}
	return out;
}
