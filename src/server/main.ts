import { homedir } from "node:os";
import { join } from "node:path";
import { herdrApi, herdrCall, herdrRun, socketRun } from "../herdr.ts";
import { type HeadlessDeps, headlessConfig } from "../agent/config.ts";
import { createHeadlessKit, type IntercomLike } from "../agent/kit.ts";
import { herdrEvents, herdrWatch, type HerdrWatch } from "../server-watch.ts";
import { alive as pidAlive } from "../remote.ts";
import { rememberStart, startedLater, startOf as processStartOf } from "../startof.ts";
import { AclError, applyAcl, awaitAclMarker } from "./acl.ts";
import { createGuiLink, elsewhereLink, type GuiLink, inProcessLink, NO_LINK } from "../link/guiport.ts";
import type { Run } from "../remote.ts";
import { herdrListens, intercomOf, RESTART_EVERY_MS, runsAs, serverEnv } from "./client.ts";
import { createAllows } from "./allows.ts";
import { allyPort } from "./allyport.ts";
import { createAsks } from "./asks.ts";
import { cliBeside, createGuiHost, spawnRestart } from "./guihost.ts";
import { type IntercomModule, loadIntercom, LoaderError } from "./intercom.ts";
import { createLinkService, type LinkService, type ServiceDeps } from "../link/service.ts";
import { createLog, tailLog } from "./log.ts";
import { gateRun, type RunInfo } from "./rungate.ts";
import type { ServerTools } from "./runtools.ts";
import {
	clearStartError, type Detach, fileOf, prepareSlot, readRecord, restartingNow, type ServerRecord, serverId, type Slot, TOUCH_MS, towerId, updateRecord, writeRecord, writeStartError,
} from "./record.ts";
import { AFTER, endpointFor, helloOf, listenControl, newSecret, type Reply, type Request } from "./socket.ts";
import { createTowers, type Towers, type TowersOptions } from "./towers.ts";
import { readTowerRuns } from "./towerruns.ts";
import { packageRoot, VERSION } from "./version.ts";

// The sb server process (docs/specs/2026-10-26-sb-backend.md). It owns the control socket and `server.json`, holds an intercom session of its own through the headless kit, and
// takes the stop and restart requests. B2 moves the GUI in (guihost.ts). B3: the primary server also runs the Straw Link holder (link/service.ts) and answers its `link` requests; the
// tower service moves in with the later step.

/** The exit code of a `serve` server that was asked to restart: a supervisor (launchd `KeepAlive`, systemd `Restart=on-failure`) starts it again. */
export const SERVE_RESTART_CODE = 75;
/** Exit codes: 0 done, 3 the server cannot run (tsx or pi-intercom missing, the Windows ACL). */
export const EXIT_CANNOT_RUN = 3;
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const BROKER_MS = 5000, HERDR_GONE_MS = 60_000, HERDR_POLL_MS = 5000, LEAVE_MS = 2000, GUI_LEAVE_MS = 6000, LINK_MS = 3000, LINK_STOP_MS = 4000;
/** The client the kit starts with, before the first connection: not connected to anything, so the GUI can be built (and answer its page) while the broker is still starting. */
const OFFLINE: IntercomLike = {
	sessionId: null, isConnected: () => false, supportsFeature: () => false, connect: async () => { throw new Error("pi-intercom is not connected"); }, disconnect: async () => {},
	listSessions: async () => { throw new Error("pi-intercom is not connected"); }, send: async () => { throw new Error("pi-intercom is not connected"); }, updatePresence() {}, updateExtensionCapabilities() {},
	sendExtensionMessage() { throw new Error("pi-intercom is not connected"); }, onBrokerMessage: () => () => {}, on() { return OFFLINE; },
};

export interface ServerOptions {
	slot: Slot;
	env: NodeJS.ProcessEnv;
	mode: "detached" | "serve";
	/** Who started it, for `restarting.by` and the log. */
	by: string;
	version?: string;
	root?: string;
	platform?: NodeJS.Platform;
	pid?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	alive?: (pid: number) => boolean;
	startOf?: (pid: number) => string | undefined;
	/** This process's start time, as the record carries it. */
	started?: () => Promise<string | undefined>;
	/** Checks that tsx and pi-intercom are there and returns the way to the broker; throws a LoaderError. */
	intercom?: () => Promise<IntercomModule>;
	/** Sets and checks the Windows ACL of the state directory; the same PowerShell start tells this process's start time (the second argument is its pid). */
	acl?: (dir: string, pid: number) => Promise<{ started?: string } | void>;
	/** Makes the slot's folder ready before the first file is created in it (on Windows, protects the state folder); `prepareSlot` by default. */
	prepare?: (slot: Slot, ms?: number) => void;
	/** Windows: the token of the file where the process that started this server left the ACL check (`--acl-token`); with it the server waits for that check and reads it instead of making its own. */
	aclToken?: string;
	/** Waits for and verifies that check (`awaitAclMarker` by default). */
	marker?: (dir: string, token: string, pid: number) => Promise<{ started?: string } | void>;
	/** How the starter started this process (Windows): through WMI, or by a plain spawn after a failure; kept in the record, so `status` and `up` can say so. */
	detach?: { via: Detach; failure?: string };
	/** The GUI the server serves (guihost.ts); `false` serves none (the tests of the process itself). `link`, `bundle`, `tailscale`, and `bindWaitMs` replace the machine's. */
	gui?: false | { link?: GuiLink; bundle?: string; tailscale?: Run; bindWaitMs?: number; /** Another process's start time as the hand-over of the GUI asks for it, and how long it waits (tests; the process's own `startedLater` and 6 s by default). */ startedLater?: (pid: number) => Promise<string | undefined>; startWaitMs?: number; /** Asks for a restart as the page's button does; the real one starts `cli.mjs restart`. */ restart?: (reason: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> };
	herdrUp?: () => Promise<boolean>;
	watch?: HerdrWatch;
	herdr?: HeadlessDeps;
	/** Replaces the tower service's timers and the like, for tests. */
	towers?: Partial<TowersOptions>;
	touchMs?: number;
	brokerMs?: number;
	herdrGoneMs?: number;
	herdrPollMs?: number;
	/** How long the start waits for the link holder's first look before it reports ready (default 3 s). */
	linkMs?: number;
	/** Seams of the link holder (service.ts): shorter timers, a relay behind a fake `fetch`, an isolated home folder. */
	link?: ServiceDeps;
}
export interface ServerHandle {
	/** True once the server answers as ready (the broker is connected or has been tried, and `restarting` is cleared); false when it could not start. */
	ready: Promise<boolean>;
	/** The exit code, once the server has left. */
	done: Promise<number>;
	endpoint: string;
	/** Ends the server without marking a stop: what a signal does. */
	shutdown(code?: number): Promise<void>;
}

const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function runServer(o: ServerOptions): Promise<ServerHandle> {
	const { slot, env, mode, by } = o;
	const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const platform = o.platform ?? process.platform, pid = o.pid ?? process.pid, version = o.version ?? VERSION;
	// Liveness is judged the way requesters judge it: an injected check is for tests, and a server never takes a record of another pid for a live one by default.
	const touchMs = o.touchMs ?? TOUCH_MS, alive = o.alive ?? pidAlive, startOf = o.startOf ?? processStartOf;
	const log = createLog(fileOf(slot, "log"), { now });
	let finish!: (code: number) => void, markReady!: (ok: boolean) => void;
	const done = new Promise<number>((resolve) => (finish = resolve));
	const ready = new Promise<boolean>((resolve) => (markReady = resolve));
	const startedAt = now();
	const desk = env.STRAW_BOSS_DESK === "1";
	let endpoint = "";
	// Until the server is up there is nothing to take down: a start that failed has only its exit code to give.
	let leave: (code: number) => Promise<void> = async (code) => finish(code);
	const handle: ServerHandle = { ready, done, get endpoint() { return endpoint; }, shutdown: (code = 0) => leave(code) };

	// The folder is ready (on Windows protected) before the log or any file is created in it. A folder that cannot be protected is a server that cannot run here: it leaves with 3. It writes no
	// log, record, or secret into a folder it could not fix, only start-error.json, which holds the reason and nothing secret: a server started through WMI has no exit code for its starter to read
	// (a foreign ACE planted after the starter protected the folder ended `up` with "exited before it answered" and nothing else; VM pass 4, F3), and `up` reads that file.
	let unprepared: Error | undefined;
	try {
		(o.prepare ?? ((s: Slot, ms?: number) => prepareSlot(s, platform, undefined, ms)))(slot);
	} catch (error) {
		unprepared = error as Error;
	}
	if (unprepared) {
		try {
			writeStartError(slot, { code: "acl", text: phrase(unprepared.message, 600) }, now());
		} catch { /* the folder is not one this process can write in: the exit code is all there is */ }
		markReady(false);
		finish(EXIT_CANNOT_RUN);
		return handle;
	}
	// `boot`: how long this process had run when it got here (its own start and the load of the server's code), which a cold start on Windows spends before any line is logged.
	log.line("start", { pid, mode, version, by, herdr: slot.herdr, desk, ...(o.pid === undefined ? { boot: Math.round(process.uptime() * 1000) } : {}) });
	/** One line per phase of the start: how long it took, and when it ended counted from the start of this server. */
	const trace = (name: string, began: number, facts: Record<string, string> = {}) => log.line("phase", { name, ms: now() - began, at: now() - startedAt, ...facts });
	const timers: ReturnType<typeof setInterval>[] = [], stops: (() => void)[] = [];
	let link: LinkService | undefined, linkFirst: Promise<void> | undefined;
	// The Allows the dialog hub gave (a gate or an approval closed with a yes) and the asks the towers made for their mains: both are held for the tower service (B6).
	const allows = createAllows({ now }), asks = createAsks(slot, now);

	/** The start cannot go on: told in start-error.json (which `up` and the session looks read) and in the record, and the process leaves with the code. */
	const abort = (code: "acl" | "loader" | "intercom" | "start", text: string, sddl?: string): ServerHandle => {
		timers.forEach(clearInterval);
		log.line("start-failed", { code, text });
		writeStartError(slot, { code, text, ...(sddl ? { sddl } : {}) }, now());
		// The start is over: `restarting` goes with it, so the record counts as gone at once and not when its last touch is 10 s old.
		// Only this server's own record: another server's keeps its state and its own last error.
		updateRecord(slot, ({ restarting: _restarting, ...r }) => (r.pid === pid ? { ...r, lastError: { at: new Date(now()).toISOString(), code, text } } : undefined));
		markReady(false);
		// 3 is for a server that cannot run here (tsx, pi-intercom, the ACL); a start that failed for another reason is a plain failure.
		finish(code === "start" ? 1 : EXIT_CANNOT_RUN);
		return handle;
	};

	// One server per slot: a record whose process runs and answers is the server. (A requester holds server.lock, so this is a guard against a start that no one asked for.)
	const prior = readRecord(slot);
	if (prior && prior.pid !== pid && prior.socket && runsAs({ alive, startOf }, prior) && (await helloOf(prior.socket, prior.secret, 1000))) {
		log.line("already-running", { pid: prior.pid });
		markReady(true);
		finish(0);
		return handle;
	}

	// Another server's record is left alone only on positive evidence that it is a server: its hello answers, or its start time is known and is the one the record names. A process that merely
	// runs under the recorded pid is not enough (a pid a crashed server left is reused by an unrelated process, and `startOf` cannot tell on Windows until a background read is in).
	const changed = (found: ServerRecord) => found.pid !== prior?.pid || found.secret !== prior?.secret || found.socket !== prior?.socket;
	const knownRunning = (found: ServerRecord) => alive(found.pid) && Boolean(found.started) && startOf(found.pid) === found.started;
	/**
	 * The record, when it is another server's that is known to run (without a hello): its start time is known and equal to the record's (a live server whose hello was slow keeps its record, though
	 * nothing about it changed), or the record was taken since the first look by a process that runs (its start time cannot be told yet, and its hello may not answer yet either).
	 */
	const rival = () => {
		const found = readRecord(slot);
		return found && found.pid !== pid && found.socket && (knownRunning(found) || (changed(found) && runsAs({ alive, startOf }, found))) ? found : undefined;
	};

	// From the first moment the record says this server is starting, and its `since` moves every touchMs: the ACL call and the code load below take seconds on Windows, and a look
	// in that time must see a start under way, not a server that is gone. The record holds no secret yet (and no socket), and keeps what a restart carries over.
	const detachOf = o.detach ? { detach: o.detach.via, ...(o.detach.failure ? { detachFailure: phrase(o.detach.failure, 200) } : {}) } : {};
	const begin = () => {
		// A record of another running process with a socket is a server, however slow its hello was a moment ago: it keeps its record.
		if (rival()) return;
		const current = readRecord(slot);
		writeRecord(slot, {
			pid, version, herdr: slot.herdr, mode, desk, intercom: intercomOf(env, platform), log: fileOf(slot, "log"), socket: "", secret: "", intercomId: serverId(slot),
			...(prior?.gui ? { gui: prior.gui } : {}), ...(prior?.lastError ? { lastError: prior.lastError } : {}), ...(prior?.lastRestart ? { lastRestart: prior.lastRestart } : {}), ...detachOf,
			restarting: restartingNow(current?.restarting, now(), { reason: "starting", by }),
		});
	};
	let early: ReturnType<typeof setInterval> | undefined;
	try {
		begin();
	} catch (error) {
		return abort("start", `the record cannot be written: ${(error as Error).message}`);
	}
	early = setInterval(() => { try { begin(); } catch (error) { log.line("error", { code: "record", text: phrase((error as Error).message, 300) }); } }, touchMs);
	timers.push(early);

	// The code the server runs from does not depend on the ACL, so it loads while the ACL call runs. The ACL still comes before the secret is written anywhere.
	const loading = (async () => {
		const began = now();
		try {
			return await (o.intercom ?? (() => loadIntercom({ env, root: o.root ?? packageRoot() })))();
		} finally {
			trace("loader", began);
		}
	})();
	loading.catch(() => {});
	let aclStarted: string | undefined;
	if (platform === "win32") {
		const began = now();
		try {
			// With a token the process that started this server made the check in its own PowerShell start (and read this process's start time there): it is waited for, and its SDDLs are checked here
			// before the secret is written. Without one (`serve`, a plain spawn) this process makes the check itself.
			aclStarted = (await (o.aclToken ? (o.marker ?? awaitAclMarker)(slot.stateDir, o.aclToken, pid) : (o.acl ?? ((dir, who) => applyAcl(dir, undefined, undefined, who)))(slot.stateDir, pid)))?.started;
		} catch (error) {
			return abort("acl", (error as Error).message, error instanceof AclError ? error.sddl : undefined);
		}
		trace("acl", began, { via: o.aclToken ? "marker" : "own" });
		if (aclStarted) rememberStart(pid, aclStarted);
	}
	// This process's start time came with the ACL call on Windows; elsewhere it is read at once. The server does not wait for it to listen: it is filled into the record when it is in.
	const startedAtLast = aclStarted ? Promise.resolve(aclStarted) : (o.started ?? (() => startedLater(pid, { hold: false })))().catch(() => undefined);
	let mod: IntercomModule;
	try {
		mod = await loading;
	} catch (error) {
		return abort(error instanceof LoaderError ? error.code : "loader", (error as Error).message);
	}

	const secret = newSecret();
	endpoint = endpointFor(slot, platform);
	log.hide(secret);
	const own: ServerRecord = {
		pid, version, herdr: slot.herdr, mode, desk, intercom: intercomOf(env, platform),
		// What the new server keeps from the one before it: the GUI's port and whether it was stopped on purpose, and the last error. The GUI's token is the old listener's and goes when the new one starts (guihost.ts writes the new token to both records before `restarting` is cleared).
		...(prior?.gui ? { gui: prior.gui } : {}), ...(prior?.lastError ? { lastError: prior.lastError } : {}), ...(prior?.lastRestart ? { lastRestart: prior.lastRestart } : {}),
		...(aclStarted ? { started: aclStarted } : {}), ...detachOf, log: fileOf(slot, "log"), socket: endpoint, secret, intercomId: serverId(slot),
	};
	let phase: "starting" | "ready" | "restarting" | "stopping" = "starting", client: IntercomLike | undefined, leaving: Promise<void> | undefined, guiHost: ReturnType<typeof createGuiHost> | undefined, towers: Towers | undefined;
	const at = () => new Date(now()).toISOString();

	// Written whole by rename, with `restarting` kept from the record (a restart began it) and only its `since` moved.
	const writeOwn = () => {
		if (rival()) return;
		const current = readRecord(slot);
		// The GUI the record already holds is this server's own once it has started (guihost.ts records its port and its new token as it starts).
		writeRecord(slot, { ...own, ...(current?.pid === pid && current.gui ? { gui: current.gui } : {}), ...(phase === "starting" ? { restarting: restartingNow(current?.restarting, now(), { reason: "starting", by }) } : {}) });
	};
	const recordError = (code: string, text: string) => {
		own.lastError = { at: at(), code, text: phrase(text, 300) };
		log.line("error", { code, text: own.lastError.text });
		if (phase !== "stopping") updateRecord(slot, (r) => (r.pid === pid ? { ...r, lastError: own.lastError } : undefined));
	};
	const facts = () => ({ pid, ...(own.started ? { started: own.started } : {}), version, mode, desk, phase, ready: phase === "ready" });

	const shutdown = (code: number): Promise<void> => (leaving ??= (async () => {
		const began = now();
		timers.forEach(clearInterval);
		stops.forEach((stop) => stop());
		// The link holder's record goes before the server does, so the next server takes it at its first look and no relay stream is left half open.
		await Promise.race([link?.stop().catch((error: Error) => log.line("error", { code: "link", text: phrase(error.message, 300) })), sleep(LINK_STOP_MS)]);
		// The GUI listeners and the remote entry go before the intercom ids are released.
		await Promise.race([guiHost?.leave(phase === "stopping").catch(() => {}), sleep(GUI_LEAVE_MS)]);
		// The tower identities leave the broker with the server's own session; their tokens and files stay for the server that comes next.
		await Promise.race([Promise.all([towers?.stop({ quitRuns: phase === "stopping" }), client?.disconnect().catch(() => {})]), sleep(LEAVE_MS)]);
		const disconnected = now();
		await control?.close();
		log.line("exit", { code, disconnectMs: disconnected - began, closeMs: now() - disconnected });
		markReady(false);
		finish(code);
	})());
	leave = shutdown;
	/** From now on the server only answers `status`: its timers stop, and it leaves once the reply that told the requester is written. */
	const leaveAfterReply = (next: "restarting" | "stopping", code: number): Reply => {
		phase = next;
		timers.forEach(clearInterval);
		timers.length = 0;
		return { ok: true, [AFTER]: () => void shutdown(code) };
	};

	let control: Awaited<ReturnType<typeof listenControl>> | undefined;
	// One restart a minute for an agent (a session's `boss_server`, a run's), decided here and not only by the requester under the lock: the record's last restart that counts, or one a run asked for just now.
	let restartAskedAt: number | undefined;
	const restartTooSoon = (): string | undefined => {
		const last = Math.max(restartAskedAt ?? 0, Date.parse(readRecord(slot)?.lastRestart?.at ?? "") || 0);
		return last && now() - last < RESTART_EVERY_MS ? `The sb server was restarted ${Math.round((now() - last) / 1000)} s ago; restarts are taken once a minute at most.` : undefined;
	};
	const handleRequest = async (request: Request): Promise<Reply> => {
		// A request that carries a run token is a run's: the token must be one the server issued, and the request is held to the run's kind (rungate.ts). One without a token is a session's or a shell's.
		let run: RunInfo | undefined;
		// A run of the server before this one polls and claims while this one is still loading the runs from disk and connecting the tower identities: it is told to wait (a claim `wait`, a poll or other
		// request a refusal that is not `unknown_token`), so the run keeps its claim through the restart and does not end on the first answer (B5R-F002).
		if ((phase === "starting" || !towers?.loaded()) && request.cmd !== "status") {
			if (request.cmd === "claim" || request.cmd === "pane-role") return { ok: true, wait: true, role: "wait" };
			if (request.token !== undefined) return { ok: false, error: "the server is still starting" };
		}
		if (request.token !== undefined) {
			run = towers?.runs.runOf(request.token);
			const verdict = run ? gateRun({ cmd: request.cmd, workspace: request.workspace, body: request.body }, run) : { ok: false as const, error: "unknown_token" };
			if (!verdict.ok) return { ok: false, error: verdict.error };
		}
		if (request.cmd === "status") return { ok: true, ...facts(), uptimeMs: now() - startedAt, ...(own.lastError ? { lastError: own.lastError } : {}), towers: towers?.status() ?? [], link: link?.status() ?? null, ...(guiHost && o.gui !== false ? { gui: guiHost.facts() } : {}) };
		if (phase === "restarting" || (phase === "stopping" && request.cmd !== "run-poll")) return { ok: false, error: "restarting" };
		if (request.cmd === "link") {
			// A request of a session to the link holder (service.ts): the answer is the holder's own, in `answer`; `ok` is only whether the server took the request. Only the primary server holds the link.
			// A run's requests go out as its workspace's tower, whatever it says it is.
			const from = run ? towerId(slot, run.workspace) : phrase(request.from, 200);
			if (!from || typeof request.body !== "object" || request.body === null) return { ok: false, error: "a link request needs from and body" };
			// An ally run may ask its own sender's device to confirm a call at `forward`, and nobody else's: the device and the team are the run's, whatever the request says. The answer comes back to the run at its poll.
			// The wait is the requester's: only the run that asked may forget it, and a request the holder refuses leaves no wait behind.
			let confirming: string | undefined;
			if (run?.kind === "ally") {
				const body = request.body as Record<string, unknown>;
				if (body.op === "confirm-request") {
					const info = towers?.runs.runOf(request.token);
					if (!info?.device || !info.team || typeof body.dialogId !== "string") return { ok: false, error: "an ally run asks its sender to confirm with a dialog id" };
					towers!.runs.watchConfirm(request.token, body.dialogId);
					confirming = body.dialogId;
					request.body = { ...body, device: info.device, team: info.team };
				} else if (body.op === "forget-confirm" && (typeof body.dialogId !== "string" || !towers?.runs.forgetConfirm(request.token, body.dialogId))) return { ok: false, error: "an ally run forgets only a confirm it asked for" };
			}
			// A test replaces the holder the tower service asks (`options.towers.link`); the requests of runs go the same way.
			const answer = o.towers?.link ? await o.towers.link(request.body, from)
				: !slot.primary ? { ok: false, code: "no_link", error: NO_LINK }
				: !link ? { ok: false, code: "no_holder", error: "The link holder is not running in the sb server yet; ask again in a moment" }
				: await link.request(request.body, from);
			if (confirming && (answer as { ok?: unknown } | undefined)?.ok !== true) towers?.runs.forgetConfirm(request.token, confirming);
			return { ok: true, answer };
		}
		const asked = await guiHost?.handle(request);
		if (asked) return asked;
		if (request.cmd === "stop") {
			// A `serve` server is never stopped from here: its supervisor would start it again at once, and hide from the infra that its service is off.
			if (mode === "serve") return { ok: false, error: "serve" };
			const who = phrase(request.by, 120) || "unknown";
			log.line("stop", { by: who });
			updateRecord(slot, (r) => (r.pid === pid ? (({ restarting: _restarting, ...rest }) => ({ ...rest, stopped: true }))(r) : undefined));
			return leaveAfterReply("stopping", 0);
		}
		if (request.cmd === "restart") {
			const reason = phrase(request.reason, 200) || "restart", who = phrase(request.by, 120) || "unknown";
			const tooSoon = request.limit === true ? restartTooSoon() : undefined;
			if (tooSoon) return { ok: false, error: `rate: ${tooSoon}` };
			log.line("restart", { reason, by: who });
			// One read of the clock: `began`, `since` and `lastRestart.at` are the same moment (two reads can fall in different milliseconds).
			const when = at();
			updateRecord(slot, (r) => (r.pid === pid ? { ...r, restarting: { began: when, since: when, reason, by: who }, ...(request.counts === false ? {} : { lastRestart: { at: when, reason, by: who } }) } : undefined));
			return leaveAfterReply("restarting", mode === "serve" ? SERVE_RESTART_CODE : 0);
		}
		const tower = towerCommand(request);
		if (tower) return tower;
		return { ok: false, error: `unknown command ${String(request.cmd)}` };
	};
	/** The tower service's commands (docs/specs/2026-10-26-sb-backend.md, The tower service): `ensure-tower`, `close-tower`, and the opener's and `close-main`'s asks. Behind `towerRuns.enabled`. */
	const towerCommand = (request: Request): Promise<Reply> | undefined => {
		const text = (value: unknown, max = 300) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);
		const answer = async (work: (t: Towers) => Promise<Record<string, unknown>>): Promise<Reply> => {
			if (!towers) return { ok: false, error: "the server is still starting" };
			try {
				return { ok: true, ...(await work(towers)) };
			} catch (error) {
				return { ok: false, error: (error as Error).message };
			}
		};
		const workspace = text(request.workspace);
		switch (request.cmd) {
			case "ensure-tower":
				return workspace ? answer(async (t) => ({ ...(await t.ensure({ workspace, ...(text(request.pane) ? { pane: text(request.pane)! } : {}), ...(text(request.cwd, 4096) ? { cwd: text(request.cwd, 4096)! } : {}) })) })) : Promise.resolve({ ok: false, error: "ensure-tower needs a workspace" });
			case "close-tower":
				return workspace ? answer((t) => t.close(workspace)) : Promise.resolve({ ok: false, error: "close-tower needs a workspace" });
			case "open-main": {
				const [what, sender] = [text(request.request, 100_000), text(request.sender)];
				return workspace && what && sender ? answer(async (t) => ({ opened: await t.openMain({ workspace, request: what, sender, ...(text(request.label) ? { label: text(request.label)! } : {}) }) })) : Promise.resolve({ ok: false, error: "open-main needs a workspace, a request, and a sender" });
			}
			case "close-main": {
				const query = text(request.query);
				return workspace && query ? answer(async (t) => ({ closed: await t.closeMain({ workspace, query }) })) : Promise.resolve({ ok: false, error: "close-main needs a workspace and a session" });
			}
			// The runs (runs.ts): a pi started with --sb-run claims its run; a pi in a standing pane asks its role; a run polls for its events, confirms them, and ends with tower_done.
			case "claim": return answer(async (t) => ({ ...(await t.runs.claim(request)) }));
			case "pane-role": return answer(async (t) => ({ ...(await t.runs.paneRole(request)) }));
			case "run-poll": return answer(async (t) => ({ ...t.runs.poll(request) }));
			case "run-taken": return answer(async (t) => ({ ...t.runs.taken(request) }));
			case "run-done": return answer(async (t) => ({ ...(await t.runs.done(request)) }));
			case "run-release": return answer(async (t) => ({ ...(await t.runs.release(request)) }));
			case "run-tool": return answer(async (t) => ({ ...(await t.runTool(request)) }));
			case "run-file": return answer(async (t) => (t.runs.setFile(request.token, request.file), {}));
			// The boss writes to the tower (the GUI's composer, `/boss tower <prompt>`): an event ahead of the rest.
			case "tower-event": {
				const body = text(request.text, 16_384);
				return workspace && body ? answer(async (t) => ({ queued: t.runs.boss(workspace, body).id })) : Promise.resolve({ ok: false, error: "tower-event needs a workspace and text" });
			}
			case "tower-retry": return workspace ? answer(async (t) => (t.runs.retry(workspace), {})) : Promise.resolve({ ok: false, error: "tower-retry needs a workspace" });
			case "tower-deliver": case "tower-drop": {
				const id = text(request.id, 64);
				return workspace && id ? answer(async (t) => (request.cmd === "tower-drop" ? t.runs.dropParked(workspace, id) : t.runs.deliverAgain(workspace, id), {})) : Promise.resolve({ ok: false, error: `${request.cmd} needs a workspace and an event id` });
			}
			default:
				return undefined;
		}
	};

	const listening = now();
	try {
		control = await listenControl({
			endpoint, secret, platform, now, hello: facts, handle: handleRequest,
			refused: (why) => log.line("refused", { why }),
		});
	} catch (error) {
		return abort("start", `the control socket cannot listen at ${endpoint}: ${(error as Error).message}`);
	}
	// The check of the prior record at the top was one look, long ago on a cold start: a server that has taken the record since keeps it, and this one, which listens at an endpoint of its
	// own on Windows (a pipe with a random name), is not a second server for the slot.
	const found = readRecord(slot);
	const taken = found && found.pid !== pid && found.socket && runsAs({ alive, startOf }, found) && (rival() !== undefined || (await helloOf(found.socket, found.secret, 1000))?.pid === found.pid) ? found : undefined;
	if (taken) {
		await control.close();
		return abort("start", `the sb server of pid ${taken.pid} runs and holds this slot's record`);
	}
	// From here the full record is written (by `writeOwn`, which keeps `restarting`) and the placeholder's touches stop.
	clearInterval(early);
	timers.splice(timers.indexOf(early!), 1);
	writeOwn();
	trace("listen", listening);
	void startedAtLast.then((started) => {
		if (!started || phase === "stopping") return;
		own.started = started;
		updateRecord(slot, (r) => (r.pid === pid && r.secret === secret ? { ...r, started } : undefined));
		guiHost?.started();
	});
	timers.push(setInterval(() => {
		try {
			if (phase === "restarting" || phase === "stopping") return;
			const current = readRecord(slot);
			if (phase === "starting") return writeOwn();
			if (current?.pid === pid && current.secret === secret && current.socket === endpoint) return;
			// Another server that runs wrote it (a takeover is under way): not ours to fight over.
			if (current && current.pid !== pid && runsAs({ alive, startOf }, current)) return;
			log.line("record-restored");
			writeOwn();
		} catch (error) {
			recordError("record", (error as Error).message);
		}
	}, touchMs));

	// Herdr: a new server taking over the socket is noticed (B4 finds the tower tabs again then); a detached server leaves 60 s after its Herdr is gone.
	const herdrCfg = { ...o.herdr, call: o.herdr?.call ?? herdrCall(slot.herdr), api: o.herdr?.api ?? herdrApi(slot.herdr), watch: o.herdr?.watch ?? o.watch ?? herdrWatch(slot.herdr), events: o.herdr?.events ?? herdrEvents(slot.herdr), stateDir: slot.stateDir };
	const kitEnv = { ...env, PI_INTERCOM_SESSION_ID: serverId(slot) };
	const cfg = headlessConfig({ ...herdrCfg, run: o.herdr?.run ?? socketRun(herdrRun, herdrCfg.call, undefined) }, kitEnv);
	// SAFETY: the kit hands a client to the modules that run the net; it is attached at the first connection, before any of them is built (the link holder is built right after it).
	const kit = createHeadlessKit({ client: OFFLINE, env: kitEnv, cfg, log: () => {} });
	const gui = o.gui === false ? {} : o.gui ?? {};
	guiHost = createGuiHost({
		listen: o.gui !== false, onAllow: (note) => allows.note(note),
		slot, kit, log, pid, version, started: () => own.started, runs: (record) => runsAs({ alive, startOf }, record), startedLater: gui.startedLater ?? (o.startOf ? async (other) => o.startOf!(other) : (other) => startedLater(other, { hold: false })), startWaitMs: gui.startWaitMs,
		sessions: async () => (client?.isConnected() ? client.listSessions() : Promise.reject(new Error("pi-intercom is not connected"))),
		// The primary server holds the link itself (B3), so the GUI asks the holder in this process as the server, which the holder takes GUI requests from; before it runs, the channel reaches the holder's session. A secondary server holds none and its GUI says so (`no_link`, as its `link` request does): the channel would ask the primary's holder as a session that is not the GUI's host.
		link: gui.link ?? (!slot.primary ? elsewhereLink() : inProcessLink(createGuiLink({ events: kit.pi.events, id: () => serverId(slot), stateDir: slot.stateDir, agentDir: env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), log: (text) => log.line("link", { text }) }), () => link, () => serverId(slot))),
		status: () => ({ state: phase === "ready" ? "live" : phase, version, pid, mode, desk, uptimeMs: now() - startedAt, log: fileOf(slot, "log"), ...(own.lastError ? { lastError: own.lastError } : {}) }),
		restart: gui.restart ?? ((reason) => spawnRestart(cliBeside(), reason, "the GUI", serverEnv(env), slot.dir)),
		failed: (code, text) => recordError(code, text), tailscale: gui.tailscale, bundle: gui.bundle, bindWaitMs: gui.bindWaitMs,
		// The page's tower units: the service's state and queue in the net, the composer as a boss event, and the notices' buttons (towers is built below, after the GUI host, and may be absent).
		tower: {
			view: (workspace) => towers?.runs.view(workspace),
			has: (workspace) => towers?.runs.view(workspace) !== undefined,
			live: (workspace) => Boolean(towers?.runs.status(workspace)?.run),
			event: async (workspace, text) => { try { return (towers!.runs.boss(workspace, text, "the boss (GUI)"), { ok: true }); } catch (error) { return { ok: false, error: (error as Error).message }; } },
			act: async (workspace, what, id) => { try { return (what === "retry" ? towers!.runs.retry(workspace) : what === "deliver" ? towers!.runs.deliverAgain(workspace, id!) : towers!.runs.dropParked(workspace, id!), { ok: true }); } catch (error) { return { ok: false, error: (error as Error).message }; } },
		},
	});
	// The tower service (behind `towerRuns.enabled`): it stands in for each workspace's tower, and finds the tabs again when a new Herdr server takes over.
	// What `boss_server` does for a run (runtools.ts): the server answers it itself, so it can refuse an ally run's token and keep the restart limit.
	const serverTools: ServerTools = {
		status: () => ({ state: phase === "ready" ? "live" : phase, version, pid, mode, desk, uptimeMs: now() - startedAt, log: fileOf(slot, "log"), ...(own.lastError ? { lastError: own.lastError } : {}), ...(readRecord(slot)?.lastRestart ? { lastRestart: readRecord(slot)!.lastRestart } : {}) }),
		logs: (lines) => tailLog(fileOf(slot, "log"), lines),
		async restart(reason, by) {
			const soon = restartTooSoon();
			if (soon) throw new Error(soon);
			restartAskedAt = now();
			log.line("restart-asked", { by, reason });
			const done = await (gui?.restart ?? ((why: string) => spawnRestart(cliBeside(), why, by, serverEnv(env), slot.dir)))(reason);
			if (done.status >= 400) throw new Error(`The restart did not start (${JSON.stringify(done.body)})`);
		},
	};
	// An unreadable config.json keeps the service on; the boss is told once per distinct problem, in the log and as the status's lastError.
	let toldConfig = "";
	const towerRuns = () => {
		const read = readTowerRuns(slot.stateDir);
		if (read.problem !== toldConfig) (toldConfig = read.problem ?? "", read.problem && recordError("config", read.problem));
		return read;
	};
	towers = createTowers({
		ally: allyPort(() => link), allows, asks,
		slot, cfg, env, connect: () => mod.connect(), log, pid, startedAt, enabled: () => towerRuns().enabled, server: serverTools,
		link: async (body, from) => (!slot.primary ? { ok: false, code: "no_link", error: NO_LINK } : link ? link.request(body, from) : { ok: false, code: "no_holder", error: "The link holder is not running in the sb server yet; ask again in a moment" }),
		sessions: () => (client ? client.listSessions() : Promise.reject(new Error("pi-intercom is not connected"))), ...o.towers,
	});
	stops.push(cfg.watch(() => {
		log.line("herdr-takeover");
		void towers?.takeover().catch((error: Error) => recordError("towers", error.message));
	}));
	let downSince: number | undefined;
	const herdrUp = o.herdrUp ?? (() => herdrListens({ slot, platform }));
	timers.push(setInterval(() => void herdrUp().then((up) => {
		if (up) return void (downSince = undefined);
		downSince ??= now();
		if (mode === "detached" && phase !== "restarting" && phase !== "stopping" && now() - downSince >= (o.herdrGoneMs ?? HERDR_GONE_MS)) {
			recordError("herdr", `Herdr at ${slot.herdr} has not answered for ${Math.round((now() - downSince) / 1000)} s, so this server leaves`);
			void shutdown(0);
		}
	}), o.herdrPollMs ?? HERDR_POLL_MS));

	// pi-intercom: the server's own session, reconnecting with the sidecar's backoff (1, 2, 5, 10, then 30 s). While it is disconnected its identities are not live.
	// The link holder (B3): the primary server only, built once the first connection is attached (the kit's channel needs a client). A computer with no team set up gets no channel, election, or files.
	const startLink = () => {
		if (link || !slot.primary || leaving) return;
		link = createLinkService({
			kit, stateDir: slot.stateDir, version, pid, started: () => own.started,
			notify: (text, level = "info") => log.line("link-notice", { level, text: phrase(text, 300) }), deps: o.link,
			// The tower service takes part in the holder's work (B6): an ask answered by a `tower-reply` is the main's, messages for a tower identity the server runs wake an ally run, and a `forward` answer reaches its run.
			tower: { asks: { take: (q) => asks.take(q) }, served: (identity) => towers?.allyWaiting(identity), confirmed: (to, dialogId, allow) => towers?.runs.confirmed(dialogId, allow) ?? false },
		});
		linkFirst = link.start();
	};
	let connecting = false, resolveFirst!: (ok: boolean) => void;
	const first = new Promise<boolean>((resolve) => (resolveFirst = resolve));
	let connectBegan = now();
	const connectLoop = async () => {
		if (connecting) return;
		connecting = true;
		connectBegan = now();
		for (let attempt = 0; !leaving && phase !== "restarting" && phase !== "stopping"; attempt++) {
			try {
				const next = await mod.connect();
				kit.attach(next);
				client = next;
				next.on("message", () => {});
				next.on("disconnected", () => {
					if (client === next) {
						log.line("intercom-lost");
						connecting = false;
						void connectLoop();
					}
				});
				next.on("error", () => {});
				await next.connect({ name: "sb server", cwd: slot.dir, model: "straw-boss-server", pid, startedAt, lastActivity: now() }, serverId(slot));
				log.line("intercom-connected", { id: serverId(slot), intercom: mod.version, ms: now() - connectBegan });
				startLink();
				resolveFirst(true);
				break;
			} catch (error) {
				recordError("intercom", (error as Error).message);
				resolveFirst(false);
				await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
			}
		}
		connecting = false;
	};
	void connectLoop();
	await Promise.race([first, sleep(o.brokerMs ?? BROKER_MS).then(() => false)]);
	// The link holder has looked once (it is bound to the identities, which are registered, and the GUI ports come after it): a first look that is slow does not hold the start.
	if (linkFirst) await Promise.race([linkFirst, sleep(o.linkMs ?? LINK_MS)]).then(((began) => () => trace("link", began))(now()));
	// Every tower identity registers before the server answers as ready (and before the GUI ports are bound, B2), so the guard sees live towers again as early as it can after a restart.
	await Promise.race([towers.activate().catch((error: Error) => recordError("towers", error.message)), sleep(o.brokerMs ?? BROKER_MS)]);

	// The GUI binds the recorded ports last (under a new token), after the intercom ids are as registered as they can be and, with the link holder in the server, after that.
	await guiHost?.start();

	// Ready: `restarting` goes, and the start-error of this attempt (and any before it) with it.
	if (phase === "starting") {
		phase = "ready";
		// The last error of the server before this one (kept so a restart changes nothing a page holds) is history once this one is ready; an error of this attempt stays.
		const stale = own.lastError !== undefined && own.lastError === prior?.lastError;
		if (stale) delete own.lastError;
		updateRecord(slot, (r) => {
			if (r.pid !== pid) return undefined;
			const { restarting: _restarting, ...rest } = r;
			if (!stale) return rest;
			const { lastError: _history, ...current } = rest;
			return current;
		});
		clearStartError(slot);
		log.line("ready", { ms: now() - startedAt });
		markReady(true);
	}
	return handle;
}
