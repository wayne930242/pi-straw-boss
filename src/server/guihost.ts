import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bridge } from "../bridge.ts";
import { createCloser } from "../closer.ts";
import type { Reply as HttpReply } from "../control.ts";
import { createDeploys } from "../deploy.ts";
import { type AllowNote, createHub, type Hub } from "../dialogs.ts";
import { BUNDLE, type Gui, startGui } from "../gui.ts";
import { alive } from "../remote.ts";
import { answers, boundedWait, type GuiRecord, listening, postServer, readRecord as readGuiJson, writeRecordFile } from "../handover.ts";
import type { Session } from "../herdr.ts";
import { type GuiLink } from "../link/guiport.ts";
import { type Net, netSource, type TowerView } from "../net.ts";
import type { TowerPanel } from "../control.ts";
import { identity, type Run, switchRemote, tailscale } from "../remote.ts";
import { createSpawn } from "../spawn.ts";
import { popBase, stashedList } from "../stash.ts";
import { trustDir } from "../trust/files.ts";
import { createTrustServe } from "../trust/serve.ts";
import type { Kit } from "../state.ts";
import { type Log, tailLog } from "./log.ts";
import { dropSecrets, keepSecrets, type Lost, readSecrets } from "./guisecrets.ts";
import { fileOf, readRecord, type ServerRecord, type Slot, updateRecord, writeJson } from "./record.ts";
import type { Reply, Request } from "./socket.ts";

// The GUI inside the sb server (docs/specs/2026-10-26-sb-backend.md, What moves out of pi sessions, GUI, `gui.json` and its successor): the page's server (gui.ts), the dialog hub, trust questions,
// spawn and deploys, the closer, the mirrors, documents and uploads, and remote access over Tailscale, which a pi session ran until 0.45.0 (host.ts). It runs on the server's own intercom
// session: the hub owns `straw-boss/gui/<hash of the server's id>` with no local bridge, and the bridges in sessions follow `gui.json`'s `ownerSession` to it as before.
//
// The GUI starts when the server does, on the ports the last one recorded (a port that is not free for 5 s is replaced) under the token and CSRF secret the last listener stored in gui-secrets.json (guisecrets.ts):
// a restart, an upgrade, a crash, a reboot, or a start after a stop keeps the address, the CSRF secret and the paired devices (D27, the boss's choice; the risk it accepts is RC3-F002's, in the spec). A new token, with the paired
// devices cleared, comes only when the store is missing or corrupt, when a listener could not get both of its ports back, and when the boss rotates on purpose (`/boss gui rotate`, `gui-rotate`). It does not start when it was stopped on purpose
// (`/boss gui stop`: `gui.stopped` in server.json, `stopped` in gui.json). Only the boss's own commands start a GUI that was stopped. gui.json is written by this server under the unchanged contract, and
// server.json's `gui` is `{ port, token, stopped }`.
//
// What a session asks over the control socket (server-look.ts):
//   gui {boss}            the GUI's URL, started if it is not running; refused with `stopped` for an automatic ask when it was stopped on purpose (`boss`: the boss's own, which starts it)
//   gui-stop              stops the GUI listeners and takes the remote entry down (remote stays wanted); marks the GUI stopped on purpose
//   gui-remote {on}       turns remote access on (answers the lines of the pairing QR) or off; the boss's own, so it starts a stopped GUI
//   gui-pair              a new one-time pairing link while remote access is on
//   gui-rotate            a new token and CSRF secret, every paired device unpaired; the boss's own, so it starts a stopped GUI (answers like `gui`)
// and what the page asks of the server panel (this computer's page only): status, restart, and the log (control.ts `server`).

/** Binding the recorded ports: a restart's old server is still letting go of them for a moment. */
export const BIND_WAIT_MS = 5000;
/** How long a start waits for a live older host to let go of the GUI it was asked to hand over. */
const RECLAIM_WAIT_MS = 5000;
/** How long the hand-over waits for the start time of the process gui.json names (Windows: the CIM read takes 3.5 s and more, and the reclaim runs once, after the broker wait). */
const RECLAIM_START_WAIT_MS = 6000;
/** How long a start waits for remote access to come back before it goes on. */
const RESUME_WAIT_MS = 3000;

export interface GuiHostOptions {
	slot: Slot;
	kit: Pick<Kit, "pi" | "cfg" | "me">;
	log: Log;
	pid: number;
	version: string;
	/** This server's start time, once it is known (on Windows it comes late). */
	started(): string | undefined;
	/** The server's intercom session, listed sessions included. */
	sessions(): Promise<Session[]>;
	/** A gate or an approval that closed with an explicit yes, as the dialog hub saw it (allows.ts): the tower service takes an ally run's gated tool call only against one. */
	onAllow?(note: AllowNote): void;
	/** Whether the process a gui.json names still runs as that process (pid alive, started when the record says): only then is it asked for anything. */
	runs?(record: Pick<GuiRecord, "pid" | "started">): boolean;
	/** A process's start time once it is known (Windows: a background read; `startOf` is undefined until it is in); undefined when it cannot be told. */
	startedLater?(pid: number): Promise<string | undefined>;
	/** How long the hand-over waits for it; `RECLAIM_START_WAIT_MS` by default. */
	startWaitMs?: number;
	/** Whether the GUI listens; false (`gui: false`) keeps only the hub and its gate tracking, which the terminal's yes of an ally run's gated call needs. */
	listen?: boolean;
	/** The GUI's way to the link holder. */
	link: GuiLink;
	/** The tower service of a workspace for the net, and the composer's and notices' way to it (towers.ts). */
	tower?: { view(workspace: string): TowerView | undefined } & TowerPanel;
	/** What the page's server panel shows. */
	status(): Record<string, unknown>;
	/** Asks the server to restart as the GUI's button does; the reply goes to the page. */
	restart?(reason: string): HttpReply | Promise<HttpReply>;
	/** Told of a failure that is worth a `lastError`. */
	failed(code: string, text: string): void;
	tailscale?: Run;
	bundle?: string;
	bindWaitMs?: number;
}

/** The hub of a server has no bridge of its own: no pi session runs in it, so every call that would reach "this session's" bridge finds none. */
const NO_BRIDGE: Bridge = {
	deliver() {}, sync() {}, probe: () => ({ editor: "unknown" }), commands: () => [], form() {},
	close: () => ({ accepted: false, reason: "The sb server is no pi session." }), stashCheck: () => undefined, pull: async () => ({ reason: "no_editor" }),
};
const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

export function createGuiHost(o: GuiHostOptions) {
	const { slot, kit, log, pid } = o, { cfg } = kit, id = kit.me(), dir = slot.dir, ts = o.tailscale ?? tailscale;
	const owner = `sb server (pid ${pid})`;
	let gui: Gui | undefined, hub: Hub | undefined, opening: Promise<Gui> | undefined, closing = false;
	/** Why remote access is off though the boss wanted it on, told by `up` and the panel. */
	let remoteNote: string | undefined;
	/** Set while the boss's rotation runs: the GUI commands wait for it, and the start it makes says why its token is new. */
	let rotating: Promise<unknown> | undefined;
	// Built once for this process: pi-intercom has no unregister, so a channel the hub registered stays, and the same hub serves the GUI again after a stop.
	const deploys = createDeploys(), trust = createTrustServe({ dir: trustDir(slot.stateDir), herdr: slot.herdr, world: () => cfg.world(), opening: deploys.openingOf });
	const live = async (session: string) => (await o.sessions()).some((x) => x.id === session);

	/** The hub, built when the server starts and kept for the process: it tracks the gates for the tower service whether or not a page listens (dialogs.ts `track`). */
	const theHub = () => (hub ??= createHub(kit.pi, id, NO_BRIDGE, o.onAllow));

	/**
	 * What the last GUI recorded, for a start to prefer: server.json's port (else gui.json's, else the stored secrets'), with the remote port of gui.json when that record is of the same local port (else the stored secrets' when they
	 * are of it). `keep` is the stored token and CSRF secret with the pair of ports they belong to, and `lost` says why there are none: the listener keeps them only when it binds that pair.
	 */
	const recorded = () => {
		const record = readRecord(slot), seen = readGuiJson(dir), was = record?.gui, stored = readSecrets(dir), keep = "secrets" in stored ? stored.secrets : undefined;
		const port = was?.port ?? seen?.port ?? keep?.port;
		return { port, remotePort: (seen && seen.port === port ? seen.remotePort : undefined) ?? (keep && keep.port === port ? keep.remotePort : undefined), keep, lost: "lost" in stored ? stored.lost : undefined, stopped: Boolean(was?.stopped) };
	};
	const mark = (change: (gui: NonNullable<ServerRecord["gui"]>) => NonNullable<ServerRecord["gui"]> | undefined) => updateRecord(slot, (r) => {
		if (r.pid !== pid) return undefined;
		const next = r.gui && change(r.gui);
		return next ? { ...r, gui: next } : undefined;
	});
	/** gui.json under the unchanged contract: pid and start time name this server. */
	const writeGuiJson = (running: Pick<Gui, "port" | "remotePort" | "token" | "csrf">, stopped = false) => {
		const started = o.started(), record: GuiRecord = { pid, ...(started ? { started } : {}), port: running.port, remotePort: running.remotePort, token: running.token, csrf: running.csrf, owner, ownerSession: id, version: o.version, herdr: slot.herdr, trust: 1, ...(stopped ? { stopped: true } : {}) };
		writeRecordFile(dir, record);
	};
	const guiJsonStopped = (on: boolean) => {
		const seen = readGuiJson(dir);
		if (seen) writeRecordFile(dir, { ...seen, pid, ...(o.started() ? { started: o.started() } : {}), owner, ownerSession: id, version: o.version, ...(on ? { stopped: true } : { stopped: undefined }) });
	};

	const unstarted = () => {
		const seen = readGuiJson(dir);
		if (seen?.pid === pid && seen.started) writeRecordFile(dir, (({ started: _started, ...rest }) => rest)(seen));
	};

	const sessions = () => o.sessions();
	const unsaved = (g: Gui) => g.access.unsaved();
	/** A server that starts here picks up where the last one left off: remote access comes back when it was wanted on (no QR; a failure is told, and the wish stays for the next start), and a serve entry a crashed server left goes when it was not. */
	const resume = async (g: Gui) => {
		remoteNote = undefined;
		if (!g.access.wanted) return void (await switchRemote(g, false, dir, ts, true).catch(() => {}));
		try {
			const [now, remembered] = [await identity(ts), g.access.remembered];
			if (remembered && (remembered.host !== now.host || remembered.login !== now.login)) {
				await switchRemote(g, false, dir, ts, true).catch(() => {});
				remoteNote = `Remote access stays off: the Tailscale identity is now ${now.login} on ${now.host}, not ${remembered.login} on ${remembered.host} that the paired devices belong to; sign in as that identity again, or turn it on here with /boss gui remote (that unpairs the old devices)`;
				return void log.line("remote-off", { why: "identity" });
			}
			await switchRemote(g, true, dir, ts);
			log.line("remote-on");
		} catch (error) {
			remoteNote = `Remote access stays off: ${(error as Error).message}; it is tried again when the server next starts`;
			log.line("remote-off", { why: phrase((error as Error).message, 200) });
		}
	};

	/** `pid`'s start time, waited for up to the bound; undefined when it is not told in time. */
	const startOfLater = (pid: number): Promise<string | undefined> => {
		if (!o.startedLater) return Promise.resolve(undefined);
		return boundedWait(o.startedLater(pid), o.startWaitMs ?? RECLAIM_START_WAIT_MS);
	};
	/**
	 * A GUI that a live older host still serves (a pi session before 0.46.0, which the first start after an upgrade finds beside it): the host is asked to hand over as an older build's takeover does
	 * (`server/stop` with `take`; its serve entry goes with it), and waited for until its page stops answering, so this server binds the same port (under a token of its own: the host's page does not follow). A host that refuses
	 * (another sb server, which answers 409) or stays up is left alone, and the bind falls back to another port. Returns whether a host let go.
	 */
	const reclaim = async (): Promise<boolean> => {
		const seen = readGuiJson(dir);
		if (!seen || (seen.pid === pid && (!seen.started || !o.started() || seen.started === o.started()))) return false;
		// Nothing is sent to a port whose recorded process is gone: another process that took it has not earned the token and CSRF secret (B2 re-check N1).
		if (!(o.runs ?? ((r) => alive(r.pid)))(seen)) return false;
		// An alive pid is not the process: on Windows another account's process may hold the number a crashed host left, and it may have bound the recorded port first. The token and the CSRF secret go
		// only to a process whose start time is KNOWN and the record's own, so an unknown time (the Windows cache is cold, the read is slow or failed) or a record without one skips the hand-over; the cost is a moved
		// port, or a second GUI beside a 0.45 host, and no secret is sent (sec-F001).
		const told = seen.started ? await startOfLater(seen.pid) : undefined;
		if (!seen.started || told !== seen.started) {
			log.line("gui-reclaim-skipped", { pid: seen.pid, why: !seen.started ? "no-start-recorded" : told === undefined ? "start-unknown" : "start-differs" });
			return false;
		}
		if (!(await answers(seen))) return false;
		log.line("gui-reclaim", { from: phrase(seen.owner, 120), pid: seen.pid });
		if ((await postServer(seen, "server/stop", { by: owner, take: true }, 2000)).status !== 202) return false;
		// Whether the old host has let go is asked of the port without the token (a connection, nothing sent): the process that binds the freed port first is not necessarily this one, and has not earned it (RC2-F001).
		for (const end = Date.now() + RECLAIM_WAIT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (!(await listening(seen.port))) return true;
		return false;
	};
	const begin = async (prefer: ReturnType<typeof recorded>, wait: number): Promise<Gui> => {
		theHub();
		const net = netSource({ ...(o.tower ? { services: (workspace: string) => o.tower!.view(workspace) } : {}), run: cfg.run, world: cfg.world, sessions, stashed: () => stashedList(slot.stateDir), trust, hub });
		// `running` is read by the page's remote buttons, which only come once the server is up.
		let running!: Gui;
		running = await startGui({
			read: async (): Promise<Net> => {
				const next = await net.read(), summary = await o.link.summary();
				return summary && (summary.allies.length || summary.alerts.length || summary.confirms.length) ? { ...next, link: summary } : next;
			},
			net, call: cfg.call, hub, dir: o.bundle ?? BUNDLE, paired: join(dir, "paired.json"), port: prefer.port, remotePort: prefer.remotePort, ...(prefer.keep ? { keep: prefer.keep } : {}), bindWaitMs: wait, desk: cfg.env.STRAW_BOSS_DESK === "1",
			link: { call: (name, args) => o.link.call(name, args), enable: () => o.link.enable() }, ...(o.tower ? { tower: o.tower } : {}), trust: { answer: trust.answer, watch: trust.watch },
			server: { status: () => o.status(), log: (lines) => tailLog(fileOf(slot, "log"), lines), restart: async (reason) => (o.restart ? o.restart(reason) : { status: 501, body: { error: "unavailable", reason: "This server cannot restart itself." } }) },
			// An older build's /boss gui stop: the GUI stops, and nothing starts it again but the boss's own command. Its takeover is refused (409): that build reports the GUI as stale and leaves it alone.
			refuseTake: true,
			onStop: (asked) => { log.line("gui-stop-asked", { by: phrase(asked.by, 120), take: asked.take }); void stop().catch(() => {}); },
			onSaveFailed: (reason) => log.line("error", { code: "paired", text: phrase(reason, 200) }),
			onRemote: async () => void (await switchRemote(running, true, dir, ts), (remoteNote = undefined), log.line("remote-on", { how: "page" })),
			onRemoteOff: async () => void (await switchRemote(running, false, dir, ts), (remoteNote = undefined), log.line("remote-off", { why: "page" })),
			spawn: createSpawn({ run: cfg.run, sleep: cfg.sleep, call: cfg.call, deploys, trustDir: trustDir(slot.stateDir), live, sessionAt: async (pane) => (await sessions()).find((x) => x.herdrLocation?.paneId === pane)?.id }),
			close: createCloser({
				run: cfg.run, sleep: cfg.sleep, me: () => id, sessions, ask: async (key, keepPane, ifStashable) => hub?.close(key, keepPane, ifStashable), check: async (key) => hub?.stashCheck(key), stateDir: slot.stateDir,
				pop: (name) => popBase({ run: cfg.run, sleep: cfg.sleep, stateDir: slot.stateDir, live, agentDir: cfg.env.PI_CODING_AGENT_DIR, trustDir: trustDir(slot.stateDir) }, name),
			}),
		});
		log.hide(running.token, running.csrf);
		return running;
	};
	/** The GUI on the recorded port when it is free, under a token and CSRF secret of its own, or on another port. Two calls in flight share one start. */
	const up = (wait = 0): Promise<Gui> => {
		if (gui) return Promise.resolve(gui);
		return (opening ??= (async () => {
			const prefer = recorded();
			const reclaimed = await reclaim();
			const started = await begin(prefer, reclaimed ? Math.max(wait, o.bindWaitMs ?? BIND_WAIT_MS) : wait);
			gui = started;
			// A listener that keeps its token keeps the devices paired under it (D27). A new token voids every pairing (cookie Path=/<token>/), so none is kept, whether or not a record of the last GUI survived: paired.json alone may hold devices.
			const why: Lost | "moved" | "rotate" = rotating ? "rotate" : prefer.keep ? "moved" : (prefer.lost ?? "missing");
			const n = started.kept ? 0 : started.access.devices.unpairAll();
			if (n) log.line("devices-cleared", { n });
			if (started.access.saveError) log.line("error", { code: "paired", text: phrase(`paired.json could not be saved (${started.access.saveError}); the cleared devices come back after the next restart`, 200) });
			// The store is dropped before the new secrets are written, so a failed write leaves none (a start with no store rotates) and never the secrets this listener replaced.
			if (!started.kept) try {
				dropSecrets(dir);
				keepSecrets(dir, { token: started.token, csrf: started.csrf, port: started.port, remotePort: started.remotePort });
			} catch (error) {
				log.line("error", { code: "gui-secrets", text: phrase(`${(error as Error).message}; the GUI runs, and the next start gets a new address`, 200) });
			}
			writeGuiJson(started);
			updateRecord(slot, (r) => (r.pid === pid ? { ...r, gui: { port: started.port, token: started.token, stopped: false } } : undefined));
			log.line("gui-start", { port: started.port, remotePort: started.remotePort, moved: prefer.port !== undefined && prefer.port !== started.port, ...(started.kept ? { kept: true } : { newToken: true, why }) });
			// Remote access comes back with it, but a slow Tailscale does not hold the start: what is not settled in a few seconds goes on in the background.
			const resuming = resume(started);
			await Promise.race([resuming, cfg.sleep(RESUME_WAIT_MS)]);
			return started;
		})().finally(() => (opening = undefined)));
	};

	/** Stops the GUI listeners, its remote entry first (remote stays wanted), and marks the GUI stopped on purpose before it stops answering. */
	async function stop(): Promise<boolean> {
		const running = gui;
		if (!running) return false;
		gui = undefined;
		mark((g) => ({ ...g, stopped: true }));
		guiJsonStopped(true);
		const off = await switchRemote(running, false, dir, ts, true).catch(() => undefined);
		if (off?.changed) log.line("remote-off", { why: "gui stop" });
		await running.stop();
		log.line("gui-stop");
		return true;
	}

	/**
	 * The boss's rotation (`/boss gui rotate`): the stored secrets go first (so any start from here on draws new ones), then the listeners and the remote entry come down, and the GUI starts again on the same ports under a new token and
	 * CSRF secret with every paired device unpaired. It is the boss's own, so a GUI stopped on purpose starts too.
	 */
	const rotate = async (): Promise<Reply> => {
		await opening?.catch(() => {});
		dropSecrets(dir);
		const running = gui;
		if (running) {
			gui = undefined;
			await switchRemote(running, false, dir, ts, true).catch(() => {});
			await running.stop();
		}
		log.line("gui-rotate", { running: Boolean(running) });
		const got = await ensure(true, BIND_WAIT_MS);
		return "reply" in got ? got.reply : { ok: true, ...guiFacts(got.running), ...(remoteNote ? { remoteNote } : {}) };
	};
	const gone = (error: unknown): Reply => ({ ok: false, error: (error as Error).message });
	const guiFacts = (g: Gui) => ({ url: g.url, port: g.port, remotePort: g.remotePort, token: g.token });
	/** The boss's own command starts a GUI that was stopped; an automatic ask leaves it. */
	const ensure = async (boss: boolean, wait = 0): Promise<{ running: Gui } | { reply: Reply }> => {
		if (!gui && recorded().stopped && !boss) return { reply: { ok: false, error: "stopped" } };
		try {
			const running = gui ?? (await up(wait));
			if (boss) mark((g) => (g.stopped ? { ...g, stopped: false } : undefined));
			if (boss && readGuiJson(dir)?.stopped) writeGuiJson(running);
			return { running };
		} catch (error) {
			o.failed("gui", (error as Error).message);
			return { reply: gone(error) };
		}
	};
	const unsavedReply = (g: Gui) => (unsaved(g) ? { warning: unsaved(g) } : {});

	return {
		/** At the server's start: the GUI on the recorded ports unless it was stopped on purpose (which only the boss's own command undoes). */
		async start(): Promise<void> {
			// The gates' tracking does not depend on the page: a GUI stopped on purpose, or one that could not bind, still has the Allows of the boss's yes in the terminal.
			theHub().track();
			// The bridges follow gui.json to the hub; a server with no gui.json (no GUI served, or one that could not bind on a fresh state folder) names its session in hub.json.
			try {
				writeJson(join(dir, "hub.json"), { pid, ownerSession: id });
			} catch (error) {
				log.line("hub-json-failed", { text: phrase((error as Error).message, 300) });
				o.failed("hub.json", (error as Error).message);
			}
			if (o.listen === false) return;
			const prefer = recorded();
			if (prefer.stopped) {
				// The record keeps the port and token, and gui.json says whose it is now.
				if (readGuiJson(dir)) guiJsonStopped(true);
				return void log.line("gui-stopped-on-purpose");
			}
			try {
				await up(o.bindWaitMs ?? BIND_WAIT_MS);
			} catch (error) {
				log.line("gui-failed", { text: phrase((error as Error).message, 300) });
				o.failed("gui", (error as Error).message);
			}
		},
		/** The server leaves: the remote entry goes (remote stays wanted), the listeners close, and the link waits end. */
		async leave(onPurpose = false): Promise<void> {
			closing = true;
			o.link.close();
			const running = gui;
			if (running) {
				gui = undefined;
				await switchRemote(running, false, dir, ts, true).catch(() => {});
				await running.stop();
				// A stop on purpose is a stopped GUI to anything that reads gui.json (straw-boss-desk): the record says whose it was.
				if (onPurpose) guiJsonStopped(true);
				// A restart or a crash is not a stop: gui.json goes without `started`, which no older build adopts, until the next server writes it again (docs/specs/2026-10-26-sb-backend.md, mixed versions).
				else unstarted();
			}
		},
		/** This server's start time arrived late: gui.json carries it too. */
		started(): void {
			if (gui && !closing) writeGuiJson(gui);
		},
		get running() { return Boolean(gui); },
		/** What `status` says of the GUI. */
		facts(): Record<string, unknown> {
			const was = recorded();
			return { running: Boolean(gui), stopped: !gui && was.stopped, ...(gui ? { port: gui.port, remotePort: gui.remotePort } : {}), remote: { wanted: gui?.access.wanted ?? false, on: Boolean(gui?.access.remote), ...(remoteNote ? { note: remoteNote } : {}) } };
		},
		/** The control requests that concern the GUI; undefined for any other. */
		async handle(request: Request): Promise<Reply | undefined> {
			if (o.listen === false || !["gui", "gui-stop", "gui-remote", "gui-pair", "gui-rotate"].includes(request.cmd)) return undefined;
			if (closing) return { ok: false, error: "restarting" };
			// A rotation in flight is finished first: a start meanwhile would bind the ports before the old listener let go, or read the secrets that are being dropped.
			while (rotating) await rotating.catch(() => {});
			if (request.cmd === "gui-rotate") {
				const done = (rotating = rotate().finally(() => (rotating = undefined)));
				return done.catch(gone);
			}
			if (request.cmd === "gui-stop") {
				const was = await stop();
				if (!was) mark((g) => ({ ...g, stopped: true }));
				if (!was && readGuiJson(dir)) guiJsonStopped(true);
				return { ok: true, was };
			}
			if (request.cmd === "gui-pair") {
				const link = gui?.access.pair();
				return gui && link && gui.access.remote ? { ok: true, url: `https://${gui.access.remote.host}/${gui.token}/pair/${link}` } : { ok: false, error: "remote_off" };
			}
			const got = await ensure(request.boss === true || request.cmd === "gui-remote");
			if ("reply" in got) return got.reply;
			const { running } = got;
			if (request.cmd === "gui") return { ok: true, ...guiFacts(running), ...(remoteNote ? { remoteNote } : {}) };
			// gui-remote
			try {
				if (request.on === false) {
					const off = await switchRemote(running, false, dir, ts);
					remoteNote = undefined;
					return { ok: true, text: off.text, ...unsavedReply(running) };
				}
				const on = await switchRemote(running, true, dir, ts);
				remoteNote = undefined;
				return { ok: true, text: on.text, ...(on.lines ? { lines: on.lines } : {}), ...unsavedReply(running) };
			} catch (error) {
				return gone(error);
			}
		},
	};
}
export type GuiHost = ReturnType<typeof createGuiHost>;

/** The restart a button on the page asks for: a requester of its own (`cli.mjs restart`), since this server is what it asks to restart and cannot start its successor itself. */
export function spawnRestart(cli: string, reason: string, by: string, env: NodeJS.ProcessEnv, cwd: string, start: typeof spawn = spawn): HttpReply {
	try {
		const child = start(process.execPath, [cli, "restart", "--reason", reason, "--by", by], { detached: true, stdio: "ignore", windowsHide: true, env, cwd });
		child.on("error", () => {});
		child.unref();
		return { status: 202, body: { restarting: true } };
	} catch (error) {
		return { status: 502, body: { error: "restart_failed", reason: (error as Error).message } };
	}
}
/** The `cli.mjs` that sits beside this code (`cli.ts` in a checkout, where Node runs it as it is). */
export const cliBeside = (from: string = import.meta.url) => fileURLToPath(new URL(from.endsWith(".ts") ? "./cli.ts" : "./cli.mjs", from));
