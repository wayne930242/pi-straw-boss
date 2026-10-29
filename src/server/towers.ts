import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHeadlessKit, type HeadlessKit, type Incoming, type IntercomLike } from "../agent/kit.ts";
import { createCloseMain, type Control } from "../closemain.ts";
import { createDigest } from "../digest.ts";
import { headReader } from "../headwatch.ts";
import { createTab, headOf, isStandin, isSub, type Pane, panes, parentOf, type Place, report, type Session, tabs, TOWER_LABEL, towerModel, type Workspace, workspaces } from "../herdr.ts";
import { type Opened, opener } from "../opener.ts";
import { netTokens } from "../order.ts";
import { allyLabel } from "../boardauto.ts";
import { stamp } from "../header.ts";
import { createReach, nameOf, type Reach } from "../reach.ts";
import type { HerdrEvents } from "../server-watch.ts";
import type { Config } from "../state.ts";
import { trustDir } from "../trust/files.ts";
import type { IntercomModule } from "./intercom.ts";
import type { Log } from "./log.ts";
import { secretDir, type Slot, towerId, towerName } from "./record.ts";
import type { Allows } from "./allows.ts";
import type { Asks } from "./asks.ts";
import { ageOf, allyTools, buildAllyBrief, buildBrief, gatherMains, LOCAL_TOOLS } from "./towerbrief.ts";
import { createStanding, type PromptReply, type StandingTimers } from "./standing.ts";
import { claimGate, proofGate, seatGate, type SeatVerdict } from "./typegate.ts";
import { addAnswer, addRoute, ALLY_LEDGER, type Peer, readAnswers, removeAnswer, routeOf, spendRoute } from "./allyroute.ts";
import { type AllyItem, type AllyPort, createRuns, type Runs, type RunsOptions, type ServiceRef, type ServiceStatus } from "./runs.ts";
import { type ConversationInfo, sessionsRoot } from "./bossconv.ts";
import { addExpect, clearExpect, lastNote, listRuns, readExpects, readNotes, readTimer } from "./towerrunstore.ts";
import { runTool, type ServerTools } from "./runtools.ts";
import { hasWaitOn, markShown, memoryRequest, memorySection, memorySummary, memoryTool, noteMessage, readMemory } from "./towermemory.ts";
import { openSeen, type Seen } from "./towerseen.ts";
import { readTowerRuns } from "./towerruns.ts";
import { appendEvent, deleteService, listServices, purgeAll, purgeQueues, putLedger, queueLength, readLedger, readService, type ServiceRecord, towerDir, writeService } from "./towerstore.ts";

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
const REFRESH_MS = 4 * 60_000, RECOVER_MS = 60_000, RECOVER_POLL_MS = 2000, RESIDENT_MS = 2000, REGISTER_WAIT_MS = 3000, LEAVE_MS = 2000;
/** How old a caller's "I just made this pane" may be and still be believed (the desk step asks within a second or two of making the base). */
const MADE_WITHIN_MS = 30_000;
/** What a tab is called once its standing pane was replaced and it kept other panes. */
const FORMER_LABEL = "former tower";
/** What Herdr reports that ends a tower's tab, or moves the head: any of them makes the service look again. */
const WATCHED = ["workspace.created", "workspace.closed", "workspace.moved", "workspace.reordered", "pane.closed", "tab.closed"];
const HEAD_EVENTS = new Set(["workspace_created", "workspace_closed", "workspace_moved", "workspace_reordered"]);
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
	residentMs?: number;
	/** How long `ensure` waits for the identity to register before it answers. */
	registerMs?: number;
	retryMs?: number[];
	/** Replaces the runs' seams (timers, starting pi, the settings check, liveness), for tests. */
	runs?: Partial<RunsOptions>;
	/** The line typed into a standing pane's shell to start the tower prompt (main.ts builds it from the CLI beside the server); without it the server types nothing and reports no stand-in. */
	promptCommand?: (workspace: string) => string | undefined;
	/** The timers of the standing pane (standing.ts), for tests. */
	standing?: Partial<StandingTimers>;
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
	openMain(request: { workspace: string; request: string; sender: string; label?: string }): Promise<Opened>;
	/** The `close-main` ask from the workspace's tower identity. */
	closeMain(request: { workspace: string; query: string }): ReturnType<Control["closeMain"]>;
	/** A new Herdr server took over: finds the tower tabs again and writes the tokens. */
	takeover(): Promise<void>;
	status(): TowerRow[];
	/** The runs of the services (runs.ts): claims, the run's requests, the boss's events. */
	runs: Runs;
	/** The tower prompt in a standing pane (standing.ts): its poll, Ctrl+D, and exit. */
	prompt(cmd: "prompt-poll" | "prompt-leave" | "prompt-gone", workspace: string, pid: number): Promise<PromptReply | { ok: true }>;
	/** Messages wait in the link inbox for this tower identity: ally runs are started for them. */
	allyWaiting(identity: string): void;
	/** The GUI panel's request on a workspace's memory (`POST tower/<workspace>/memory`, towermemory.ts `memoryRequest`). */
	memory(workspace: string, json: Record<string, unknown>): { status: number; body: Record<string, unknown> };
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
	const timers: ReturnType<typeof setInterval>[] = [];
	const digest = createDigest(run, now);
	const readHead = headReader({ run, digest, workspaces: () => [...services.values()].filter((l) => l.state !== "waiting" && !l.stopped).map((l) => l.record.workspace) });
	let looking: Promise<void> = Promise.resolve();

	// --- runs ---------------------------------------------------------------------------------------------------------------------------------------------------------------

	/** What the run hub (runs.ts) needs of one service: its record, whether its identity is registered, the folder to check, and the brief (built here from the net, the ledger, the digest, and the last note). */
	const refOf = (l: Live): ServiceRef => ({
		workspace: l.record.workspace,
		record: () => l.record,
		live: () => l.state === "live" && l.seated && Boolean(l.client?.isConnected()),
		proven: () => proven(l),
		cwd: async () => (await panes(run, l.record.workspace).catch(() => [])).find((p) => p.pane_id === l.record.pane)?.cwd ?? l.record.cwd ?? slot.stateDir,
		towerKey: async () => (await netTokens(run, place(l), "tower", l.record.name, now(), cfg.world)).own.sb_order ?? undefined,
		yieldPane: () => standing.yieldPane(l.record.workspace),
		freed: (over) => standing.freed(l.record.workspace, over?.fresh, over?.keepParked),
		clearDigest: (keys) => digest.drop(l.record.workspace, keys),
		renewPane: (runId) => renew(l, runId),
		renewing: () => l.renewing === true,
		// The run that was shown an expired wait has polled: it will not be shown again (towermemory.ts).
		shown: (ids) => { try { markShown(slot, l.record.workspace, now(), ids); } catch (cause) { error("memory", (cause as Error).message); } },
		memory: () => {
			const { memory, problem } = readMemory(slot, l.record.workspace, now());
			return { ...memorySummary(memory), ...(problem ? { problem } : {}) };
		},
		// A live run is given a new brief when the memory moved or a run left a note (runs.ts `refreshed`): what a conversation of an hour would otherwise not see.
		briefVersion: () => `${readMemory(slot, l.record.workspace, now()).memory.rev}:${lastNote(slot, l.record.workspace, "local")?.at ?? ""}`,
		liveSessions: async () => (await panes(run).catch(() => [])).flatMap((p) => (p.agent_session?.value ? [p.agent_session.value] : [])),
		allyLine: (item) => {
			const mine = { name: allyLabel(l.record.name), id: l.record.id, role: "tower" as const, workspace: allyLabel(l.record.label) };
			// An answer a local session gave to what the run asked or opened: no verified peer header, the session is local; the device's next run reads it as data.
			if (item.local) return stamp({ from: { name: allyLabel(item.local.name), id: item.local.id, role: "session" }, kind: "tower_reply", scope: "session", to: [mine], reply: false }, item.text);
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
					label: l.record.label, workspace: ws, head: mains.head, woken: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, counts, identity: l.record.id,
					...(refresh ? { refreshed: true as const } : {}), ...(talk ? { conversation: talk.line, since: talk.since } : {}),
					memory: section.text, mains: mains.rows, obligations: [...mains.opened, ...(o.asks?.openOf(ws) ?? []).map((a) => `an ask for the main ${a.forName} is open (sent ${ageOf(now() - a.at)} ago): its answer goes to that main, not to you`), ...readExpects(slot, ws, now()).map((e) => `waiting for a reply from ${e.name} (asked ${ageOf(now() - e.at)} ago): ${e.first}`), ...(timer && timer.at <= now() ? ["your wakeAfter follow-up is due"] : [])], digest: lines.map((x) => x.line),
					...(note ? { note: { text: note.note, age: ageOf(now() - Date.parse(note.at)) } } : {}),
					flags: [
						...(crashed.length ? [`${crashed.length} event${crashed.length > 1 ? "s were" : " was"} possibly handled by a run that crashed: check before acting.`] : []),
						...(oldest !== undefined && oldest > 10 * 60_000 ? [`The oldest event waiting is ${ageOf(oldest)} old.`] : []),
					],
					tools: LOCAL_TOOLS,
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
		waiting: (identity) => {
			const ws = workspaceOf(identity), answers: AllyItem[] = ws ? readAnswers(slot, ws, now()).map((a) => ({ id: `${LOCAL}${a.id}`, device: a.device, label: a.label, short: a.short, team: a.team, teamName: a.teamName, fromWorkspace: "", replyExpected: false, text: a.text, at: a.at, local: a.from })) : [];
			return [...o.ally!.waiting(identity), ...answers].sort((a, b) => a.at - b.at);
		},
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
	const runs: Runs = createRuns({ slot, run, sleep, now, log, sessions: sessionsRoot(o.env), enabled: o.enabled, max: () => readTowerRuns(slot.stateDir).max, trustDir: trustDir(slot.stateDir), model: () => towerModel(slot.stateDir), ...(allyPort ? { ally: allyPort } : {}), ...o.runs });

	const standing = createStanding({ run, api: cfg.api, world: cfg.world, sleep, now, log, command: o.promptCommand ?? (() => undefined), timers: o.standing, ...(o.runs?.platform ? { platform: o.runs.platform } : {}), ...(o.runs?.alive ? { alive: o.runs.alive } : {}) });
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
			// Written to disk with a flush, then receipted, then remembered (towerseen.ts). The receipt `queued` goes only after the flush: the broker waits for it, and a sender whose message is not
			// confirmed retries it, which the dedupe makes safe. No text reaches the log.
			try {
				const seen = (l.seen ??= openSeen(slot, l.record.workspace, now)), verdict = seen.check(from.id, message.id, message.content.text);
				if (verdict === "conflict") return log.line("tower-dropped", { workspace: l.record.workspace, from: from.id, why: "the same message id with other content" });
				const ws = l.record.workspace, route = verdict === "new" ? routeOf(slot, ws, from.id, now()) : undefined, local = route && readExpects(slot, ws, now()).find((e) => e.to === from.id);
				if (route && (!local || route.at >= local.at)) {
					// A session an ally run wrote to or opened is answering the device, not the local run: the answer waits for the device's next ally run.
					addAnswer(slot, ws, { id: `${Date.now().toString(36)}-${message.id}`.slice(0, 80), device: route.device, label: route.label, short: route.short, team: route.team, teamName: route.teamName, from: { id: from.id, name: phrase(from.name ?? from.id, 40) }, text: message.content.text, at: now() }, now());
					spendRoute(slot, ws, route, now());
					seen.add(from.id, message.id, message.content.text);
					log.line("tower-ally-answer", { workspace: ws, from: from.id });
					runs.pokeAllies(l.record.id);
				} else if (verdict === "new") {
					const written = appendEvent(slot, l.record, { kind: "intercom", from: { id: from.id, ...(from.name ? { name: from.name } : {}) }, text: message.content.text, at: new Date(now()).toISOString(), messageId: message.id });
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
					l.control = createCloseMain(kit, { closeSelf: () => "A tower service closes no mains for itself; ask it to close one.", check: () => undefined });
					l.control.register();
					// Two openers over the same tower: the local run's, whose ledger the local brief lists, and the ally runs', whose ledger is their own (allyroute.ts).
					const openerFor = (file?: string) => opener({
						run, sleep, workspaceId: l.record.workspace, cwd: l.record.cwd ?? slot.stateDir, sessions: () => (l.client ?? client).listSessions(), send: (to, message) => l.reach!.send(to, message),
						tower: () => ({ id: l.record.id, name: l.record.name }), trustDir: trustDir(slot.stateDir),
						ledger: { entries: () => readLedger(slot, l.record.workspace, now(), file), put: (row) => { try { putLedger(slot, l.record.workspace, row, now(), file); } catch (cause) { error("ledger", (cause as Error).message); } } },
					});
					l.open = openerFor();
					l.openAlly = openerFor(ALLY_LEDGER);
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
	const publish = async (l: Live) => {
		// Nothing is written to a pane that is not proven to be the tower's own (a stranger's shell under a reused id gets no marks).
		if (!l.seated) return;
		// A live foreign holder keeps the workspace: this service steps back and waits for it (a hand-over whose reply was lost leaves the resident running and publishing its own token).
		const foreign = await residentOf(l);
		if (foreign) return void (await yieldTo(l, foreign));
		const own: Record<string, string | null> = await netTokens(run, place(l), "tower", l.record.name, now(), cfg.world).then((net) => net.own, () => ({}));
		// The proof is asked of a listing read now, after the reads above: the marks go only to a pane that is still in the terminal it was proven for.
		if (!(await proven(l))) return;
		await Promise.all([
			report(run, "workspace", l.record.workspace, { tower: l.record.id, sb_tower_quit: null }),
			report(run, "pane", l.record.pane, { sb_role: "tower", ...own }),
		]).catch((cause: Error) => {
			// The pane (or its workspace) is gone: the pane a handover replaced, a workspace closed while no server ran. The reconcile loses the service, or finds its tab again within the recovery window; a report to what is not there is no error.
			if (/\b(pane|workspace)_not_found\b/.test(cause.message)) return log.line("tokens-dropped", { workspace: l.record.workspace, pane: l.record.pane, why: phrase(cause.message, 120) });
			error("tokens", `${l.record.id}: ${cause.message}`);
		});
		// The panes of its ally runs are keyed after it.
		await runs.markAllies(l.record.workspace, own.sb_order ?? null);
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
		const candidates = (await tabs(run, l.record.workspace)).filter((t) => t.label === TOWER_LABEL).flatMap((t) => {
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
			const verdict = seatGate({ pane: seat, tab });
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
			const held = all.find((w) => w.workspace_id === l.record.workspace)?.tokens?.tower;
			// Another tower's token (a resident tower that took the workspace) is not ours to clear.
			if (all.some((w) => w.workspace_id === l.record.workspace) && (!held || held === l.record.id)) {
				const members = ps.filter((p) => ["member", "main"].includes(p.tokens?.sb_role ?? "")).length;
				await report(run, "workspace", l.record.workspace, { tower: null, sb_tower_quit: String(members) }).catch(() => {});
			}
			if (ps.some((p) => p.pane_id === l.record.pane)) await report(run, "pane", l.record.pane, CLEAR).catch(() => {});
		} catch (cause) {
			error("tower-closed", (cause as Error).message);
		}
		deleteService(slot, l.record.workspace);
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
		if (l.stopped || gone() || l.renewing) return undefined;
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
				if (!recovering) await lose(l, "its tab is gone");
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
			// Herdr kept neither id: the identity registers again with the pane it stands in now, so the broker resolves its place.
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
		if (prior && !prior.stopped) return prior;
		services.set(record.workspace, l);
		runs.attach(refOf(l));
		standing.attach({ workspace: record.workspace, label: () => l.record.label, pane: () => l.record.pane, live: () => l.state === "live" && !l.stopped && Boolean(l.client?.isConnected()), seated: (pane) => holds(l, pane), status: () => runs.status(record.workspace), runWithin: (ms) => runs.startsWithin(record.workspace, ms), paneBusy: () => runs.paneBusy(record.workspace), busyPids: () => runs.busyPids(record.workspace), paneFree: () => runs.retry(record.workspace) }, fresh);
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
			// across Herdr servers and `roles/` is shared by them all, so the id alone proves nothing: the pane must also be in the recorded tab, and that tab a tower tab or the pane
			// run the record's own session file.
			if (!pane || !workspace || isSub(workspace) || record.tab !== pane.tab_id) continue;
			const glyph = (await tabs(run, workspace.workspace_id)).some((t) => t.tab_id === pane.tab_id && t.label === TOWER_LABEL);
			if (!glyph && !(typeof (record as { file?: unknown }).file === "string" && pane.agent_session?.value === (record as { file?: string }).file)) continue;
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
		let connections = 0;
		const stop = cfg.events(WATCHED, (event) => {
			// Every acknowledgement after the first is a reconnection (Herdr restarted): the recovery window opens here too, since nothing orders this connection against the watch's
			// takeover, and a tab that is not back yet must not end its service.
			if (event === null && connections++ > 0) herdrChanged();
			if (event === null || HEAD_EVENTS.has(event.event)) readHead();
			look();
		});
		events = stop;
		readHead();
		timers.push(setInterval(() => {
			if (!o.enabled()) return void retire().catch((cause: Error) => error("retire", cause.message));
			// A run that was refused because the seat could not be read is woken again here, at the latest.
			for (const l of services.values()) if (l.state === "live") (void publish(l), runs.poke(l.record.workspace));
			try {
				purgeQueues(slot, now());
			} catch (cause) {
				error("purge", (cause as Error).message);
			}
		}, o.refreshMs ?? REFRESH_MS));
		// A service whose tab is not found yet (Herdr is restoring) is looked for until the minute is over; one waiting for a resident looks at it. Both stop themselves.
		const poll = o.recoverPollMs ?? RECOVER_POLL_MS;
		timers.push(setInterval(() => { if (now() < recoverUntil + poll) look(); }, poll));
		timers.forEach((t) => t.unref());
		standing.start();
		await Promise.race([Promise.all(adopted.map((l) => l.starting)), sleep(o.registerMs ?? REGISTER_WAIT_MS)]);
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
			events?.();
			events = undefined;
			throw cause;
		});
		await activation;
	};
	/** The flag is off: the identities leave, our token goes, and `service.json`, the queues and the ledger are purged, so no message text stays on disk with no time limit. */
	const retire = async () => {
		const all = await workspaces(run).catch(() => []);
		for (const l of [...services.values()]) {
			services.delete(l.record.workspace);
			await standing.detach(l.record.workspace);
			await runs.detach(l.record.workspace, "the tower service is off");
			await release(l);
			if (all.find((w) => w.workspace_id === l.record.workspace)?.tokens?.tower === l.record.id) await report(run, "workspace", l.record.workspace, { tower: null }).catch(() => {});
			log.line("tower-retired", { workspace: l.record.workspace, id: l.record.id });
		}
		const gone = purgeAll(slot);
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
			await lose(existing, stranger ? "its workspace now holds another tab under the ids it made" : "its tab is gone", Boolean(stranger));
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
		const pending = opening.get(target.workspace_id) ?? openFor(target, target === asked ? pane : undefined, cwd, pid, target === asked ? made : undefined).finally(() => opening.delete(target.workspace_id));
		opening.set(target.workspace_id, pending);
		return pending;
	};

	const need = (workspace: string) => {
		const l = services.get(workspace);
		if (!l || l.stopped) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
		if (l.state !== "live" || !l.open || !l.control) throw new Error(`The tower of workspace ${workspace} is not registered with pi-intercom yet (${l.state})`);
		return l;
	};

	/** The tools a run calls, done as the workspace's tower identity (runtools.ts). A failure that comes after the run has gone is told to the next run as a notice. */
	const runToolFor = async (request: Record<string, unknown>) => {
		const who = runs.runOf(request.token);
		if (!who) throw new Error("unknown_token");
		const name = typeof request.tool === "string" ? request.tool : "", args = (typeof request.args === "object" && request.args !== null ? request.args : {}) as Record<string, unknown>;
		const l = need(who.workspace), ws = who.workspace;
		// What an ally run waits on or opens is its device's: the routes (allyroute.ts) send those sessions' answers to the device's next ally run, never to a local run, and its opened mains have a ledger of their own.
		const peer: Peer | undefined = who.kind === "ally" && who.device && who.team ? { device: who.device, label: who.deviceLabel ?? who.device.slice(0, 6), short: who.deviceShort ?? who.device.slice(0, 6), team: who.team, teamName: who.teamName ?? who.team.slice(0, 6) } : undefined;
		const route = (to: string, name: string, kind: "expect" | "opened") => { try { addRoute(slot, ws, { ...peer!, to, name, kind, at: now() }, now()); } catch (cause) { error("ally-route", (cause as Error).message); } };
		const host = {
			reach: l.reach!, open: peer ? async (request: Parameters<NonNullable<Live["open"]>>[0]) => { const opened = await l.openAlly!(request); route(opened.main, "opened main", "opened"); return opened; } : l.open!, closeMain: l.control!.closeMain, now, boardDir: join(slot.stateDir, "board"), label: l.record.label,
			link: async (body: Record<string, unknown>) => ((await o.link?.(body, l.record.id)) ?? { ok: false, code: "no_holder", error: "The link holder is not running in the sb server" }) as { ok: boolean; error?: string },
			server: o.server ?? { status: () => ({}), logs: () => [], restart: () => Promise.reject(new Error("The server cannot restart itself here")) },
			expect: (to: string, name: string, text: string) => { if (peer) return route(to, phrase(name, 40), "expect"); try { addExpect(slot, ws, { to, name, at: now(), first: phrase(text, 80) }, now()); } catch (cause) { error("expects", (cause as Error).message); } },
			who, identity: l.record.id, requests: l.requests,
			allow: (q: { toolCallId: string; tool: string; args: unknown }) => (o.allows ? o.allows.take({ pane: who.pane, ...q, sessions: () => l.client!.listSessions() }) : Promise.resolve({ ok: false as const, reason: "this server holds no Allows" })),
			allowRequest: (q: { toolCallId: string; lines: string[] }) => (o.allows ? o.allows.takeRequest({ pane: who.pane, ...q, sessions: () => l.client!.listSessions() }) : Promise.resolve({ ok: false as const, reason: "this server holds no Allows" })),
			asks: o.asks ?? { open: () => { throw new Error("this server keeps no asks"); } },
			...(who.team && o.ally?.project(who.team) ? { project: o.ally.project(who.team)! } : {}),
			isTower: async (query: string) => {
				// A tower identity of this server by its id or name, whether or not the broker lists it just now; or any session whose pane is a tower's (a resident tower of the previous build).
				if ([...services.values()].some((x) => x.record.id === query || x.record.name === query)) return true;
				const net = await l.reach!.read(), named = net.sessions.filter((x) => x.id === query || x.name === query);
				return named.some((x) => /^sb-tower-/.test(x.id) || net.ps.find((p) => p.pane_id === x.herdrLocation?.paneId)?.tokens?.sb_role === "tower");
			},
			memory: (margs: Record<string, unknown>) => memoryTool({
				slot, workspace: ws, run: who.id, now, log, bossEvents: () => runs.bossEvents(request.token),
				session: async (query: string) => {
					const net = await l.reach!.read(), named = net.sessions.filter((x) => x.id === query || nameOf(x) === query);
					if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${query}"`);
					return { id: named[0]!.id, name: phrase(nameOf(named[0]!), 40) };
				},
			}, margs),
			mainOf: async (query: string) => {
				const net = await l.reach!.read(), named = net.sessions.filter((x) => x.id === query || nameOf(x) === query);
				if (named.length !== 1) throw new Error(`${named.length ? "Several sessions are named" : "No live session is named or has the id"} "${query}"`);
				const pane = net.ps.find((p) => p.pane_id === named[0]!.herdrLocation?.paneId);
				if (pane?.tokens?.sb_role !== "main" || pane.workspace_id !== ws) throw new Error(`${query} is not a main of workspace ${l.record.label}: an ask for a main names one of its mains`);
				return { id: named[0]!.id, name: phrase(nameOf(named[0]!), 40) };
			},
		};
		try {
			return await runTool(host, who.kind, name, args, typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {});
		} catch (cause) {
			// The run was released while the call was under way (a /new, an end): nobody is left to read the failure, so the next run does.
			if (!runs.runOf(request.token) && who.kind === "local") runs.notice(ws, `${name} failed after your run ended: ${(cause as Error).message}`, `${name}:${phrase((cause as Error).message, 80)}`);
			throw cause;
		}
	};

	const api: Towers = {
		runTool: runToolFor,
		memory: (workspace, json) => {
			if (!services.has(workspace)) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
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
		openMain: ({ workspace, request, sender, label }) => need(workspace).open!({ request, sender, ...(label ? { label } : {}) }),
		closeMain: ({ workspace, query }) => need(workspace).control!.closeMain(query),
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
				readHead();
			} finally {
				await runs.takeoverEnd();
			}
		},
		status: () => [...services.values()].map((l) => ({ workspace: l.record.workspace, label: l.record.label, id: l.record.id, state: l.state, queue: queueLength(slot, l.record.workspace), ...(runs.status(l.record.workspace) ? { service: runs.status(l.record.workspace)! } : {}) })),
		runs,
		async prompt(cmd, workspace, pid) {
			if (cmd === "prompt-poll") return standing.poll(workspace, pid);
			return cmd === "prompt-leave" ? standing.leave(workspace, pid) : standing.gone(workspace, pid);
		},
		async stop(opts) {
			stopped = true;
			await standing.stop();
			await runs.stop(opts);
			timers.forEach(clearInterval);
			events?.();
			await Promise.all([...services.values()].map((l) => release(l)));
		},
	};
	o.expose?.(api);
	return api;
}
