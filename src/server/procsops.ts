import { join } from "node:path";
import { homedir } from "node:os";
import type { HerdrRun } from "../herdr.ts";
import { panes as herdrPanes, workspaces as herdrWorkspaces } from "../herdr.ts";
import type { HerdrEvents } from "../server-watch.ts";
import { inTestRun } from "./testguard.ts";
import { createProcs, type Procs, type ProcsDeps, ProcsRefusal, protectedSet } from "./procs.ts";
import type { Reply, Request } from "./socket.ts";

// The server's side of the owner registry (procs.ts): the control-socket commands and the wiring of the registry to Herdr's events and a timer. Kept out of main.ts, which carries a line budget.

const str = (value: unknown, max = 4096) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);
const refusal = (error: unknown): Reply => ({ ok: false, error: (error as Error).message });
const phrase = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 300);

/** A worker's pi says hello, beats, and says bye; `procs-list` and `procs-reap` are the CLI's. Undefined for a command that is not the registry's. */
export function procsReply(reg: Procs | undefined, request: Request): Promise<Reply> | undefined {
	if (typeof request.cmd !== "string" || !request.cmd.startsWith("procs-")) return undefined;
	if (!reg) return Promise.resolve({ ok: false, error: "the server is still starting" });
	switch (request.cmd) {
		case "procs-hello":
			return reg.hello({ pid: Number(request.pid), id: str(request.id, 64), started: str(request.started, 64), subagentId: str(request.subagentId), role: request.role === "train" ? "train" : undefined, sessionFile: str(request.sessionFile), pane: str(request.pane), terminal: str(request.terminal), cwd: str(request.cwd) }).then((r) => ({ ok: true, ...r }), (error: unknown) => (error instanceof ProcsRefusal ? { ok: false, error: error.message, refused: true } : refusal(error)));
		case "procs-beat":
			return Promise.resolve({ ok: true, known: reg.beat(String(request.id)) });
		case "procs-bye":
			return Promise.resolve({ ok: true, known: reg.bye(String(request.id)) });
		case "procs-list":
			return Promise.resolve({ ok: true, owners: reg.list() });
		case "procs-reap": {
			const owner = str(request.owner, 64), checkout = str(request.checkout);
			if ((owner === undefined) === (checkout === undefined)) return Promise.resolve({ ok: false, error: "procs-reap needs an owner or a checkout, not both" });
			return (owner ? reg.reapOwner(owner) : reg.reapCheckout(checkout!)).then((r) => ({ ok: true, ...r }), (error: unknown) => (error instanceof ProcsRefusal ? { ok: false, error: error.message, refused: true } : refusal(error)));
		}
		default:
			return Promise.resolve({ ok: false, error: `unknown command ${request.cmd}` });
	}
}

export interface StartProcs {
	dir: string;
	stateDir: string;
	env: NodeJS.ProcessEnv;
	pid: number;
	platform: NodeJS.Platform;
	now(): number;
	log(event: string, facts: Record<string, number | string | boolean>): void;
	run: HerdrRun;
	events: HerdrEvents;
	/** The stall watch (stallops.ts), which samples the table of each tick. */
	watch?: ProcsDeps["watch"];
	/** The seams of a test (the process table, the kill sequence, the tick); the registry reads no table of this machine in a test run unless the test gives one. */
	over?: Partial<ProcsDeps> & { tickMs?: number };
	stops: (() => void)[];
	timers: ReturnType<typeof setInterval>[];
	/** The server is leaving or restarting: no timer starts. */
	leaving(): boolean;
}

/**
 * The registry of this server: its own Herdr subscription (apart from the tower service's), the first tick, and the tick timer. A subscription that throws is one `procs` error line and the server goes on
 * (the pid-gone tick still ends owners); nothing here is fatal to the start.
 */
export function startProcs(o: StartProcs): Procs {
	const error = (e: unknown) => o.log("error", { code: "procs", text: phrase(e) });
	const quiet: Partial<ProcsDeps> = inTestRun() && !o.over?.read ? { read: async () => [], startOf: () => undefined } : {};
	const procs = createProcs({
		dir: o.dir, now: o.now, log: o.log, self: [o.pid], platform: o.platform, ...(process.getuid ? { ownUid: process.getuid() } : {}),
		protect: (table) => protectedSet(table, { run: o.run, stateDir: o.stateDir, agentDir: o.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), self: o.pid }),
		panes: async () => (await herdrPanes(o.run)).map((p) => ({ pane_id: p.pane_id, ...(p.terminal_id ? { terminal_id: p.terminal_id } : {}), ...(p.cwd ? { cwd: p.cwd } : {}), ...(p.workspace_id ? { workspace_id: p.workspace_id } : {}) })),
		workspaces: async () => (await herdrWorkspaces(o.run)).flatMap((w) => (w.worktree?.is_linked_worktree && w.worktree.checkout_path ? [{ workspace_id: w.workspace_id, checkout_path: w.worktree.checkout_path }] : [])),
		...(o.watch ? { watch: o.watch } : {}), ...quiet, ...o.over,
	});
	if (o.platform === "win32") return procs;
	try {
		o.stops.push(o.events(["pane.exited", "pane.closed"], (event) => void (event ? procs.paneEvent(event) : procs.tick()).catch(error)));
	} catch (e) {
		error(e);
	}
	void procs.start().catch(error).then(() => {
		// One timer at the rate the first tick's cost allows (10 s, or 30 s after a tick that took over a second).
		if (!o.leaving()) o.timers.push(setInterval(() => void procs.tick().catch(error), o.over?.tickMs ?? procs.tickMs()));
	});
	return procs;
}
