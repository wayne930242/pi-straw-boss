import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { availableParallelism, loadavg, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSyncExe } from "../exe.mjs";
import { checkAcceptRef, checkCar, checkEvidence, parseAppAccept, parseSlip } from "../train/accept.ts";
import { appsFile, projectAppsDir, readAppIntegration, repoRoot } from "../train/appsconfig.ts";
import { type Board, boardPath, boardState, MAX_TRAINS, trainboardDir, factsOf, MAX_CLEARS, readBoard, readTrainboards, type Writer, writeBoard } from "../train/board.ts";
import { isName, isObject, validateStep } from "../train/spec.ts";
import { noticeStatus, stateLine, type Attempt } from "../train/cars.ts";
import { carsFolderOk, listCars, MAX_CAR_FILES } from "../trainboard.ts";
import { holding, loadLimit, stepWaits, type FactStep, type TrainFacts, type Wait } from "../train/waits.ts";
import { gateDeps, type GateDeps, type GateFile, readGate, runGate, writerAlive } from "./traingate.ts";
import { plain } from "./operatesanitize.ts";
import { heldLocks, lockDirOf } from "./trainlock.ts";

// The `train` commands of cli.mjs (docs/specs/2026-11-07-train-workers.md §9.2): `gate` (traingate.ts), `check`, `status`, `clear`. Kept out of cli.ts, which carries a line budget (procscli.ts is the model). Exit codes: `gate` as the wrapper
// says (0, 1, 3, 143); `check` 0 when nothing is refused and 2 when something is (a usage error is 2 too); `status` 0; `clear` 0 done, 1 refused (the train's state does not allow it), 2 usage.

export interface TrainIo {
	out(text: string): void;
	err(text: string): void;
	env: NodeJS.ProcessEnv;
	/** The state folder (`<state>/trainboard/…`, and `<state>/locks/…`: the locks are the computer's, whichever slot asks). */
	stateDir: string;
	cwd?: string;
	now?: () => number;
	alive?: (writer: Writer) => boolean;
	user?: string;
	/** `git merge-base --is-ancestor` in `cwd`, and whether a file is there: replaced by tests. */
	isAncestor?: (older: string, newer: string) => boolean;
	exists?: (path: string) => boolean;
	load?: () => { now: number; cores: number } | undefined;
	gate?: Partial<GateDeps>;
}

const MAX_INPUT = 256 * 1024;
const usage = (io: TrainIo, text: string) => (io.err(`${text}\n`), 2);

function readInput(file: string): string {
	const stat = lstatSync(file);
	if (!stat.isFile()) throw new Error("not a regular file");
	if (stat.size > MAX_INPUT) throw new Error(`more than ${MAX_INPUT / 1024} KB`);
	return readFileSync(file, "utf8");
}

export async function runTrain(flags: Record<string, string | true>, io: TrainIo): Promise<number> {
	switch (flags.sub) {
		case "gate": return typeof flags.spec === "string" ? runGate(flags.spec, gateDeps(io.env, { out: (line) => io.out(`${line}\n`), ...io.gate })) : usage(io, "train gate needs --spec <file>");
		case "check": return check(flags, io);
		case "status": return status(flags, io);
		case "notices": return notices(flags, io);
		case "clear": return clear(flags, io);
	}
	return usage(io, "train needs gate, check, status, clear or notices");
}

// ---- check

function check(flags: Record<string, string | true>, io: TrainIo): number {
	const cwd = io.cwd ?? process.cwd();
	if ((flags.step === undefined) === (flags.accept === undefined)) return usage(io, "train check needs --step <spec.json> or --accept <file> (with --app, --app-accept and --slip), one of them");
	if (flags.step !== undefined && (flags["app-accept"] !== undefined || flags.slip !== undefined || flags.app !== undefined)) return usage(io, "--app, --app-accept and --slip go with --accept");
	if (flags.accept === undefined && flags.slip !== undefined) return usage(io, "--slip goes with --accept");
	const read = (flag: string) => {
		try {
			return { text: readInput(resolve(cwd, String(flags[flag]))) };
		} catch (error) {
			return { refusal: `sb: cannot read --${flag} ${String(flags[flag])}: ${(error as Error).message}` };
		}
	};
	const refusals: string[] = [];
	if (flags.step !== undefined) {
		const input = read("step");
		if (input.refusal) refusals.push(input.refusal);
		else {
			let value: unknown;
			try {
				value = JSON.parse(input.text!);
			} catch (error) {
				value = undefined;
				refusals.push(`sb: the step file is not JSON (${(error as Error).message})`);
			}
			// The file may be the todo's whole metadata (`{ "sb": … }`) or `metadata.sb` itself.
			if (value !== undefined) refusals.push(...validateStep(isObject(value) && isObject(value.sb) && value.spec === undefined ? value.sb : value));
		}
	} else {
		// `--accept none` is no evidence at all (the slip says `accept: none`): it is checked against what the app requires (`--app-accept`), and a file named `none` is read as `./none`.
		const none = typeof flags.accept === "string" && flags.accept.trim().toLowerCase() === "none";
		const accept: { text?: string; refusal?: string } = none ? {} : read("accept"), slip = flags.slip !== undefined ? read("slip") : undefined;
		const list = typeof flags["app-accept"] === "string" ? String(flags["app-accept"]).split(",").map((k) => k.trim()).filter(Boolean) : [];
		const setting = parseAppAccept(list);
		if (accept.refusal) refusals.push(accept.refusal);
		if (slip?.refusal) refusals.push(slip.refusal);
		if (!setting.ok) refusals.push(setting.refusal);
		// What the app requires is the file's (TB-F001): the project's apps.json, for the app `--app` names, else the slip's `car:` (or `app:`), else the evidence's `car.app`. `--app-accept` can only add to it. The file is this folder's, else
		// that of the repository's main checkout (a coordinator's linked worktree may have none, and the tower reads the project's). When neither has one, a named app could not be checked, and the check says so instead of ok (0.77.3);
		// with no app named, the flag alone is checked.
		let required: string[] = setting.ok ? setting.accept : [];
		if (!accept.refusal && !slip?.refusal && setting.ok) {
			const app = typeof flags.app === "string" ? flags.app : slip ? parseSlip(slip.text!).fields.car : evidenceApp(accept.text);
			const dir = projectAppsDir(cwd);
			if (dir === undefined) {
				if (app) refusals.push(`sb: app ${app} could not be checked: ${noAppsWhere(cwd)}; run train check in the project's checkout`);
			} else {
				const found = app ? readAppIntegration(dir, app) : { ok: false as const, refusal: "sb: the project has an apps.json, so name the app to check against: --app <name>" };
				if (found.ok) required = [...new Set([...required, ...found.accept])];
				else refusals.push(found.refusal);
			}
		}
		if (!accept.refusal && !slip?.refusal && setting.ok && !refusals.length) {
			const exists = io.exists ?? ((path: string) => existsSync(resolve(cwd, path)));
			const isAncestor = io.isAncestor ?? ((older: string, newer: string) => {
				try {
					execFileSyncExe("git", ["merge-base", "--is-ancestor", older, newer], { cwd, stdio: "ignore", timeout: 15_000, killSignal: "SIGKILL" });
					return true;
				} catch {
					return false;
				}
			});
			const options = { appAccept: required, exists, isAncestor };
			refusals.push(...(slip ? checkCar(slip.text!, accept.text, options) : none ? checkAcceptRef("none", required) : checkEvidence(accept.text!, options)));
		}
	}
	io.out(`${JSON.stringify({ ok: refusals.length === 0, refusals })}\n`);
	return refusals.length ? 2 : 0;
}

/** Where `train check` looked for an apps.json and found none: the folder's git root, and the repository's main checkout when that is another folder. */
function noAppsWhere(cwd: string): string {
	const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
	const here = appsFile(real(cwd)).both, main = appsFile(repoRoot(cwd)).both;
	return `no apps.json at ${here}${main === here ? "" : `, nor in the main checkout of this repository (${main})`}`;
}

/** The app an evidence file names (`car.app`), if it is one. */
function evidenceApp(text: string | undefined): string | undefined {
	try { const car = (JSON.parse(text ?? "null") as { car?: { app?: unknown } } | null)?.car; return typeof car?.app === "string" ? car.app : undefined; } catch { return undefined; }
}

// ---- status

export interface StepRow { id: number; kind: string; name: string; status: string; round: number; outcome?: string; waits: Wait[]; gate?: GateFile }
export interface TrainRow {
	project: string; app?: string; code: string; state: TrainFacts["state"]; reason?: string; session?: { id: string; pid: number; live: boolean }; round?: number; steps: StepRow[];
	cars: { tickets: string[]; branch: string; head: string; coordinator: string }[]; holds?: { lanes: string[]; targets: string[] };
}
export interface Status { load?: { now: number; cores: number }; locks: { name: string; train: string; step: number; pid: number; since: string }[]; trains: TrainRow[]; truncated: boolean; unlisted: string[] }

/** Every train on this computer from the trainboards: its state, its steps with the wait each is in and the wrapper's last word, the load now, and the locks held. */
export function trainStatus(io: Pick<TrainIo, "stateDir" | "now" | "alive" | "load">, project?: string): Status {
	const now = (io.now ?? Date.now)(), alive = io.alive ?? ((w: Writer) => writerAlive(w));
	const { trains: reads, truncated, unlisted } = readTrainboards(io.stateDir, project !== undefined ? { project } : {});
	const facts = reads.map((r) => factsOf(r, { now, alive }));
	const load = (io.load ?? (() => ({ now: loadavg()[0]!, cores: availableParallelism() })))();
	const locks = heldLocks(lockDirOf(io.stateDir)).map(({ name, holder }) => ({ name, train: holder.train, step: holder.step, pid: holder.pid, since: holder.since }));
	const held = Object.fromEntries(locks.map((l) => [l.name, { train: l.train, step: l.step }]));
	const trains = reads.map((read, i): TrainRow => {
		const train = facts[i]!;
		if (!read.ok) return { project: read.project, code: read.code, state: "unreadable", reason: read.reason, steps: [], cars: [] };
		const { board } = read, steps = board.steps.map((s): StepRow => {
			const fact: FactStep = { id: s.id, kind: s.kind, status: s.status, round: s.round, ...(s.holds ? { holds: s.holds } : {}), ...(s.load ? { load: s.load } : {}), ...(s.lock ? { lock: s.lock } : {}) };
			const gate = s.status === "in_progress" ? readGate(join(dirname(read.file), `gate-${s.id}.json`)) : undefined;
			return {
				id: s.id, kind: s.kind, name: s.name, status: s.status, round: s.round, ...(s.outcome ? { outcome: s.outcome } : {}),
				waits: s.status === "in_progress" ? stepWaits(train, fact, { trains: facts, ...(load ? { load } : {}), locks: held }) : [], ...(gate ? { gate } : {}),
			};
		});
		const held2 = holding(train);
		return {
			project: board.project, app: board.app, code: board.code, state: train.state, session: { id: board.writer.session, pid: board.writer.pid, live: alive(board.writer) }, round: board.round, steps,
			cars: board.cars.map((c) => ({ tickets: c.tickets, branch: c.branch, head: c.head, coordinator: c.coordinator })), holds: { lanes: held2.lanes, targets: held2.targets },
		};
	});
	return { ...(load ? { load } : {}), locks, trains, truncated, unlisted };
}

const waitText = (w: Wait) => ("load" in w ? `load <=${w.load.max} (now ${w.load.now})` : "lock" in w ? `lock ${w.lock.name}${w.lock.holder ? ` held by ${w.lock.holder.train} #${w.lock.holder.step}` : ""}`
	: "lane" in w ? `lane ${w.lane.app} held by ${w.lane.holder}${w.lane.why ? ` (${w.lane.why})` : ""}` : `target ${w.target.target} held by ${w.target.holder}${w.target.why ? ` (${w.target.why})` : ""}`);

function render(s: Status): string {
	const lines = [s.load ? `load ${Math.round(s.load.now * 10) / 10} on ${s.load.cores} cores` : "load unknown", s.locks.length ? `locks: ${s.locks.map((l) => `${l.name} (${l.train} #${l.step}, pid ${l.pid})`).join(", ")}` : "locks: none"];
	for (const t of s.trains) {
		lines.push(`${t.project} ${t.app ?? "?"} ${t.code} ${t.state}${t.session ? ` session ${t.session.id} ${t.session.live ? "live" : "gone"}` : ""}${t.round ? ` round ${t.round}` : ""}${t.reason ? ` (${t.reason})` : ""}`);
		for (const c of t.cars) lines.push(`  car ${c.tickets.join(",")} ${c.branch} (${c.coordinator})`);
		for (const st of t.steps) lines.push(`  #${st.id} ${st.kind} ${st.name}: ${st.status}${st.outcome ? ` ${st.outcome}` : ""}${st.gate ? ` [${st.gate.state}: ${st.gate.message}]` : ""}${st.waits.length ? ` waits ${st.waits.map(waitText).join("; ")}` : ""}`);
	}
	if (s.truncated) lines.push("(more trains than the 64 shown)");
	for (const u of s.unlisted) lines.push(`(${u}; the trains in it are not shown)`);
	return `${lines.join("\n")}\n`;
}

function status(flags: Record<string, string | true>, io: TrainIo): number {
	if (flags.project !== undefined && typeof flags.project !== "string") return usage(io, "--project needs a name");
	const result = trainStatus(io, flags.project as string | undefined);
	io.out(flags.json === true ? `${JSON.stringify(result)}\n` : render(result));
	return 0;
}

// ---- clear

function clear(flags: Record<string, string | true>, io: TrainIo): number {
	const { project, train, lane, target, reason } = flags;
	if (![project, train, reason].every((v) => typeof v === "string") || (lane === undefined) === (target === undefined) || (lane !== undefined && typeof lane !== "string") || (target !== undefined && typeof target !== "string"))
		return usage(io, "train clear needs --project P --train CODE --reason TEXT and one of --lane <app> or --target <name>");
	const why = String(reason).replace(/\s+/g, " ").trim();
	if (!why || why.length > 600) return usage(io, "--reason is 1 to 600 characters");
	let file: string;
	try {
		file = boardPath(io.stateDir, String(project), String(train));
	} catch (error) {
		return usage(io, (error as Error).message);
	}
	const refuse = (text: string) => (io.err(`sb: ${text}\n`), 1);
	const read = readBoard(file);
	if (!read.ok) return refuse(`the board of train ${String(train)} cannot be read (${read.reason}), so what it holds cannot be known and a clear does not release it`);
	const { board } = read, now = (io.now ?? Date.now)(), alive = (io.alive ?? ((w: Writer) => writerAlive(w)))(board.writer);
	const state = boardState(board, { now, alive });
	if (state === "ended") return refuse(`train ${board.code} has ended; it holds nothing`);
	if (state === "live") return refuse(alive ? `train ${board.code}'s session is live (pid ${board.writer.pid}); only a train whose session is gone can be cleared` : `train ${board.code}'s session is gone, but its board was updated less than 10 minutes ago; it is stale after that, and a clear is honored only for a stale train`);
	const facts = factsOf({ project: board.project, code: board.code, file, ...read }, { now, alive: () => alive }), held = holding(facts);
	const key = lane !== undefined ? "lane" : "target", name = String(lane ?? target);
	if (!(key === "lane" ? held.lanes : held.targets).includes(name)) return refuse(`train ${board.code} does not hold ${key} ${name}${board.clears?.some((c) => c[key] === name) ? " (already cleared)" : ""}`);
	if ((board.clears?.length ?? 0) >= MAX_CLEARS) return refuse(`train ${board.code} has ${MAX_CLEARS} clears already`);
	// `updated` stays as it was: the train is stale by it, and a clear is honored only while stale.
	const next: Board = { ...board, clears: [...(board.clears ?? []), { [key]: name, reason: why, by: `cli train clear (${io.user ?? userInfo().username})`, at: new Date(now).toISOString() }] };
	try {
		writeBoard(io.stateDir, next);
	} catch (error) {
		return refuse(`the clear was not written: ${(error as Error).message}`);
	}
	io.out(`${JSON.stringify({ ok: true, project: board.project, train: board.code, [key]: name, reason: why })}\n`);
	return 0;
}

// ---- notices

export interface NoticeState { state: string; at: string; by: { role: string; name: string; session: string }; text?: string; status: "pending" | "delivered" | "escalated" | "unreadable"; attempts: { at: string; outcome: string; answer?: string }[]; towerAttempts: number; deliveredAt?: string; escalatedAt?: string }
export interface NoticeCar { project: string; app: string; tickets: string[]; branch: string; head: string; coordinator: string; states: NoticeState[] }
/** `source`: these are the files on disk, which the server wrote and a train could also have written, not the server's own record (its memory). `unreadable`: the car and notice files that failed, with why. */
export interface Notices { source: "journal on disk"; cars: NoticeCar[]; truncated: boolean; unreadable: { project: string; file: string; reason: string }[] }

const MAX_NOTICE_CARS = MAX_TRAINS * 16;

/**
 * Every car's states and notice records under `<state>/trainboard/<project>/cars/`, as the page reads them (`listCars`: the newest 256 files of a project, each validated and capped; a project or cars folder that is a link is not followed), at
 * most 1024 files in all. A file that fails is told in `unreadable`, and the car of a notice record that fails shows its states `unreadable`: nothing is guessed. This is the journal on disk (CR-F003), which a train could have written.
 */
export function trainNotices(io: Pick<TrainIo, "stateDir">, opts: { project?: string; pending?: boolean } = {}): Notices {
	const root = trainboardDir(io.stateDir), out: Notices = { source: "journal on disk", cars: [], truncated: false, unreadable: [] };
	let names: string[];
	try { names = opts.project !== undefined ? [opts.project] : readdirSync(root).filter(isName).sort(); } catch { return out; }
	let read = 0;
	for (const project of names) {
		try {
			if (!lstatSync(join(root, project)).isDirectory() || !carsFolderOk(io.stateDir, project)) continue;
		} catch { continue; }
		if (read >= MAX_NOTICE_CARS) { out.truncated = true; break; }
		const listing = listCars(io.stateDir, project, { max: Math.min(MAX_CAR_FILES, MAX_NOTICE_CARS - read) });
		read += listing.cars.length + listing.unreadable.length;
		if (listing.truncated) out.truncated = true;
		out.unreadable.push(...listing.unreadable.map((u) => ({ project, file: plain(u.file, 128), reason: plain(u.reason, 200) })));
		for (const { name, file, notice, noticeProblem } of listing.cars) {
			if (noticeProblem) out.unreadable.push({ project, file: plain(name.replace(/\.json$/, ".notice.json"), 128), reason: plain(noticeProblem, 200) });
			const states = file.states.map((entry): NoticeState => {
				const status = noticeStatus(notice, entry.state), record = notice?.states[entry.state];
				let text: string | undefined;
				try { text = plain(stateLine(file, entry), 600); } catch { text = undefined; }
				const told = noticeProblem ? undefined : record;
				return {
					state: entry.state, at: entry.at, by: { role: entry.by.role, name: plain(entry.by.name, 128), session: plain(entry.by.session, 128) }, ...(text ? { text } : {}), status: noticeProblem ? "unreadable" : status.kind,
					attempts: (told?.attempts ?? []).slice(0, 64).map((a: Attempt) => ({ at: plain(a.at, 40), outcome: plain(a.outcome, 20), ...(a.answer !== undefined ? { answer: plain(a.answer, 200) } : {}) })),
					towerAttempts: told?.tower?.length ?? 0, ...(told?.deliveredAt ? { deliveredAt: plain(told.deliveredAt, 40) } : {}), ...(told?.escalatedAt ? { escalatedAt: plain(told.escalatedAt, 40) } : {}),
				};
			}).filter((s) => !opts.pending || s.status === "pending" || s.status === "unreadable");
			if (!states.length) continue;
			if (out.cars.length >= MAX_NOTICE_CARS) { out.truncated = true; break; }
			out.cars.push({ project, app: file.app, tickets: file.car.tickets.map((t) => plain(t, 64)), branch: plain(file.car.branch, 255), head: file.car.head, coordinator: plain(file.coordinator, 128), states });
		}
	}
	return out;
}

function notices(flags: Record<string, string | true>, io: TrainIo): number {
	if (flags.project !== undefined && (typeof flags.project !== "string" || !isName(flags.project))) return usage(io, "--project needs a project name");
	const result = trainNotices(io, { ...(flags.project !== undefined ? { project: flags.project as string } : {}), pending: flags.pending === true });
	if (flags.json === true) return (io.out(`${JSON.stringify(result)}\n`), 0);
	const lines: string[] = ["from the journal on disk (<state>/trainboard/*/cars): what the server wrote, which a train could also have written; the server's own record is in its memory"];
	for (const c of result.cars) {
		lines.push(`${c.project} ${c.tickets.join(",")} ${c.app} ${c.head.slice(0, 12)} coordinator ${c.coordinator}`);
		for (const st of c.states) lines.push(`  ${st.state} ${st.at} by ${st.by.role} ${st.by.name}: ${st.status}${st.deliveredAt ? ` ${st.deliveredAt}` : ""}${st.escalatedAt ? ` ${st.escalatedAt}` : ""}, ${st.attempts.length} attempt${st.attempts.length === 1 ? "" : "s"}${st.attempts.length ? ` (${st.attempts.map((a) => a.outcome).join(", ")})` : ""}${st.text ? `\n    sent: ${st.text}` : ""}`);
	}
	if (lines.length === 1) lines.push(flags.pending === true ? "no pending notices" : "no car notices");
	if (result.truncated) lines.push("(more cars than shown)");
	for (const u of result.unreadable) lines.push(`unreadable: ${u.project}/${u.file}: ${u.reason}`);
	if (result.unreadable.length) lines.push(`(${result.unreadable.length} car or notice file${result.unreadable.length === 1 ? "" : "s"} unreadable)`);
	io.out(`${lines.join("\n")}\n`);
	return 0;
}
