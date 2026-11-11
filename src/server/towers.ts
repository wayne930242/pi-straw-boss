import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHeadlessKit, type HeadlessKit, type Incoming, type IntercomLike } from "./kit.ts";
import { createCloseMain, type Control } from "../closemain.ts";
import { createDigest } from "../digest.ts";
import { createTab, headModel, isHead, isStandin, isSub, type Pane, panes, parentOf, type Place, report, SEAT_LABEL, type ServiceKind, type Session, STANDIN_HEAD, tabs, TOWER_LABEL, towerModel, type Workspace, workspaces } from "../herdr.ts";
import { type Opened, opener } from "../opener.ts";
import { netTokens } from "../order.ts";
import { allyLabel } from "../boardauto.ts";
import { fieldsOf, stamp } from "../header.ts";
import { createReach, nameOf, type Reach } from "../reach.ts";
import type { HerdrEvents } from "../server-watch.ts";
import type { Config } from "../state.ts";
import { isSessionRole } from "../trainrole.ts";
import { integrationOff } from "../trainswitch.ts";
import { trustDir } from "../trust/files.ts";
import type { IntercomModule } from "./intercom.ts";
import type { Log } from "./log.ts";
import { secretDir, type Slot, towerId, towerName } from "./record.ts";
import { createHead, HEAD_ORDER, HEAD_TOKEN, type HeadEnsured } from "./head.ts";
import { asked, checkSupersedes, closeAsk, isAct, noteToolCall, openAsk, openAsks } from "./headasks.ts";
import { headBrief, headIntake, relayOnlyFromHead, stateWord } from "./headside.ts";
import type { Requester } from "../autostate.ts";
import type { AutoMode } from "./automode.ts";
import { basisOf, briefLine, type ParkedRow, parkedRows, parkedText, parkOpen, type Target, unpark } from "./autotower.ts";
import { autoAnswer, headHost, headTool, type HeadPort } from "./headtools.ts";
import type { Allows } from "./allows.ts";
import type { Asks } from "./asks.ts";
import { ageOf, allyTools, buildAllyBrief, buildBrief, gatherMains, localTools } from "./towerbrief.ts";
import { createStanding, type PromptReply, type StandingTimers } from "./standing.ts";
import { digestOf, type WaitDigest, type WaitList, waitList, waitRows } from "./waitlist.ts";
import { claimGate, proofGate, seatGate, type SeatVerdict } from "./typegate.ts";
import { addAnswer, addRoute, answeredAsks, ALLY_LEDGER, dropAsk, dropOpened, type Peer, readAnswers, readRoutes, removeAnswer, openedFor, routeOf, setStop, spendRoute } from "./allyroute.ts";
import { createRevoker, type OpenedMain } from "./revoke.ts";
import { createUnitStop, kindOfPane, type MainFact } from "./unitstop.ts";
import type { UnitStopInput } from "../link/holder.ts";
import { type AllyItem, type AllyPort, createRuns, type Runs, type RunsOptions, type ServiceRef, type ServiceStatus } from "./runs.ts";
import { type ConversationInfo, sessionsRoot } from "./bossconv.ts";
import { addExpect, clearExpect, lastNote, listRuns, readExpects, readNotes, readTimer } from "./towerrunstore.ts";
import { runTool, type ServerTools } from "./runtools.ts";
import { localeOf } from "../towerprompt/messages.ts";
import { type PressDoor, pressRequest } from "./waitpress.ts";
import { type Entry, hasWaitOn, markShown, memoryRequest, memorySection, memorySummary, memoryTool, noteMessage, readMemory } from "./towermemory.ts";
import { openSeen, type Seen } from "./towerseen.ts";
import { readTowerRuns } from "./towerruns.ts";
import type { CarBook } from "./carbook.ts";
import { noteTrains } from "./trainnote.ts";
import { appendEvent, bindDir, deleteService, HEAD_KEY, headDir, listServices, purgeAll, purgeQueues, putLedger, queueLength, readHeadService, readQueue, readLedger, readService, type ServiceRecord, towerDir, unbindDir, writeService } from "./towerstore.ts";

// The tower service without runs (docs/specs/2026-10-26-sb-backend.md, The tower service; build step B4), behind `towerRuns.enabled`. The server stands in for a workspace's tower:
// it makes the tower tab with a standing pane that sits at its shell prompt, registers the tower identity (`sb-tower-<workspace>`, with a cwd of its own) with pi-intercom, writes
// the tokens the guard, `tower_list`, the dashboard, and the sidebar find the tower by, finds the tab again after a Herdr restart, watches the head workspace for the digest, and
// keeps the opener's ledger and the `close-main` channel. It starts no pi: what reaches the identity is queued, and nothing wakes (runs come with B5).
//
// One identity is one pi-intercom connection and one headless kit (the modules of a pi session get the channel and the outbox from it), so the opener, the `close-main` ask, and
// the sender are the ones a tower session used, with the identity as their `me()`.

/** What `residentOf` names when it could not read who holds the workspace. */
const UNKNOWN = "(unknown)";
/** A run's request is held 30 s (server-look.ts): the server's resends for a tool stop at about 20 s, so a tool never fails while a copy is still going out. */
export const RUN_SEND_CAP_MS = 20_000;
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const REPUBLISH_MS = 300, REVOKE_MS = 15_000, REFRESH_MS = 4 * 60_000, RECOVER_MS = 60_000, RECOVER_POLL_MS = 2000, RESIDENT_MS = 2000, REGISTER_WAIT_MS = 3000, LEAVE_MS = 2000;
/** How old a caller's "I just made this pane" may be and still be believed (the desk step asks within a second or two of making the base). */
const MADE_WITHIN_MS = 30_000;
/** What a tab is called once its standing pane was replaced and it kept other panes. */
const FORMER_LABEL = "former tower";
/** What Herdr reports that ends a tower's tab, or moves the head: any of them makes the service look again. */
const WATCHED = ["workspace.created", "workspace.closed", "workspace.moved", "workspace.reordered", "pane.closed", "tab.closed"];
const ORDER_EVENTS = new Set(["workspace_created", "workspace_closed", "workspace_moved", "workspace_reordered"]);
const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

export interface TowersOptions {
	slot: Slot;
	cfg: Config;
	env: NodeJS.ProcessEnv;
	/** A new client of the broker (the server's `IntercomModule.connect`); each identity has one of its own. */
	connect: IntercomModule["connect"];
	log: Log;
	pid: number;
	startedAt: number;
	/** Whether `towerRuns.enabled` is on now: read at each activation and each `ensure`. */
	enabled(): boolean;
	/** The live sessions as the server's own connection sees them: how a resident tower of an older build is told. */
	sessions(): Promise<Session[]>;
	/** How long a Herdr restart is given to bring the tower tabs back, how often the tokens are written again, and how often a waiting service looks at its resident. */
	recoverMs?: number;
	/** How often the minute after a restart looks at the tabs again (2 s); a test shortens it to leave the minute's look out of what it pins. */
	recoverPollMs?: number;
	refreshMs?: number;
	/** How often a controller's opened mains are checked against the roster and the policy (15 s; revoke.ts). */
	revokeMs?: number;
	republishMs?: number;
	residentMs?: number;
	/** How long `ensure` waits for the identity to register before it answers. */
	registerMs?: number;
	retryMs?: number[];
	/** Replaces the runs' seams (timers, starting pi, the settings check, liveness), for tests. */
	runs?: Partial<RunsOptions>;
	/** The line typed into a standing pane's shell to start the tower prompt (main.ts builds it from the CLI beside the server); without it the server types nothing and reports no stand-in. */
	promptCommand?: (workspace: string) => string | undefined;
	/** The timers of the standing pane (standing.ts), for tests, and `standingWait`: */
	standing?: Partial<StandingTimers>; standingWait?: /* the clock of a run's wait for the prompt's exit (tests) */ { now: () => number; sleep: (ms: number) => Promise<void> };
	/** A request to the link holder as a tower identity (main.ts; absent in a world without one). */
	link?: (body: unknown, from: string) => Promise<unknown>;
	/** The server's own part of `boss_server` for a run. */
	server?: ServerTools;
	/** The link holder's messages for the tower identities, as an ally run takes them (B6; absent in a world without a holder). */
	ally?: AllyPort;
	/** The Allows the dialog hub holds, against which an ally run's gated tool call (and a local run's approved `link_request`) is taken. */
	allows?: Allows;
	/** The asks the towers made for their mains. */
	asks?: Asks;
	/** The car book (carbook.ts): a forward the tower stamps and a train it opens are noted there, for the checks of the server to rest on. */
	cars?: Pick<CarBook, "noteForward" | "noteTrain" | "remoteOf">;
	/** Auto mode (automode.ts): the head's `boss_auto` acts through it. Absent on a secondary server. */
	auto?: Pick<AutoMode, "view" | "decided" | "bossAuto" | "onSwitch">;
	/** Hands the service to a test as soon as it is built. */
	expose?: (towers: Towers) => void;
}
export interface Ensured { id: string; workspace: string; label: string; tab?: string; pane?: string; opened: boolean; resident?: true; live: boolean }
export interface TowerRow { workspace: string; label: string; id: string; state: "waiting" | "registering" | "live"; queue: number; service?: ServiceStatus }
export interface Towers {
	/** Starts the service when the flag is on: converts resident-tower records, adopts every `service.json`, registers the identities, and watches Herdr. Idempotent. */
	activate(): Promise<void>;
	/** Whether the runs of the last server are loaded and the identities adopted (true when the tower runs are off: there is nothing to load). */
	loaded(): boolean;
	/** Gives a workspace its tower (a promotion, `/boss tower`, a handover from a resident tower of this build). */
	ensure(request: { workspace: string; pane?: string; cwd?: string; pid?: number; made?: { pane: string; at: number } }): Promise<Ensured>;
	/** The boss closed the tower: its tab goes, and the service with it. */
	close(workspace: string): Promise<{ workspace: string; id: string }>;
	/** The opener, with the persisted ledger, for the workspace's tower. */
	openMain(request: { workspace: string; request: string; sender: string; label?: string; role?: string }): Promise<Opened>;
	/** The `close-main` ask from the workspace's tower identity. */
	closeMain(request: { workspace: string; query: string }): ReturnType<Control["closeMain"]>;
	/** The holder's sink for a `unit-stop` that passed its checks (unitstop.ts): decides it from the route table and writes it on the route, which the revoker then carries out. Never rejects. */
	unitStop(stop: UnitStopInput): Promise<void>;
	/** The mains ally runs opened that are on record, with the name and pane state the broker and Herdr give them now (the `mains` of a unit-status). */
	mains(): Promise<MainFact[]>;
	/** A new Herdr server took over: finds the tower tabs again and writes the tokens. */
	takeover(): Promise<void>;
	status(): TowerRow[];
	stateOf(workspace: string): TowerRow["state"] | undefined; // `waiting` while a resident tower holds the workspace (the page shows that tower, not the service); none when the server stands in for no tower there
	/** A main was closed from the page: every service drops the `opened` route of that session, except one that carries a stop the box accepted, which the revoker lets go itself with its done line and notice (a close the tower makes drops it itself). Never throws. */
	forget(session: string): void;
	owns(id: string): boolean; // the session id is the identity of one of the services: it has no pi and no bridge, so it is ended, not asked to quit
	/** The runs of the services (runs.ts): claims, the run's requests, the boss's events. */
	runs: Runs;
	/** Auto mode (autotower.ts): the open boss waits that are parked, for the return list; and the end of the period, which makes them ordinary waits again. */
	parked(): ParkedRow[];
	unpark(): void;
	/** The head tower (head.ts): a service of kind `head` in a workspace of its own, made on first use and kept after; the same machinery as a workspace tower's service. */
	head: {
		ensure(): Promise<HeadEnsured>;
		close(): Promise<{ workspace: string; id: string } | undefined>;
		status(): TowerRow | undefined;
		/** The boss's words to the head, from any channel: the head workspace is made when it is missing, and a boss event with `present` wakes a run (or goes into the live one). */
		event(text: string, requester?: Requester): Promise<{ workspace: string; id: string }>;
	};
	/** The tower prompt in a standing pane (standing.ts): its poll, Ctrl+D, and exit. */
	prompt(cmd: "prompt-poll" | "prompt-leave" | "prompt-gone", workspace: string, pid: number): Promise<PromptReply | { ok: true }>;
	/** Messages wait in the link inbox for this tower identity: ally runs are started for them. */
	allyWaiting(identity: string): void;
	/** The GUI panel's request on a workspace's memory (`POST tower/<workspace>/memory`, towermemory.ts `memoryRequest`). */
	/** The boss's request on a tower's memory; a `press` waits for the raiser's notice (waitpress.ts), the rest answer at once. */
	memory(workspace: string, json: Record<string, unknown>, via?: PressDoor): { status: number; body: Record<string, unknown> } | Promise<{ status: number; body: Record<string, unknown> }>;
	/** The boss's open waits of every tower and the head, or of one workspace (or `head`): the read behind `boss-waits` (waitlist.ts). Throws for a workspace nobody serves. */
	waitList(only?: string, own?: string): WaitList;
	/** The digest of one workspace's own waits that its standing prompt's and its runs' polls carry; undefined when the server stands in for no tower there. */
	waitDigest(workspace: string): WaitDigest | undefined;
	/** A tool a run calls (`run-tool`): checked against the token's kind, done as the tower identity. */
	runTool(request: Record<string, unknown>): Promise<{ text: string; details?: unknown }>;
	/** The identities leave the broker; tokens and files stay. */
	stop(opts?: { quitRuns?: boolean }): Promise<void>;
}

interface Live {
	record: ServiceRecord;
	state: TowerRow["state"];
	client?: IntercomLike;
	kit?: HeadlessKit;
	reach?: Reach;
	control?: Control;
	open?: ReturnType<typeof opener>;
	/** The opener an ally run opens mains with: its ledger is the ally runs' own (allyroute.ts), so the local brief never lists them. */
	openAlly?: ReturnType<typeof opener>;
	/** The start in flight: the wait for a resident tower, then the registration, then the tokens. */
	starting?: Promise<void>;
	registered?: Promise<boolean>;
	/** The standing pane is being replaced (`renew`). */
	renewing?: boolean;
	/**
	 * The recorded pane is proven to be this service's own seat (typegate.ts `seatGate`). A service the server made or renewed is seated; one adopted from `service.json`, or after a Herdr came back, is not until `prove` says so: nothing is
	 * typed, marked, or woken in a pane before (a lost session's reused ids can name the boss's own shell, VM pass B7 F10). `epoch` moves whenever the proof is voided, so a proof read before it is not believed after.
	 * The proof is for one terminal of the pane (`terminal`, typegate.ts `proofGate`): each act asks it of a listing read just before, so a new Herdr that answers before the server's connections are acknowledged again is a stranger's at once.
	 */
	seated: boolean;
	terminal?: string;
	epoch: number;
	stopped: boolean;
	/** The messages taken, for dedupe (towerseen.ts); opened when the first message comes. */
	seen?: Seen;
	/** What `request-open` answered for the `link_request`s of local runs that are not yet run or dropped: request id → the lines the holder said the request does. */
	requests: Map<string, string[]>;
}

export function createTowers(o: TowersOptions): Towers {
	const { slot, cfg, log } = o, { run, sleep, now } = cfg;
	const retry = o.retryMs ?? RETRY_MS;
	const services = new Map<string, Live>();
	const opening = new Map<string, Promise<Ensured>>();
	let activation: Promise<void> | undefined, loadedAll = false, stopped = false, recoverUntil = 0, events: (() => void) | undefined;
	const timers: (ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>)[] = [];
	let republishTimer: ReturnType<typeof setTimeout> | undefined;
	let republishSoon = () => {};
	const digest = createDigest(run, now);
	/** The head tower is a service like a workspace tower's, of its own kind: its seat glyph, tokens, and folder differ (head.ts). */
	const isHeadL = (l: Live) => l.record.kind === "head";
	const kindOf = (l: Live): ServiceKind => (isHeadL(l) ? "head" : "tower");
	const headLive = () => [...services.values()].find((l) => isHeadL(l) && !l.stopped);
	/** One line in the digest of every tower workspace when the head tower opens or closes: each tower reads it at its next run (digest.ts). A workspace counts when its tower token is set (a service of this server or a resident). */
	const noteHead = (text: string) => void workspaces(run).then((all) => Promise.all(all.filter((w) => !isSub(w) && !isHead(w) && w.tokens?.tower).map((w) => digest.note(w.workspace_id, text).catch(() => {})))).catch(() => {});
	let looking: Promise<void> = Promise.resolve();
	/** What the tower brief says of the head tower, and what the head's brief says of a workspace's tower. */
	/** The auto mode line of a brief: present only while it is on (autotower.ts). */
	const autoLine = (): string | undefined => ((v) => (v?.on ? briefLine(v.since) : undefined))(o.auto?.view());
	const headState = (): string => ((h) => (h ? stateWord(runs.status(h.record.workspace)?.state, "open") : "not opened"))(headLive());
	const towerState = (workspace: string, tokens: Record<string, string> | undefined): string => ((l) => stateWord(l && !l.stopped && !isHeadL(l) ? runs.status(workspace)?.state : undefined, tokens?.tower ? "an older tower" : "none"))(services.get(workspace));

	// --- runs ---------------------------------------------------------------------------------------------------------------------------------------------------------------

	/** What the run hub (runs.ts) needs of one service: its record, whether its identity is registered, the folder to check, and the brief (built here from the net, the ledger, the digest, and the last note). */
	const refOf = (l: Live): ServiceRef => ({
		workspace: l.record.workspace,
		record: () => l.record,
		live: () => l.state === "live" && l.seated && Boolean(l.client?.isConnected()),
		proven: () => proven(l),
		cwd: async () => (await panes(run, l.record.workspace).catch(() => [])).find((p) => p.pane_id === l.record.pane)?.cwd ?? l.record.cwd ?? slot.stateDir,
		towerKey: async () => (isHeadL(l) ? undefined : (await netTokens(run, place(l), "tower", l.record.name, now(), cfg.world)).own.sb_order ?? undefined),
		yieldPane: () => standing.yieldPane(l.record.workspace),
		freed: (over) => standing.freed(l.record.workspace, over?.fresh, over?.keepParked),
		clearDigest: (keys) => digest.drop(l.record.workspace, keys),
		renewPane: (runId) => renew(l, runId),
		renewing: () => l.renewing === true,
		// The run that was shown an expired wait has polled: it will not be shown again (towermemory.ts).
		shown: (ids) => { try { markShown(slot, l.record.workspace, now(), ids); } catch (cause) { error("memory", (cause as Error).message); } },
		memory: () => {
			const { memory, problem } = readMemory(slot, l.record.workspace, now());
			return { ...memorySummary(memory, isHeadL(l) ? now() : undefined), ...(problem ? { problem } : {}) };
		},
		// A live run is given a new brief when the memory moved or a run left a note (runs.ts `refreshed`): what a conversation of an hour would otherwise not see.
		briefVersion: () => `${readMemory(slot, l.record.workspace, now()).memory.rev}:${o.auto?.view().on ? `auto${o.auto.view().since}:` : ""}${lastNote(slot, l.record.workspace, "local")?.at ?? ""}${isHeadL(l) ? `:${openAsks(slot, now()).map((a) => `${a.id}.${a.answers.length}`).join(",")}` : ""}`,
		liveSessions: async () => (await panes(run).catch(() => [])).flatMap((p) => (p.agent_session?.value ? [p.agent_session.value] : [])),
		allyLine: (item) => {
			const mine = { name: allyLabel(l.record.name), id: l.record.id, role: "tower" as const, workspace: allyLabel(l.record.label) };
			// An answer a local session gave to what the run asked or opened: no verified peer header, the session is local; the device's next run reads it as data.
			if (item.local) return stamp({ from: { name: allyLabel(item.local.name), id: item.local.id, role: "session" }, kind: "tower_reply", scope: "session", to: [mine], reply: false, ...(item.awaitsReply ? { asks: item.awaitsReply } : {}) }, item.text);
			const from = { name: item.label, id: `link:${item.device}`, role: "tower" as const, ...(item.fromWorkspace ? { workspace: item.fromWorkspace } : {}) };
			return stamp({ from, kind: "tower_send", scope: "tower", to: [mine], reply: item.replyExpected, remote: { device: item.label, short: item.short, team: item.teamName }, ...(item.awaitsReply ? { asks: item.awaitsReply } : {}) }, item.text);
		},
		async allyBrief({ run: rec, items, woken }) {
			const ws = l.record.workspace, all = await workspaces(run), target = all.find((w) => w.workspace_id === ws);
			if (!target || !l.client) throw new Error("the tower's workspace or its intercom connection is gone");
			const first = items[0], device = rec.device ?? "";
			const mains = await gatherMains({ run, now, sessions: () => l.client!.listSessions(), boardDir: join(slot.stateDir, "board"), workspace: target, ledger: [], within: { project: rec.team ? o.ally?.project(rec.team) : undefined } });
			const note = lastNote(slot, ws, "ally", device), at = new Date(woken);
			const line = (text: string) => text.split("\n").find((x) => x.trim()) ?? "";
			return {
				text: buildAllyBrief({
					device: { label: rec.deviceLabel ?? first?.label ?? device.slice(0, 6), short: first?.short ?? device.slice(0, 6), team: first?.teamName ?? rec.team?.slice(0, 6) ?? "", level: rec.level ?? "reply" },
					workspace: ws, label: l.record.label, woken: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, seen: mains.rows,
					...(note ? { note: { text: note.note, age: ageOf(now() - Date.parse(note.at)) } } : {}),
					asks: items.filter((i) => i.awaitsReply || i.askedBy).map((i) => ({ ...(i.awaitsReply ? { id: i.awaitsReply } : {}), first: line(i.text), ...(i.askedBy ? { askedBy: i.askedBy } : {}) })),
					thread: (o.ally?.thread(device) ?? []).map((m) => ({ dir: m.dir, kind: m.kind, text: m.text, age: ageOf(now() - m.at) })),
					tools: allyTools(rec.level ?? "reply"),
				}),
			};
		},
		async brief({ events, woken, run: rec, refresh }) {
			const ws = l.record.workspace, all = await workspaces(run), target = all.find((w) => w.workspace_id === ws);
			if (!target || !l.client) throw new Error("the tower's workspace or its intercom connection is gone");
			if (isHeadL(l)) return headBrief({ slot, run, now, auto: autoLine, record: () => l.record, sessions: () => l.client!.listSessions(), towerState, locale: localeOf(o.env) }, { woken, run: rec });
			const mains = await gatherMains({ run, now, sessions: () => l.client!.listSessions(), boardDir: join(slot.stateDir, "board"), workspace: target, ledger: readLedger(slot, ws, now()) });
			const lines = await digest.peek(ws).catch(() => []), note = lastNote(slot, ws, "local"), timer = readTimer(slot, ws);
			const counts: Record<string, number> = {};
			for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
			const crashed = events.filter((e) => e.flag === "crash"), oldest = events.map((e) => now() - Date.parse(e.at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
			const at = new Date(woken);
			// The boss's standing instructions and decisions and the open waits (towermemory.ts): a local brief only, never an ally's. An expired wait is shown once.
			const kept = readMemory(slot, ws, now()), section = memorySection(kept.memory, now(), kept.problem);
			const talk = rec.conversation && conversationLines(rec.conversation, ws);
			return {
				digestKeys: lines.map((x) => x.key),
				expired: section.expired,
				text: buildBrief({
					label: l.record.label, workspace: ws, head: headState(), woken: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, counts, identity: l.record.id,
					...(autoLine() ? { auto: autoLine()! } : {}), ...(refresh ? { refreshed: true as const } : {}), ...(talk ? { conversation: talk.line, since: talk.since } : {}),
					memory: section.text, mains: mains.rows, obligations: [...mains.opened, ...(o.asks?.openOf(ws) ?? []).map((a) => `an ask for the main ${a.forName} is open (sent ${ageOf(now() - a.at)} ago): its answer goes to that main, not to you`), ...readExpects(slot, ws, now()).map((e) => `waiting for a reply from ${e.name} (asked ${ageOf(now() - e.at)} ago): ${e.first}`), ...(timer && timer.at <= now() ? ["your wakeAfter follow-up is due"] : [])], digest: lines.map((x) => x.line),
					...(note ? { note: { text: note.note, age: ageOf(now() - Date.parse(note.at)) } } : {}),
					flags: [
						...(crashed.length ? [`${crashed.length} event${crashed.length > 1 ? "s were" : " was"} possibly handled by a run that crashed: check before acting.`] : []),
						...(oldest !== undefined && oldest > 10 * 60_000 ? [`The oldest event waiting is ${ageOf(oldest)} old.`] : []),
					],
					tools: localTools(localeOf(o.env)),
				}),
			};
		},
	});
	// The link holder's messages for the identity, and beside them the answers local sessions gave to what ally runs asked or opened (allyroute.ts): both are for a device's next ally run, neither enters a local run.
	const workspaceOf = (identity: string) => [...services.values()].find((x) => x.record.id === identity)?.record.workspace;
	const LOCAL = "local-";
	const allyPort: AllyPort | undefined = o.ally && {
		standing: (device, team) => o.ally!.standing(device, team),
		project: (team) => o.ally!.project(team),
		thread: (device) => o.ally!.thread(device),
		known: (team) => o.ally!.known?.(team) ?? true,
		waiting: (identity) => {
			const ws = workspaceOf(identity), answers: AllyItem[] = ws ? readAnswers(slot, ws, now()).map((a) => ({ id: `${LOCAL}${a.id}`, device: a.device, label: a.label, short: a.short, team: a.team, teamName: a.teamName, fromWorkspace: "", replyExpected: false, text: a.text, at: a.at, local: a.from, ...(a.ask ? { awaitsReply: a.ask } : {}) })) : [];
			return [...o.ally!.waiting(identity), ...answers].sort((a, b) => a.at - b.at);
		},
		delivered: (id, run) => { if (!id.startsWith(LOCAL)) o.ally!.delivered?.(id, run); },
		taken: async (id, identity) => {
			const ws = workspaceOf(identity);
			if (!id.startsWith(LOCAL)) return o.ally!.taken(id, identity);
			if (ws) removeAnswer(slot, ws, id.slice(LOCAL.length), now());
		},
	};
	/** The brief's section 1a: how the boss conversation began, and what the event runs left since the boss last talked with the tower (the first lines of up to 3 notes, 1,200 characters together). */
	const conversationLines = (c: ConversationInfo, ws: string): { line: string; since: string[] } => {
		const day = (at?: string) => (at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleDateString("sv") : "an unknown day");
		const line = c.resumed ? `Boss conversation: the boss is at this pane. Resumed session from ${day(c.from)}, ${c.turns} boss turn${c.turns === 1 ? "" : "s"}.` : `Boss conversation: the boss is at this pane. New session: ${c.why ?? "no earlier boss session"}.`;
		const after = c.after ? Date.parse(c.after) : NaN, events = new Map(listRuns(slot, ws).filter((r) => r.kind === "local" && !r.conversation).map((r) => [r.id, r]));
		// An event run the boss spoke in after their last conversation turn is named with when, so the resumed session knows who said what to whom.
		const spoke = (id: string) => { const at = events.get(id)?.bossIn; return at !== undefined && (!Number.isFinite(after) || Date.parse(at) > after) ? at : undefined; };
		const notes = readNotes(slot, ws).filter((n) => n.kind === "local" && events.has(n.run) && (spoke(n.run) !== undefined || (Number.isFinite(after) && Date.parse(n.at) > after))).slice(-3);
		const rows = notes.map((n) => `- ${ageOf(now() - Date.parse(n.at))} ago${spoke(n.run) ? ` (the boss spoke in this run ${ageOf(now() - Date.parse(spoke(n.run)!))} ago, so what they said is in that run's session, not in yours)` : ""}: that run's own handoff note, not the boss's words: «${phrase(n.note.split("\n")[0], 340).replace(/[«»]/g, "")}»`);
		return { line, since: rows };
	};
	const runs: Runs = createRuns({ slot, run, sleep, now, log, sessions: sessionsRoot(o.env), enabled: o.enabled, max: () => readTowerRuns(slot.stateDir).max, trustDir: trustDir(slot.stateDir), model: () => towerModel(slot.stateDir), headModel: () => headModel(slot.stateDir), ...(allyPort ? { ally: allyPort } : {}), ...o.runs });

	const standing = createStanding({ run, api: cfg.api, world: cfg.world, sleep, now, log, command: o.promptCommand ?? (() => undefined), timers: o.standing, ...(o.standingWait ? { wait: o.standingWait } : {}), ...(o.runs?.platform ? { platform: o.runs.platform } : {}), ...(o.runs?.alive ? { alive: o.runs.alive } : {}) });
	const place = (l: Live): Place => ({ paneId: l.record.pane, tabId: l.record.tab, workspaceId: l.record.workspace });
	const dirOf = (workspace: string) => join(towerDir(slot, workspace));
	const error = (code: string, text: string) => log.line("error", { code, text: phrase(text, 300) });

	// --- the identity -------------------------------------------------------------------------------------------------------------------------------------------------------------

	/**
	 * A wait on a session now has a message to look at (whether it answers the wait is the run's to judge). The id on the message is the broker's, so the wait is marked only when the net the server reads
	 * (Herdr's panes and the broker's sessions) shows a live session with that id in this tower's workspace.
	 */
	const markAnswered = async (l: Live, session: string): Promise<void> => {
		try {
			const ws = l.record.workspace;
			if (!hasWaitOn(slot, ws, session)) return;
			const live = (await l.reach?.read())?.sessions.find((x) => x.id === session);
			if (live?.herdrLocation?.workspace?.id !== ws) return;
			for (const id of noteMessage(slot, ws, now(), session)) log.line("tower-memory", { workspace: ws, op: "answered", id });
		} catch (cause) { error("memory", (cause as Error).message); }
	};
	const wire = (l: Live, client: IntercomLike) => {
		client.on("message", (from: Session, message: Incoming) => {
			// The head tower takes only the answers to its own asks (headgate.ts); the boss's words come through the run hub. Everything else is refused, with a receipt, and nothing is queued or woken.
			if (isHeadL(l)) return void headIntake({ slot, log, now, record: () => l.record, seen: () => (l.seen ??= openSeen(slot, l.record.workspace, now)), poke: () => runs.poke(l.record.workspace), towerOf: async (id) => [...services.values()].find((x) => x.record.id === id && !isHeadL(x) && !x.stopped)?.record.workspace ?? (await workspaces(run)).find((w) => w.tokens?.tower === id)?.workspace_id }, client, from, message);
			// Written to disk with a flush, then receipted, then remembered (towerseen.ts). The receipt `queued` goes only after the flush: the broker waits for it, and a sender whose message is not
			// confirmed retries it, which the dedupe makes safe. No text reaches the log.
			try {
				const seen = (l.seen ??= openSeen(slot, l.record.workspace, now)), verdict = seen.check(from.id, message.id, message.content.text);
				if (verdict === "conflict") return log.line("tower-dropped", { workspace: l.record.workspace, from: from.id, why: "the same message id with other content" });
				const ws = l.record.workspace, route = verdict === "new" ? routeOf(slot, ws, from.id, now()) : undefined, local = route && readExpects(slot, ws, now()).find((e) => e.to === from.id);
				if (route && (!local || route.at >= local.at)) {
					// A session an ally run wrote to or opened is answering the device, not the local run: the answer waits for the device's next ally run.
					addAnswer(slot, ws, { id: `${Date.now().toString(36)}-${message.id}`.slice(0, 80), device: route.device, label: route.label, short: route.short, team: route.team, teamName: route.teamName, from: { id: from.id, name: phrase(from.name ?? from.id, 40) }, text: message.content.text, at: now(), ...(route.ask ? { ask: route.ask } : {}) }, now());
					spendRoute(slot, ws, route, now());
					seen.add(from.id, message.id, message.content.text);
					log.line("tower-ally-answer", { workspace: ws, from: from.id });
					runs.pokeAllies(l.record.id);
				} else if (verdict === "new") {
					const written = appendEvent(slot, l.record, { kind: "intercom", from: { id: from.id, ...(from.name ? { name: from.name } : {}) }, text: relayOnlyFromHead(slot, from.id, message.content.text), at: new Date(now()).toISOString(), messageId: message.id });
					seen.add(from.id, message.id, message.content.text);
					clearExpect(slot, l.record.workspace, from.id, now());
					void markAnswered(l, from.id);
					log.line("tower-event", { workspace: l.record.workspace, kind: "intercom", from: from.id, seq: written.seq });
					runs.poke(l.record.workspace);
				}
				client.sendMessageReceipt?.({ messageId: message.id, status: "queued", timestamp: now() });
			} catch (cause) {
				error("queue", `an event for ${l.record.id} could not be queued: ${(cause as Error).message}`);
			}
		});
		client.on("disconnected", () => void reconnect(l, client));
		client.on("error", () => {});
	};
	const registration = (l: Live) => ({ name: l.record.name, cwd: dirOf(l.record.workspace), model: "straw-boss-tower", pid: o.pid, startedAt: o.startedAt, lastActivity: now(), herdrPaneId: l.record.pane, acknowledgesReceipts: true });

	/** The first connection of an identity: the kit and the modules made from it, the `close-main` channel, then the registration (retried until it holds or the service is gone). */
	const register = (l: Live): Promise<boolean> => (l.registered ??= (async () => {
		for (let attempt = 0; !l.stopped && !stopped; attempt++) {
			try {
				const client = await o.connect();
				if (l.stopped || stopped) return (await client.disconnect().catch(() => {}), false);
				if (!l.kit) {
					const env = { ...o.env, PI_INTERCOM_SESSION_ID: l.record.id, STRAW_BOSS_ROLE: "tower" };
					const kit = createHeadlessKit({ client, env, cfg, log: (text, level) => level === "error" && error("tower", text) });
					// SAFETY: `s.c` is the tab channel in a session; the modules made here ask it for the live sessions only, which is all this object answers.
					kit.s.c = { listSessions: () => (l.client ?? client).listSessions(), snapshot: () => ({ connected: (l.client ?? client).isConnected(), supported: false }), publish() {}, commitState() {} } as unknown as typeof kit.s.c;
					kit.s.at = place(l);
					kit.s.ownName = l.record.name;
					l.kit = kit;
					l.reach = createReach(kit, undefined, { retryCapMs: RUN_SEND_CAP_MS });
					// The head opens and closes no mains: it has no opener and no `close-main` channel (HH1-F006).
					if (!isHeadL(l)) (l.control = createCloseMain(kit, { closeSelf: () => "A tower service closes no mains for itself; ask it to close one.", check: () => undefined }), l.control.register());
					// Two openers over the same tower: the local run's, whose ledger the local brief lists, and the ally runs', whose ledger is their own (allyroute.ts).
					const openerFor = (file?: string) => opener({
						run, sleep, workspaceId: l.record.workspace, cwd: l.record.cwd ?? slot.stateDir, sessions: () => (l.client ?? client).listSessions(), send: (to, message) => l.reach!.send(to, message),
						tower: () => ({ id: l.record.id, name: l.record.name }), trustDir: trustDir(slot.stateDir), integrationOff: () => integrationOff(o.env, slot.stateDir), stateDir: slot.stateDir,
						ledger: { entries: () => readLedger(slot, l.record.workspace, now(), file), put: (row) => { try { putLedger(slot, l.record.workspace, row, now(), file); } catch (cause) { error("ledger", (cause as Error).message); } } },
					});
					if (!isHeadL(l)) (l.open = noteTrains(openerFor(), { cars: o.cars, checkout: async () => (await workspaces(run)).find((w) => w.workspace_id === l.record.workspace)?.worktree?.checkout_path ?? l.record.cwd, error }), l.openAlly = openerFor(ALLY_LEDGER));
				}
				l.kit.attach(client);
				l.client = client;
				wire(l, client);
				mkdirSync(dirOf(l.record.workspace), { recursive: true, mode: 0o700 });
				await client.connect(registration(l), l.record.id);
				log.line("tower-registered", { workspace: l.record.workspace, id: l.record.id, pane: l.record.pane });
				return true;
			} catch (cause) {
				error("tower-register", `${l.record.id}: ${(cause as Error).message}`);
				await sleep(retry[Math.min(attempt, retry.length - 1)]!);
			}
		}
		return false;
	})());

	const reconnect = async (l: Live, dropped: IntercomLike) => {
		if (l.stopped || stopped || dropped !== l.client) return;
		log.line("tower-lost-intercom", { workspace: l.record.workspace });
		l.registered = undefined;
		l.state = "registering";
		if (await register(l)) (l.state = "live", runs.poke(l.record.workspace));
	};
	const release = async (l: Live) => {
		l.stopped = true;
		const client = l.client;
		l.client = undefined;
		await Promise.race([client?.disconnect().catch(() => {}), sleep(LEAVE_MS)]);
	};

	// --- tokens ---------------------------------------------------------------------------------------------------------------------------------------------------------------

	/** The marks the guard, `tower_list`, the dashboard, and the sidebar find the tower by: the workspace's `tower` token and the standing pane's role and sort key. Display and discovery only. */
	const published = new WeakMap<Live, string>();
	/** `ifChanged`: a republish after a workspace event writes nothing when the tokens are the ones last written. */
	const publish = async (l: Live, ifChanged = false) => {
		// Nothing is written to a pane that is not proven to be the tower's own (a stranger's shell under a reused id gets no marks).
		if (!l.seated) return;
		// A live foreign holder keeps the workspace: this service steps back and waits for it (a hand-over whose reply was lost leaves the resident running and publishing its own token).
		const foreign = await residentOf(l);
		if (foreign) return void (await yieldTo(l, foreign));
		// The head's pane is always first in the net view; a tower's key depends on its place in Herdr's order.
		const own: Record<string, string | null> = isHeadL(l) ? { sb_order: HEAD_ORDER } : await netTokens(run, place(l), "tower", l.record.name, now(), cfg.world).then((net) => net.own, () => ({}));
		const key = JSON.stringify(own);
		// Nothing is written for an unchanged key, so the proof (one more listing) is not asked for.
		if (ifChanged && published.get(l) === key) return;
		// The proof is asked of a listing read now, after the reads above: the marks go only to a pane that is still in the terminal it was proven for.
		if (!(await proven(l))) return;
		let wrote = true;
		await Promise.all([
			report(run, "workspace", l.record.workspace, isHeadL(l) ? { [HEAD_TOKEN]: l.record.id } : { tower: l.record.id, sb_tower_quit: null }),
			report(run, "pane", l.record.pane, { sb_role: isHeadL(l) ? "head" : "tower", ...own }),
		]).catch((cause: Error) => {
			wrote = false;
			// The pane (or its workspace) is gone: the pane a handover replaced, a workspace closed while no server ran. The reconcile loses the service, or finds its tab again within the recovery window; a report to what is not there is no error.
			if (/\b(pane|workspace)_not_found\b/.test(cause.message)) return log.line("tokens-dropped", { workspace: l.record.workspace, pane: l.record.pane, why: phrase(cause.message, 120) });
			error("tokens", `${l.record.id}: ${cause.message}`);
		});
		// The key counts as written only once the write went through: a failed one is tried again by the next pass.
		if (wrote) published.set(l, key);
		// The panes of its ally runs are keyed after it.
		if (!isHeadL(l)) await runs.markAllies(l.record.workspace, own.sb_order ?? null);
	};
	const yieldTo = async (l: Live, holder: string) => {
		if (l.stopped || services.get(l.record.workspace) !== l) return;
		log.line("tower-yield", { workspace: l.record.workspace, resident: holder });
		await release(l);
		services.set(l.record.workspace, adopt(l.record));
	};
	const CLEAR = { sb_role: null, sb_order: null, sb_mark: null, sb_indent: null, sb_name: null, sb_tab: null, sb_main_tab: null, sb_member_tab: null };

	// --- finding the tab ---------------------------------------------------------------------------------------------------------------------------------------------------------

	/**
	 * The standing pane: the recorded one when Herdr kept it. After a Herdr restart (`fallback`) a tab labelled with the tower glyph that has a single pane in the workspace stands
	 * in for a pane whose id was not kept. Undefined when neither is there.
	 */
	const locate = async (l: Live, fallback: boolean, notId?: string): Promise<Pane | undefined> => {
		const ps = await panes(run, l.record.workspace);
		// `notId`: the pane under the recorded id is a stranger's (`prove`), so only the tab the glyph names can stand in.
		const byId = notId ? undefined : ps.find((p) => p.pane_id === l.record.pane);
		if (byId || !fallback) return byId;
		const claimed = new Set([...services.values()].filter((x) => x !== l).map((x) => x.record.pane));
		const candidates = (await tabs(run, l.record.workspace)).filter((t) => t.label === SEAT_LABEL[kindOf(l)]).flatMap((t) => {
			const inside = ps.filter((p) => p.tab_id === t.tab_id);
			return inside.length === 1 && !claimed.has(inside[0]!.pane_id) ? [inside[0]!] : [];
		});
		return candidates[0];
	};

	/**
	 * Whether the pane (the recorded one, or the one a restore put the tower's tab in) is this service's own seat: the facts are read here, the answer is typegate.ts `seatGate`'s. A proof of the recorded pane seats the service,
	 * unless the proof was voided or the record moved while Herdr answered. `unknown`: Herdr did not answer, nothing is proven or refuted.
	 */
	const prove = async (l: Live, pane?: Pane): Promise<SeatVerdict | "unknown"> => {
		const record = l.record, epoch = l.epoch;
		try {
			const seat = pane ?? (await panes(run, record.workspace)).find((p) => p.pane_id === record.pane);
			const tab = seat ? (await tabs(run, record.workspace)).find((t) => t.tab_id === seat.tab_id) : undefined;
			const verdict = seatGate({ pane: seat, tab, kind: kindOf(l) });
			// The proof is for the terminal the pane is in now (`terminal` stays undefined where Herdr lists none).
			if (verdict === "ours" && seat?.pane_id === record.pane && l.record === record && l.epoch === epoch && !l.stopped) (l.seated = true, l.terminal = seat.terminal_id);
			return verdict;
		} catch {
			return "unknown";
		}
	};
	/** The proof of one service is void until it is proven again; a look of it that is in flight stops at its next question. */
	const voidSeat = (l: Live) => {
		l.seated = false;
		l.terminal = undefined;
		l.epoch++;
	};
	/** A Herdr came back (or its events connection did): what was proven of the panes is void until it is proven again. */
	const unseat = () => {
		for (const l of services.values()) voidSeat(l);
	};
	/** A new Herdr server holds the ids: every proof is void, and the minute in which a restore brings the tabs back opens (the events connection acknowledging again says the same, up to two seconds later). */
	const herdrChanged = () => {
		unseat();
		recoverUntil = Math.max(recoverUntil, now() + (o.recoverMs ?? RECOVER_MS));
	};
	/**
	 * Whether the proof still holds for the pane as `pane` lists it (typegate.ts `proofGate`); an act that rests on the proof asks it of a listing it has just read. A pane in another terminal than the one proven means a new Herdr
	 * server (Herdr gives every pane of a new server a new terminal id): the proof is void, the minute opens, and the look proves the seats again, which a pane under a reused id never passes. A proof made for a pane whose
	 * terminal was not known (a tab this server made a moment ago) takes the terminal of the first listing that shows it.
	 */
	const holds = (l: Live, pane: Pane | undefined): boolean => {
		if (!l.seated || l.stopped) return false;
		switch (proofGate({ terminal: l.terminal, pane })) {
			case "holds":
				return true;
			case "bind":
				l.terminal = pane!.terminal_id;
				return true;
			case "moved":
				log.line("tower-unseated", { workspace: l.record.workspace, pane: l.record.pane, why: "the pane is in another terminal than the one proven: a new Herdr server" });
				herdrChanged();
				void look();
				return false;
			default:
				return false;
		}
	};
	/** `holds`, for a listing read now: a run's start and the marks use it; a listing that fails proves nothing. */
	const proven = async (l: Live): Promise<boolean> => {
		if (!l.seated || l.stopped) return false;
		const record = l.record, epoch = l.epoch;
		try {
			const pane = (await panes(run, record.workspace)).find((p) => p.pane_id === record.pane);
			return l.record === record && l.epoch === epoch && holds(l, pane);
		} catch {
			return false;
		}
	};

	/** The boss closed the tower, or its tab is gone: the identity leaves, the marks go, `sb_tower_quit` records how many members the base had, and the record goes. The queue stays 24 h. */
	const lose = async (l: Live, why: string, stranger = false) => {
		// A look of this service that is waiting on Herdr stops at its next question: it types nothing after the service is gone.
		voidSeat(l);
		if (services.get(l.record.workspace) === l) services.delete(l.record.workspace);
		await standing.detach(l.record.workspace);
		await runs.detach(l.record.workspace, why);
		await release(l);
		log.line("tower-closed", { workspace: l.record.workspace, id: l.record.id, why });
		// A pane that proved to be a stranger's is not ours to mark or clear, not even as a quit tower's.
		if (!stranger) try {
			const [ps, all] = await Promise.all([panes(run, l.record.workspace).catch(() => []), workspaces(run)]);
			const held = all.find((w) => w.workspace_id === l.record.workspace)?.tokens?.[isHeadL(l) ? HEAD_TOKEN : "tower"];
			// Another tower's token (a resident tower that took the workspace) is not ours to clear.
			if (all.some((w) => w.workspace_id === l.record.workspace) && (!held || held === l.record.id)) {
				const members = ps.filter((p) => isSessionRole(p.tokens?.sb_role)).length;
				await report(run, "workspace", l.record.workspace, isHeadL(l) ? { [HEAD_TOKEN]: null } : { tower: null, sb_tower_quit: String(members) }).catch(() => {});
			}
			if (ps.some((p) => p.pane_id === l.record.pane)) await report(run, "pane", l.record.pane, CLEAR).catch(() => {});
		} catch (cause) {
			error("tower-closed", (cause as Error).message);
		}
		deleteService(slot, l.record.workspace, l.record.kind);
		if (isHeadL(l) && !services.has(l.record.workspace)) unbindDir(slot, l.record.workspace);
		if (isHeadL(l) && !stopped) noteHead("head tower closed");
	};

	/** What the old standing pane may lose: its own shell (the process Herdr started there, `shell_pid`) or a process that carries the run's id (its pi or the wrapper that started it). Anything else, an interpreter running the boss's script included, is the boss's own program. Unknown (an unreadable or empty list) is kept. */
	const closable = async (pane: string, runId: string): Promise<boolean> => {
		try {
			const info = JSON.parse(await run(["pane", "process-info", "--pane", pane])).result?.process_info as { shell_pid?: number; foreground_processes?: { pid?: number; cmdline?: string }[] } | undefined;
			const list = info?.foreground_processes;
			if (!Array.isArray(list) || !list.length) return false;
			return list.every((p) => p.cmdline?.includes(`--sb-run ${runId}`) || (typeof info?.shell_pid === "number" && p.pid === info.shell_pid));
		} catch {
			return false; // unknown is not a shell
		}
	};
	/**
	 * A fresh standing pane for a service whose pane a forced kill left unusable (Windows: a pi ended with TerminateProcess leaves the console in a mode where the next `agent start` there types a mangled command and
	 * times out). The tab is made and marked as `openFor` makes one, the record moves to it as `reconcile` moves it when Herdr kept neither id, and the old standing pane is closed when it holds nothing but a shell or
	 * the run's own pi (never the tab, which may hold ally panes and the boss's splits; never a pane running the boss's program, which only loses its marks); a tab that keeps panes loses the tower label. The service
	 * keeps its runs, queue, and notices. The identity is not live while this runs, so no run wakes in the old pane, and a pi typed into it is told to quit. Returns the new pane.
	 */
	const renew = async (l: Live, runId: string): Promise<string | undefined> => {
		const ws = l.record.workspace, old = l.record, was = l.state;
		const gone = () => stopped || services.get(ws) !== l;
		if (l.stopped || gone() || l.renewing || isHeadL(l)) return undefined;
		l.state = "registering";
		l.renewing = true;
		let made: Awaited<ReturnType<typeof createTab>> | undefined;
		// The service was closed (or retired) while this ran: the new tab is not left standing.
		const abandon = async () => {
			if (made) await run(["tab", "close", made.tabId]).catch(() => {});
			return undefined;
		};
		try {
			const target = (await workspaces(run)).find((w) => w.workspace_id === ws);
			if (!target) throw new Error("its workspace is gone");
			const dir = old.cwd ?? target.worktree?.checkout_path ?? slot.stateDir;
			made = await createTab(run, ws, dir, [], TOWER_LABEL);
			if (gone() || l.stopped) return await abandon();
			await report(run, "pane", made.paneId, { sb_role: "tower" });
			if (gone() || l.stopped) return await abandon();
			await cfg.api("tab.move", { tab_id: made.tabId, insert_index: 0 }).catch((cause: Error) => error("tab-move", cause.message));
			if (gone() || l.stopped) return await abandon();
			l.record = { ...old, pane: made.paneId, tab: made.tabId, cwd: dir };
			writeService(slot, l.record);
			log.line("tower-renewed", { workspace: ws, pane: made.paneId, was: old.pane });
			// The old pane is looked at last: whatever was typed into it meanwhile is seen.
			const closed = (await closable(old.pane, runId)) && (await run(["pane", "close", old.pane]).then(() => true, () => false));
			if (!closed) await report(run, "pane", old.pane, CLEAR).catch(() => {});
			// A tab that keeps a pane (ally runs, the boss's splits, the pane that was kept) is no longer the tower's.
			if ((await panes(run, ws).catch(() => [])).some((p) => p.tab_id === old.tab)) await run(["tab", "rename", old.tab, FORMER_LABEL]).catch(() => {});
			// The record names the new pane now: a server stop leaves it for the next server; only a service that was lost or retired (gone from the map) takes it down. A stop marks `l` stopped as well, so that flag does not tell the two apart.
			if (services.get(ws) !== l) return await abandon();
			if (stopped || l.stopped) return undefined;
			await release(l);
			if (services.get(ws) !== l) return await abandon();
			if (stopped) return undefined;
			services.set(ws, adopt(l.record, false, true));
			return made.paneId;
		} catch (cause) {
			error("tower-renew", `${old.id}: ${(cause as Error).message}`);
			if (l.record === old && !l.stopped) l.state = was;
			return undefined;
		} finally {
			l.renewing = false;
		}
	};

	/** One look at every service's tab. A tab that is gone ends its service, except in the minute after a Herdr restart (or this server's start), when it is looked for again. */
	const reconcile = async () => {
		let all: Workspace[];
		try {
			all = await workspaces(run);
		} catch {
			return; // Herdr does not answer: nothing is known, nothing is lost
		}
		const recovering = now() < recoverUntil;
		if (!all.length && recovering) return;
		for (const l of [...services.values()]) {
			if (l.stopped) continue;
			let found: Pane | undefined;
			try {
				found = all.some((w) => w.workspace_id === l.record.workspace) ? await locate(l, recovering) : undefined;
			} catch {
				continue; // a pane or tab list that failed is unknown, not a tab that is gone
			}
			if (!found) {
				// A service not seated on this Herdr is lost as a stranger's workspace unless it still carries the label of the one the service made: the id may name the boss's own workspace of a lost session (RVSEAT6-F006).
				if (!recovering) await lose(l, "its tab is gone", !l.seated && all.find((w) => w.workspace_id === l.record.workspace)?.label !== l.record.label);
				continue;
			}
			// After a Herdr came back the ids prove nothing: the pane under the recorded id must be in a tab the service made (`seatGate`), else it is a stranger's (a lost session's counters named the boss's own workspace).
			// While the minute after a restore runs the tower's tab may stand under other ids, and is looked for; a stranger is never typed into, marked, or woken in, and the service ends when no tab is found.
			let seated = false;
			if (!l.seated) {
				const verdict = await prove(l, found);
				if (verdict === "stranger") {
					const own = recovering ? await locate(l, true, found.pane_id).catch(() => undefined) : undefined;
					if (!own) {
						if (!recovering) await lose(l, "its workspace now holds another tab under the ids it made", true);
						continue;
					}
					found = own;
				} else if (verdict !== "ours") continue;
				else seated = true;
			}
			if (found.pane_id === l.record.pane && found.tab_id === l.record.tab) {
				// The proof came now: the marks are written, the prompt typed, and a waiting run woken.
				if (seated && l.state === "live") (await publish(l), standing.kick(l.record.workspace), runs.poke(l.record.workspace));
				continue;
			}
			// Herdr kept neither id: the identity registers again with the pane it stands in now, so the broker resolves its place. The service may have ended while the questions above were asked (a close, a stranger found): its record is not written then.
			if (l.stopped || services.get(l.record.workspace) !== l) continue;
			l.record = { ...l.record, pane: found.pane_id, tab: found.tab_id };
			writeService(slot, l.record);
			log.line("tower-found", { workspace: l.record.workspace, pane: found.pane_id });
			// A service that is not live yet (waiting for a resident, registering) publishes when it gets there, with the record as it is by then.
			if (l.client) await release(l).then(() => services.set(l.record.workspace, adopt(l.record)));
			else if (l.state === "live") await publish(l);
		}
	};
	const look = () => (looking = looking.then(reconcile).catch((cause: Error) => error("reconcile", cause.message)));

	// --- the start ------------------------------------------------------------------------------------------------------------------------------------------------------------

	/** The session id of a resident tower of an older build that holds the workspace's `tower` token, when it is live. */
	const residentOf = async (l: Live): Promise<string | undefined> => {
		// A resident tower of an older build never held the head workspace: there was no head tower then.
		if (isHeadL(l)) return undefined;
		// Fails closed: a read that fails (the server's own broker connection is not up yet, Herdr does not answer) leaves a holder possible, and the service waits.
		const all = await workspaces(run).catch(() => undefined);
		if (!all) return UNKNOWN;
		const held = all.find((w) => w.workspace_id === l.record.workspace)?.tokens?.tower;
		if (!held || held === l.record.id) return undefined;
		const sessions = await o.sessions().catch(() => undefined);
		return !sessions || sessions.some((x) => x.id === held) ? held : undefined;
	};
	/** `fresh`: the standing pane was made by this call, so it is known to be a shell nobody has used (standing.ts types into it where Herdr cannot tell an idle shell from a busy one). A pane a resident tower hands over is marked by `standing.handed` once that tower's pi has left it. */
	const adopt = (record: ServiceRecord, fresh = false, seated = false, terminal?: string): Live => {
		const l: Live = { record, state: "registering", stopped: false, requests: new Map(), seated, ...(seated && terminal ? { terminal } : {}), epoch: 0 };
		const prior = services.get(record.workspace);
		// A workspace id is held by one service. A service of another kind under it is a stranger's (Herdr numbered a new workspace as it numbered a lost one): the head's `ensure` ends it first, and nothing else may take its place.
		if (prior && !prior.stopped && isHeadL(prior) !== isHeadL(l)) throw new Error(`workspace ${record.workspace} is held by the ${isHeadL(prior) ? "head tower" : "tower of another workspace"}'s service`);
		if (prior && !prior.stopped) return prior;
		services.set(record.workspace, l);
		// The head's files are in `head/`, whatever the id of its workspace is. Its runs are the hub's too (runs.ts): they resume one conversation and have the head's tools.
		if (isHeadL(l)) bindDir(slot, record.workspace, headDir(slot));
		runs.attach(refOf(l));
		standing.attach({ workspace: record.workspace, label: () => l.record.label, ...(isHeadL(l) ? { agent: STANDIN_HEAD } : {}), pane: () => l.record.pane, live: () => l.state === "live" && !l.stopped && Boolean(l.client?.isConnected()), seated: (pane) => holds(l, pane), status: () => runs.status(record.workspace), runWithin: (ms) => runs.startsWithin(record.workspace, ms), paneBusy: () => runs.paneBusy(record.workspace), busyPids: () => runs.busyPids(record.workspace), paneFree: () => runs.retry(record.workspace) }, fresh);
		l.starting = (async () => {
			// A resident tower keeps its workspace; the service registers its identity once that session leaves. Two towers never hold one workspace.
			let waited = false;
			for (let resident = await residentOf(l); resident && !l.stopped && !stopped; resident = await residentOf(l)) {
				if (!waited) log.line("tower-waiting", { workspace: record.workspace, resident });
				waited = true;
				l.state = "waiting";
				await sleep(o.residentMs ?? RESIDENT_MS);
			}
			if (l.stopped || stopped) return;
			// The resident closed its pane when it quit, and with it its tab: nothing is left to stand in.
			if (waited && (await locate(l, true).then((p) => !p, () => false))) return void (await lose(l, "the resident tower closed its tab"));
			l.state = "registering";
			if (!(await register(l))) return;
			l.state = "live";
			runs.poke(record.workspace);
			// A record read from `service.json` names a pane whose id may be a stranger's now: the reconcile ends the service when it is, or waits for the tab while a restore brings it back.
			if (!l.seated && (await prove(l)) !== "ours") return;
			runs.poke(record.workspace);
			await publish(l);
			standing.kick(record.workspace);
		})().catch((cause: Error) => error("tower-start", `${record.id}: ${cause.message}`));
		return l;
	};

	/** Records of resident towers (`roles/`) whose pane is in this Herdr become `service.json`, and are deleted. Main records are not touched. */
	const convertRoles = async () => {
		const dir = join(slot.stateDir, "roles");
		let names: string[] = [];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch { return; }
		const [ps, all] = await Promise.all([panes(run), workspaces(run)]);
		for (const name of names) {
			let record: { role?: unknown; pane?: unknown; tab?: unknown; workspace?: unknown } | undefined;
			try {
				record = JSON.parse(readFileSync(join(dir, name), "utf8"));
			} catch { continue; }
			if (record?.role !== "tower" || typeof record.pane !== "string" || typeof record.workspace !== "string") continue;
			const pane = ps.find((p) => p.pane_id === record!.pane && p.workspace_id === record!.workspace), workspace = all.find((w) => w.workspace_id === record!.workspace);
			// A pane that is not in this Herdr belongs to another one (or to a tab that is gone): the record is left for the server that finds it. Herdr ids are short counters that repeat
			// across Herdr servers and `roles/` is shared by them all, so the id alone proves nothing: the pane must also be in the recorded tab, and that tab a tower tab, or the pane
			// run the record's own session file as a live tower (its `sb_role=tower` mark). The record and the session file are files the session's own shell can write, so they alone
			// never make a seat: the glyph and the mark are Herdr's (docs/specs/2026-11-07-train-workers.md §29).
			if (!pane || !workspace || isSub(workspace) || record.tab !== pane.tab_id) continue;
			const glyph = (await tabs(run, workspace.workspace_id)).some((t) => t.tab_id === pane.tab_id && t.label === TOWER_LABEL);
			if (!glyph && !(pane.tokens?.sb_role === "tower" && typeof (record as { file?: unknown }).file === "string" && pane.agent_session?.value === (record as { file?: string }).file)) continue;
			if (!services.has(workspace.workspace_id) && !readService(slot, workspace.workspace_id)) {
				const made: ServiceRecord = { workspace: workspace.workspace_id, label: workspace.label, id: towerId(slot, workspace.workspace_id), name: towerName(slot, workspace.label), pane: pane.pane_id, tab: pane.tab_id, created: new Date(now()).toISOString(), seq: 0 };
				// A tab that is the tower's by its session file, not by the glyph, gets the glyph: it is what proves the seat after a Herdr restart (typegate.ts `seatGate`).
				if (!glyph) await run(["tab", "rename", pane.tab_id, TOWER_LABEL]).catch(() => {});
				writeService(slot, made);
				log.line("tower-converted", { workspace: made.workspace, pane: made.pane });
			}
			rmSync(join(dir, name), { force: true });
		}
	};

	const begin = async () => {
		recoverUntil = now() + (o.recoverMs ?? RECOVER_MS);
		secretDir(join(slot.dir, "tower"));
		try {
			await convertRoles();
		} catch (cause) {
			error("convert", (cause as Error).message);
		}
		purgeQueues(slot, now());
		const adopted = listServices(slot).map((record) => adopt(record));
		log.line("towers-active", { services: adopted.length });
		// The head tower's record is in `head/`, not in `tower/`.
		// Both records may name one id when Herdr lost its session and numbered anew: the tower holds it, and the head is made again by the next ask.
		const kept = readHeadService(slot), adoptedHead: Live[] = [];
		if (kept) try { adoptedHead.push(adopt(kept)); } catch (cause) { error("head-clash", (cause as Error).message); }
		let connections = 0;
		// A workspace made, closed, or moved changes every tower's place in the net: the keys are written again soon (events in a burst make one pass), not at the next refresh.
		// One timer, re-armed by every event (a trailing debounce), and one pass at a time: an event that lands while a pass runs makes one more pass after it, so the newest key is written last.
		// The refresh joins the same chain, so its publish cannot finish after a newer pass.
		let pass: Promise<void> | undefined, dirty: "changed" | "all" | undefined;
		const publishAll = (force: boolean) => {
			if (pass) {
				dirty = force || dirty === "all" ? "all" : "changed";
				return;
			}
			pass = (async () => {
				let again: typeof dirty = force ? "all" : "changed";
				while (again) {
					dirty = undefined;
					await Promise.all([...services.values()].filter((l) => l.state === "live").map((l) => publish(l, again === "changed").catch((cause: Error) => error("tokens", cause.message))));
					again = dirty;
				}
			})().finally(() => void (pass = undefined));
		};
		const republish = () => {
			if (stopped) return;
			clearTimeout(republishTimer);
			republishTimer = setTimeout(() => publishAll(false), o.republishMs ?? REPUBLISH_MS);
			republishTimer.unref();
		};
		republishSoon = republish;
		const stop = cfg.events(WATCHED, (event) => {
			// Every acknowledgement after the first is a reconnection (Herdr restarted): the recovery window opens here too, since nothing orders this connection against the watch's
			// takeover, and a tab that is not back yet must not end its service.
			if (event === null && connections++ > 0) herdrChanged();
			if (event && ORDER_EVENTS.has(event.event)) republishSoon();
			look();
		});
		events = stop;
		timers.push(setInterval(() => {
			if (!o.enabled()) return void retire().catch((cause: Error) => error("retire", cause.message));
			// A run that was refused because the seat could not be read is woken again here, at the latest.
			publishAll(true);
			for (const l of services.values()) if (l.state === "live") runs.poke(l.record.workspace);
			try {
				purgeQueues(slot, now());
			} catch (cause) {
				error("purge", (cause as Error).message);
			}
		}, o.refreshMs ?? REFRESH_MS));
		timers.push(setInterval(() => void revoker.sweep(), o.revokeMs ?? REVOKE_MS));
		// A service whose tab is not found yet (Herdr is restoring) is looked for until the minute is over; one waiting for a resident looks at it. Both stop themselves.
		const poll = o.recoverPollMs ?? RECOVER_POLL_MS;
		timers.push(setInterval(() => { if (now() < recoverUntil + poll) look(); }, poll));
		timers.forEach((t) => t.unref());
		standing.start();
		await Promise.race([Promise.all([...adopted, ...adoptedHead].map((l) => l.starting)), sleep(o.registerMs ?? REGISTER_WAIT_MS)]);
		await look();
		loadedAll = true;
	};
	/** Once, however many ask while it runs: a second start would adopt every service twice. */
	const activate = async () => {
		if (stopped) return;
		if (!o.enabled()) return void (await retire());
		activation ??= begin().catch((cause: Error) => {
			// A start that failed once is tried again by the next ask, from scratch.
			activation = undefined;
			loadedAll = false;
			timers.splice(0).forEach(clearInterval);
			clearTimeout(republishTimer);
			events?.();
			events = undefined;
			throw cause;
		});
		await activation;
	};
	/** The flag is off: the identities leave, our token goes, and `service.json`, the queues and the ledger are purged, so no message text stays on disk with no time limit. */
	const retire = async () => {
		const all = await workspaces(run).catch(() => []), heads = [...services.values()].filter(isHeadL);
		for (const l of [...services.values()]) {
			services.delete(l.record.workspace);
			await standing.detach(l.record.workspace);
			await runs.detach(l.record.workspace, "the tower service is off");
			await release(l);
			const token = isHeadL(l) ? HEAD_TOKEN : "tower";
			if (all.find((w) => w.workspace_id === l.record.workspace)?.tokens?.[token] === l.record.id) await report(run, "workspace", l.record.workspace, { [token]: null }).catch(() => {});
			log.line("tower-retired", { workspace: l.record.workspace, id: l.record.id });
		}
		const gone = purgeAll(slot);
		for (const l of heads) unbindDir(slot, l.record.workspace);
		if (gone) log.line("towers-purged", { files: gone });
	};

	// --- ensure-tower --------------------------------------------------------------------------------------------------------------------------------------------------------

	const answer = (l: Live, opened: boolean): Ensured => ({ id: l.record.id, workspace: l.record.workspace, label: l.record.label, tab: l.record.tab, pane: l.record.pane, opened, live: l.state === "live" });

	/**
	 * What the server sees of the pane the desk step says it just made (`up --dir`, desk.ts `makeBase`): it is a base the claim is believed for when the claim is seconds old and the pane is the workspace's only pane, and a bare shell
	 * nobody has used (so the prompt may be typed into it where Herdr cannot tell an idle shell from a busy one, F10) when it is marked as a tower and holds no agent. What the claim does with them is typegate.ts `claimGate`.
	 */
	const baseOf = async (ws: string, claim: { pane: string; at: number } | undefined): Promise<{ base: boolean; bare: boolean; terminal: string | undefined }> => {
		if (!claim || Math.abs(now() - claim.at) > MADE_WITHIN_MS) return { base: false, bare: false, terminal: undefined };
		const here = await panes(run, ws).catch(() => []);
		const base = here.length === 1 && here[0]!.pane_id === claim.pane;
		return { base, bare: base && here[0]!.tokens?.sb_role === "tower" && !here[0]!.agent, terminal: base ? here[0]!.terminal_id : undefined };
	};

	const openFor = async (target: Workspace, hint: string | undefined, cwd: string | undefined, handedBy?: number, claim?: { pane: string; at: number }): Promise<Ensured> => {
		const ws = target.workspace_id;
		let existing = services.get(ws);
		// A base the caller made a moment ago is new to the server: a service still registered for its id belongs to a workspace that was lost (Herdr was killed with its session unsaved and numbered the new one alike), and it is
		// dropped now instead of at the next refresh, so the new tower gets its tokens at once, whatever that service did in the pane meanwhile (it may have proven the base by its glyph, started its prompt there, and shows its
		// stand-in). The pane is a fresh shell only if nothing was typed into it since (`claimGate`).
		// A claim is used once: a service opened for this pane after the claim was made has used it, and a replay would drop the live tower and type the prompt again.
		const used = Boolean(claim && existing && !existing.stopped && existing.record.pane === claim.pane && Date.parse(existing.record.created) >= claim.at);
		const seen = used ? { base: false, bare: false, terminal: undefined } : await baseOf(ws, claim);
		const { fresh } = await claimGate({
			base: seen.base,
			bare: seen.bare,
			used,
			end: async () => {
				if (existing && !existing.stopped) await lose(existing, "its workspace was made again");
				existing = undefined;
			},
			typed: () => standing.typedSince(claim!.pane, seen.terminal, claim!.at),
		});
		if (existing && !existing.stopped) {
			// A pane list that fails is unknown: the ask fails, the service stays.
			const here = await locate(existing, false);
			// A pane under the recorded id that is a stranger's (a lost session's reused id) is no tower: the service ends and a tower is made anew.
			const stranger = here && !existing.seated && (await prove(existing, here)) === "stranger";
			if (here && !stranger) {
				if (hint === existing.record.pane) standing.handed(ws, handedBy);
				if (existing.state !== "waiting") await Promise.race([existing.starting, sleep(o.registerMs ?? REGISTER_WAIT_MS)]);
				return answer(existing, false);
			}
			// No tab is no proof of whose workspace it is: an unseated service writes to it only while it still carries the label the service made (RVSEAT6-F006).
			const foreign = stranger || (!existing.seated && (await workspaces(run).catch(() => [])).find((w) => w.workspace_id === ws)?.label !== existing.record.label);
			await lose(existing, stranger ? "its workspace now holds another tab under the ids it made" : "its tab is gone", Boolean(foreign));
		}
		// A resident tower of an older build keeps its workspace; it is the tower until it leaves.
		const draft: Live = { record: { workspace: ws, label: target.label, id: towerId(slot, ws), name: towerName(slot, target.label), pane: "", tab: "", created: "", seq: 0 }, state: "registering", stopped: false, requests: new Map(), seated: false, epoch: 0 };
		const resident = await residentOf(draft);
		if (resident) return { id: resident, workspace: ws, label: target.label, opened: false, resident: true, live: true };

		// A leftover tower tab is reused: the tab with the pane marked `sb_role=tower`, else a bare one (the tower glyph, one pane, no agent, no marker). With a pane given, that pane is the
		// standing pane: a resident tower of this build hands over the pane it runs in.
		const here = await panes(run, ws);
		const given = hint ? here.find((p) => p.pane_id === hint) : undefined;
		if (hint && !given) throw new Error(`Pane ${hint} is not in workspace ${target.label}`);
		const marked = given ?? here.find((p) => p.tokens?.sb_role === "tower");
		const bare = marked ? [] : (await tabs(run, ws)).filter((t) => t.label === TOWER_LABEL).flatMap((t) => {
			const inside = here.filter((p) => p.tab_id === t.tab_id);
			// The stand-in agent is no agent: the pane of a tower whose tokens lapsed while the prompt went on is still the tower's.
			return inside.length === 1 && (!inside[0]!.agent || isStandin(inside[0]!)) && !inside[0]!.tokens?.sb_role ? [inside[0]!] : [];
		});
		let pane = marked ?? bare[0], dir: string | undefined, made = false;
		if (!pane) {
			dir = target.worktree?.checkout_path ?? cwd ?? slot.stateDir;
			const tab = await createTab(run, ws, dir, [], TOWER_LABEL);
			pane = { pane_id: tab.paneId, tab_id: tab.tabId };
			made = true;
		} else {
			// Other shell-only leftovers are closed; failing to close one leaves a harmless tab.
			for (const extra of bare.slice(1)) await run(["tab", "close", extra.tab_id]).catch(() => {});
			if (given && (await tabs(run, ws)).find((t) => t.tab_id === given.tab_id)?.label !== TOWER_LABEL) await run(["tab", "rename", given.tab_id, TOWER_LABEL]).catch(() => {});
		}
		// Marked at once, so a tab left without its identity is recognised (while the marker lasts); the label stays display only.
		await report(run, "pane", pane.pane_id, { sb_role: "tower" });
		await cfg.api("tab.move", { tab_id: pane.tab_id, insert_index: 0 }).catch((cause: Error) => error("tab-move", cause.message));
		const record: ServiceRecord = { ...draft.record, pane: pane.pane_id, tab: pane.tab_id, ...(pane.cwd ?? dir ? { cwd: pane.cwd ?? dir } : {}), created: new Date(now()).toISOString() };
		writeService(slot, record);
		// This call chose the pane (a tab it made, a leftover tower tab, or the pane it was handed): it is the tower's seat.
		// A claim the server believes and that `claimGate` finds untouched is a fact the pane is a shell nobody has used, as a pane this call made is.
		const l = adopt(record, made || (fresh && pane.pane_id === claim?.pane), true, pane.terminal_id);
		// A pane a resident tower hands over is a shell nobody has used once that tower's pi has left it (standing.ts).
		if (given && !made) standing.handed(ws, handedBy);
		log.line("tower-opened", { workspace: ws, id: record.id, pane: record.pane, tab: record.tab });
		await Promise.race([l.starting, sleep(o.registerMs ?? REGISTER_WAIT_MS)]);
		return answer(l, true);
	};

	const ensure: Towers["ensure"] = async ({ workspace, pane, cwd, pid, made }) => {
		if (!o.enabled()) throw new Error("towerRuns.enabled is off in config.json, so the sb server stands in for no tower");
		if (stopped) throw new Error("the sb server is stopping");
		await activate();
		const all = await workspaces(run);
		const asked = all.find((w) => w.workspace_id === workspace) ?? (all.filter((w) => w.label === workspace).length === 1 ? all.find((w) => w.label === workspace) : undefined);
		if (!asked) throw new Error(`${all.filter((w) => w.label === workspace).length > 1 ? "Several workspaces match" : "No workspace matches"} "${workspace}". Workspaces: ${all.map((w) => `${w.workspace_id} (${w.label})`).join(", ")}`);
		// A sub workspace never has a tower: its parent workspace's tower serves it.
		const target = isSub(asked) ? parentOf(all, asked) : asked;
		if (!target) throw new Error(`${asked.label} is a sub workspace with no open parent workspace, so it has no tower; open the parent workspace first`);
		if (isHead(target) || headLive()?.record.workspace === target.workspace_id) throw new Error(`${target.label} is the head tower's workspace: it has no workspace tower, the head tower is its own`);
		const pending = opening.get(target.workspace_id) ?? openFor(target, target === asked ? pane : undefined, cwd, pid, target === asked ? made : undefined).finally(() => opening.delete(target.workspace_id));
		opening.set(target.workspace_id, pending);
		return pending;
	};

	// --- the head tower ------------------------------------------------------------------------------------------------------------------------------------------------------

	const head = createHead<Live>({
		slot, run, api: cfg.api, env: o.env, log, sleep, now, registerMs: o.registerMs ?? REGISTER_WAIT_MS, enabled: o.enabled, stopped: () => stopped, activate, live: headLive,
		holder: (workspace) => { const l = services.get(workspace); return l && !l.stopped ? l : undefined; }, recovering: () => now() < recoverUntil,
		locate, prove: (l, pane) => prove(l, pane), lose, adopt: (record) => adopt(record, true, true),
		answer: (l, opened) => ({ ...answer(l, opened), tab: l.record.tab, pane: l.record.pane }),
	});
	const ensureHead = async () => {
		const got = await head.ensure();
		if (got.opened) noteHead("head tower opened");
		return got;
	};
	const row = (l: Live): TowerRow => ({ workspace: l.record.workspace, label: l.record.label, id: l.record.id, state: l.state, queue: queueLength(slot, l.record.workspace), ...(runs.status(l.record.workspace) ? { service: runs.status(l.record.workspace)! } : {}) });

	const need = (workspace: string, forHead = false) => {
		const l = services.get(workspace);
		if (!l || l.stopped) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
		// The head opens no tabs (HT-D2) and closes no mains: it forwards to the workspace towers, which do (HH1-F006). Its run's own tools come through here with `forHead`.
		if (isHeadL(l) && !forHead) throw new Error(`${l.record.label} is the head tower's workspace: it opens and closes no mains, a workspace tower does`);
		if (l.state !== "live" || (!forHead && (!l.open || !l.control))) throw new Error(`The tower of workspace ${workspace} is not registered with pi-intercom yet (${l.state})`);
		return l;
	};
	/** A main that accepted the close has no use for its opened route (a main the boss closes is let go when the next one opens, or after a week). A route file that cannot be written does not undo the close. */
	const forgetClosed = <T extends { main?: string }>(ws: string, closed: T): T => { try { if (closed.main) dropOpened(slot, ws, closed.main, now()); } catch (cause) { error("ally-route", (cause as Error).message); } return closed; };
	/** The mains ally runs opened end with their controller's dispatch (revoke.ts): asked to quit as `boss_close_main` asks, the admins told through the same notice channel as a run's end. */
	/** The `opened` rows of every live service: a main an ally run opened for a device, with the stop the box accepted for it, if any. */
	const openedRows = (): OpenedMain[] => (o.ally ? [...services.values()].filter((l) => !l.stopped && l.state === "live" && l.control && !isHeadL(l)).flatMap((l) => readRoutes(slot, l.record.workspace, now()).filter((r) => r.kind === "opened").map((r) => ({ workspace: l.record.workspace, label: l.record.label, main: r.to, name: r.name, device: r.device, deviceLabel: r.label, team: r.team, ...(r.level ? { level: r.level } : {}), ...(r.pane ? { pane: r.pane } : {}), ...(r.stop ? { stop: r.stop } : {}) }))) : []);
	const revoker = createRevoker({
		opened: openedRows,
		known: (team) => o.ally?.known?.(team) ?? true, standing: (device, team) => o.ally?.standing(device, team),
		close: async (workspace, main, mode) => void (await need(workspace).control!.closeMain(main, mode === "interrupt" ? { interrupt: true } : undefined)), paneGone: async (workspace, pane) => { if (!pane) return false; try { const net = await need(workspace).reach!.read(); return !net.ps.some((p) => p.pane_id === pane); } catch { return false; } }, // Herdr's listing is the second witness that a main is gone; no pane or a failed read confirms nothing
		forget: (workspace, main) => void forgetClosed(workspace, { main }), signal: (s) => o.runs?.signal?.(s), log: ({ event, ...rest }) => log.line(String(event), rest as Record<string, string>),
		label: (team, device) => o.ally?.label?.(team, device) ?? device.slice(0, 6), audit: (entry) => o.ally?.audit?.(entry),
	});
	/** A remote stop (unitstop.ts): which main and whose is decided from the route table, the roster, and the main's pane token; an accepted stop is written on the route and the revoker sweeps at once. */
	const unitStop = createUnitStop({
		box: () => o.ally?.box?.(), opened: openedRows, admin: (team, device) => o.ally?.admin?.(team, device) ?? false,
		witness: async (row) => {
			const net = await need(row.workspace).reach!.read(), session = net.sessions.find((x) => x.id === row.main);
			const token = net.ps.find((p) => p.pane_id === (session?.herdrLocation?.paneId ?? row.pane))?.tokens?.sb_opened_by;
			return { ...(typeof token === "string" && token.startsWith("link:") ? { device: token.replace(/^(link:)+/, "") } : {}), ...(session ? { name: nameOf(session) } : {}) };
		},
		record: (row, stop, name) => setStop(slot, row.workspace, row.main, stop, now(), name), sweep: () => void revoker.sweep(true), signal: (s) => o.runs?.signal?.(s),
		tell: async (team, device, notice) => { if (!o.ally?.tell) throw new Error("This server has no link holder to tell the sender"); await o.ally.tell(team, device, notice); },
		label: (team, device) => o.ally?.label?.(team, device) ?? device.slice(0, 6), audit: (entry) => o.ally?.audit?.(entry), now,
	});
	const mains = async (): Promise<MainFact[]> => {
		const out: MainFact[] = [], rows = openedRows();
		// The read is of the whole computer (the broker's sessions and Herdr's panes), so one serves every row.
		const net = rows[0] ? await need(rows[0].workspace).reach!.read().catch(() => undefined) : undefined;
		for (const row of rows) {
			const session = net?.sessions.find((x) => x.id === row.main);
			const pane = net?.ps.find((p) => p.pane_id === (session?.herdrLocation?.paneId ?? row.pane));
			const kind = kindOfPane(pane?.tokens);
			out.push({ row, name: session ? nameOf(session) : row.name, state: pane?.agent_status ?? "unknown", ...(kind !== undefined ? { kind } : {}) });
		}
		return out;
	};
	const answered = answeredAsks(now); // run id → asks it answered: kept out of a route, as the Mac closes an answered ask
	/** The tools a run calls, done as the workspace's tower identity (runtools.ts). A failure that comes after the run has gone is told to the next run as a notice. */
	const runToolFor = async (request: Record<string, unknown>) => {
		const who = runs.runOf(request.token);
		if (!who) throw new Error("unknown_token");
		const name = typeof request.tool === "string" ? request.tool : "", args = (typeof request.args === "object" && request.args !== null ? request.args : {}) as Record<string, unknown>;
		const l = need(who.workspace, who.kind === "head"), ws = who.workspace;
		// What an ally run waits on or opens is its device's: the routes (allyroute.ts) send those sessions' answers to the device's next ally run, never to a local run, and its opened mains have a ledger of their own.
		const peer: Peer | undefined = who.kind === "ally" && who.device && who.team ? { device: who.device, label: who.deviceLabel ?? who.device.slice(0, 6), short: who.deviceShort ?? who.device.slice(0, 6), team: who.team, teamName: who.teamName ?? who.team.slice(0, 6) } : undefined;
		const route = (to: string, name: string, kind: "expect" | "opened", ask?: string, live?: ReadonlySet<string>, panes?: ReadonlySet<string>, pane?: string) => { try { addRoute(slot, ws, { ...peer!, to, name, kind, at: now(), ...(ask ? { ask } : {}), ...(pane ? { pane } : {}), ...(kind === "opened" && who.level ? { level: who.level } : {}) }, now(), live, panes); } catch (cause) { error("ally-route", (cause as Error).message); } };
		/**
		 * The sessions that sent this run a `call_tower` expecting an answer, among the events the run took: the header is the sender's own words, so each is checked against the broker and Herdr's pane token before it binds anything.
		 * An asker may be a main of any workspace on this computer; that is the only way a main outside this workspace becomes a target.
		 */
		const callers = () => {
			const ids = new Set<string>();
			for (const e of readQueue(slot, ws)) {
				if (e.taken?.run !== who.id || e.kind !== "intercom" || !e.from) continue;
				const fields = fieldsOf(e.text);
				if (fields?.kind === "call_tower" && fields.reply === "expected") ids.add(e.from.id);
			}
			return ids;
		};
		/**
		 * The live main named by id or name that an ask may be made for: a main of this tower's workspace, or a main of another workspace on this computer that called this run (`callers`).
		 * Throws when there is none, several, or it is neither; no other session is a target.
		 */
		const mainOf = async (query: string, byId = false) => {
			const net = await l.reach!.read(), named = net.sessions.filter((x) => x.id === query || (!byId && nameOf(x) === query));
			if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${query}"`);
			const pane = net.ps.find((p) => p.pane_id === named[0]!.herdrLocation?.paneId);
			if (pane?.tokens?.sb_role !== "main") throw new Error(`${query} is not a main of workspace ${l.record.label}: an ask for a main names one of its mains, or a main of another workspace that called this tower`);
			if (pane.workspace_id !== ws && !callers().has(named[0]!.id)) throw new Error(`${query} is not a main of workspace ${l.record.label}, and it did not call this tower in this run: an ask for a main of another workspace names one that did`);
			return { id: named[0]!.id, name: phrase(nameOf(named[0]!), 40) };
		};
		const host = {
			reach: l.reach!, open: peer ? async (request: Parameters<NonNullable<Live["open"]>>[0]) => { const opened = await l.openAlly!(request); const net = await l.reach!.read().catch(() => undefined), live = net && new Set(net.sessions.map((x) => x.id)), panes = net && new Set(net.ps.map((p) => p.pane_id)); route(opened.main, "opened main", "opened", ((u) => (u.length === 1 ? u[0] : undefined))((who.asks ?? []).filter((a) => !answered.has(who.id, a))), live, panes, opened.pane); return opened; } : l.open!, closeMain: (l.control ? async (query: string) => forgetClosed(ws, await l.control!.closeMain(query)) : undefined) as unknown as Control["closeMain"], now, boardDir: join(slot.stateDir, "board"), label: l.record.label,
			link: async (body: Record<string, unknown>) => ((await o.link?.(body, l.record.id)) ?? { ok: false, code: "no_holder", error: "The link holder is not running in the sb server" }) as { ok: boolean; error?: string },
			server: o.server ?? { status: () => ({}), logs: () => [], restart: () => Promise.reject(new Error("The server cannot restart itself here")) },
			expect: (to: string, name: string, text: string) => { if (peer) return route(to, phrase(name, 40), "expect"); try { addExpect(slot, ws, { to, name, at: now(), first: phrase(text, 80) }, now()); } catch (cause) { error("expects", (cause as Error).message); } },
			who, identity: l.record.id, requests: l.requests, startedAt: o.startedAt,
			allow: (q: { toolCallId: string; tool: string; args: unknown }) => (o.allows ? o.allows.take({ pane: who.pane, ...q, sessions: () => l.client!.listSessions() }) : Promise.resolve({ ok: false as const, reason: "this server holds no Allows" })),
			allowRequest: (q: { toolCallId: string; lines: string[] }) => (o.allows ? o.allows.takeRequest({ pane: who.pane, ...q, sessions: () => l.client!.listSessions() }) : Promise.resolve({ ok: false as const, reason: "this server holds no Allows" })),
			asks: o.asks ?? { open: () => { throw new Error("this server keeps no asks"); } },
			// The `call_tower` events (why=shared) this run took: a car slip is forwarded by naming one, and the code stamps the sender the broker named for it (docs/specs/2026-11-07-train-workers.md §5.5).
			forwardEvent: (id: string) => {
				const event = readQueue(slot, ws).find((e) => e.id === id && e.taken?.run === who.id && e.kind === "intercom" && e.from);
				const fields = event && fieldsOf(event.text);
				return event && fields?.kind === "call_tower" && fields.why === "shared" ? { id: event.id, from: event.from!.id, text: event.text, at: Date.parse(event.at) } : undefined;
			},
			// A reply that settles a blocked call_tower this run took, while auto mode is on, is listed for the return list with the basis it names (autotower.ts `basisOf`) or `none`.
			decided: (to: string, gist: string, basis: unknown) => {
				if (!o.auto?.view().on) return;
				const blocked = readQueue(slot, ws).some((e) => e.taken?.run === who.id && e.kind === "intercom" && e.from?.id === to && ((f) => f?.kind === "call_tower" && f.why === "blocked")(fieldsOf(e.text)));
				if (blocked) o.auto.decided({ run: who.id.slice(0, 8), to, gist, basis: basisOf(basis, readMemory(slot, ws, now()).memory, runs.bossEvents(request.token)) });
			},
			// The `call_tower` messages (why=shared) this run took, as the door of an integrator's open reads them (runtools.ts): a local run's queue events, and for an ally run what the sessions its device's runs opened or wrote to
			// said to the tower. The sender is the broker's, the text the sender's own; an ally answer has no event id, so its forward is named by a digest of the answer's id.
			slipEvents: () => {
				const shared = (text: string) => ((f) => f?.kind === "call_tower" && f.why === "shared")(fieldsOf(text));
				if (peer) return runs.allyAnswers(request.token).filter((x) => shared(x.text)).map((x) => ({ fwd: createHash("sha256").update(x.id).digest("hex").slice(0, 16), from: x.from, text: x.text }));
				return readQueue(slot, ws).flatMap((e) => (e.taken?.run === who.id && e.kind === "intercom" && e.from && shared(e.text) ? [{ fwd: e.id, from: e.from, text: e.text }] : []));
			},
			// An integrator is the tower's own main whichever run's slip opened it: one opener (and so one queue) for both kinds of run, and no ally route, so its reports reach the local runs.
			...(l.open ? { openIntegrator: l.open } : {}),
			noteForward: (f: { fwd: string; from: string; to: string[]; text: string }) => { try { o.cars?.noteForward(f); } catch (cause) { error("cars", (cause as Error).message); } },
			headAsked: (id: string) => asked(slot, now(), ws, id), openedFor: (session: string) => openedFor(slot, ws, session, now()),
			openedAnywhere: (session: string) => [ws, ...[...services.values()].map((x) => x.record.workspace)].map((w) => openedFor(slot, w, session, now())).find((d) => d !== undefined),
			...(who.team && o.ally?.project(who.team) ? { project: o.ally.project(who.team)! } : {}),
			isTower: async (query: string) => {
				// A tower identity of this server by its id or name, whether or not the broker lists it just now; or any session whose pane is a tower's (a resident tower of the previous build).
				if ([...services.values()].some((x) => x.record.id === query || x.record.name === query)) return true;
				const net = await l.reach!.read(), named = net.sessions.filter((x) => x.id === query || x.name === query);
				return named.some((x) => /^sb-tower-/.test(x.id) || net.ps.find((p) => p.pane_id === x.herdrLocation?.paneId)?.tokens?.sb_role === "tower");
			},
			memory: (margs: Record<string, unknown>) => memoryTool({
				slot, workspace: ws, run: who.id, now, log, bossEvents: () => runs.bossEvents(request.token), intercomEvents: () => runs.intercomEvents(request.token), locale: () => localeOf(o.env), ...(o.auto ? { auto: { on: () => o.auto!.view().on, told: (e: Entry) => tellParked(ws, e) } } : {}),
				// The session with this id in the net now: never found by name, since a subagent shows on intercom as `subagent-chat-<id>` (todo #49).
				raiser: async (id: string) => {
					const net = await l.reach!.read(), x = net.sessions.find((s) => s.id === id);
					if (!x) return undefined;
					const pane = net.ps.find((p) => p.pane_id === x.herdrLocation?.paneId), token = pane?.tokens?.sb_role;
					return { id, name: phrase(nameOf(x), 40), role: token === "main" || token === "member" || token === "tower" ? token : "session", ...(x.herdrLocation?.workspace?.label ? { workspace: phrase(x.herdrLocation.workspace.label, 40) } : {}), ...(x.herdrLocation?.tab?.label ? { tab: phrase(x.herdrLocation.tab.label, 40) } : {}) };
				},
				session: async (query: string) => {
					const net = await l.reach!.read(), named = net.sessions.filter((x) => x.id === query || nameOf(x) === query);
					if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${query}"`);
					return { id: named[0]!.id, name: phrase(nameOf(named[0]!), 40) };
				},
			}, margs),
			mainOf,
			// Who asked this run for the work it sends a device: the one session that sent it a `call_tower` expecting an answer, if it is a live main (of this workspace or another on this computer). A second asker, or one that is no main, leaves it unknown.
			requester: async () => {
				const askers = callers();
				if (askers.size !== 1) return undefined;
				return mainOf([...askers][0]!, true).catch(() => undefined);
			},
		};
		try {
			if (who.kind === "head") {
				const head = headHost(host, {
					ensureTower: async (workspace) => { const got = await ensure({ workspace }); return { id: got.id, opened: got.opened }; },
					openAsk: (d) => openAsk(slot, now(), d), closeAsk: (id) => closeAsk(slot, id), checkSupersedes: (id) => checkSupersedes(slot, id),
					relay: (turn) => (typeof request.token === "string" && turn !== undefined && runs.bossTaken(request.token, turn) ? `boss:${turn}` : undefined),
					boss: (turn) => (typeof request.token === "string" && turn !== undefined ? runs.bossEvents(request.token).find((e) => e.id === turn)?.text : undefined),
					// The boss's own words in this turn (§2): the event the run's extension reports as the turn's starter, if this run took it as a boss event, or the line the boss typed at the head pane; the model supplies neither.
					auto: (on) => {
						if (!o.auto) throw new Error("auto mode is held by the primary server of this computer");
						const token = request.token, turn = typeof request.turn === "string" ? request.turn : undefined;
						const event = typeof token === "string" && turn !== undefined && runs.bossTaken(token, turn) ? runs.bossEvents(token).find((e) => e.id === turn) : undefined;
						const typed = typeof request.typed === "string" && Number.isInteger(request.seq) ? { text: request.typed, run: who.id, seq: request.seq as number } : undefined;
						return autoAnswer(o.auto.bossAuto(on, { ...(event ? { event } : {}), ...(typed ? { typed } : {}) }, { session: who.id }));
					},
				} satisfies HeadPort);
				return await headTool(head, name, args, { ...(typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {}), ...(typeof request.turn === "string" ? { turn: request.turn } : {}) });
			}
			const done = await runTool(host, who.kind, name, args, typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {});
			// What a tower did in the turn the head's message started is noted on the head's ask (headasks.ts `noteToolCall`).
			if (who.kind === "local" && isAct(name) && typeof request.turn === "string") noteToolCall(slot, now(), ws, readQueue(slot, ws).find((e) => e.id === request.turn), { name, args, details: done.details });
			// The ask a run answered is spent on the asking computer: a report of a main the run opened must not name it again.
			if (peer && name === "tower_send" && typeof args.inReplyTo === "string") try { answered.add(who.id, args.inReplyTo); dropAsk(slot, ws, peer.device, args.inReplyTo, now()); } catch (cause) { error("ally-route", (cause as Error).message); }
			return done;
		} catch (cause) {
			// The run was released while the call was under way (a /new, an end): nobody is left to read the failure, so the next run does.
			if (!runs.runOf(request.token) && (who.kind === "local" || who.kind === "head")) runs.notice(ws, `${name} failed after your run ended: ${(cause as Error).message}`, `${name}:${phrase((cause as Error).message, 80)}`);
			throw cause;
		}
	};

	// Auto mode and the towers (§6): the waits open when it turns on are parked, and a raiser is told once under `wait_parked`.
	const targets = (): Target[] => [...services.values()].map((l) => ({ workspace: l.record.workspace, label: l.record.label, ...(isHeadL(l) ? { head: true as const } : {}) }));
	const tellParked = async (workspace: string, entry: Entry): Promise<void> => {
		const raiser = entry.card?.from?.id, reach = services.get(workspace)?.reach;
		if (raiser && reach) await reach.post(raiser, parkedText(entry.id), "wait_parked", "session", false, undefined, undefined, { wait: entry.id });
	};
	const offAuto = o.auto?.onSwitch((change) => {
		if (!change.to.on || change.from.on) return;
		try {
			for (const { target, entry } of parkOpen(slot, now(), targets())) if (entry.parkedTold) void tellParked(target.workspace, entry).catch((cause: Error) => error("wait-parked", cause.message));
		} catch (cause) { error("wait-parked", (cause as Error).message); }
	});

	// The boss's waits for the list and the polls' digests (waitlist.ts): the head's memory is read under its constant key, a workspace's under its id.
	const autoView = () => ((v) => ({ on: v?.on === true, ...(v?.since ? { since: v.since } : {}) }))(o.auto?.view());
	const listed = (): Target[] => [...services.values()].filter((l) => !l.stopped && !isHeadL(l)).map((l) => ({ workspace: l.record.workspace, label: l.record.label }));
	const api: Towers = {
		waitList: (only, own) => {
			const h = headLive();
			return waitList({ slot, now, locale: localeOf(o.env), auto: autoView }, listed(), h ? { at: h.record.workspace } : waitRows(slot, HEAD_KEY, now(), true).rows.length ? {} : undefined, only, own);
		},
		waitDigest: (workspace) => {
			const l = services.get(workspace);
			return l && !l.stopped ? digestOf(waitRows(slot, isHeadL(l) ? HEAD_KEY : workspace, now(), isHeadL(l)).rows, o.auto?.view().on === true) : undefined;
		},
		parked: () => parkedRows(slot, now(), targets()),
		unpark: () => unpark(slot, now(), targets()),
		runTool: runToolFor,
		memory: (workspace, json, via) => {
			// The head's constant key reaches head/ whether or not a head service stands (towerstore.ts `HEAD_KEY`).
			if (workspace !== HEAD_KEY && !services.has(workspace)) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			if (json.op === "press") {
				const l = workspace === HEAD_KEY ? headLive() : services.get(workspace);
				if (!l) return Promise.resolve({ status: 409, body: { error: "refused", reason: "The tower service is not running, so nothing can be pressed" } });
				return pressRequest({
					slot, now, log, locale: localeOf(o.env), autoOn: () => o.auto?.view().on === true,
					live: async (id) => (await l.reach!.read()).sessions.some((x) => x.id === id),
					send: (to, text, wait) => l.reach!.post(to, text, "wait_card", "session", false, undefined, undefined, { wait }),
					boss: (text) => void runs.boss(l.record.workspace, text, "the boss (wait card)", { press: true }),
				}, workspace, json, via);
			}
			return memoryRequest(slot, workspace, now(), json, log);
		},
		allyWaiting: (identity) => runs.pokeAllies(identity),
		activate,
		loaded: () => !o.enabled() || loadedAll,
		ensure,
		async close(workspace) {
			const l = services.get(workspace);
			if (!l) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			// The tab is closed only while it is proven the tower's own (a new Herdr may have given its id to a tab of the boss's); an unproven one is left, and the service ends all the same.
			if (l.seated || (await prove(l)) === "ours") if (await proven(l)) await run(["tab", "close", l.record.tab]).catch(() => {});
			await lose(l, "closed by the boss");
			return { workspace, id: l.record.id };
		},
		openMain: ({ workspace, request, sender, label, role }) => need(workspace).open!({ request, sender, ...(label ? { label } : {}), ...(role ? { role } : {}) }),
		closeMain: async ({ workspace, query }) => forgetClosed(workspace, await need(workspace).control!.closeMain(query)),
		unitStop: (stop) => unitStop.handle(stop),
		mains,
		async takeover() {
			// A new Herdr server has no tokens and no pane environment: the tabs are looked for (for a minute, since a restore brings them back one by one), and the marks are written again.
			recoverUntil = now() + (o.recoverMs ?? RECOVER_MS);
			// Nothing proven of the panes holds in a new Herdr (a lost session's ids can name the boss's own shells): the look below proves each seat again, and until it does nothing is typed, marked, or woken.
			unseat();
			// Every pane is a fresh shell: the prompt that stood there is gone, and so is the label Herdr kept for it.
			standing.reset();
			// Runs that were live end with outcome `herdr-restart`, and claims are held until this has been processed (the wake protocol, step 2).
			runs.takeoverBegin();
			try {
				if (!activation) return;
				log.line("towers-takeover", { services: services.size });
				await look();
				for (const l of services.values()) if (l.state === "live") (await publish(l), standing.kick(l.record.workspace));
			} finally {
				await runs.takeoverEnd();
			}
		},
		stateOf: (workspace) => services.get(workspace)?.state,
		// A main closed from the page: its `opened` row goes, unless it carries a stop the box accepted: then the revoker lets it go, with the done audit and the notice, and is asked to sweep now. A row with no stop has neither waiting, and the revoker would never drop it if its device had dispatch again.
		forget(session) {
			let held: OpenedMain[] = [], sweep = false;
			try { held = openedRows().filter((r) => r.main === session); } catch (cause) { error("ally-route", (cause as Error).message); }
			for (const l of services.values()) {
				if (held.some((r) => r.workspace === l.record.workspace && r.stop)) sweep = true;
				else forgetClosed(l.record.workspace, { main: session });
			}
			if (sweep) void revoker.sweep(true);
		},
		owns: (id) => [...services.values()].some((l) => l.record.id === id),
		status: () => [...services.values()].filter((l) => !isHeadL(l)).map(row),
		head: {
			ensure: ensureHead,
			event: async (text, requester) => {
				const got = await ensureHead();
				return { workspace: got.workspace, id: runs.boss(got.workspace, text, "the boss", { present: true, ...(requester ? { requester } : {}) }).id };
			},
			close: async () => {
				const l = headLive();
				return l ? api.close(l.record.workspace) : undefined;
			},
			status: () => {
				const l = headLive();
				return l ? row(l) : undefined;
			},
		},
		runs,
		async prompt(cmd, workspace, pid) {
			if (cmd === "prompt-poll") {
				const polled = standing.poll(workspace, pid);
				return polled.ok ? { ...polled, ...api.waitDigest(workspace) } : polled;
			}
			return cmd === "prompt-leave" ? standing.leave(workspace, pid) : standing.gone(workspace, pid);
		},
		async stop(opts) {
			stopped = true;
			offAuto?.();
			await standing.stop();
			await runs.stop(opts);
			timers.forEach(clearInterval);
			clearTimeout(republishTimer);
			events?.();
			await Promise.all([...services.values()].map((l) => release(l)));
			// The head's folder is bound for as long as this process stands in for it; the record on disk stays.
			for (const l of services.values()) if (isHeadL(l)) unbindDir(slot, l.record.workspace);
		},
	};
	o.expose?.(api);
	return api;
}
