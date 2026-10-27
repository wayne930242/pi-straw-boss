import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bridge } from "../bridge.ts";
import { createCloser } from "../closer.ts";
import type { Reply as HttpReply } from "../control.ts";
import { createDeploys } from "../deploy.ts";
import { createHub, type Hub } from "../dialogs.ts";
import { BUNDLE, type Gui, startGui } from "../gui.ts";
import { type GuiRecord, readRecord as readGuiJson, writeRecordFile } from "../handover.ts";
import type { Session } from "../herdr.ts";
import { type GuiLink } from "../link/guiport.ts";
import { type Net, netSource } from "../net.ts";
import { identity, type Run, switchRemote, tailscale } from "../remote.ts";
import { createSpawn } from "../spawn.ts";
import { popBase, stashedList } from "../stash.ts";
import { trustDir } from "../trust/files.ts";
import { createTrustServe } from "../trust/serve.ts";
import type { Kit } from "../state.ts";
import { type Log, tailLog } from "./log.ts";
import { fileOf, readRecord, type ServerRecord, type Slot, updateRecord } from "./record.ts";
import type { Reply, Request } from "./socket.ts";

// The GUI inside the sb server (docs/specs/2026-10-26-sb-backend.md, What moves out of pi sessions, GUI, `gui.json` and its successor): the page's server (gui.ts), the dialog hub, trust questions,
// spawn and deploys, the closer, the mirrors, documents and uploads, and remote access over Tailscale, which a pi session ran until 0.45.0 (host.ts). It runs on the server's own intercom
// session: the hub owns `straw-boss/gui/<hash of the server's id>` with no local bridge, and the bridges in sessions follow `gui.json`'s `ownerSession` to it as before.
//
// The GUI starts when the server does, on the port, token, and CSRF secret the last one recorded (a restart keeps the URL; a port that is not free for 5 s is replaced), unless it was stopped on purpose
// (`/boss gui stop`: `gui.stopped` in server.json, `stopped` in gui.json). Only the boss's own commands start a GUI that was stopped. gui.json is written by this server under the unchanged contract, and
// server.json's `gui` is `{ port, token, stopped }`.
//
// What a session asks over the control socket (server-look.ts):
//   gui {boss}            the GUI's URL, started if it is not running; refused with `stopped` for an automatic ask when it was stopped on purpose (`boss`: the boss's own, which starts it)
//   gui-stop              stops the GUI listeners and takes the remote entry down (remote stays wanted); marks the GUI stopped on purpose
//   gui-remote {on}       turns remote access on (answers the lines of the pairing QR) or off; the boss's own, so it starts a stopped GUI
//   gui-pair              a new one-time pairing link while remote access is on
// and what the page asks of the server panel (this computer's page only): status, restart, and the log (control.ts `server`).

/** Binding the recorded ports: a restart's old server is still letting go of them for a moment. */
export const BIND_WAIT_MS = 5000;
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
	/** The GUI's way to the link holder. */
	link: GuiLink;
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
	// Built once for this process: pi-intercom has no unregister, so a channel the hub registered stays, and the same hub serves the GUI again after a stop.
	const deploys = createDeploys(), trust = createTrustServe({ dir: trustDir(slot.stateDir), herdr: slot.herdr, world: () => cfg.world(), opening: deploys.openingOf });
	const live = async (session: string) => (await o.sessions()).some((x) => x.id === session);

	/** What the last GUI recorded, for a restart to keep: server.json's port and token, with the remote port and CSRF secret of gui.json when it is that same GUI. */
	const recorded = () => {
		const record = readRecord(slot), seen = readGuiJson(dir), was = record?.gui;
		const same = was && seen && seen.port === was.port && seen.token === was.token;
		return { port: was?.port ?? seen?.port, token: was?.token ?? seen?.token, remotePort: same || !was ? seen?.remotePort : undefined, csrf: same || !was ? seen?.csrf : undefined, stopped: Boolean(was?.stopped) };
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

	const begin = async (prefer: ReturnType<typeof recorded>, wait: number): Promise<Gui> => {
		hub ??= createHub(kit.pi, id, NO_BRIDGE);
		const net = netSource({ run: cfg.run, world: cfg.world, sessions, stashed: () => stashedList(slot.stateDir), trust, hub });
		// `running` is read by the page's remote buttons, which only come once the server is up.
		let running!: Gui;
		running = await startGui({
			read: async (): Promise<Net> => {
				const next = await net.read(), summary = await o.link.summary();
				return summary && (summary.allies.length || summary.alerts.length || summary.confirms.length) ? { ...next, link: summary } : next;
			},
			net, call: cfg.call, hub, dir: o.bundle ?? BUNDLE, paired: join(dir, "paired.json"), port: prefer.port, remotePort: prefer.remotePort, token: prefer.token, csrf: prefer.csrf, bindWaitMs: wait,
			link: { call: (name, args) => o.link.call(name, args), enable: () => o.link.enable() }, trust: { answer: trust.answer, watch: trust.watch },
			server: { status: () => o.status(), log: (lines) => tailLog(fileOf(slot, "log"), lines), restart: async (reason) => (o.restart ? o.restart(reason) : { status: 501, body: { error: "unavailable", reason: "This server cannot restart itself." } }) },
			// Another build's /boss gui stop, or a takeover by one: the GUI stops, and nothing starts it again but the boss's own command.
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
	/** The GUI on the recorded port and token, or a new one. Two calls in flight share one start. */
	const up = (wait = 0): Promise<Gui> => {
		if (gui) return Promise.resolve(gui);
		return (opening ??= (async () => {
			const prefer = recorded();
			const started = await begin(prefer, wait);
			gui = started;
			writeGuiJson(started);
			updateRecord(slot, (r) => (r.pid === pid ? { ...r, gui: { port: started.port, token: started.token, stopped: false } } : undefined));
			log.line("gui-start", { port: started.port, remotePort: started.remotePort, moved: prefer.port !== undefined && prefer.port !== started.port });
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

	const gone = (error: unknown): Reply => ({ ok: false, error: (error as Error).message });
	const guiFacts = (g: Gui) => ({ url: g.url, port: g.port, remotePort: g.remotePort, token: g.token });
	/** The boss's own command starts a GUI that was stopped; an automatic ask leaves it. */
	const ensure = async (boss: boolean): Promise<{ running: Gui } | { reply: Reply }> => {
		if (!gui && recorded().stopped && !boss) return { reply: { ok: false, error: "stopped" } };
		try {
			const running = gui ?? (await up());
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
			if (!["gui", "gui-stop", "gui-remote", "gui-pair"].includes(request.cmd)) return undefined;
			if (closing) return { ok: false, error: "restarting" };
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
