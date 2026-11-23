import type { Log } from "./log.ts";
import { type ChildExit, newNonce, type PiPath, pruneStderr, runEnv, type RunChild, type Spawn, startChild, stderrFile } from "./runchild.ts";
import { createRing, plain, type Ring } from "./runring.ts";

// The headless children of the run hub (docs/specs/2026-11-23-lite-b2-d-e-f.md §4.4, docs/specs/2026-11-23-f-entry.md): the pi each run is, the nonce its claim must carry, the transcript ring of each
// workspace, and the dialogs the runs raise over RPC. runs.ts decides when a run starts and ends; this file holds the processes. A dialog is answered only by the boss (a viewer's typed key, this computer's
// local page): nothing a run sends can answer one, since only the server writes a run's stdin. One nobody answers is cancelled after `dialogMs`, so an approval falls to "no".

export interface KidsPort {
	/** `towerRuns.headless`: runs are the server's children. Read at each start. */
	on(): boolean;
	/** The node and pi CLI (runchild.ts `resolvePi`); throws with the path it looked at. */
	pi(): PiPath;
	env: NodeJS.ProcessEnv;
	/** `<state>/tower/<ws>`: the run's stderr goes under `runs/`. */
	dir(workspace: string): string;
	spawn?: Spawn;
	platform?: NodeJS.Platform;
	killGroup?: (pid: number) => void;
	taskkill?: (pid: number) => void;
}
export interface Dialog { key: string; run: string; workspace: string; method: string; title: string; message?: string; options?: string[]; at: number }
interface Kid { child: RunChild; nonce: string; workspace: string; exit?: ChildExit }
/** How long a server restart gives its headless runs to settle (decision F-5). */
export const DRAIN_MS = 60_000;
/** How long a run's dialog waits for the boss before it is cancelled. */
export const DIALOG_MS = 60_000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function createKids(o: { port: KidsPort; log: Log; now: () => number; dialogMs?: number }) {
	const kids = new Map<string, Kid>(), rings = new Map<string, Ring>(), dialogs = new Map<string, Dialog & { timer: ReturnType<typeof setTimeout> }>();
	const ring = (workspace: string) => rings.get(workspace) ?? (rings.set(workspace, createRing()), rings.get(workspace)!);
	const answerTo = (d: Dialog, reply: { value?: string; confirmed?: boolean; cancelled?: true }) => {
		const kid = kids.get(d.run), found = dialogs.get(d.key);
		if (found) (clearTimeout(found.timer), dialogs.delete(d.key));
		try { kid?.child.write({ type: "extension_ui_response", id: d.key.slice(d.key.indexOf(":") + 1), ...reply }); } catch { /* a closed stdin: the run is ending */ }
	};
	const onUi = (run: string, workspace: string, rec: Record<string, unknown>) => {
		const method = String(rec.method ?? ""), id = typeof rec.id === "string" ? rec.id.slice(0, 80) : "";
		if (!id) return;
		if (!DIALOG_METHODS.has(method)) {
			if (method === "notify" && typeof rec.message === "string") ring(workspace).add(`· ${plain(rec.message).slice(0, 160)}`);
			return;
		}
		const d: Dialog = { key: `${run}:${id}`, run, workspace, method, title: plain(String(rec.title ?? "")).slice(0, 200), ...(typeof rec.message === "string" ? { message: plain(rec.message).slice(0, 400) } : {}), ...(Array.isArray(rec.options) ? { options: rec.options.slice(0, 9).map((x) => plain(String(x)).slice(0, 80)) } : {}), at: o.now() };
		const timer = setTimeout(() => {
			o.log.line("run-dialog-cancelled", { run, method });
			answerTo(d, { cancelled: true });
			ring(workspace).add(`· a ${method} nobody answered was cancelled: ${d.title.slice(0, 80)}`);
		}, o.dialogMs ?? DIALOG_MS);
		timer.unref?.();
		dialogs.set(d.key, { ...d, timer });
		ring(workspace).add(`? ${d.title.slice(0, 120)} · answer in the viewer's card view or on this computer's page`);
	};
	return {
		on: () => o.port.on(),
		/** Starts a run's pi. Returns its PID and the nonce its claim must carry; throws when pi is not found or does not start. `onExit` is told once, when it has gone. */
		start(input: { run: string; workspace: string; kind: string; args: string[]; cwd: string; onExit: (exit: ChildExit) => void }) {
			const nonce = newNonce(), dir = o.port.dir(input.workspace);
			pruneStderr(`${dir}/runs`, o.now());
			const child = startChild({
				pi: o.port.pi(), args: ["--mode", "rpc", ...input.args], cwd: input.cwd, env: runEnv(o.port.env, nonce), stderr: stderrFile(dir, input.run),
				onRecord: (rec) => (rec.type === "extension_ui_request" ? onUi(input.run, input.workspace, rec) : ring(input.workspace).record(rec)),
				onBad: () => o.log.line("rpc-bad-record", { run: input.run }),
				...(o.port.spawn ? { spawn: o.port.spawn } : {}), ...(o.port.platform ? { platform: o.port.platform } : {}), ...(o.port.killGroup ? { killGroup: o.port.killGroup } : {}), ...(o.port.taskkill ? { taskkill: o.port.taskkill } : {}),
			});
			const kid: Kid = { child, nonce, workspace: input.workspace };
			kids.set(input.run, kid);
			o.log.line("run-spawn", { run: input.run, kind: input.kind, pid: child.pid, workspace: input.workspace });
			void child.exited.then((exit) => {
				kid.exit = exit;
				for (const d of [...dialogs.values()]) if (d.run === input.run) (clearTimeout(d.timer), dialogs.delete(d.key));
				o.log.line("run-exit", { run: input.run, code: exit.code ?? "none", signal: exit.signal ?? "none" });
				input.onExit(exit);
			});
			return { pid: child.pid, nonce };
		},
		/** Whether a claim's PID and nonce are the ones this child was started with. */
		claimed: (run: string, pid: unknown, nonce: unknown) => { const k = kids.get(run); return Boolean(k && k.child.pid === pid && typeof nonce === "string" && nonce === k.nonce); },
		has: (run: string) => kids.has(run),
		gone: (run: string) => Boolean(kids.get(run)?.child.done),
		/** Closes the child's stdin: pi shuts down once it settles. */
		close: (run: string) => kids.get(run)?.child.close(),
		kill: (run: string) => kids.get(run)?.child.kill(),
		forget: (run: string) => void kids.delete(run),
		/** Writes `abort` to the live run of a workspace: pi ends its turn. False when none runs. */
		abort(workspace: string, run?: string) {
			for (const [id, k] of kids) if (k.workspace === workspace && !k.child.done && (!run || run === id)) return k.child.write({ type: "abort" });
			return false;
		},
		ring: (workspace: string) => ring(workspace),
		dropRing: (workspace: string) => void rings.delete(workspace),
		/** The dialogs waiting, of one workspace or all, oldest first. */
		dialogs: (workspace?: string): Dialog[] => [...dialogs.values()].filter((d) => !workspace || d.workspace === workspace).map(({ timer: _t, ...d }) => d),
		/** The boss's answer to a dialog: a select's option, a confirm's yes or no, an input's text. An answer for a dialog that is not waiting is refused. */
		answer(key: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
			const d = dialogs.get(key);
			if (!d) return false;
			if (d.method === "select" && reply.value !== undefined && !(d.options ?? []).includes(reply.value)) return false;
			answerTo(d, reply.cancelled ? { cancelled: true } : d.method === "confirm" ? { confirmed: reply.confirmed === true } : { value: String(reply.value ?? "").slice(0, 4000) });
			ring(d.workspace).add(`» answered: ${d.title.slice(0, 80)}`);
			return true;
		},
	};
}
export type Kids = ReturnType<typeof createKids>;
