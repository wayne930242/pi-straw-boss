import { execFileExe } from "./exe.mjs";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stateDirOf } from "./server/paths.ts";
import { herdrRun, panes as herdrPanes, result as herdrResult, workspaces as herdrWorkspaces, type HerdrRun, type Workspace } from "./herdr.ts";
import { type Cwd, readCwds } from "./procs/cwd.ts";
import { type Holder, parseWorktreeList, refusal, removeTargets } from "./procs/guard.ts";
import { OWNER_KEY, readOwners, setOwner } from "./procs/marker.ts";
import { baseName, isOrphan, named, programOf, type Proc, readTable } from "./procs/table.ts";
import { checkoutOf, physical, under } from "./procs/worktree.ts";
import { inRun, inStandingRun } from "./runmark.ts";
import { makeCtx, trusted } from "./server/client.ts";
import { cliCommand } from "./server/version.ts";
import { slotOf } from "./server/record.ts";
import { TRAIN_EVENT } from "./trainrole.ts";
import { callControl, type Reply } from "./server/socket.ts";
import { startOf } from "./startof.ts";

// Process hygiene in every pi (docs/specs/2026-11-04-procs.md; plan sb-procs-plan.md A, B, D). Three jobs:
//  1. The owner marker: STRAW_BOSS_OWNER=<id> in this process's environment at load, so everything its bash starts carries it (src/procs/marker.ts).
//  2. A pi-herdr-agents worker (PI_SUBAGENT_ID set) tells the sb server it exists (`procs-hello`), beats every 30 s, and says `procs-bye` when it quits; the server reaps what the worker leaves (src/server/procs.ts).
//  3. The removal guard: `worktree_remove`, and a bash `git worktree remove` / `herdr worktree remove`, are refused while a process has its working folder in the target checkout. The `/worktree remove` slash command
//     does not pass `tool_call`; that is a documented limit, and the reaper plugin refuses its own removals.
// Inert in a standing tower run (src/runmark.ts) and on Windows (it says so once). No command line or environment is read, logged or shown.

export const BEAT_MS = 30_000;
/** A target of a removal: the word, the folder it is read in, and what removes it (`tool`: the `worktree_remove` tool). */
interface GuardTarget { target: string; cwd: string; via: "git" | "herdr" | "tool" }
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh"]);
const NOTE = Symbol.for("pi-straw-boss.hygiene.told");

/** What this extension reaches the machine with; replaced in tests. */
export interface HygieneDeps {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	argv?: readonly string[];
	pid?: number;
	startOf?: (pid: number) => string | undefined;
	/** One request to the live sb server; undefined when none runs or it does not answer. */
	call?: (request: Record<string, unknown>) => Promise<Reply | undefined>;
	table?: () => Promise<Proc[] | undefined>;
	cwds?: (pids: readonly number[]) => Promise<Map<number, Cwd>>;
	markers?: (pids: readonly number[]) => Promise<Map<number, string>>;
	/** Runs git in a folder and gives its output; throws when it fails. */
	git?: (cwd: string, args: string[]) => Promise<string>;
	workspaces?: () => Promise<Workspace[]>;
	/** The shell pids of the panes of a Herdr workspace that sit idle at the prompt (the shell is its pane's foreground process group): the retained shell a finished worker leaves. Throws when Herdr cannot say. */
	idleShells?: (workspace: string) => Promise<number[]>;
	/** The terminal id Herdr gives a pane (a pane id is reused). */
	terminalOf?: (pane: string) => Promise<string | undefined>;
	exists?: (path: string) => boolean;
	real?: (path: string) => string;
	now?: () => number;
	/** Calls `fn` every `ms` until the returned function is called. */
	every?: (fn: () => void, ms: number) => () => void;
	/** The command that runs the CLI of this package, as the refusal prints it. */
	cli?: () => string;
	/** Told every background step as it starts, so a test can wait for it. */
	track?: (done: Promise<unknown>) => void;
}

const runGit = (cwd: string, args: string[]) => new Promise<string>((resolveRun, reject) => execFileExe("git", args, { cwd, encoding: "utf8", deadline: 5000, maxBuffer: 1 << 24 }, (error, stdout) => (error ? reject(error) : resolveRun(stdout))));
const sanitize = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

/** The owner id of a pi: its pid, with the pi-herdr-agents subagent id in front for a worker (`<id>-<pid>` is unique while the pid lives; a pid reused later has another start time). */
export function ownerId(pid: number, subagentId?: string): string {
	const tail = `-${pid}`, head = subagentId ? sanitize(subagentId).slice(0, 64 - tail.length) : "pi";
	return `${head || "pi"}${tail}`;
}

/** One request to the live sb server of this account over its control socket; undefined when none runs, it is not trusted, or it does not answer within `timeoutMs` (a watchdog's hold takes longer, watchdog.ts). */
export async function callServer(env: NodeJS.ProcessEnv, request: Record<string, unknown>, timeoutMs = 5000): Promise<Reply | undefined> {
	try {
		const ctx = makeCtx({ env, slot: slotOf(stateDirOf(env), env), version: "0.0.0", cli: "cli.mjs", by: "process hygiene" });
		const record = await trusted(ctx);
		if (!record || !ctx.alive(record.pid)) return undefined;
		return (await callControl(record.socket, record.secret, { ...request, cmd: String(request.cmd) }, timeoutMs)).reply;
	} catch {
		return undefined;
	}
}

export function createHygiene(deps: HygieneDeps = {}) {
	const env = deps.env ?? process.env, platform = deps.platform ?? process.platform, argv = deps.argv ?? process.argv, pid = deps.pid ?? process.pid;
	const call = deps.call ?? ((request) => callServer(env, request)), now = deps.now ?? Date.now, exists = deps.exists ?? existsSync, real = deps.real ?? physical;
	const table = deps.table ?? (() => readTable()), cwdsOf = deps.cwds ?? ((pids) => readCwds(pids)), markersOf = deps.markers ?? ((pids) => readOwners(pids));
	const git = deps.git ?? runGit, cli = deps.cli ?? cliCommand;
	const herdr: HerdrRun = herdrRun;
	const idleShells = deps.idleShells ?? (async (workspace: string) => {
		const out: number[] = [];
		for (const pane of await herdrPanes(herdr, workspace)) {
			const info = (await herdrResult(herdr, ["pane", "process-info", "--pane", pane.pane_id]))?.process_info as { shell_pid?: unknown; foreground_process_group_id?: unknown } | undefined;
			if (typeof info?.shell_pid === "number" && info.shell_pid > 1 && info.foreground_process_group_id === info.shell_pid) out.push(info.shell_pid);
		}
		return out;
	});
	const workspacesOf = deps.workspaces ?? (() => herdrWorkspaces(herdr)), terminalOf = deps.terminalOf ?? (async (pane) => (await herdrPanes(herdr)).find((p) => p.pane_id === pane)?.terminal_id);
	const every = deps.every ?? ((fn, ms) => {
		const timer = setInterval(fn, ms);
		timer.unref();
		return () => clearInterval(timer);
	});
	const track = (done: Promise<unknown>) => (deps.track?.(done), done);
	const subagentId = env.PI_SUBAGENT_ID?.trim() || undefined;
	// A train (docs/specs/2026-11-07-train-workers.md §3.3) registers as an owner as a worker does, so what its gates leave dies with it. What makes this pi a train is the session's own word (the event the
	// session emits once it knows: its claim, its entry, or its record), never the shell's `STRAW_BOSS_ROLE`, which a later pi or one whose claim failed in the train's tab inherits.
	let isTrain = false;
	let id = ownerId(pid, subagentId);
	/** Nothing of this runs on Windows, nor in a standing tower run (a run of the sb server, which has its own pane and rules). */
	const inert = () => platform === "win32" || inStandingRun(argv);

	/**
	 * The linked worktrees a target word names: a path, a branch, a unique trailing path component (as git takes it), or a Herdr workspace id. Physical roots, as lsof tells a working folder. A look that could not run throws,
	 * unless the target already named a worktree by its path: the removal is then blocked with the reason (a check that did not run is not a pass).
	 */
	async function checkoutsOf({ target: word, cwd, via }: GuardTarget, spaces: () => Promise<Workspace[]>): Promise<string[]> {
		const found = new Set<string>();
		let target = word, gitError: unknown;
		// A word the shell expands (a variable, a substitution, a glob) names no checkout this guard can read: unresolved is blocked.
		if (/[$`*?[]/.test(word)) throw new Error(`the target ${JSON.stringify(word)} is not a literal checkout; name the checkout literally (or use worktree_remove)`);
		if (via === "herdr" && !target) {
			// `herdr worktree remove` without `--workspace` takes the workspace of the caller.
			target = env.HERDR_WORKSPACE_ID?.trim() ?? "";
			if (!target) throw new Error("herdr worktree remove without --workspace takes the caller's workspace, which this pi does not know: name it with --workspace");
		}
		if (via !== "herdr") {
			const abs = resolve(cwd, target.startsWith("~/") ? join(env.HOME ?? "", target.slice(2)) : target);
			if (exists(abs)) {
				const c = checkoutOf(abs);
				if (c.kind === "linked") found.add(c.root);
			}
			let listed: ReturnType<typeof parseWorktreeList> = [];
			try {
				listed = parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain"]));
			} catch (error) {
				// A caller outside any repository may still name a Herdr workspace (the tool); decided below.
				if (!found.size) gitError = error;
			}
			// The first entry is the main checkout, which git does not remove.
			for (const w of listed.slice(1)) if (w.branch === target || real(w.path) === real(abs)) found.add(real(w.path));
			// git also takes the unique last path components of a worktree (`feat-x`, `wts/feat-x`); several matches, or the main checkout alone, is git's own error.
			const parts = target.split("/").filter(Boolean);
			if (!isAbsolute(target) && !target.startsWith("~") && parts.length && !parts.includes("..") && !parts.includes(".")) {
				const hits = listed.filter((w) => { const at = w.path.split("/").filter(Boolean); return at.length >= parts.length && parts.every((part, i) => at[at.length - parts.length + i] === part); });
				if (hits.length === 1 && hits[0] !== listed[0]) found.add(real(hits[0]!.path));
			}
		}
		if (via !== "git" && (via === "herdr" || !found.size)) {
			for (const w of await spaces()) {
				if (w.workspace_id === target && w.worktree?.is_linked_worktree && w.worktree.checkout_path) found.add(real(w.worktree.checkout_path));
			}
		}
		if (!found.size && gitError) throw gitError;
		return [...found];
	}

	/** The processes that work in `root`, with what the server knows of their owners. */
	async function holdersOf(root: string): Promise<Holder[]> {
		const all = await table();
		if (!all) return [];
		const live = all.filter((p) => !p.zombie), cwds = await cwdsOf(live.map((p) => p.pid));
		const here = live.filter((p) => { const c = cwds.get(p.pid); return c !== undefined && under(real(c.path), root); });
		if (!here.length) return [];
		const marks = await markersOf(here.map((p) => p.pid)).catch(() => new Map<number, string>());
		const known = marks.size ? ((await call({ cmd: "procs-list" }).catch(() => undefined))?.owners as { id: string; live: boolean; endedReason?: string }[] | undefined) : undefined;
		return here.map((proc) => {
			const mark = marks.get(proc.pid), row = mark ? known?.find((o) => o.id === mark) : undefined;
			return { proc, orphan: isOrphan(proc, []), ...(mark ? { owner: { id: mark, state: row ? (row.live ? "live" : "ended") : "unknown", ...(row?.endedReason ? { reason: row.endedReason } : {}) } as NonNullable<Holder["owner"]> } : {}) };
		});
	}

	/** The shell pids in `root` that Herdr says sit idle at the prompt in a pane of a workspace of that checkout: a finished worker's retained shell, which the removal closes with the workspace. Empty when Herdr cannot say. */
	async function idleShellsOf(root: string, spaces: () => Promise<Workspace[]>): Promise<Set<number>> {
		const shells = new Set<number>();
		try {
			const comms = new Map((await table())?.map((p) => [p.pid, baseName(p.comm).replace(/^-/, "")]) ?? []);
			for (const w of await spaces()) {
				// Herdr's pid and process group stay the same when a shell execs a program: only a pid that still runs a shell is idle.
				if (w.worktree?.is_linked_worktree && w.worktree.checkout_path && real(w.worktree.checkout_path) === root) for (const pid of await idleShells(w.workspace_id)) if (SHELL_NAMES.has(comms.get(pid) ?? "")) shells.add(pid);
			}
		} catch {
			shells.clear();
		}
		return shells;
	}

	/** The refusal of a removal of `targets`, or undefined when no process works in any checkout they name. A target that names no linked worktree is the tool's own to refuse. */
	async function guard(what: string, targets: GuardTarget[]): Promise<string | undefined> {
		let listing: Promise<Workspace[]> | undefined;
		const spaces = () => (listing ??= workspacesOf());
		// A root named only by bare `git worktree remove` keeps its idle shells as holders: git does not close the workspace.
		const roots = new Map<string, boolean>();
		for (const target of targets) for (const root of await checkoutsOf(target, spaces)) roots.set(root, (roots.get(root) ?? true) && target.via !== "git");
		for (const [root, closes] of roots) {
			const idle = closes ? await idleShellsOf(root, spaces) : new Set<number>();
			const holders = (await holdersOf(root)).filter((h) => !idle.has(h.proc.pid));
			if (holders.length) return refusal(what, root, holders, cli(), now(), (p) => programOf(named(p)));
		}
		return undefined;
	}

	return function hygiene(pi: ExtensionAPI): void {
		// A standing tower run is a pane the server owns: it gets no marker, no hello, no guard.
		if (!inRun(argv) && platform !== "win32") setOwner(id, env);
		const tell = (notify: (text: string) => void, text: string) => {
			const host = globalThis as { [NOTE]?: Set<string> };
			const told = (host[NOTE] ??= new Set());
			if (told.has(text)) return;
			told.add(text);
			notify(text);
		};
		let stop: (() => void) | undefined, registered = false, refused = false, current: { self: Self; pane: string | undefined } | undefined;
		/** Everything a hello needs of the session, read while its ctx is live: pi invalidates the ctx of a session that is replaced (reload, new, resume, fork) and a getter of it then throws. */
		interface Self { cwd: string; file?: string; notify: (text: string) => void; terminal?: Promise<string | undefined> }
		/** A background step: its failure is its own (a stale session, a server that went away), never an unhandled rejection that would take pi down. */
		const background = (step: Promise<unknown>) => void track(step.catch(() => undefined));
		/** What this pi says about itself; the server checks the pid against its own table. */
		const hello = async (self: Self, pane: string | undefined) => {
			const started = deps.startOf ? deps.startOf(pid) : startOf(pid);
			// The terminal of the pane is asked of Herdr once per session start: a server that is not running leaves the hello to be repeated at every beat.
			self.terminal ??= pane ? terminalOf(pane).catch(() => undefined) : Promise.resolve(undefined);
			const terminal = await self.terminal;
			const reply = await call({ cmd: "procs-hello", pid, id, ...(started ? { started } : {}), ...(subagentId ? { subagentId } : {}), ...(isTrain ? { role: "train" } : {}), ...(self.file ? { sessionFile: self.file } : {}), ...(pane ? { pane } : {}), ...(terminal ? { terminal } : {}), cwd: self.cwd });
			if (reply?.ok) return void (registered = true);
			registered = false;
			// The server turned this pi down (an id in use, a pid it does not know): that does not change on its own, so it is said once and not asked again. No server, a restarting one, or any other failed reply is tried again at the next beat.
			if (reply && !reply.ok && reply.refused === true) (refused = true, tell(self.notify, `Straw Boss: the sb server did not register this worker for process hygiene: ${String(reply.error ?? "refused")}. What it starts is not reaped when it ends.`));
		};

		pi.on("session_start", (_event, ctx) => {
			const ui = ctx.ui, notify = (text: string) => { try { ui?.notify?.(text, "warning"); } catch { /* the session is gone */ } };
			if (platform === "win32") return void tell(notify, "Straw Boss process hygiene is not available on Windows: workers are not tracked and worktree removal is not checked for running processes.");
			if (inStandingRun(argv)) {
				if (env[OWNER_KEY] === id) delete env[OWNER_KEY];
				return;
			}
			const pane = env.HERDR_PANE_ID, self: Self = { cwd: ctx.cwd, notify };
			try { self.file = ctx.sessionManager?.getSessionFile?.(); } catch { /* no session file */ }
			current = { self, pane };
			if (subagentId || isTrain) enlist();
		});
		/** Says hello now and at every beat; what a worker does at its start and a train does when its session says it is one. */
		const enlist = () => {
			if (!current || platform === "win32" || inStandingRun(argv)) return;
			const { self, pane } = current;
			refused = false;
			stop?.();
			background(hello(self, pane));
			stop = every(() => background(registered ? call({ cmd: "procs-beat", id }).then((reply) => void (registered = reply?.ok === true && reply.known === true), () => void (registered = false)) : refused ? Promise.resolve() : hello(self, pane)), BEAT_MS);
		};
		pi.events?.on(TRAIN_EVENT, (data) => {
			if (subagentId || isTrain || (data as { train?: unknown } | undefined)?.train !== true || platform === "win32" || inStandingRun(argv)) return;
			isTrain = true;
			id = ownerId(pid, "train");
			if (!inRun(argv)) setOwner(id, env); // what its gates start from here on carries the train's owner id
			enlist();
		});
		pi.on("session_shutdown", async (event) => {
			stop?.();
			stop = undefined;
			// A reload or a switch of session keeps this process (and its children) alive: only a quit is the worker's end.
			if (event.reason === "quit" && (subagentId || isTrain) && registered && !inert()) await track(call({ cmd: "procs-bye", id }).catch(() => undefined));
			registered = false;
			// The next session of this process finds out again; the owner id goes back to the plain one.
			if (isTrain) {
				isTrain = false;
				const was = id;
				id = ownerId(pid, subagentId);
				if (env[OWNER_KEY] === was && !inRun(argv)) setOwner(id, env);
			}
			current = undefined;
		});

		pi.on("tool_call", async (event, ctx) => {
			if (inert()) return;
			let what: string, targets: GuardTarget[];
			if (event.toolName === "worktree_remove") {
				const target = (event.input as { target?: unknown }).target;
				if (typeof target !== "string" || !target) return;
				[what, targets] = ["worktree_remove", [{ target, cwd: ctx.cwd, via: "tool" }]];
			} else if (event.toolName === "bash") {
				const command = (event.input as { command?: unknown }).command;
				if (typeof command !== "string") return;
				// The words decide, not the raw text: quotes can split `worktree` and `remove` apart.
				targets = removeTargets(command, ctx.cwd);
				what = "worktree remove";
				if (!targets.length) return;
			} else return;
			try {
				const reason = await guard(what, targets);
				return reason ? { block: true, reason } : undefined;
			} catch (error) {
				// A check that could not run is not a pass: the removal waits (the `/worktree remove` command does not pass here).
				return { block: true, reason: `${what} refused: the check for running processes in the checkout failed (${(error as Error).message}). Repeat the call; if it keeps failing, use the /worktree remove command.` };
			}
		});
	};
}

export default createHygiene();
