import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHeadlessKit, type HeadlessKit, type Incoming, type IntercomLike } from "../agent/kit.ts";
import { createCloseMain, type Control } from "../closemain.ts";
import { createDigest } from "../digest.ts";
import { headReader } from "../headwatch.ts";
import { createTab, headOf, isSub, type Pane, panes, parentOf, type Place, report, type Session, tabs, TOWER_LABEL, towerModel, type Workspace, workspaces } from "../herdr.ts";
import { type Opened, opener } from "../opener.ts";
import { netTokens } from "../order.ts";
import { createReach, type Reach } from "../reach.ts";
import type { HerdrEvents } from "../server-watch.ts";
import type { Config } from "../state.ts";
import { trustDir } from "../trust/files.ts";
import type { IntercomModule } from "./intercom.ts";
import type { Log } from "./log.ts";
import { secretDir, type Slot, towerId, towerName } from "./record.ts";
import { ageOf, buildBrief, gatherMains, LOCAL_TOOLS } from "./towerbrief.ts";
import { createRuns, type Runs, type RunsOptions, type ServiceRef, type ServiceStatus } from "./runs.ts";
import { addExpect, clearExpect, lastNote, readExpects, readTimer } from "./towerrunstore.ts";
import { runTool, type ServerTools } from "./runtools.ts";
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
	refreshMs?: number;
	residentMs?: number;
	/** How long `ensure` waits for the identity to register before it answers. */
	registerMs?: number;
	retryMs?: number[];
	/** Replaces the runs' seams (timers, starting pi, the settings check, liveness), for tests. */
	runs?: Partial<RunsOptions>;
	/** A request to the link holder as a tower identity (main.ts; absent in a world without one). */
	link?: (body: unknown, from: string) => Promise<unknown>;
	/** The server's own part of `boss_server` for a run. */
	server?: ServerTools;
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
	ensure(request: { workspace: string; pane?: string; cwd?: string }): Promise<Ensured>;
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
	/** The start in flight: the wait for a resident tower, then the registration, then the tokens. */
	starting?: Promise<void>;
	registered?: Promise<boolean>;
	stopped: boolean;
	/** The messages taken, for dedupe (towerseen.ts); opened when the first message comes. */
	seen?: Seen;
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
		live: () => l.state === "live" && Boolean(l.client?.isConnected()),
		cwd: async () => (await panes(run, l.record.workspace).catch(() => [])).find((p) => p.pane_id === l.record.pane)?.cwd ?? l.record.cwd ?? slot.stateDir,
		clearDigest: (keys) => digest.drop(l.record.workspace, keys),
		async brief({ events, woken }) {
			const ws = l.record.workspace, all = await workspaces(run), target = all.find((w) => w.workspace_id === ws);
			if (!target || !l.client) throw new Error("the tower's workspace or its intercom connection is gone");
			const mains = await gatherMains({ run, now, sessions: () => l.client!.listSessions(), boardDir: join(slot.stateDir, "board"), workspace: target, ledger: readLedger(slot, ws, now()) });
			const lines = await digest.peek(ws).catch(() => []), note = lastNote(slot, ws, "local"), timer = readTimer(slot, ws);
			const counts: Record<string, number> = {};
			for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
			const crashed = events.filter((e) => e.flag === "crash"), oldest = events.map((e) => now() - Date.parse(e.at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
			const at = new Date(woken);
			return {
				digestKeys: lines.map((x) => x.key),
				text: buildBrief({
					label: l.record.label, workspace: ws, head: mains.head, woken: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`, counts, identity: l.record.id,
					mains: mains.rows, obligations: [...mains.opened, ...readExpects(slot, ws, now()).map((e) => `waiting for a reply from ${e.name} (asked ${ageOf(now() - e.at)} ago): ${e.first}`), ...(timer && timer.at <= now() ? ["your wakeAfter follow-up is due"] : [])], digest: lines.map((x) => x.line),
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
	const runs: Runs = createRuns({ slot, run, sleep, now, log, enabled: o.enabled, max: () => readTowerRuns(slot.stateDir).max, trustDir: trustDir(slot.stateDir), model: () => towerModel(slot.stateDir), ...o.runs });

	const place = (l: Live): Place => ({ paneId: l.record.pane, tabId: l.record.tab, workspaceId: l.record.workspace });
	const dirOf = (workspace: string) => join(towerDir(slot, workspace));
	const error = (code: string, text: string) => log.line("error", { code, text: phrase(text, 300) });

	// --- the identity -------------------------------------------------------------------------------------------------------------------------------------------------------------

	const wire = (l: Live, client: IntercomLike) => {
		client.on("message", (from: Session, message: Incoming) => {
			// Written to disk with a flush, then receipted, then remembered (towerseen.ts). The receipt `queued` goes only after the flush: the broker waits for it, and a sender whose message is not
			// confirmed retries it, which the dedupe makes safe. No text reaches the log.
			try {
				const seen = (l.seen ??= openSeen(slot, l.record.workspace, now)), verdict = seen.check(from.id, message.id, message.content.text);
				if (verdict === "conflict") return log.line("tower-dropped", { workspace: l.record.workspace, from: from.id, why: "the same message id with other content" });
				if (verdict === "new") {
					const written = appendEvent(slot, l.record, { kind: "intercom", from: { id: from.id, ...(from.name ? { name: from.name } : {}) }, text: message.content.text, at: new Date(now()).toISOString(), messageId: message.id });
					seen.add(from.id, message.id, message.content.text);
					clearExpect(slot, l.record.workspace, from.id, now());
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
					l.open = opener({
						run, sleep, workspaceId: l.record.workspace, cwd: l.record.cwd ?? slot.stateDir, sessions: () => (l.client ?? client).listSessions(), send: (to, message) => l.reach!.send(to, message),
						tower: () => ({ id: l.record.id, name: l.record.name }), trustDir: trustDir(slot.stateDir),
						ledger: { entries: () => readLedger(slot, l.record.workspace, now()), put: (row) => { try { putLedger(slot, l.record.workspace, row, now()); } catch (cause) { error("ledger", (cause as Error).message); } } },
					});
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
		// A live foreign holder keeps the workspace: this service steps back and waits for it (a hand-over whose reply was lost leaves the resident running and publishing its own token).
		const foreign = await residentOf(l);
		if (foreign) return void (await yieldTo(l, foreign));
		const own = await netTokens(run, place(l), "tower", l.record.name, now(), cfg.world).then((net) => net.own, () => ({}));
		await Promise.all([
			report(run, "workspace", l.record.workspace, { tower: l.record.id, sb_tower_quit: null }),
			report(run, "pane", l.record.pane, { sb_role: "tower", ...own }),
		]).catch((cause: Error) => error("tokens", `${l.record.id}: ${cause.message}`));
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
	const locate = async (l: Live, fallback: boolean): Promise<Pane | undefined> => {
		const ps = await panes(run, l.record.workspace);
		const byId = ps.find((p) => p.pane_id === l.record.pane);
		if (byId || !fallback) return byId;
		const claimed = new Set([...services.values()].filter((x) => x !== l).map((x) => x.record.pane));
		const candidates = (await tabs(run, l.record.workspace)).filter((t) => t.label === TOWER_LABEL).flatMap((t) => {
			const inside = ps.filter((p) => p.tab_id === t.tab_id);
			return inside.length === 1 && !claimed.has(inside[0]!.pane_id) ? [inside[0]!] : [];
		});
		return candidates[0];
	};

	/** The boss closed the tower, or its tab is gone: the identity leaves, the marks go, `sb_tower_quit` records how many members the base had, and the record goes. The queue stays 24 h. */
	const lose = async (l: Live, why: string) => {
		if (services.get(l.record.workspace) === l) services.delete(l.record.workspace);
		await runs.detach(l.record.workspace, why);
		await release(l);
		log.line("tower-closed", { workspace: l.record.workspace, id: l.record.id, why });
		try {
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
			if (found.pane_id === l.record.pane && found.tab_id === l.record.tab) continue;
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
	const adopt = (record: ServiceRecord): Live => {
		const l: Live = { record, state: "registering", stopped: false };
		const prior = services.get(record.workspace);
		if (prior && !prior.stopped) return prior;
		services.set(record.workspace, l);
		runs.attach(refOf(l));
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
			await publish(l);
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
			if (event === null && connections++ > 0) recoverUntil = Math.max(recoverUntil, now() + (o.recoverMs ?? RECOVER_MS));
			if (event === null || HEAD_EVENTS.has(event.event)) readHead();
			look();
		});
		events = stop;
		readHead();
		timers.push(setInterval(() => {
			if (!o.enabled()) return void retire().catch((cause: Error) => error("retire", cause.message));
			for (const l of services.values()) if (l.state === "live") void publish(l);
			try {
				purgeQueues(slot, now());
			} catch (cause) {
				error("purge", (cause as Error).message);
			}
		}, o.refreshMs ?? REFRESH_MS));
		// A service whose tab is not found yet (Herdr is restoring) is looked for until the minute is over; one waiting for a resident looks at it. Both stop themselves.
		timers.push(setInterval(() => { if (now() < recoverUntil + RECOVER_POLL_MS) look(); }, RECOVER_POLL_MS));
		timers.forEach((t) => t.unref());
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

	const openFor = async (target: Workspace, hint: string | undefined, cwd: string | undefined): Promise<Ensured> => {
		const ws = target.workspace_id;
		const existing = services.get(ws);
		if (existing && !existing.stopped) {
			// A pane list that fails is unknown: the ask fails, the service stays.
			if (await locate(existing, false)) {
				if (existing.state !== "waiting") await Promise.race([existing.starting, sleep(o.registerMs ?? REGISTER_WAIT_MS)]);
				return answer(existing, false);
			}
			await lose(existing, "its tab is gone");
		}
		// A resident tower of an older build keeps its workspace; it is the tower until it leaves.
		const draft: Live = { record: { workspace: ws, label: target.label, id: towerId(slot, ws), name: towerName(slot, target.label), pane: "", tab: "", created: "", seq: 0 }, state: "registering", stopped: false };
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
			return inside.length === 1 && !inside[0]!.agent && !inside[0]!.tokens?.sb_role ? [inside[0]!] : [];
		});
		let pane = marked ?? bare[0], dir: string | undefined;
		if (!pane) {
			dir = target.worktree?.checkout_path ?? cwd ?? slot.stateDir;
			const made = await createTab(run, ws, dir, [], TOWER_LABEL);
			pane = { pane_id: made.paneId, tab_id: made.tabId };
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
		const l = adopt(record);
		log.line("tower-opened", { workspace: ws, id: record.id, pane: record.pane, tab: record.tab });
		await Promise.race([l.starting, sleep(o.registerMs ?? REGISTER_WAIT_MS)]);
		return answer(l, true);
	};

	const ensure: Towers["ensure"] = async ({ workspace, pane, cwd }) => {
		if (!o.enabled()) throw new Error("towerRuns.enabled is off in config.json, so the sb server stands in for no tower");
		if (stopped) throw new Error("the sb server is stopping");
		await activate();
		const all = await workspaces(run);
		const asked = all.find((w) => w.workspace_id === workspace) ?? (all.filter((w) => w.label === workspace).length === 1 ? all.find((w) => w.label === workspace) : undefined);
		if (!asked) throw new Error(`${all.filter((w) => w.label === workspace).length > 1 ? "Several workspaces match" : "No workspace matches"} "${workspace}". Workspaces: ${all.map((w) => `${w.workspace_id} (${w.label})`).join(", ")}`);
		// A sub workspace never has a tower: its parent workspace's tower serves it.
		const target = isSub(asked) ? parentOf(all, asked) : asked;
		if (!target) throw new Error(`${asked.label} is a sub workspace with no open parent workspace, so it has no tower; open the parent workspace first`);
		const pending = opening.get(target.workspace_id) ?? openFor(target, target === asked ? pane : undefined, cwd).finally(() => opening.delete(target.workspace_id));
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
		const host = {
			reach: l.reach!, open: l.open!, closeMain: l.control!.closeMain, now, boardDir: join(slot.stateDir, "board"), label: l.record.label,
			link: async (body: Record<string, unknown>) => ((await o.link?.(body, l.record.id)) ?? { ok: false, code: "no_holder", error: "The link holder is not running in the sb server" }) as { ok: boolean; error?: string },
			server: o.server ?? { status: () => ({}), logs: () => [], restart: () => Promise.reject(new Error("The server cannot restart itself here")) },
			expect: (to: string, who: string, text: string) => { try { addExpect(slot, ws, { to, name: who, at: now(), first: phrase(text, 80) }, now()); } catch (cause) { error("expects", (cause as Error).message); } },
		};
		try {
			return await runTool(host, who.kind, name, args);
		} catch (cause) {
			// The run was released while the call was under way (a /new, an end): nobody is left to read the failure, so the next run does.
			if (!runs.runOf(request.token) && who.kind === "local") runs.notice(ws, `${name} failed after your run ended: ${(cause as Error).message}`, `${name}:${phrase((cause as Error).message, 80)}`);
			throw cause;
		}
	};

	const api: Towers = {
		runTool: runToolFor,
		activate,
		loaded: () => !o.enabled() || loadedAll,
		ensure,
		async close(workspace) {
			const l = services.get(workspace);
			if (!l) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			await run(["tab", "close", l.record.tab]).catch(() => {});
			await lose(l, "closed by the boss");
			return { workspace, id: l.record.id };
		},
		openMain: ({ workspace, request, sender, label }) => need(workspace).open!({ request, sender, ...(label ? { label } : {}) }),
		closeMain: ({ workspace, query }) => need(workspace).control!.closeMain(query),
		async takeover() {
			// A new Herdr server has no tokens and no pane environment: the tabs are looked for (for a minute, since a restore brings them back one by one), and the marks are written again.
			recoverUntil = now() + (o.recoverMs ?? RECOVER_MS);
			// Runs that were live end with outcome `herdr-restart`, and claims are held until this has been processed (the wake protocol, step 2).
			runs.takeoverBegin();
			try {
				if (!activation) return;
				log.line("towers-takeover", { services: services.size });
				await look();
				for (const l of services.values()) if (l.state === "live") await publish(l);
				readHead();
			} finally {
				await runs.takeoverEnd();
			}
		},
		status: () => [...services.values()].map((l) => ({ workspace: l.record.workspace, label: l.record.label, id: l.record.id, state: l.state, queue: queueLength(slot, l.record.workspace), ...(runs.status(l.record.workspace) ? { service: runs.status(l.record.workspace)! } : {}) })),
		runs,
		async stop(opts) {
			stopped = true;
			await runs.stop(opts);
			timers.forEach(clearInterval);
			events?.();
			await Promise.all([...services.values()].map((l) => release(l)));
		},
	};
	o.expose?.(api);
	return api;
}
