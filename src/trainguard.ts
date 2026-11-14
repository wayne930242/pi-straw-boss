import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { availableParallelism, homedir, loadavg } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSyncExe } from "./exe.mjs";
import { startMs, writerAlive } from "./server/traingate.ts";
import { serverCli } from "./server/version.ts";
import { startOf } from "./startof.ts";
import { snapshotOfBranch } from "./todo.ts";
import { type Acceptance, acceptanceOf, checkAcceptRef, checkCar, checkEvidence, type EvidenceOptions, parseSlip, slipBlocks } from "./train/accept.ts";
import { checkContract, type Contract, type SkillCommand } from "./train/contract.ts";
import { type AppIntegration, carRepos, readAppIntegration } from "./train/appsconfig.ts";
import { type BoardRead, type BoardStep, boardPath, capBoard, type CarRow, factsOf, readBoard, readTrainboards, validateTrainTodo, type Writer, writeBoard, writeYard } from "./train/board.ts";
import { type CarView, coordinatorWord, forwardsFor, forwardsOf, noticeSatisfied, receivedTold, type TerminalState } from "./train/cars.ts";
import { fieldsOf } from "./headerfields.ts";
import { type Effect, isObject, type Json, shortCode, STEP_REQUIRED, todoEffects, validateStep } from "./train/spec.ts";
import { type FactStep, stepWaits, type TrainFacts, type Wait, waitMessage } from "./train/waits.ts";
import { type Acceptor, buildBoard, buildYard, freezeStep, type Row } from "./trainboard.ts";
import type { MainDuty } from "./mainduty.ts";
import type { Roles } from "./roles.ts";
import { ENTRY, type Kit } from "./state.ts";
import { TRAIN, type TrainId, trainFromToken, trainToken } from "./trainrole.ts";
import { integrationOff } from "./trainswitch.ts";

// The guard of the train's session (docs/specs/2026-11-07-train-workers.md §7, §21; todo #125 task 4): a `tool_call` handler on the session's own tools. In a train it handles every `todo` and `MonitorCreate` call; in the integrator, the `todo`
// calls that carry a `metadata.sb`. Policy reads `event.input`; state reads the session branch (the todo list) with the call applied to a copy. A blocked call leaves the list as it was and the model reads the reason.
//
// What the model can rewrite is exact (§21): the todo list and the step it describes, the files under `<state>/trainboard/`, and its session file on disk. What it cannot: this process's memory, the monitor's own record (what pi-loop-monitor says
// about a monitor it ran: its status, its exit code, its lines), git, and the clock. So a `run` step passes only on the monitor's record of a run of the spec as this guard froze it; the frozen spec's hash, the runs, and the time a step
// started live in this module's memory, are written nowhere the train can reach, and are gone with the process. A /reload therefore forgets them: a step that had run must run again, a report must be written after the step is set in_progress again.

const MIN_TIMEOUT_MS = 120_000, START_GRACE_MS = 60_000, MAX_RUNS = 200;
const NOT_INTEGRATOR = `sb: a train todo is the integrator's: call boss_duty with duty "integrator" first`;
const UNSETTLED = "sb: this session's train role is not settled yet: Straw Boss is still working out whether it is a train (Herdr has not answered). todo and MonitorCreate wait for it; try again in a moment";
const GENERIC = (code: string) => `sb: a train's monitor runs one step: describe it "train ${shortCode(code)} #<id> <kind>"`;

// ---- the frozen spec

const sorted = (value: unknown): unknown => (Array.isArray(value) ? value.map(sorted) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])])) : value);
/** The bytes the wrapper reads: the step's `metadata.sb` without its result, keys in order, so the same step is the same bytes whatever order the model wrote it in. Only for a value `validateStep` passed (it is nested at most 32 levels). */
export function frozenText(sb: Json): string {
	const { result: _result, ...step } = sb;
	return `${JSON.stringify(sorted(step))}\n`;
}
export const specHash = (sb: Json): string => createHash("sha256").update(frozenText(sb)).digest("hex");
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
/** The command a run step's monitor runs: the wrapper on the frozen file, each part quoted for the shell (a `'` in a folder name included). */
export const gateCommand = (node: string, cli: string, file: string) => `${quote(node)} ${quote(cli)} train gate --spec ${quote(file)}`;

// ---- the manifest (§5.3, §5.4)

const HANDOFF = /Straw Boss: the tower of workspace .*you are the train \S+ of project \S+/s, MARK = "Request, verbatim:\n";
const textOf = (entry: unknown): string => {
	const e = entry as { content?: unknown; message?: { content?: unknown } } | null;
	const content = e?.content ?? e?.message?.content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (isObject(b) && typeof b.text === "string" ? b.text : "")).join("\n") : "";
};
export interface ManifestCar { ticket: string; slip: string; row?: CarRow; head?: string; evidence?: string }
export interface LeftOut { ticket: string; head: string; word: string }
export interface Manifest { app?: string; cars: ManifestCar[]; leftOut: LeftOut[] }

/** The manifest the tower handed the train: what follows `Request, verbatim:` in the first message that is the train's handoff. A later message that looks alike is none. */
export function manifestText(entries: readonly unknown[]): string | undefined {
	for (const entry of entries) {
		const text = textOf(entry), at = text.indexOf(MARK);
		if (at >= 0 && HANDOFF.test(text.slice(0, at))) return text.slice(at + MARK.length);
	}
	return undefined;
}

export { slipBlocks };

/** What the manifest check needs besides the text: the app's `integration` from apps.json, and the files and git of the train's own folder. */
export interface ManifestCheck { config(app: string | undefined): AppIntegration; exists(path: string): boolean; /** `app` is the manifest's: git is asked in that app's own repository when it is one (a submodule). */ isAncestor(older: string, newer: string, app?: string): boolean }
/** The refusals of a slip against what its app requires (TB-F001): the kinds the evidence lacks, `accept: none` where something is required, and an evidence file that did not read. */
const OWED = /^sb: (acceptance evidence lacks |accept: none is allowed only |accept: .* names an evidence file, but it was not read)/;

export function parseManifest(text: string, read: (path: string) => string | undefined, check: ManifestCheck): Manifest {
	const { header, blocks } = slipBlocks(text), cars: ManifestCar[] = [], leftOut: LeftOut[] = [];
	const app = /^\s*app:\s*([A-Za-z0-9._-]{1,64})\s*$/m.exec(header)?.[1], config = check.config(app), appAccept = config.ok ? config.accept : [];
	for (const slip of blocks) {
		const parsed = parseSlip(slip), ticket = parsed.tickets[0] ?? parsed.fields.branch ?? "unknown", accept = parsed.fields.accept;
		const evidence = accept && /\.json$/i.test(accept) ? read(accept) : undefined;
		const refusals = checkCar(slip, evidence, { appAccept, exists: () => true, isAncestor: () => false });
		// A car that asks the train for acceptance, or shows less than its app requires (or whose app's requirement cannot be read), is left out: the train runs none and the car goes back to its coordinator.
		const asked = refusals.find((r) => r.startsWith("sb: the train runs no acceptance: "));
		const owed = config.ok ? (appAccept.length ? refusals.find((r) => OWED.test(r)) : undefined) : config.refusal;
		const word = asked ?? (owed ? `sb: car ${ticket}: ${owed.replace(/^sb: /, "")}` : undefined);
		const head = /^[0-9a-f]{40}$/.test(parsed.fields.head ?? "") ? parsed.fields.head! : undefined;
		const shown: Acceptance = config.ok ? acceptanceOf(accept ?? "none", evidence, { appAccept, ...(head ? { head } : {}), exists: check.exists, isAncestor: (older, newer) => check.isAncestor(older, newer, app) }) : { unverified: true };
		const f = parsed.fields, row: CarRow = { tickets: parsed.tickets, branch: f.branch ?? "", head: head ?? "", coordinator: f.coordinator ?? "", departs: f.departs ?? "next", accept: accept ?? "none", ...shown };
		cars.push({ ticket, slip, ...(head ? { head } : {}), ...(evidence ? { evidence } : {}), ...(row.tickets.length && row.branch && row.head && row.coordinator ? { row } : {}) });
		if (word) leftOut.push({ ticket, head: head ?? "", word });
	}
	return { ...(app ? { app } : {}), cars, leftOut };
}

// ---- the runs of the session's monitors (§7.2, §21)

export type RunState = "starting" | "running" | "passed" | "failed" | "stopped" | "refused" | "stale" | "unverified" | "ran another spec";
interface Run {
	step: number; frozen: string; command: string; description: string; call: string; at: number; state: RunState; monitor?: string;
	/** The first wrapper line the stream showed: the file it read (`spec`) and its nonce (`run`). It is printed before the command exists. */
	first?: { spec: string; run: string }; conflict?: true;
	/** The last line the stream showed, if it was a wrapper line. */
	last?: { run: string; spec: string; step: unknown; train: unknown; outcome?: string };
}

/** Starts, lines and ends of the monitors a train created, from pi-loop-monitor's events: what the monitor says of itself, not what any file says. */
export class RunBook {
	readonly runs: Run[] = [];
	private readonly now: () => number;
	constructor(now: () => number) {
		this.now = now;
	}
	begin(run: Omit<Run, "state" | "at">) {
		this.runs.push({ ...run, state: "starting", at: this.now() });
		while (this.runs.length > MAX_RUNS) this.runs.shift();
	}
	/** The run of this step that is starting or running; a start that never came is forgotten after a minute. */
	active(step: number): Run | undefined {
		return this.runs.find((r) => r.step === step && (r.state === "running" || (r.state === "starting" && this.now() - r.at < START_GRACE_MS)));
	}
	failedToStart(call: string) {
		const at = this.runs.findIndex((r) => r.call === call && r.state === "starting");
		if (at >= 0) this.runs.splice(at, 1);
	}
	started(d: Json) {
		const run = this.runs.find((r) => r.state === "starting" && r.command === d.command && r.description === d.description && typeof d.monitorId === "string");
		if (run) [run.state, run.monitor] = ["running", d.monitorId as string];
	}
	private of(d: Json) {
		return typeof d.monitorId === "string" ? this.runs.find((r) => r.monitor === d.monitorId && r.state === "running") : undefined;
	}
	output(d: Json) {
		const run = this.of(d);
		if (!run) return;
		let line: unknown;
		try { line = typeof d.line === "string" && d.line.length <= 4000 ? JSON.parse(d.line) : undefined; } catch { line = undefined; }
		const sb = isObject(line) && isObject(line.sb) ? line.sb : undefined;
		if (!sb || typeof sb.spec !== "string" || typeof sb.run !== "string") return void (run.last = undefined);
		if (!run.first) run.first = { spec: sb.spec, run: sb.run };
		else if (run.first.spec !== sb.spec || run.first.run !== sb.run) run.conflict = true;
		const outcome = isObject((line as Json).monitorOutcome) ? ((line as Json).monitorOutcome as Json).status : undefined;
		run.last = { run: sb.run, spec: sb.spec, step: sb.step, train: sb.train, ...(typeof outcome === "string" ? { outcome } : {}) };
	}
	/** The end, by the monitor's own record: a pass is exit 0 of a run that said `passed` in its last line, with the nonce and the file of its first. */
	finished(d: Json, code: string) {
		const run = this.of(d);
		if (!run) return;
		const reported = isObject(d.reportedOutcome) && typeof d.reportedOutcome.status === "string" ? d.reportedOutcome.status : undefined;
		const word = (s: string | undefined): RunState => (s === "stopped" || s === "refused" ? s : "failed");
		if (d.status === "stopped") run.state = d.reason === "timeout" ? "stale" : "stopped";
		else if (d.status !== "completed" || d.exitCode !== 0) run.state = word(run.last?.outcome ?? reported);
		else if (!run.first || run.last?.outcome !== "passed" || run.last.run !== run.first.run || run.last.spec !== run.first.spec || run.last.step !== run.step || run.last.train !== code || (reported !== undefined && reported !== "passed")) run.state = run.first ? "ran another spec" : "unverified";
		else run.state = run.first.spec === run.frozen && !run.conflict ? "passed" : "ran another spec";
		if (run.state === "ran another spec" && run.last && !run.last.outcome) run.state = "unverified";
	}
	/** Whether a run of this step passed for exactly this spec (`hash`). */
	passed(step: number, hash: string): boolean {
		return this.runs.some((r) => r.step === step && r.state === "passed" && r.frozen === hash);
	}
	/** What to say of the step's last run when none passed. */
	last(step: number, hash: string): string {
		const mine = this.runs.filter((r) => r.step === step);
		const run = mine.at(-1);
		if (!run) return "none";
		return run.state === "passed" && run.frozen !== hash ? "passed for another spec" : run.state;
	}
}

// ---- the guard

export interface GuardPi {
	on(event: string, handler: (event: Json, ctx: Ctx) => unknown): void;
	events?: { on(channel: string, handler: (data: unknown) => void): unknown };
}
export interface Ctx { cwd?: string; sessionManager: { getBranch(): readonly unknown[] } }
export interface GuardEnv {
	stateDir: string;
	/** This session's train, when it is one. */
	train(): TrainId | undefined;
	/** Whether this session is a main (the integrator is one). */
	isMain(): boolean;
	/** The main's kind as it runs now (mainduty.ts `now()`): only `integrator` holds `train` todos and writes the yard. */
	duty(): string;
	/** Whether a local sign says this session is a train whose role is not settled yet (§22): the guard refuses `todo` and `MonitorCreate` meanwhile. Left out, a session is never pending. */
	pending?(): boolean;
	session(): { id: string; pane?: string };
	now(): number;
	node: string; cli: string; home: string;
	tell(text: string, level?: "info" | "warning" | "error"): void;
	/** Seams: git, the load, the age of a board's writer, this process's start (tests replace them). */
	git?(cwd: string, args: string[]): string;
	load?(): { now: number; cores: number } | undefined;
	alive?(writer: Writer): boolean;
	pid?: number;
	/** The sb server's book of cars (§5.5): the one place a car's state and the delivery of its notice are read. The guard never reads the car files on disk, which the train's shell can write. Left out, a check that needs a notice is refused. */
	cars?: CarSource;
	/** Whether the `integrating` and `deploying` skills pi loaded declare the merge-train contract the train's prompts assume (train/contract.ts, TB-F008): a train's and the integrator's mutating calls are refused with its reason when they do not. Left out, nothing is checked. */
	contract?(): Contract;
}
/** The sb server's answer about the cars of a project, over its socket. */
export interface CarSource { read(project: string): Promise<CarView[]> }
type Block = { block: true; reason: string } | undefined;
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_EXEC_PATH"];
const realGit = (cwd: string, args: string[]): string => {
	const env = { ...process.env };
	for (const key of GIT_ENV) delete env[key];
	return String(execFileSyncExe("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], env })).trim();
};
const shortError = (error: unknown) => String((error as { stderr?: unknown }).stderr || (error as Error).message).trim().split("\n")[0]!.slice(0, 200);
const STATUS = ["pending", "in_progress", "completed"];
const sbOf = (row: Row | undefined): Json | undefined => (row && isObject(row.metadata?.sb) ? (row.metadata!.sb as Json) : undefined);
const isStep = (row: Row) => sbOf(row) !== undefined;
/** The tickets an assemble step removes (`spec.removed[].ticket`). */
const removedTickets = (sb: Json): string[] => (isObject(sb.spec) && Array.isArray(sb.spec.removed) ? (sb.spec.removed as Json[]).flatMap((r) => (isObject(r) && typeof r.ticket === "string" ? [r.ticket] : [])) : []);
/** Whether the list holds a round-1 assemble, other than step `self`, that removes this ticket. */
const opened = (shadow: Map<number, Row>, self: number, ticket: string): boolean =>
	[...shadow.values()].some((r) => {
		const s = sbOf(r);
		return r.id !== self && s?.kind === "assemble" && s.round === 1 && isObject(s.spec) && Array.isArray(s.spec.removed) && (s.spec.removed as Json[]).some((x) => x.ticket === ticket);
	});

export function rowsOfSnapshot(snapshot: unknown): { rows: Row[]; nextId: number } {
	const s = isObject(snapshot) ? snapshot : {}, tasks = Array.isArray(s.tasks) ? s.tasks : [];
	const rows = tasks.flatMap((t): Row[] => (isObject(t) && Number.isInteger(t.id) && STATUS.includes(t.status as string) ? [{ id: t.id as number, status: t.status as string, ...(isObject(t.metadata) ? { metadata: t.metadata } : {}) }] : []));
	return { rows, nextId: Number.isInteger(s.nextId) ? (s.nextId as number) : Math.max(0, ...rows.map((r) => r.id)) + 1 };
}

export function createTrainGuard(pi: GuardPi, env: GuardEnv) {
	const book = new RunBook(env.now), git = env.git ?? realGit;
	const starts = new Map<number, number>(); // the time this guard saw each step go in_progress
	let manifest: Manifest | undefined;
	const toldBoard = new Set<string>();
	const created = new Date(env.now()).toISOString();

	const expand = (path: string, ctx: Ctx) => (path === "~" ? env.home : path.startsWith("~/") ? join(env.home, path.slice(2)) : isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path));
	const readText = (ctx: Ctx) => (path: string): string | undefined => {
		try {
			const file = expand(path, ctx), stat = lstatSync(file);
			return stat.isFile() && stat.size <= 32 * 1024 ? readFileSync(file, "utf8") : undefined;
		} catch { return undefined; }
	};
	const manifestOf = (ctx: Ctx): Manifest | undefined => {
		if (manifest) return manifest;
		const text = manifestText(ctx.sessionManager.getBranch());
		return text === undefined ? undefined : (manifest = parseManifest(text, readText(ctx), manifestCheck(ctx)));
	};
	const appsDir = (ctx: Ctx) => ctx.cwd ?? process.cwd();
	const isAncestorIn = (ctx: Ctx, app: string | undefined) => (older: string, newer: string): boolean => carRepos(appsDir(ctx), app).some((dir) => { try { git(dir, ["--no-replace-objects", "merge-base", "--is-ancestor", older, newer]); return true; } catch { return false; } }); // replace refs off (GIT_NO_REPLACE_OBJECTS; RD0801-F002): a graft in the repository asked makes no commit an ancestor
	const manifestCheck = (ctx: Ctx): ManifestCheck => ({ config: (app) => (app ? readAppIntegration(appsDir(ctx), app) : { ok: false, refusal: "sb: the manifest names no app, so integration.accept of the app is unknown" }), exists: (path) => existsSync(expand(path, ctx)), isAncestor: (older, newer, app) => isAncestorIn(ctx, app)(older, newer) });
	const writer = (): Writer => {
		const pid = env.pid ?? process.pid, said = startOf(pid), at = said ? startMs(said) : Number.NaN;
		return { session: env.session().id, ...(env.session().pane ? { pane: env.session().pane } : {}), pid, started: Number.isNaN(at) ? created : new Date(at).toISOString() };
	};
	const alive = env.alive ?? ((w: Writer) => writerAlive(w));
	// The skills pi loaded change only when the boss updates them and reloads: read at most once a minute, and again on every call while they are refused.
	let contractSeen: { at: number; got: Contract } | undefined;
	const contractNow = (): Contract | undefined => {
		if (env.contract && (!contractSeen || env.now() - contractSeen.at > 60_000 || !contractSeen.got.ok)) contractSeen = { at: env.now(), got: env.contract() };
		return contractSeen?.got;
	};

	/** Every board of the project as the waits read them; a read that is cut or cannot list holds everything, which is a refusal here. */
	function others(project: string): { trains: TrainFacts[] } | { error: string } {
		const read = readTrainboards(env.stateDir, { project, max: 4096 });
		if (read.truncated) return { error: `more than 4096 trainboards of project ${project}, so what is held cannot be known` };
		if (read.unlisted.length) return { error: `what trains of project ${project} hold cannot be known: ${read.unlisted.join("; ")}` };
		return { trains: read.trains.map((b: BoardRead) => factsOf(b, { now: env.now(), alive })) };
	}
	const factStep = (id: number, sb: Json): FactStep => {
		const spec = isObject(sb.spec) ? sb.spec : {};
		return { id, kind: String(sb.kind), status: "in_progress", round: Number(sb.round), ...(isObject(spec.holds) ? { holds: spec.holds } : {}), ...(isObject(spec.load) ? { load: spec.load } : {}), ...(typeof spec.lock === "string" ? { lock: spec.lock } : {}) };
	};

	// ---- completion evidence, by check type (§6.3)

	function gitRefusals(check: Json, result: Json, ctx: Ctx): string[] {
		const cwd = expand(String(check.cwd), ctx), ref = typeof check.ref === "string" ? check.ref : "HEAD";
		if (ref.startsWith("-")) return ["git check: a ref does not begin with -"];
		let actual: string;
		try { actual = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); } catch (error) { return [`git check: git failed in ${cwd}: ${shortError(error)}`]; }
		if (actual !== result.head) return [`git check: ${ref} of ${cwd} is ${actual}, not result.head ${String(result.head).slice(0, 12)}`];
		return (check.contains as string[]).flatMap((sha) => {
			try { git(cwd, ["merge-base", "--is-ancestor", sha, actual]); return []; } catch { return [`git check: ${sha.slice(0, 12)} is not an ancestor of ${ref}`]; }
		});
	}
	function reportRefusals(id: number, check: Json, ctx: Ctx): string[] {
		const file = expand(String(check.path), ctx), began = starts.get(id);
		let stat;
		try { stat = statSync(file); } catch { return [`report ${file} does not exist`]; }
		if (!stat.isFile() || stat.size === 0) return [`report ${file} is empty`];
		if (began === undefined) return ["report check: the step was never seen in_progress by this session; set it in_progress before it completes"];
		return stat.mtimeMs > began ? [] : [`report ${file} was not changed since the step went in_progress (${new Date(began).toISOString()})`];
	}
	function passRefusals(id: number, sb: Json, ctx: Ctx, views: CarView[] | undefined): string[] {
		const spec = sb.spec as Json, check = spec.check as Json;
		const told = (tickets: string[], state: TerminalState | TerminalState[]) => noticeSatisfied(views ?? [], tickets, state, { app: String(sb.app) }).map((r) => r.replace(/^sb: /, `sb: step #${id}: `));
		const own = ((): string[] => {
			switch (check.type) {
				case "run": return book.passed(id, specHash(sb)) ? [] : [`sb: step #${id} has no passed run of its spec (last: ${book.last(id, specHash(sb))})`];
				case "git": return gitRefusals(check, sb.result as Json, ctx).map((r) => `sb: step #${id}: ${r}`);
				case "report": return reportRefusals(id, check, ctx).map((r) => `sb: step #${id}: ${r}`);
				default: return told(check.cars as string[], check.state as TerminalState);
			}
		})();
		// An assemble that removes cars passes only when sb has told each car's coordinator that it is dropped or returned (§5.5), whatever its own check is: the check alone is not enough (SB4-F003).
		const removed = sb.kind === "assemble" ? removedTickets(sb) : [];
		return [...own, ...(removed.length ? told(removed, ["dropped", "returned"]) : [])];
	}

	// ---- todo calls

	const startedWord = (id: number, status: string) => `sb: step #${id} is ${status}; a started step is never deleted: complete it as void (why: skipped or superseded)`;

	/** The server's cars of a project, or the refusal in words: a guard that cannot ask the server does not let a notice-dependent step through. */
	async function fetchViews(project: string): Promise<CarView[] | string> {
		if (!env.cars) return "sb: this guard has no link to the sb server, so it cannot read the car notices a step waits for";
		try { return await env.cars.read(project); } catch (error) { return `sb: the sb server did not answer for the cars of project ${project} (${(error as Error).message}); try again`; }
	}
	/** Whether a step this call completes as passed rests on a notice: a `notice` check, or an assemble that removes cars. */
	const needsCars = (effect: Effect): boolean => {
		const sb = effect.metadata?.sb;
		if (effect.status !== "completed" || !isObject(sb) || !isObject(sb.result) || sb.result.outcome !== "passed" || !isObject(sb.spec) || !isObject(sb.spec.check)) return false;
		return sb.spec.check.type === "notice" || (sb.kind === "assemble" && removedTickets(sb).length > 0);
	};

	async function trainTodo(input: Json, ctx: Ctx, me: TrainId): Promise<string[]> {
		const entries = ctx.sessionManager.getBranch(), { rows, nextId } = rowsOfSnapshot(snapshotOfBranch(entries));
		if (input.action === "clear") {
			const started = rows.find((r) => isStep(r) && r.status !== "pending");
			return started ? [startedWord(started.id, started.status)] : [];
		}
		if (input.action === "delete") {
			const row = typeof input.id === "number" ? rows.find((r) => r.id === input.id) : undefined;
			return row && isStep(row) && row.status !== "pending" ? [startedWord(row.id, row.status)] : [];
		}
		if (input.action !== "create" && input.action !== "update") return [];
		const effects = todoEffects(input, rows, nextId), batch = input.action === "create" && Array.isArray(input.tasks);
		const shadow = new Map(rows.map((r) => [r.id, r])), begun: number[] = [], info = manifestOf(ctx);
		let views: CarView[] | undefined;
		if (effects.some(needsCars)) {
			const got = await fetchViews(me.project);
			if (typeof got === "string") return [got];
			views = got;
		}
		for (const effect of effects) {
			const out = step(effect, shadow, me, info, ctx, views);
			if (out.length) return batch ? out.map((r) => r.replace(/^sb: /, `sb: tasks[${effect.item}]: `)) : out;
			if (effect.status === "deleted") shadow.delete(effect.id);
			else shadow.set(effect.id, { id: effect.id, status: effect.status, ...(effect.metadata ? { metadata: effect.metadata } : {}) });
			if (effect.status === "in_progress" && shadow.get(effect.id)) begun.push(effect.id);
		}
		for (const id of begun) if (rows.find((r) => r.id === id)?.status !== "in_progress" || !starts.has(id)) starts.set(id, env.now());
		return [];
	}

	/** The refusals of one todo a call creates or changes, against the list as the call's earlier todos left it. */
	function step(effect: Effect, shadow: Map<number, Row>, me: TrainId, info: Manifest | undefined, ctx: Ctx, views: CarView[] | undefined): string[] {
		const before = shadow.get(effect.id);
		if (effect.status === "deleted") return before && isStep(before) && before.status !== "pending" ? [startedWord(effect.id, before.status)] : [];
		const sb = effect.metadata?.sb;
		if (sb === undefined) return [STEP_REQUIRED];
		const steps = [...shadow.values()].flatMap((r) => { const s = sbOf(r); return s && Number.isInteger(s.round) ? [{ id: r.id, status: r.status, round: s.round as number, app: s.app }] : []; });
		const current = steps.reduce((top, s) => Math.max(top, s.round), 0);
		const prev = sbOf(before), asked = isObject(sb) ? sb : {};
		let round = Math.max(current, 1);
		if (!effect.created && prev && Number.isInteger(prev.round)) round = prev.round as number;
		else if (current >= 1 && asked.round === current + 1) {
			if (asked.kind !== "assemble") return [`sb: a new round starts with an assemble step: step #${effect.id} names round ${String(asked.round)}, and this train is in round ${current}`];
			const open = steps.filter((s) => s.round <= current && s.status !== "completed").sort((a, b) => a.id - b.id)[0];
			if (open) return [`sb: round ${current} still has step #${open.id} ${open.status}; complete it (void) first`];
			round = current + 1;
		}
		const app = steps.find((s) => typeof s.app === "string")?.app ?? info?.app ?? (typeof asked.app === "string" ? asked.app : "unknown");
		const refusals = validateStep(sb, { status: effect.status, id: effect.id, expect: { project: me.project, app: String(app), train: me.code, round } });
		if (refusals.length) return refusals.map((r) => (/result|completed needs/.test(r) && !r.includes("step #") ? r.replace(/^sb: /, `sb: step #${effect.id}: `) : r));
		const spec = asked.spec as Json, check = spec.check as Json;
		// A manifest car that asks for acceptance is left out of round 1, and no step carries it (D13, §5.4).
		for (const out of info?.leftOut ?? []) {
			const removed = Array.isArray(spec.removed) ? (spec.removed as Json[]).some((r) => r.ticket === out.ticket) : false;
			if (asked.kind === "assemble" && asked.round === 1 && !removed) return [`${out.word} Put ${out.ticket} in this assemble's spec.removed and set it returned with train_car; no step carries it.`];
			// Round 1 starts with an assemble that removes the car; a step of round 1 before one would run the round without the removal (SB4-F002).
			if (round === 1 && asked.kind !== "assemble" && !opened(shadow, effect.id, out.ticket)) return [`sb: round 1 starts with an assemble: car ${out.ticket} was left out of round 1 (it asks the train for acceptance). Create the round's assemble with ${out.ticket} in spec.removed first.`];
			const carried = (Array.isArray(spec.cars) && spec.cars.includes(out.ticket)) || (check.type === "notice" && (check.cars as string[]).includes(out.ticket)) || (check.type === "git" && out.head !== "" && (check.contains as string[]).includes(out.head));
			if (carried) return [`sb: car ${out.ticket} was left out of round 1: it asks the train for acceptance; no step carries it`];
		}
		if (effect.status === "in_progress" && before?.status !== "in_progress" && check.type !== "run" && isObject(spec.holds)) {
			const read = others(me.project);
			if ("error" in read) return [`sb: step #${effect.id} cannot start: ${read.error}`];
			const own: TrainFacts = { project: me.project, code: me.code, state: "live", steps: [factStep(effect.id, asked)] };
			const waits = stepWaits(own, own.steps[0]!, { trains: [own, ...read.trains.filter((t) => t.code !== me.code)] });
			if (waits.length) return [`sb: step #${effect.id} ${waitMessage(waits)}; start it when it is free`];
		}
		const result = asked.result;
		// A round opens with its assemble, and its other steps wait until that assemble has passed: an assemble that exists but cannot pass yet (a removed car's notice is still pending) holds the round (SB4-F003). A void completion is always allowed, and an assemble that is itself void (skipped) does not hold its round.
		if (asked.kind !== "assemble" && (effect.status === "in_progress" || (effect.status === "completed" && isObject(result) && result.outcome !== "void"))) {
			const assembles = [...shadow.values()].flatMap((r) => { const s = sbOf(r); return r.id !== effect.id && s?.kind === "assemble" && s.round === round ? [{ id: r.id, passed: r.status === "completed" && isObject(s.result) && (s.result.outcome === "passed" || s.result.outcome === "void") }] : []; });
			if (assembles.length && !assembles.some((a) => a.passed)) return [`sb: step #${effect.id} waits for round ${round}'s assemble #${assembles[0]!.id} to pass`];
		}
		if (effect.status === "completed" && isObject(result) && result.outcome === "passed") return passRefusals(effect.id, asked, ctx, views);
		return [];
	}

	// ---- the integrator's `train` todo (§7.4)

	async function integratorTodo(input: Json, ctx: Ctx): Promise<string[]> {
		if (input.action !== "create" && input.action !== "update") return [];
		const entries = ctx.sessionManager.getBranch(), { rows, nextId } = rowsOfSnapshot(snapshotOfBranch(entries));
		const project = rows.map(sbOf).find((s) => s?.kind === "train")?.project;
		const batch = input.action === "create" && Array.isArray(input.tasks);
		let views: CarView[] | undefined;
		for (const effect of todoEffects(input, rows, nextId)) {
			const sb = effect.metadata?.sb;
			if (sb === undefined || effect.status === "deleted") continue;
			const refusals = validateTrainTodo(sb, { status: effect.status, id: effect.id, ...(typeof project === "string" ? { project } : {}) });
			if (!refusals.length && isObject(sb) && isObject(sb.spec)) {
				// What the app requires is read from its apps.json here and in the train's manifest check, never from a flag a model passes (TB-F001); a file that cannot be read refuses (TB-F002 too: stages that list uat).
				const cars = (sb.spec.cars as CarRow[]) ?? [], config = readAppIntegration(appsDir(ctx), String(sb.app));
				refusals.push(...(config.ok ? [...claimedRefusals(cars), ...evidenceRefusals(cars, ctx, String(sb.app), config.accept)] : [config.refusal]));
			}
			// The manifest goes to the tower only when every car is received, its slip came from the coordinator the tower's forward names, and sb has told that coordinator (§5.5, §7.4).
			if (!refusals.length && effect.status === "in_progress" && rows.find((r) => r.id === effect.id)?.status !== "in_progress" && isObject(sb) && isObject(sb.spec)) {
				const got = views ?? (typeof sb.project === "string" ? await fetchViews(sb.project) : "sb: the train todo names no project");
				if (typeof got === "string") refusals.push(got);
				else {
					views = got;
					refusals.push(...receiptRefusals((sb.spec.cars as CarRow[]) ?? [], String(sb.app), got, forwardsOf(entries, fieldsOf)));
				}
			}
			if (refusals.length) return batch ? refusals.map((r) => r.replace(/^sb: /, `sb: tasks[${effect.item}]: `)) : refusals;
		}
		return [];
	}
	/** For each car of a manifest: the slip's `coordinator` is the session a tower's forward on this branch names as its sender, and the car's `received` notice is told or escalated. */
	function receiptRefusals(cars: readonly CarRow[], app: string, views: CarView[], forwards: ReturnType<typeof forwardsOf>): string[] {
		return cars.flatMap((car) => {
			const ticket = car.tickets[0] ?? "?", sent = forwardsFor(forwards, car.head);
			const own = sent.length === 0 ? [`sb: car ${ticket} has no forward by the tower on this branch: a car slip reaches the integrator as the tower's forward, whose header names its sender (fwd-from)`]
				: sent.some((f) => f.from === car.coordinator) ? [] : [coordinatorWord(ticket, car.coordinator, sent.at(-1)!.from)];
			return [...own, ...receivedTold(views, { app, head: car.head, ticket })];
		});
	}
	/** A car's acceptance is what the checked evidence shows; the yard states it from there (TB-F003), so a todo that carries a word of its own about it is refused. */
	const claimedRefusals = (cars: readonly CarRow[]): string[] => cars.flatMap((car) => (car.accepted !== undefined || car.unverified !== undefined ? [`sb: car ${car.tickets[0]}: accepted is set by Straw Boss from the checked evidence; leave accepted and unverified out of the car`] : []));
	/** `train check --accept` on each car's evidence, with the kinds the app requires: the evidence is complete for what the file says and for what the app asks, names the car's head, and asks the train for nothing (§5.2, §5.4). */
	function evidenceRefusals(cars: readonly CarRow[], ctx: Ctx, app: string, appAccept: readonly string[]): string[] {
		const out: string[] = [], read = readText(ctx);
		for (const car of cars) {
			if (car.accept.trim().toLowerCase() === "none") { out.push(...checkAcceptRef("none", appAccept).map((r) => `sb: car ${car.tickets[0]}: ${r.replace(/^sb: /, "")}`)); continue; }
			const text = read(car.accept);
			if (text === undefined) { out.push(`sb: car ${car.tickets[0]}: cannot read the evidence file ${car.accept}`); continue; }
			const options: EvidenceOptions = { appAccept, head: car.head, exists: (path) => existsSync(expand(path, ctx)), isAncestor: isAncestorIn(ctx, app) };
			out.push(...checkEvidence(text, options));
		}
		return out;
	}
	/** The acceptance of the integrator's cars as the code reads it now (TB-F003): the app's requirement from apps.json and the evidence file through the reader the check above used; what cannot be read claims nothing. */
	function acceptorOf(ctx: Ctx): Acceptor {
		const read = readText(ctx), configs = new Map<string, AppIntegration>();
		return (car, app) => {
			if (!configs.has(app)) configs.set(app, readAppIntegration(appsDir(ctx), app));
			const config = configs.get(app)!;
			if (!config.ok) return { unverified: true };
			return acceptanceOf(car.accept, car.accept.trim().toLowerCase() === "none" ? undefined : read(car.accept), { appAccept: config.accept, head: car.head, exists: (path) => existsSync(expand(path, ctx)), isAncestor: isAncestorIn(ctx, app) });
		};
	}

	// ---- monitor calls

	function monitorCall(event: Json, input: Json, ctx: Ctx, me: TrainId): string | undefined {
		if (input.herdrPaneId !== undefined) return "sb: a train's monitor runs a step's command; herdrPaneId is refused";
		const generic = GENERIC(me.code), found = /^train (\S+) #(\d+) (\S+)$/.exec(typeof input.description === "string" ? input.description.trim() : "");
		if (!found || (found[1] !== shortCode(me.code) && found[1] !== me.code) || typeof input.command !== "string") return generic;
		const id = Number(found[2]), { rows } = rowsOfSnapshot(snapshotOfBranch(ctx.sessionManager.getBranch())), row = rows.find((r) => r.id === id), sb = sbOf(row);
		if (!row || !sb || sb.kind !== found[3]) return generic;
		if (row.status !== "in_progress") return `sb: step #${id} is ${row.status}; a monitor starts only for an in_progress step`;
		const round = rows.flatMap((r) => { const s = sbOf(r); return s && Number.isInteger(s.round) ? [s.round as number] : []; }).reduce((top, r) => Math.max(top, r), 1);
		const app = typeof sb.app === "string" ? sb.app : "unknown";
		const refusals = validateStep(sb, { status: "in_progress", id, expect: { project: me.project, app, train: me.code, round } });
		if (refusals.length) return refusals[0];
		const check = (sb.spec as Json).check as Json;
		if (check.type !== "run") return `sb: step #${id} is a ${String(check.type)} check; a monitor runs a run check`;
		if (input.command !== check.run) return `sb: step #${id} runs ${JSON.stringify(check.run)}, not this command`;
		const running = book.active(id);
		if (running) return `sb: step #${id} already has a running monitor (#${running.monitor ?? "starting"})`;
		const text = frozenText(sb);
		let file: string;
		try { file = freezeStep(env.stateDir, me.project, me.code, id, text); } catch (error) { return `sb: step #${id} cannot be frozen: ${(error as Error).message}`; }
		// Rewritten in place (spike (b)): pi hands this same object to the tool, with no new validation, so the types stay and `description` is left alone.
		input.command = gateCommand(env.node, env.cli, file);
		input.timeout = Math.max(MIN_TIMEOUT_MS, typeof input.timeout === "number" && Number.isFinite(input.timeout) ? input.timeout : 0);
		book.begin({ step: id, frozen: createHash("sha256").update(text).digest("hex"), command: input.command as string, description: String(input.description), call: String(event.toolCallId) });
		return undefined;
	}

	// ---- the files

	/** The board of this train, or the yard of this integrator, from the todo list after a call; a failure to write is told once and never fails the call. */
	function publish(rows: Row[], ctx: Ctx) {
		const me = env.train();
		try {
			if (me) {
				const info = manifestOf(ctx), steps = rows.flatMap((r) => { const s = sbOf(r); return s ? [s] : []; });
				const app = String(steps.find((s) => typeof s.app === "string")?.app ?? info?.app ?? "unknown");
				const removed = new Set(steps.flatMap((s) => (isObject(s.spec) && Array.isArray(s.spec.removed) ? (s.spec.removed as Json[]).map((r) => String(r.ticket)) : [])));
				const left = new Set(info?.leftOut.map((l) => l.ticket));
				const cars = (info?.cars ?? []).flatMap((c) => (c.row && !removed.has(c.ticket) && !left.has(c.ticket) ? [c.row] : []));
				const file = boardPath(env.stateDir, me.project, me.code), existing = readBoard(file);
				const read = others(me.project), load = env.load ? env.load() : { now: loadavg()[0]!, cores: availableParallelism() };
				const waits = (s: BoardStep): Wait[] => {
					if ("error" in read) return [];
					const own: TrainFacts = { project: me.project, code: me.code, state: "live", steps: [] };
					const fact: FactStep = { id: s.id, kind: s.kind, status: "in_progress", round: s.round, ...(s.holds ? { holds: s.holds } : {}), ...(s.load ? { load: s.load } : {}), ...(s.lock ? { lock: s.lock } : {}) };
					const w = stepWaits(own, fact, { trains: read.trains.filter((t) => t.code !== me.code), ...(load && s.load ? { load } : {}) });
					return w.filter((x) => !("lock" in x));
				};
				const heads = new Map((info?.cars ?? []).flatMap((c) => (c.head ? [[c.ticket, c.head] as const] : []))), board = buildBoard({ project: me.project, code: me.code, app, rows, cars, heads, writer: writer(), now: env.now(), ...(existing.ok && existing.board.clears ? { clears: existing.board.clears } : {}), waits: (s) => waits(s) });
				writeBoard(env.stateDir, capBoard(board));
			} else if (env.isMain() && env.duty() === "integrator") {
				const project = rows.map(sbOf).find((s) => s?.kind === "train")?.project;
				if (typeof project === "string") writeYard(env.stateDir, buildYard({ project, rows, writer: writer(), now: env.now(), acceptance: acceptorOf(ctx) }));
			}
		} catch (error) {
			const text = `Straw Boss: the trainboard could not be written (${(error as Error).message}); the train goes on, and other trains cannot see it`;
			if (!toldBoard.has(text)) (toldBoard.add(text), env.tell(text, "warning"));
		}
	}

	// ---- pi

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input;
		if (!isObject(input) || (event.toolName !== "todo" && event.toolName !== "MonitorCreate")) return undefined;
		const me = env.train();
		let reasons: string[] = [];
		try {
			if (!me && env.pending?.()) reasons = [UNSETTLED];
			else if (me) reasons = event.toolName === "todo" ? await trainTodo(input, ctx, me) : [monitorCall(event, input, ctx, me)].flatMap((r) => (r ? [r] : []));
			else if (event.toolName === "todo" && env.isMain() && (hasSb(input) || changesTrainTodo(input, ctx))) reasons = env.duty() === "integrator" ? await integratorTodo(input, ctx) : [NOT_INTEGRATOR];
			// The skills the prompts follow must be the ones they assume; a call that changes nothing (a todo read) is let through.
			const mutates = event.toolName === "MonitorCreate" || input.action === "create" || input.action === "update" || input.action === "delete" || input.action === "clear";
			if (!reasons.length && mutates && (me || (event.toolName === "todo" && env.isMain() && (hasSb(input) || changesTrainTodo(input, ctx))))) {
				const contract = contractNow();
				if (contract && !contract.ok) reasons = [contract.refusal];
			}
		} catch (error) {
			// A guard that fails does not let the call through: the train's checks are enforcement.
			reasons = [`sb: the train guard could not check this call (${(error as Error).message}); try again`];
		}
		return reasons.length ? ({ block: true, reason: reasons.join("\n") } satisfies Block) : undefined;
	});
	/** Whether a todo call carries a `metadata.sb`, in its own metadata or in a batch's. */
	function hasSb(input: Json): boolean {
		const meta = (m: unknown) => isObject(m) && m.sb !== undefined;
		return meta(input.metadata) || (Array.isArray(input.tasks) && input.tasks.some((t) => isObject(t) && meta(t.metadata)));
	}
	/** Whether an update reaches a `train` todo of the integrator's list, whatever metadata it carries: completing one needs its result too. */
	function changesTrainTodo(input: Json, ctx: Ctx): boolean {
		const { rows } = rowsOfSnapshot(snapshotOfBranch(ctx.sessionManager.getBranch()));
		return input.action === "update" && sbOf(rows.find((r) => r.id === input.id))?.kind === "train";
	}
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "MonitorCreate" && event.isError === true && typeof event.toolCallId === "string") book.failedToStart(event.toolCallId);
		if (event.toolName !== "todo" || event.isError === true || (!env.train() && !env.isMain())) return;
		const fromDetails = isObject(event.details) ? rowsOfSnapshot(event.details) : undefined;
		publish((fromDetails && Array.isArray((event.details as Json).tasks) ? fromDetails : rowsOfSnapshot(snapshotOfBranch(ctx.sessionManager.getBranch()))).rows, ctx);
	});
	pi.on("turn_end", (_event, ctx) => {
		if (!env.train() && !env.isMain()) return;
		const { rows } = rowsOfSnapshot(snapshotOfBranch(ctx.sessionManager.getBranch()));
		if (rows.some(isStep)) publish(rows, ctx);
	});
	pi.events?.on("monitor:started", (d) => isObject(d) && book.started(d));
	pi.events?.on("monitor:output", (d) => isObject(d) && book.output(d));
	pi.events?.on("monitor:finished", (d) => { const me = env.train(); if (isObject(d) && me) book.finished(d, me.code); });
	return { book, manifestOf };
}
export type TrainGuard = ReturnType<typeof createTrainGuard>;

/** Local signs, known at once and before Herdr answers, that this session may be a train: it was started as one, its saved entry names one, or its pane's role record does. A sign proves nothing by itself; it only closes the guard until the role is settled. */
export function signsOfTrain(env: NodeJS.ProcessEnv, entries: readonly unknown[], recorded: TrainId | undefined): boolean {
	if (env.STRAW_BOSS_ROLE === TRAIN || recorded !== undefined) return true;
	return entries.some((e) => isObject(e) && e.type === "custom" && e.customType === ENTRY && isObject(e.data) && trainFromToken(e.data.train && trainToken(e.data.train as TrainId)) !== undefined);
}

/** Takes the signs once per start and holds them in `s.trainSign` (SB4R-F001): the guard reads this copy, so a role record moved away or put back mid-window changes nothing. Registered before every other session_start handler, so the copy exists before any of them awaits. */
export function registerTrainSigns(kit: Kit, roles: Pick<Roles, "trainOf">): void {
	const { s, cfg } = kit;
	(kit.pi as unknown as { on(event: string, handler: (event: unknown, ctx: { sessionManager: { getBranch(): readonly unknown[]; getSessionFile(): string | undefined } }) => unknown): void }).on("session_start", (_event, ctx) => {
		s.file = ctx.sessionManager.getSessionFile();
		s.trainSign = signsOfTrain(cfg.env, ctx.sessionManager.getBranch(), roles.trainOf({ paneId: cfg.env.HERDR_PANE_ID, tabId: cfg.env.HERDR_TAB_ID, workspaceId: cfg.env.HERDR_WORKSPACE_ID }));
	});
}

/** The guard of this session, unless the merge train is off (§14.8: with it off nothing of this loads). */
export function registerTrainGuard(kit: Kit, cars: CarSource | undefined, mainDuty: MainDuty): TrainGuard | undefined {
	const { s, cfg } = kit;
	if (integrationOff(cfg.env, kit.guiDir)) return undefined;
	return createTrainGuard(kit.pi as unknown as GuardPi, {
		stateDir: kit.guiDir, train: () => (s.isTrain ? s.train : undefined), pending: () => !s.isTrain && !s.trainSettled && s.trainSign, isMain: () => kit.role() === "main", duty: () => mainDuty.now(), session: () => ({ id: kit.me(), ...(s.at?.paneId ? { pane: s.at.paneId } : {}) }), now: () => cfg.now(),
		node: process.execPath, cli: serverCli(), home: homedir(), tell: kit.tell, ...(cars ? { cars } : {}),
		contract: () => checkContract((kit.pi as { getCommands?(): readonly SkillCommand[] }).getCommands?.()),
	});
}
