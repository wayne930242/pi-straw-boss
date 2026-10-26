import { herdrApi, herdrCall, herdrRun, socketRun } from "../herdr.ts";
import { type HeadlessDeps, headlessConfig } from "../agent/config.ts";
import { createHeadlessKit, type IntercomLike } from "../agent/kit.ts";
import { herdrEvents, herdrWatch, type HerdrWatch } from "../server-watch.ts";
import { alive as pidAlive } from "../remote.ts";
import { rememberStart, startedLater, startOf as processStartOf } from "../startof.ts";
import { AclError, applyAcl } from "./acl.ts";
import { herdrListens, intercomOf, runsAs } from "./client.ts";
import { type IntercomModule, loadIntercom, LoaderError } from "./intercom.ts";
import { createLog } from "./log.ts";
import {
	clearStartError, fileOf, prepareSlot, readRecord, restartingNow, type ServerRecord, serverId, type Slot, TOUCH_MS, updateRecord, writeRecord, writeStartError,
} from "./record.ts";
import { AFTER, endpointFor, helloOf, listenControl, newSecret, type Reply, type Request } from "./socket.ts";
import { packageRoot, VERSION } from "./version.ts";

// The sb server process (docs/specs/2026-10-26-sb-backend.md). B1 is the skeleton: it owns the control socket and `server.json`, holds an intercom session of its own through
// the headless kit, and takes the stop and restart requests. The GUI, the link holder, and the tower service move in with the later steps; nothing else moves yet.

/** The exit code of a `serve` server that was asked to restart: a supervisor (launchd `KeepAlive`, systemd `Restart=on-failure`) starts it again. */
export const SERVE_RESTART_CODE = 75;
/** Exit codes: 0 done, 3 the server cannot run (tsx or pi-intercom missing, the Windows ACL). */
export const EXIT_CANNOT_RUN = 3;
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const BROKER_MS = 5000, HERDR_GONE_MS = 60_000, HERDR_POLL_MS = 5000, LEAVE_MS = 2000;

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
	prepare?: (slot: Slot) => void;
	herdrUp?: () => Promise<boolean>;
	watch?: HerdrWatch;
	herdr?: HeadlessDeps;
	touchMs?: number;
	brokerMs?: number;
	herdrGoneMs?: number;
	herdrPollMs?: number;
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

	// The folder is ready (on Windows protected) before the log or any file is created in it. A folder that cannot be protected is a server that cannot run here: it leaves with 3 and writes
	// nothing into it, since an unprotected folder is what it could not fix (a starter that asked for it reads the same reason from its own call, and from the exit code).
	let unprepared: Error | undefined;
	try {
		(o.prepare ?? ((s: Slot) => prepareSlot(s, platform)))(slot);
	} catch (error) {
		unprepared = error as Error;
	}
	if (unprepared) {
		markReady(false);
		finish(EXIT_CANNOT_RUN);
		return handle;
	}
	// `boot`: how long this process had run when it got here (its own start and the load of the server's code), which a cold start on Windows spends before any line is logged.
	log.line("start", { pid, mode, version, by, herdr: slot.herdr, desk, ...(o.pid === undefined ? { boot: Math.round(process.uptime() * 1000) } : {}) });
	/** One line per phase of the start: how long it took, and when it ended counted from the start of this server. */
	const trace = (name: string, began: number) => log.line("phase", { name, ms: now() - began, at: now() - startedAt });
	const timers: ReturnType<typeof setInterval>[] = [], stops: (() => void)[] = [];

	/** The start cannot go on: told in start-error.json (which `up` and the session looks read) and in the record, and the process leaves with the code. */
	const abort = (code: "acl" | "loader" | "intercom" | "start", text: string, sddl?: string): ServerHandle => {
		timers.forEach(clearInterval);
		log.line("start-failed", { code, text });
		writeStartError(slot, { code, text, ...(sddl ? { sddl } : {}) }, now());
		// The start is over: `restarting` goes with it, so the record counts as gone at once and not when its last touch is 10 s old.
		updateRecord(slot, ({ restarting: _restarting, ...r }) => ({ ...(r.pid === pid ? r : { ...r, restarting: _restarting }), lastError: { at: new Date(now()).toISOString(), code, text } }));
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

	/** The record, when it is another running process's with a socket. */
	const rival = () => {
		const found = readRecord(slot);
		return found && found.pid !== pid && found.socket && runsAs({ alive, startOf }, found) ? found : undefined;
	};

	// From the first moment the record says this server is starting, and its `since` moves every touchMs: the ACL call and the code load below take seconds on Windows, and a look
	// in that time must see a start under way, not a server that is gone. The record holds no secret yet (and no socket), and keeps what a restart carries over.
	const begin = () => {
		// A record of another running process with a socket is a server, however slow its hello was a moment ago: it keeps its record.
		if (rival()) return;
		const current = readRecord(slot);
		writeRecord(slot, {
			pid, version, herdr: slot.herdr, mode, desk, intercom: intercomOf(env, platform), log: fileOf(slot, "log"), socket: "", secret: "", intercomId: serverId(slot),
			...(prior?.gui ? { gui: prior.gui } : {}), ...(prior?.lastError ? { lastError: prior.lastError } : {}), ...(prior?.lastRestart ? { lastRestart: prior.lastRestart } : {}),
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
			aclStarted = (await (o.acl ?? ((dir, who) => applyAcl(dir, undefined, undefined, who)))(slot.stateDir, pid))?.started;
		} catch (error) {
			return abort("acl", (error as Error).message, error instanceof AclError ? error.sddl : undefined);
		}
		trace("acl", began);
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
		// What the new server keeps from the one before it, so a restart changes nothing a page or a shell holds: the GUI's port and token (B2 fills them in), and the last error.
		...(prior?.gui ? { gui: prior.gui } : {}), ...(prior?.lastError ? { lastError: prior.lastError } : {}), ...(prior?.lastRestart ? { lastRestart: prior.lastRestart } : {}),
		...(aclStarted ? { started: aclStarted } : {}), log: fileOf(slot, "log"), socket: endpoint, secret, intercomId: serverId(slot),
	};
	let phase: "starting" | "ready" | "restarting" | "stopping" = "starting", client: IntercomLike | undefined, leaving: Promise<void> | undefined;
	const at = () => new Date(now()).toISOString();

	// Written whole by rename, with `restarting` kept from the record (a restart began it) and only its `since` moved.
	const writeOwn = () => {
		if (rival()) return;
		const current = readRecord(slot);
		writeRecord(slot, { ...own, ...(phase === "starting" ? { restarting: restartingNow(current?.restarting, now(), { reason: "starting", by }) } : {}) });
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
		await Promise.race([client?.disconnect().catch(() => {}), sleep(LEAVE_MS)]);
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
	const handleRequest = async (request: Request): Promise<Reply> => {
		if (request.cmd === "status") return { ok: true, ...facts(), uptimeMs: now() - startedAt, ...(own.lastError ? { lastError: own.lastError } : {}), towers: [], link: null };
		if (phase === "restarting" || phase === "stopping") return { ok: false, error: "restarting" };
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
			log.line("restart", { reason, by: who });
			updateRecord(slot, (r) => (r.pid === pid ? { ...r, restarting: { began: at(), since: at(), reason, by: who }, ...(request.counts === false ? {} : { lastRestart: { at: at(), reason, by: who } }) } : undefined));
			return leaveAfterReply("restarting", mode === "serve" ? SERVE_RESTART_CODE : 0);
		}
		return { ok: false, error: `unknown command ${String(request.cmd)}` };
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
	const taken = rival();
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
	// SAFETY: the kit hands a client to the modules that run the net; it is attached at the first connection, before any of them is built (none is in B1).
	const kit = createHeadlessKit({ client: undefined as unknown as IntercomLike, env: kitEnv, cfg, log: () => {} });
	stops.push(cfg.watch(() => log.line("herdr-takeover")));
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

	// Ready: the identities are as registered as they can be, `restarting` goes, and the start-error of this attempt (and any before it) with it.
	if (phase === "starting") {
		phase = "ready";
		updateRecord(slot, (r) => {
			if (r.pid !== pid) return undefined;
			const { restarting: _restarting, ...rest } = r;
			return rest;
		});
		clearStartError(slot);
		log.line("ready", { ms: now() - startedAt });
		markReady(true);
	}
	return handle;
}
