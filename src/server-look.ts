import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
	type Ctx, decide, describe, ensure, lockWaitFor, makeCtx, probe, restart, RESTART_EVERY_MS, ServerError, stop,
} from "./server/client.ts";
import { tailLog } from "./server/log.ts";
import { fileOf, readRecord, slotOf } from "./server/record.ts";
import { newer } from "./semver.ts";
import { packageRoot } from "./server/version.ts";
import type { Kit } from "./state.ts";

// A pi session's part in the sb server (docs/specs/2026-10-26-sb-backend.md, Starting, Stopping, Seeing and restarting the server): at session start, and then every 2 s, it
// looks whether a live server runs for its Herdr and starts one when none does and the rules allow; it asks the live server to upgrade when this session's package is newer;
// and it carries `/boss server` and the `boss_server` tool. The server itself lives in src/server/ and runs as its own process.

export { RESTART_EVERY_MS };
const RETRY_FAILED_MS = 60_000;
const MAX_LOG_LINES = 200;
const STOP_WARNING = "Every workspace then loses its live tower, and mains are demoted 15 s later. The server stays down until /boss server or `cli.mjs up` starts it again.";

/** Replaces what the look reaches the machine with, for tests. */
export interface ServerLookDeps { ctx?: Partial<Ctx>; cli?: string; /** The package folder whose package.json holds the version of the package on disk. */ root?: string }

export function createServerLook({ pi, cfg, s, guiDir, me, tell }: Kit, deps: ServerLookDeps) {
	const told = new Set<string>();
	// The screen this session started with: the look's first notice comes before session.ts has handed `s.ui` its own.
	let ui: ExtensionContext["ui"] | undefined;
	const tellOnce = (key: string, text: string, level: "info" | "warning" | "error" = "warning") => {
		if (told.has(key)) return;
		told.add(key);
		(ui ?? s.ui)?.notify(text, level);
	};
	// Only a session with a screen looks: a print run is short-lived, and a subagent never gets here (index.ts).
	let timer: ReturnType<typeof setInterval> | undefined, looking = false, failedAt: number | undefined, failedUpgrade: string | undefined, stopped = false, interactive = false;

	const slot = () => slotOf(cfg.stateDir ?? guiDir, cfg.env);
	/** Where the server is started from: the built `dist/server/cli.mjs` of this package, or `src/server/cli.ts` in a checkout (Node runs it as it is). */
	const cli = () => {
		if (deps.cli) return deps.cli;
		const root = packageRoot(), built = join(root, "dist", "server", "cli.mjs");
		return existsSync(built) ? built : join(root, "src", "server", "cli.ts");
	};
	const asker = () => `session "${(pi.getSessionName() || s.ownName || me() || "unnamed").replace(/["\n]/g, " ")}" (${me().slice(0, 8) || "no id"})`;
	/**
	 * The version of the package the server would start from: read from the package.json beside `cli()` each time, because a session keeps the code it loaded (`cfg.version`) while the
	 * package on disk may have been replaced since (a downgrade). Judging by the loaded version would upgrade, start the older package, and upgrade again at every look.
	 */
	const version = () => {
		if (deps.cli && !deps.root) return cfg.version;
		try {
			const found = (JSON.parse(readFileSync(join(deps.root ?? packageRoot(), "package.json"), "utf8")) as { version?: unknown }).version;
			return typeof found === "string" ? found : cfg.version;
		} catch {
			return cfg.version;
		}
	};
	const ctxFor = (): Ctx => makeCtx({ slot: slot(), version: version(), cli: cli(), by: asker(), env: cfg.env, now: cfg.now, ...deps.ctx });

	/** One look: start, upgrade, or leave the server as it is. Anything that cannot be done is told once. */
	async function look() {
		if (looking || stopped || !interactive) return;
		looking = true;
		let verdictWas: string | undefined, upgradePair: string | undefined;
		try {
			const ctx = ctxFor(), seen = await probe(ctx), verdict = decide(ctx, seen);
			verdictWas = verdict.do;
			if (verdict.do === "refuse") return tellOnce(verdict.why, `Straw Boss: ${verdict.text}`);
			if (verdict.do === "start") {
				if (failedAt !== undefined && cfg.now() - failedAt < RETRY_FAILED_MS) return;
				await ensure(ctx);
			}
			if (verdict.do === "upgrade") {
				// An upgrade that failed is asked for again when the record's version or the package's changes, not as time passes: a package whose dist is older than its
				// package.json (a stale build) would otherwise restart the server once a minute for nothing.
				const pair = `${seen.record!.version}|${ctx.version}`;
				if (failedUpgrade === pair) return;
				upgradePair = pair;
				const before = seen.record!.version, done = await restart(ctx, { reason: "upgrade", upgrade: true, lockWaitMs: 0 });
				// An upgrade that starts a server no newer than the one it replaced would be asked for again at every look.
				if (!newer(done.record.version, before)) throw new Error(`the upgrade started pi-straw-boss ${done.record.version}, not newer than the ${before} it replaced (this session loaded ${cfg.version}; the package on disk is ${ctx.version})`);
			}
			failedAt = undefined;
			failedUpgrade = undefined;
		} catch (error) {
			// Another session holds the lock (it starts or restarts the server); the next look finds the result.
			if (error instanceof ServerError && error.code === "busy") return;
			if (verdictWas === "upgrade") failedUpgrade = upgradePair;
			else failedAt = cfg.now();
			tellOnce(`failed:${(error as Error).message}`, `Straw Boss: the sb server could not ${verdictWas === "upgrade" ? "upgrade" : "start"}: ${(error as Error).message}`, "error");
		} finally {
			looking = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		stopped = false;
		interactive = ctx.hasUI;
		ui = ctx.ui;
		clearInterval(timer);
		void look();
		timer = setInterval(() => void look(), cfg.adoptMs).unref();
	});
	pi.on("session_shutdown", () => {
		stopped = true;
		clearInterval(timer);
	});

	/** Stopped on purpose, or the other way a request from an agent can be refused: the reason as an error. */
	const refuse = (error: unknown): never => {
		throw error instanceof ServerError ? new Error(error.message) : error;
	};

	/** One line for `/boss server`. */
	const summary = (st: Record<string, unknown>) => {
		const parts = [`state ${String(st.state)}`, ...(st.pid ? [`pid ${String(st.pid)}`] : []), ...(st.version ? [`pi-straw-boss ${String(st.version)}`] : []), ...(st.mode ? [String(st.mode)] : []), ...(typeof st.uptimeMs === "number" ? [`up ${Math.round(st.uptimeMs / 1000)} s`] : [])];
		const error = st.lastError as { code: string; text: string } | undefined, start = st.startError as { code: string; text: string } | undefined, restarting = st.restarting as { reason: string; by: string } | undefined;
		return `sb server: ${parts.join(", ")}${restarting ? `; restarting (${restarting.reason}, by ${restarting.by})` : ""}${start ? `; the last start failed: ${start.code}: ${start.text}` : ""}${error ? `; last error: ${error.code}: ${error.text}` : ""}; log ${String(st.log)}`;
	};
	const api = {
		look,
		/** `boss_server status`: works with the server down, from the files. */
		async status() {
			return describe(ctxFor());
		},
		/** `boss_server logs`: the last lines of the server's log, at most 200. */
		logs(lines = MAX_LOG_LINES) {
			return tailLog(fileOf(slot(), "log"), Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(lines))));
		},
		/**
		 * `boss_server restart` (an agent: `boss` false) and `/boss server restart` (the boss). An agent's restart needs a reason of 1 to 200 characters on one line, is refused while
		 * the server is stopped on purpose, and is taken at most once a minute for the whole machine (the server records the last one). A server that is down is started.
		 */
		async restart(reason: string, { boss = false, downgrade = false } = {}) {
			const why = reason.trim();
			if (!why || why.length > 200 || /[\r\n]/.test(why)) throw new Error("A restart needs a reason: 1 to 200 characters on one line.");
			const ctx = ctxFor();
			// The once-a-minute limit is judged under server.lock (client.ts), so two asks at once cannot both pass it.
			if (!boss && readRecord(ctx.slot)?.stopped) throw new Error("The sb server was stopped on purpose; an agent cannot restart it. The boss starts it again with /boss server.");
			try {
				const done = await restart(ctx, { reason: why, downgrade, boss, limit: !boss });
				return { server: done.server, pid: done.record.pid, version: done.record.version };
			} catch (error) {
				return refuse(error);
			}
		},
		/** `/boss server`: starts the server when it is down or stopped on purpose (the boss's own start). */
		async start() {
			const ctx = ctxFor();
			try {
				return await ensure(ctx, { boss: true, lockWaitMs: lockWaitFor(ctx) });
			} catch (error) {
				return refuse(error);
			}
		},
		/** `/boss server stop`, after the confirm. */
		async stop() {
			try {
				return await stop(ctxFor());
			} catch (error) {
				return refuse(error);
			}
		},
	};
	return {
		...api,
		/** The `/boss server [stop|restart [--downgrade] [reason]]` command: the boss's own, so it asks to confirm what costs something and clears a stop on purpose. */
		async command(sub: "" | "stop" | "restart", rest: string) {
			const ask = async (title: string, message: string) => (await s.ui?.confirm(title, message)) === true;
			if (sub === "stop") {
				if (!(await ask("Stop the sb server?", STOP_WARNING))) return tell("The sb server was not stopped.");
				const done = await api.stop();
				return tell(done.outcome === "stopped" ? "The sb server was stopped on purpose. /boss server starts it again." : "The sb server was not running.");
			}
			if (sub === "restart") {
				const downgrade = /(^|\s)--downgrade(?=\s|$)/.test(rest), reason = rest.replace(/(^|\s)--downgrade(?=\s|$)/g, " ").trim() || "restart from /boss server restart";
				const message = downgrade ? "This starts the server from this session's pi-straw-boss, which is OLDER than the server's. Pages reconnect on the same URL." : "Pages and the desk webview reconnect on the same URL; runs and dialogs carry on.";
				if (!(await ask(downgrade ? "Restart the sb server from an older package?" : "Restart the sb server?", message))) return tell("The sb server was not restarted.");
				const done = await api.restart(reason, { boss: true, downgrade });
				return tell(`The sb server ${done.server} (pid ${done.pid}, pi-straw-boss ${done.version}).`);
			}
			const before = await api.status();
			if (before.state === "live") return tell(summary(before));
			const done = await api.start();
			if ("skipped" in done) return tell(`${summary(await api.status())}; not started: ${done.skipped.do === "refuse" ? done.skipped.text : done.skipped.do === "nothing" ? done.skipped.why : done.skipped.do}`, "warning");
			return tell(`The sb server ${done.server} (pid ${done.record.pid}). ${summary(await api.status())}`);
		},
	};
}
export type ServerLook = ReturnType<typeof createServerLook>;
