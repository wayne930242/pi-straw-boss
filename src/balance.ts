import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inStandingRun } from "./runmark.ts";

// Pane balance: when a pi starts in a Herdr tab, or quits out of one, the tab's panes are made equal again, so a tab that
// pi-herdr-agents keeps splitting for workers does not end up as a chain of halves. Every pi does this, joined or not.
// The work runs in balance.mjs as a detached process: a quitting pi exits before Herdr closes its pane, and a fresh process
// always runs the installed version, where an imported .mjs would stay cached across /reload.

const HELPER = fileURLToPath(new URL("./balance.mjs", import.meta.url));

/** Runs the helper outside this process: `now <pane>` or `after-close <pane> <tab>`. `windowsHide`: a detached console child on Windows would get a console window of its own. */
export function runHelper(args: string[], launch = spawn): void {
	const child = launch(process.execPath, [HELPER, ...args], { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", () => {});
	child.unref();
}

// Survives /reload, which loads extensions again in the same process.
const STARTED = Symbol.for("pi-straw-boss.pane-balance.started");

/** Equalises a Herdr tab only when a pi starts in it or quits out of it. */
export default function paneBalance(pi: ExtensionAPI, helper = runHelper, env = process.env, argv: readonly string[] = process.argv): void {
	const paneId = env.HERDR_PANE_ID;
	if (!paneId) return;
	// Balance on load: session_start waits for every other extension's handler, about ten seconds later.
	const host = globalThis as { [STARTED]?: boolean };
	if (!host[STARTED]) {
		host[STARTED] = true;
		helper(["now", paneId]);
	}
	pi.on("session_shutdown", (event) => {
		// A local tower run's pane is a standing pane that never closes: the helper would only wait out its 30 s, and on Windows `Start-Process -Wait` for pi.cmd waits for it too, so the next `herdr agent start` in the pane finds no prompt. An ally pane is closed by the server as soon as pi is gone, so it keeps the helper and the tower tab is rebalanced.
		if (event.reason === "quit" && !inStandingRun(argv)) helper(["after-close", paneId, env.HERDR_TAB_ID ?? ""]);
	});
}
