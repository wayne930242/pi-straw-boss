import { createTab, type HerdrApi, type HerdrRun, isStandin, type Pane, panes, report, TOWER_LABEL, workspaces } from "../herdr.ts";
import type { Log } from "./log.ts";
import type { ServiceState, ServiceStatus } from "./runs.ts";
import type { ServiceRecord } from "./towerstore.ts";
import { nameOf, SHELLS } from "./typegate.ts";

// A tower's standing pane between runs (docs/how-it-works.md, The standing pane, When the pane closes). The boss's order of 2026-11-28 (「只在有卡片等我時才留」): the pane stays only while a card waits for him. Once no run
// is live, nothing waits to wake one, no card of the tower waits, and that has held for `idleMs`, the pane closes (only the pane: Herdr drops the emptied tab itself) and the service goes on with no pane, as a headless
// service does: its identity stays registered and its token written, so mains still reach it. The next run, ally run, card, or ensure-tower makes the tab again, as the first open made it.
// What keeps the pane is decided here alone (`idleGate`, `paneGate`, `seatOpen`; their table test is tests/towerstow.test.ts); the look gathers the facts and acts on the answer.
// Under headless runs (`towerRuns.headless`) the pane is the service's viewer and the same rules close it; it comes back as a fresh viewer only when the idle close took it (`stowed` on the record), and only on an attended
// device (`reopenGate`): a service of headless runs needs no tab, and a viewer the boss ended himself stays ended.
// The head tower's pane is never closed: it is its workspace's only pane, so closing it would close the head workspace and take the head's record with it (`lose`). A pane that is the last of its workspace is kept for the
// same reason: the queue, the memory, and the ledgers are kept under the workspace's id, which a workspace made again does not get.

export interface StowTimers {
	/** How often the look runs. */
	intervalMs: number;
	/** How long nothing may have kept the pane before it closes: a burst of events, or a milestone's 30 s wait, reuses it. */
	idleMs: number;
}
export const STOW: StowTimers = { intervalMs: 3000, idleMs: 30_000 };

/** Why a standing pane stays. */
export type Keep = "head" | "unready" | "cards" | "run" | "held" | "queued" | "soon" | "recent" | "gone" | "agent" | "tab" | "last" | "parked" | "prompt" | "draft" | "program" | "unknown";
export type StowVerdict = { stow: true } | { stow: false; why: Keep };
const keep = (why: Keep): StowVerdict => ({ stow: false, why });

export interface IdleFacts {
	head: boolean;
	/** The identity is registered, the seat proven, and no pane change is under way. */
	ready: boolean;
	/** The tower's own wait cards that wait for the boss. */
	cards: number;
	state?: ServiceState;
	/** A local run or an ally run is live. */
	run: boolean;
	/** Events that wake a run (a quiet one wakes none). */
	queued: number;
	/** A wake is due within `idleMs` (a milestone's hold). */
	soon: boolean;
	idleFor: number;
	idleMs: number;
}
/** The facts of the service, cheap to read: asked before the pane's facts, which cost Herdr calls. */
export function idleGate(f: IdleFacts): StowVerdict {
	if (f.head) return keep("head");
	if (!f.ready) return keep("unready");
	if (f.cards > 0) return keep("cards");
	if (f.run || f.state === "waking" || f.state === "running" || f.state === "closing") return keep("run");
	if (f.state === "held") return keep("held"); // its notices, and the pane's last lines, are what the boss reads
	if (f.queued > 0) return keep("queued");
	if (f.soon) return keep("soon");
	if (f.idleFor < f.idleMs) return keep("recent");
	return { stow: true };
}

export interface PaneFacts {
	pane?: Pick<Pane, "agent">;
	/** The panes in the standing pane's tab, and in its workspace, itself included. */
	inTab: number;
	inWorkspace: number;
	/** The boss took the shell with Ctrl+D (standing.ts). */
	parked: boolean;
	/** The tower prompt polls in the pane, and its last poll said the boss has words on its line (or a card's field, or the picker). */
	prompt: boolean;
	draft: boolean;
	foreground: "clean" | "program" | "unknown";
}
/** The pane as Herdr lists it now: only a lone standing pane that holds the tower prompt at rest, in a workspace that keeps another pane, closes. */
export function paneGate(f: PaneFacts): StowVerdict {
	if (!f.pane) return keep("gone");
	if (f.pane.agent && !isStandin(f.pane)) return keep("agent"); // a pi the boss started there by hand
	if (f.inTab > 1) return keep("tab"); // a split of the boss's, or an ally run's pane
	if (f.inWorkspace <= f.inTab) return keep("last");
	if (f.parked) return keep("parked");
	if (!f.prompt) return keep("prompt"); // only the prompt's own polls prove what the pane holds, on every platform
	if (f.draft) return keep("draft");
	if (f.foreground !== "clean") return keep(f.foreground);
	return { stow: true };
}

/** Whether the pane's foreground holds nothing but its shell and this tower's prompt (`promptPid`: the pid that polls). Windows lists the shell alone under any program, which is why `paneGate` asks the prompt's polls first. */
export function foregroundOf(info: { shell_pid?: unknown; foreground_processes?: unknown } | undefined, workspace: string, promptPid?: number): PaneFacts["foreground"] {
	const list = Array.isArray(info?.foreground_processes) ? (info!.foreground_processes as { pid?: number; name?: string; argv0?: string; cmdline?: string }[]) : [];
	if (!list.length) return "unknown";
	const shell = typeof info?.shell_pid === "number" ? info.shell_pid : undefined, prompt = new RegExp(`\\bprompt --workspace ${workspace.replace(/[^\w.:-]/g, "")}(\\s|$)`);
	return list.every((p) => (shell !== undefined ? p.pid === shell : list.length === 1 && SHELLS.has(nameOf(p))) || (promptPid !== undefined && p.pid === promptPid) || prompt.test(p.cmdline ?? "")) ? "clean" : "program";
}

/** Whether a tower with no pane gets its tab again (before a run or an ally run, for a card): a standing pane always does; under headless runs only a viewer the idle close took (`stowed`), and only where the boss is. */
export function reopenGate(f: { headless: boolean; stowed: boolean; attended: boolean }): boolean {
	return !f.headless || (f.stowed && f.attended);
}

/**
 * Whether a headless `ensure-tower` makes a viewer tab. The boss's own Open viewer (`view: true`) makes one wherever the service has none; an attended session's plain ensure (`"attended"`: a promotion, a main's call)
 * makes one only with the service it makes. A service that stands with no tab (a viewer the idle close took, or one the boss ended) gets a viewer back by `reopenGate` alone: a plain ensure that came while the identity
 * registered again after the idle close (seen 2026-11-28 06:41:36) would make a viewer the idle close takes again half a minute later.
 */
export function viewerGate(f: { asked: boolean | "attended"; attended: boolean; service: "none" | "tabless" | "tab" }): boolean {
	if (f.service === "tab" || f.asked === false) return false;
	return f.asked === true || (f.attended && f.service === "none");
}

/** Whether a tower with no pane may make its tab in the workspace under its id: after a Herdr restart (`seated` false) only one that still carries the label it had is its own (ids repeat across Herdr servers). */
export function seatOpen(f: { seated: boolean; label: string | undefined; record: string }): "open" | "stranger" | "gone" {
	if (f.label === undefined) return "gone";
	return f.seated || f.label === f.record ? "open" : "stranger";
}

/** What the look needs of the tower service (towers.ts). `L` is its live service. */
export interface StowPort<L> {
	run: HerdrRun;
	api: HerdrApi;
	log: Log;
	now(): number;
	stateDir: string;
	timers?: Partial<StowTimers>;
	list(): L[];
	current(workspace: string): L | undefined;
	record(l: L): ServiceRecord;
	/** The record in memory only, before the pane closes: Herdr's `pane.closed` then finds a service with no pane, not one whose tab is gone. */
	place(l: L, record: ServiceRecord): void;
	head(l: L): boolean;
	ready(l: L): boolean;
	seated(l: L): boolean;
	/** The minute after a Herdr restart (or the server's start), in which nothing is judged a stranger's yet. */
	recovering(): boolean;
	/** The workspace under the id still carries the label: a stowed service is seated again after a Herdr restart (its token is written again). */
	seat(l: L): Promise<void>;
	/** The service is not live while its pane changes (no run begins, no pi is admitted); returns the undo. */
	hold(l: L): () => void;
	headless(): boolean;
	/** A boss is at this device (no `unattended` box): only there does a headless viewer come back. */
	attended(): boolean;
	status(workspace: string): ServiceStatus | undefined;
	queued(workspace: string): number;
	soon(workspace: string, ms: number): boolean;
	cards(l: L): number;
	prompt(workspace: string): { prompt: boolean; draft: boolean; parked: boolean; pid?: number } | undefined;
	/** The record is written and the identity registers again with it; `fresh`: the pane was just made. */
	reseat(l: L, record: ServiceRecord, fresh: boolean): Promise<L>;
	lose(l: L, why: string, stranger: boolean): Promise<void>;
}

export function createStow<L>(o: StowPort<L>) {
	const t: StowTimers = { ...STOW, ...o.timers };
	const { run, log } = o;
	/** Since when nothing kept each workspace's pane (the clock starts again with every reason that means work), and the pane-side reason last logged. */
	const since = new Map<string, { pane: string; at: number }>(), said = new Map<string, Keep>();
	const opening = new Map<string, Promise<L | undefined>>();
	let timer: ReturnType<typeof setInterval> | undefined, looking: Promise<void> = Promise.resolve(), stopped = false;
	const error = (code: string, text: string) => log.line("error", { code, text: text.slice(0, 300) });
	const processInfo = (pane: string) => run(["pane", "process-info", "--pane", pane]).then((x) => JSON.parse(x).result?.process_info, () => undefined);
	const idleOf = (l: L, at: number) => {
		const ws = o.record(l).workspace, status = o.status(ws), from = since.get(ws);
		return idleGate({ head: o.head(l), ready: o.ready(l), cards: o.cards(l), state: status?.state, run: Boolean(status?.run) || (status?.allyRuns.length ?? 0) > 0, queued: o.queued(ws), soon: o.soon(ws, t.idleMs), idleFor: from ? at - from.at : 0, idleMs: t.idleMs });
	};
	const wants = (l: L) => reopenGate({ headless: o.headless(), stowed: o.record(l).stowed === true, attended: o.attended() });
	const said1 = (ws: string, why: Keep) => {
		if (said.get(ws) === why) return;
		said.set(ws, why);
		log.line("tower-stow-kept", { workspace: ws, why });
	};

	/** The pane closes and the service goes on with no pane. Every fact is asked again after the last await; a close Herdr refuses leaves everything as it was. */
	const close = async (l: L, record: ServiceRecord) => {
		const ws = record.workspace, undo = o.hold(l);
		const bare: ServiceRecord = { ...record, pane: "", tab: "", stowed: true };
		o.place(l, bare);
		try {
			await run(["pane", "close", record.pane]);
		} catch (cause) {
			o.place(l, record);
			undo();
			return error("tower-stow", `${ws}: ${(cause as Error).message}`);
		}
		since.delete(ws);
		said.delete(ws);
		log.line("tower-stowed", { workspace: ws, pane: record.pane });
		await o.reseat(l, bare, false);
	};
	const lookAt = async (l: L) => {
		const record = o.record(l), ws = record.workspace;
		if (o.head(l) || opening.has(ws)) return;
		if (!record.pane) {
			if (!wants(l)) return; // a service of headless runs with no viewer, or one the boss ended: nothing to bring back
			// A service seated before a Herdr restart is seated again by its workspace's label: its token is written again, and a card or a run makes its tab. A workspace under its id with another label is a stranger's, once the minute is over.
			if (!o.seated(l)) {
				const listed = await workspaces(run).catch(() => undefined), seat = listed && seatOpen({ seated: false, label: listed.find((w) => w.workspace_id === ws)?.label, record: record.label });
				if (seat === "open") await o.seat(l);
				else if (seat === "stranger" && !o.recovering()) return void (await o.lose(l, "its workspace carries another label after a Herdr restart", true));
			}
			if (o.ready(l) && o.cards(l) > 0) await open(ws, "cards");
			return;
		}
		const at = o.now();
		if (since.get(ws)?.pane !== record.pane) since.set(ws, { pane: record.pane, at });
		const idle = idleOf(l, at);
		if (!idle.stow) {
			if (idle.why !== "recent") since.set(ws, { pane: record.pane, at });
			return;
		}
		const all = await panes(run, ws).catch(() => undefined);
		if (!all) return;
		const pane = all.find((p) => p.pane_id === record.pane), here = o.prompt(ws);
		const v = paneGate({ ...(pane ? { pane } : {}), inTab: pane ? all.filter((p) => p.tab_id === pane.tab_id).length : 0, inWorkspace: all.length, parked: here?.parked === true, prompt: here?.prompt === true, draft: here?.draft === true, foreground: pane ? foregroundOf(await processInfo(record.pane), ws, here?.pid) : "unknown" });
		if (!v.stow) {
			if (v.why === "draft") since.set(ws, { pane: record.pane, at: o.now() });
			return said1(ws, v.why);
		}
		// Asked again after the reads: an event, a card, or a run that came meanwhile keeps the pane.
		if (stopped || o.current(ws) !== l || o.record(l) !== record || !idleOf(l, o.now()).stow || o.prompt(ws)?.draft) return;
		await close(l, record);
	};
	const look = () => (looking = looking.then(async () => {
		for (const l of o.list()) {
			if (stopped) return;
			await lookAt(l).catch((cause: Error) => error("tower-stow", cause.message));
		}
	}));

	/** Makes the tab of a tower with no pane again, as the first open made it (the tower glyph, first, the pane marked `sb_role=tower`), and seats the service in it. Undefined when the workspace proved a stranger's and the service ended. */
	const open = (workspace: string, why: "run" | "ally" | "cards" | "ensure"): Promise<L | undefined> => {
		const pending = opening.get(workspace) ?? (async () => {
			const l = o.current(workspace);
			if (!l || o.record(l).pane) return l;
			const record = o.record(l), target = (await workspaces(run)).find((w) => w.workspace_id === workspace);
			const verdict = seatOpen({ seated: o.seated(l), label: target?.label, record: record.label });
			if (verdict === "gone") throw new Error(`the workspace of ${record.id} is gone`);
			if (verdict === "stranger") return void (await o.lose(l, "its workspace carries another label after a Herdr restart", true));
			const undo = o.hold(l);
			let made: { tabId: string; paneId: string } | undefined;
			try {
				const dir = record.cwd ?? target!.worktree?.checkout_path ?? o.stateDir;
				made = await createTab(run, workspace, dir, [], TOWER_LABEL);
				if (o.current(workspace) !== l) throw new Error("the service ended while its tab was made");
				await report(run, "pane", made.paneId, { sb_role: "tower" });
				await o.api("tab.move", { tab_id: made.tabId, insert_index: 0 }).catch((cause: Error) => error("tab-move", cause.message));
				log.line("tower-unstowed", { workspace, pane: made.paneId, why });
				const { stowed: _, ...kept } = record;
				return await o.reseat(l, { ...kept, pane: made.paneId, tab: made.tabId, cwd: dir }, true);
			} catch (cause) {
				undo();
				if (made) await run(["pane", "close", made.paneId]).catch(() => {}); // the pane it made, never the tab
				throw cause;
			}
		})().finally(() => opening.delete(workspace));
		opening.set(workspace, pending);
		return pending;
	};

	return {
		look,
		open,
		/** Whether the tower with no pane gets its tab again before a run starts (`reopenGate`). */
		wants,
		start() {
			timer ??= setInterval(() => void look(), t.intervalMs);
			timer.unref();
		},
		async stop() {
			stopped = true;
			clearInterval(timer);
			timer = undefined;
			await looking.catch(() => {});
			await Promise.all([...opening.values()].map((p) => p.catch(() => {})));
		},
	};
}
export type Stow<L> = ReturnType<typeof createStow<L>>;
