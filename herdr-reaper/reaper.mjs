// Herdr plugin entry point: `reaper.mjs <mode>`, started through run.sh by the manifest's startup hook, event hooks and actions.
//
//   startup      start the ticker (once per Herdr server start)
//   event        an event hook: record what the event changed, and keep the ticker alive
//   sweep        one sweep; what the ticker runs every ten minutes
//   reap-now     one sweep without the confirmation wait
//   dry-run      print what reap-now would do and change nothing (also usable from a terminal)
//   pin          toggle the pin on the workspace the action was invoked in
//   ticker       the loop that invokes `sweep` when it is due (started by the modes above, never by hand)
import { spawn } from "node:child_process";
import { closeSync, openSync, statSync, truncateSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIRM_MS } from "./decide.mjs";
import { createStore, gitClient, herdrClient, loadConfig, withLock } from "./io.mjs";
import { runEvent, runPinToggle, runSweep } from "./sweep.mjs";

const TICK_MS = 15_000;
const BEAT_FRESH_MS = 3 * TICK_MS;
const START_DELAY_MS = 20_000;
const MAX_FAILURES = 3;
const LOG_LIMIT_BYTES = 200_000;

const env = process.env;
const pluginId = env.HERDR_PLUGIN_ID ?? "wayne930242.straw-boss-reaper";
const stateDir = env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".config/herdr/plugins/state", pluginId);
const configDir = env.HERDR_PLUGIN_CONFIG_DIR ?? join(homedir(), ".config/herdr/plugins/config", pluginId);
const bin = env.HERDR_BIN_PATH ?? "herdr";
const beatFile = join(stateDir, "ticker.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => console.log(line);

async function readBeat() {
	try {
		return JSON.parse(await readFile(beatFile, "utf8"));
	} catch {
		return null;
	}
}

/** Starts the ticker unless one has beaten recently. Two starting at once settle it themselves: the later one exits. */
async function ensureTicker() {
	const beat = await readBeat();
	if (beat && Date.now() - beat.beat < BEAT_FRESH_MS) return;
	await mkdir(stateDir, { recursive: true });
	const logFile = join(stateDir, "ticker.log");
	try {
		if (statSync(logFile).size > LOG_LIMIT_BYTES) truncateSync(logFile);
	} catch {}
	const out = openSync(logFile, "a");
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "ticker"], { detached: true, stdio: ["ignore", out, out], env });
	child.unref();
	closeSync(out);
	log("ticker started");
}

/** Claims the ticker role; false when another ticker beats. */
async function claim() {
	const outcome = await withLock(stateDir, "ticker", async () => {
		const beat = await readBeat();
		if (beat && beat.pid !== process.pid && Date.now() - beat.beat < BEAT_FRESH_MS) return false;
		await writeFile(beatFile, JSON.stringify({ pid: process.pid, beat: Date.now() }));
		return true;
	});
	return !outcome.held && outcome.value;
}

/**
 * Invokes `sweep` through Herdr whenever the state file says one is due, so every sweep is a logged plugin command. The loop ends
 * when another ticker took over or Herdr has not answered MAX_FAILURES times in a row; the next hook starts a new one.
 */
async function ticker() {
	if (!(await claim())) return;
	const store = createStore(stateDir);
	await sleep(START_DELAY_MS);
	let failures = 0;
	for (;;) {
		if (!(await claim())) return;
		const state = await store.read();
		if (Date.now() >= state.nextSweepAt) {
			await store.apply([{ op: "set", path: ["nextSweepAt"], value: Date.now() + 10 * 60_000 }]);
			const invoke = spawn(bin, ["plugin", "action", "invoke", `${pluginId}.sweep`], { stdio: "ignore", env });
			const code = await new Promise((resolve) => invoke.on("close", resolve).on("error", () => resolve(1)));
			failures = code === 0 ? 0 : failures + 1;
			console.log(`${new Date().toISOString()} sweep invoked, exit ${code}`);
			if (failures >= MAX_FAILURES) return console.log("herdr did not answer; ticker stops");
		}
		await sleep(TICK_MS);
	}
}

async function main(mode) {
	if (mode === "ticker") return ticker();
	const config = await loadConfig(configDir);
	const deps = { herdr: herdrClient(bin), git: gitClient(), store: createStore(stateDir), log, now: Date.now, config };
	switch (mode) {
		case "startup":
			return ensureTicker();
		case "event": {
			let payload = {};
			try {
				const parsed = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON ?? "{}");
				payload = parsed.data ?? parsed;
			} catch {}
			await ensureTicker();
			return runEvent(deps, env.HERDR_PLUGIN_EVENT ?? "", payload);
		}
		case "sweep":
			return runSweep(deps, { confirmMs: CONFIRM_MS });
		case "reap-now":
			return runSweep(deps, { confirmMs: 0 });
		case "dry-run":
			return runSweep(deps, { confirmMs: 0, dryRun: true });
		case "pin":
			if (!env.HERDR_WORKSPACE_ID) throw new Error("the pin action needs a workspace: invoke it from a workspace");
			return runPinToggle(deps, env.HERDR_WORKSPACE_ID);
		default:
			throw new Error(`unknown mode ${mode}`);
	}
}

main(process.argv[2]).catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
