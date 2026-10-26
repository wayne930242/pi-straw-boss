import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
export default function paneBalance(pi: ExtensionAPI, helper = runHelper, env = process.env): void {
	const paneId = env.HERDR_PANE_ID;
	if (!paneId) return;
	// Balance on load: session_start waits for every other extension's handler, about ten seconds later.
	const host = globalThis as { [STARTED]?: boolean };
	if (!host[STARTED]) {
		host[STARTED] = true;
		helper(["now", paneId]);
	}
	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") helper(["after-close", paneId, env.HERDR_TAB_ID ?? ""]);
	});
}
