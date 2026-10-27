import { GUARD_MS, RESTORE_WAIT_MS } from "../guard.ts";
import { herdrApi, herdrCall, herdrRun, herdrWorld, socketRun, worldOf } from "../herdr.ts";
import { herdrEvents, herdrWatch } from "../server-watch.ts";
import type { Config, Deps } from "../state.ts";

/** What a process that is not a pi session (a net sidecar, the sb server) may be given in place of the real Herdr connections. */
export type HeadlessDeps = Pick<Deps, "run" | "world" | "api" | "call" | "sleep" | "now" | "events" | "watch" | "guardMs" | "couple" | "autoTower" | "detectMs" | "stateDir" | "restoreMs">;

const unavailable = (what: string) => (() => { throw new Error(`${what} is not available in a headless process`); }) as never;

/** The configuration of a pi session, with what only a screen (the clipboard, a browser) uses left unavailable. */
export function headlessConfig(d: HeadlessDeps, env: NodeJS.ProcessEnv): Config {
	const call = d.call ?? herdrCall(), run = d.run ?? socketRun(herdrRun, call);
	return {
		run, world: d.world ?? (d.run ? worldOf(run) : herdrWorld(call)), api: d.api ?? herdrApi(), call, env, stateDir: d.stateDir,
		sleep: d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), now: d.now ?? Date.now,
		watch: d.watch ?? herdrWatch(), events: d.events ?? herdrEvents(), guardMs: d.guardMs ?? GUARD_MS, couple: d.couple ?? true, autoTower: d.autoTower ?? true, detectMs: d.detectMs ?? 1000,
		copy: unavailable("copy"), openUrl: unavailable("openUrl"), later: unavailable("later"),
		promptDir: "", nudgeMs: 0, version: "", adoptMs: 0, restoreMs: d.restoreMs ?? RESTORE_WAIT_MS,
	};
}

