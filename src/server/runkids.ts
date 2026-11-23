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
	/** The Herdr socket of the server's slot: the run's look finds the server's folder by it (runchild.ts `runEnv`). */
	herdr?: string;
	/** `<state>/tower/<ws>`: the run's stderr goes under `runs/`. */
	dir(workspace: string): string;
	spawn?: Spawn;
	platform?: NodeJS.Platform;
	killGroup?: (pid: number) => void;
	taskkill?: (pid: number) => void;
	/** How many of this computer's own pages have a stream open (gui.ts): a dialog waits for the boss up to `PAGE_DIALOG_MS` while one does (ZF-2, docs/specs/2026-11-24-zen-f.md). None: 0. */
	pages?: () => number;
}
/** A run's dialog. `approval`: one the server raised itself (pi's trust question before the claim, the approval of a `link_request` or of an ally run's gated call), which only this computer's viewer or local page answers: never a paired device (`NO_RELAY`). */
export interface Dialog { key: string; run: string; workspace: string; method: string; title: string; message?: string; options?: string[]; at: number; approval?: true; /** The run's kind: `local`, `head`, or `ally`. */ kind?: string; /** The wait card a run's `boss_wait_ask` shows with this dialog (the run said so before drawing it: `waitShown`). */ wait?: { workspace: string; id: string } }
type Held = Dialog & { timer: ReturnType<typeof setTimeout>; settle?: (yes: boolean) => void };
/** `writing`: the text of the assistant message the run is writing now, for the page's `live` (a local or head run's only: an ally run is a teammate's, read-only in its own comms). */
interface Kid { child: RunChild; nonce: string; workspace: string; kind: string; exit?: ChildExit; writing: string; /** The wait card the run's `boss_wait_ask` shows now: its dialogs carry it. */ showing?: { workspace: string; id: string } }
/** How long a server restart gives its headless runs to settle (decision F-5). */
export const DRAIN_MS = 60_000;
/** How long a run's dialog waits for the boss before it is cancelled. */
export const DIALOG_MS = 60_000;
/** How long it waits while this computer has a page open, where Zen queues it as a card the boss takes when he is ready (ZF-2, docs/specs/2026-11-24-zen-f.md §7). */
export const PAGE_DIALOG_MS = 10 * 60_000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** How long an approval the server raised waits for the boss: the gate's and `link_request`'s own ten minutes. */
export const APPROVAL_MS = 10 * 60_000;

export function createKids(o: { port: KidsPort; log: Log; now: () => number; dialogMs?: number; pageDialogMs?: number }) {
	const follows = new Map<string, { label: string; head: string }>();
	const kids = new Map<string, Kid>(), rings = new Map<string, Ring>(), dialogs = new Map<string, Held>();
	const ring = (workspace: string) => rings.get(workspace) ?? (rings.set(workspace, createRing()), rings.get(workspace)!);
	const answerTo = (d: Dialog, reply: { value?: string; confirmed?: boolean; cancelled?: true }) => {
		const kid = kids.get(d.run), found = dialogs.get(d.key);
		if (found) (clearTimeout(found.timer), dialogs.delete(d.key));
		// A dialog the server raised is no pi's: its answer is the boss's yes or no, and nothing is written to the run.
		if (found?.settle) return found.settle(reply.cancelled !== true && reply.confirmed === true);
		try { kid?.child.write({ type: "extension_ui_response", id: d.key.slice(d.key.indexOf(":") + 1), ...reply }); } catch { /* a closed stdin: the run is ending */ }
	};
	const onUi = (run: string, workspace: string, rec: Record<string, unknown>) => {
		const method = String(rec.method ?? ""), id = typeof rec.id === "string" ? rec.id.slice(0, 80) : "";
		if (!id) return;
		if (!DIALOG_METHODS.has(method)) {
			if (method === "notify" && typeof rec.message === "string") ring(workspace).add(`· ${plain(rec.message).slice(0, 160)}`);
			return;
		}
		const k = kids.get(run);
		const d: Dialog = { key: `${run}:${id}`, run, workspace, method, title: plain(String(rec.title ?? "")).slice(0, 200), ...(typeof rec.message === "string" ? { message: plain(rec.message).slice(0, 400) } : {}), ...(Array.isArray(rec.options) ? { options: rec.options.slice(0, 9).map((x) => plain(String(x)).slice(0, 80)) } : {}), at: o.now(), ...(k ? { kind: k.kind } : {}), ...(k?.showing ? { wait: { ...k.showing } } : {}) };
		// ZF-2: `dialogMs` (60 s) with no page of this computer open; while one is, it is looked at again every `dialogMs` up to `PAGE_DIALOG_MS` from when it came.
		const short = o.dialogMs ?? DIALOG_MS, long = Math.max(short, o.pageDialogMs ?? PAGE_DIALOG_MS);
		const arm = (ms: number) => {
			const timer = setTimeout(() => {
				const held = dialogs.get(d.key);
				if (held?.timer !== timer) return;
				const age = o.now() - d.at;
				if ((o.port.pages?.() ?? 0) > 0 && age < long) return arm(Math.min(short, long - age));
				o.log.line("run-dialog-cancelled", { run, method });
				answerTo(d, { cancelled: true });
				ring(workspace).add(`· a ${method} nobody answered was cancelled: ${d.title.slice(0, 80)}`);
			}, ms);
			timer.unref?.();
			dialogs.set(d.key, { ...d, timer });
		};
		arm(short);
		ring(workspace).add(`? ${d.title.slice(0, 120)} · answer in the viewer's card view or on this computer's page`);
	};
	return {
		on: () => o.port.on(),
		/** Starts a run's pi. Returns its PID and the nonce its claim must carry; throws when pi is not found or does not start. `onExit` is told once, when it has gone. */
		start(input: { run: string; workspace: string; kind: string; args: string[]; cwd: string; onExit: (exit: ChildExit) => void }) {
			const nonce = newNonce(), dir = o.port.dir(input.workspace);
			pruneStderr(`${dir}/runs`, o.now());
			const child = startChild({
				pi: o.port.pi(), args: ["--mode", "rpc", ...input.args], cwd: input.cwd, env: runEnv(o.port.env, nonce, o.port.herdr), stderr: stderrFile(dir, input.run),
				onRecord: (rec) => {
					if (rec.type === "extension_ui_request") return onUi(input.run, input.workspace, rec);
					const ev = rec.type === "message_update" ? (rec.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined) : undefined;
					if (ev?.type === "text_delta" && typeof ev.delta === "string") kid.writing = (kid.writing + ev.delta).slice(-8000);
					else if (rec.type === "message_end" || rec.type === "agent_settled") kid.writing = "";
					const said = ring(input.workspace).record(rec), f = follows.get(input.workspace);
					// A tower the boss addressed from the head's viewer: each finished message of its run is one line there (docs/specs/2026-11-23-f-entry.md §2.6).
					if (said && f) ring(f.head).add(`[${f.label}] ${said.slice(0, 160)}`);
				},
				onBad: () => o.log.line("rpc-bad-record", { run: input.run }),
				...(o.port.spawn ? { spawn: o.port.spawn } : {}), ...(o.port.platform ? { platform: o.port.platform } : {}), ...(o.port.killGroup ? { killGroup: o.port.killGroup } : {}), ...(o.port.taskkill ? { taskkill: o.port.taskkill } : {}),
			});
			const kid: Kid = { child, nonce, workspace: input.workspace, kind: input.kind, writing: "" };
			kids.set(input.run, kid);
			o.log.line("run-spawn", { run: input.run, kind: input.kind, pid: child.pid, workspace: input.workspace });
			const f = follows.get(input.workspace);
			if (f) ring(f.head).add(`↳ ${f.label} run`);
			void child.exited.then((exit) => {
				kid.exit = exit;
				for (const d of [...dialogs.values()]) if (d.run === input.run) (clearTimeout(d.timer), dialogs.delete(d.key), d.settle?.(false));
				o.log.line("run-exit", { run: input.run, code: exit.code ?? "none", signal: exit.signal ?? "none" });
				const f = follows.get(input.workspace);
				if (f) (ring(f.head).add(exit.code === 0 ? `✓ ${f.label} done` : `✗ ${f.label} crashed`), follows.delete(input.workspace));
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
		/** The text of the message a live run of the workspace is writing now ("" when none is): the GUI's `live` (docs/specs/2026-11-23-lite-b2-d-e-f.md §4.4, The GUI). */
		liveText: (workspace: string) => ((k) => (k ? k.writing.split("\n").map((l) => plain(l, 4000)).join("\n").trim().slice(-4000) : ""))([...kids.values()].find((k) => k.workspace === workspace && k.kind !== "ally" && !k.child.done)),
		/** The boss addressed this tower from the head's viewer: its runs' finished messages show there too, as one line each, until the tower's next run starts on its own. */
		follow: (workspace: string, label: string, head: string) => void follows.set(workspace, { label: plain(label).slice(0, 40), head }),
		dropRing: (workspace: string) => void rings.delete(workspace),
		/** A run's `boss_wait_ask` is about to show the wait card `wait` (or has stopped showing one: undefined): the run's dialogs carry it meanwhile, so Zen draws the wait card and no second one (ZF-3). */
		waitShown(run: string, wait: { workspace: string; id: string } | undefined) {
			const k = kids.get(run);
			if (!k) return false;
			if (wait) k.showing = { workspace: plain(wait.workspace).slice(0, 120), id: plain(wait.id).slice(0, 12) };
			else delete k.showing;
			return true;
		},
		/** The dialogs waiting, of one workspace or all, oldest first. */
		dialogs: (workspace?: string): Dialog[] => [...dialogs.values()].filter((d) => !workspace || d.workspace === workspace).map(({ timer: _t, settle: _s, ...d }) => d),
		/**
		 * A dialog the server raises for a run itself (`approval`): resolves true only on the boss's explicit yes, false on a no, a cancel, the run's end, `withdraw`, or `ms` passing. `id` names it within its run; a second
		 * one with the same id replaces the first, which resolves false.
		 */
		confirm(input: { run: string; workspace: string; id: string; title: string; message?: string; ms?: number }): Promise<boolean> {
			const key = `${input.run}:sb-${input.id}`, before = dialogs.get(key);
			if (before) (clearTimeout(before.timer), dialogs.delete(key), before.settle?.(false));
			return new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					if (dialogs.get(key)?.timer !== timer) return;
					dialogs.delete(key);
					o.log.line("run-dialog-cancelled", { run: input.run, method: "approval" });
					ring(input.workspace).add(`· an approval nobody answered was refused: ${plain(input.title).slice(0, 80)}`);
					resolve(false);
				}, input.ms ?? APPROVAL_MS);
				timer.unref?.();
				dialogs.set(key, { key, run: input.run, workspace: input.workspace, ...(kids.get(input.run) ? { kind: kids.get(input.run)!.kind } : {}), method: "confirm", title: plain(input.title).slice(0, 200), ...(input.message ? { message: input.message.split("\n").map((l) => plain(l, 12_000)).join("\n") } : {}), at: o.now(), approval: true, timer, settle: resolve });
				ring(input.workspace).add(`? ${plain(input.title).slice(0, 120)} · answer in a viewer's card view or on this computer's page`);
			});
		},
		/** Ends a dialog the server raised as a no (the call that asked was aborted, or answered another way). */
		withdraw(run: string, id: string) {
			const d = dialogs.get(`${run}:sb-${id}`);
			if (d?.settle) (clearTimeout(d.timer), dialogs.delete(d.key), d.settle(false));
		},
		/** The boss's answer to a dialog: a select's option, a confirm's yes or no, an input's text. An answer for a dialog that is not waiting is refused. */
		answer(key: string, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
			const d = dialogs.get(key);
			if (!d) return false;
			// A select is answered with one of its own options or cancelled: no answer without a value (REV-F004).
			if (d.method === "select" && !reply.cancelled && (typeof reply.value !== "string" || !(d.options ?? []).includes(reply.value))) return false;
			if (d.approval && !reply.cancelled && typeof reply.confirmed !== "boolean") return false;
			answerTo(d, reply.cancelled ? { cancelled: true } : d.method === "confirm" ? { confirmed: reply.confirmed === true } : { value: String(reply.value ?? "").slice(0, 4000) });
			ring(d.workspace).add(`» answered: ${d.title.slice(0, 80)}`);
			return true;
		},
	};
}
export type Kids = ReturnType<typeof createKids>;
