import { spawn } from "node:child_process";
import { resolveExe } from "./exe.mjs";
import type { Kit } from "./state.ts";

/**
 * Closes a pane once the pi process `pid` has exited (at most 60 s), from a process of its own, so pi's shutdown runs to the end first. Windows has no sh, so there
 * the wait runs in node (pi runs on node there; a Bun-built pi would read `-e` as its own flag, so sh stays the waiter elsewhere).
 */
export const afterExit = (pid: number, args: string[]) => {
	// Both programs are found by absolute path (a `herdr.exe` or `sh` in the project folder is never run); one that is not found throws ExeNotFound, which the caller's catch reports.
	const herdr = resolveExe(process.env.HERDR_BIN_PATH || "herdr");
	const sh = `i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done; exec "$0" "$@"`;
	const node = `const [bin, ...args] = process.argv.slice(1); let i = 0; const alive = () => { try { return process.kill(${pid}, 0); } catch (e) { return e.code === "EPERM"; } };
	const t = setInterval(() => { if (alive() && ++i < 120) return; clearInterval(t); require("node:child_process").spawn(bin, args, { stdio: "ignore", windowsHide: true }).on("error", () => {}); }, 500);`;
	const [cmd, pre] = process.platform === "win32" ? [process.execPath, ["-e", node]] : [resolveExe("sh"), ["-c", sh]];
	spawn(cmd, [...pre, herdr, ...args], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
};

/**
 * Closing: pi quits as /quit would (its shutdown clears this session's tokens; a tower's quit clears the mains), then its pane closes, which
 * closes an emptied tab and an emptied base with it. `keepPane` leaves the pane to a caller that closes the whole tab or base.
 * Closing is this session's own: the GUI asks its bridge, /boss close asks here, and only a session that runs this extension can (not a subagent).
 */
export function createClosing({ s }: Kit) {
	return (keepPane: boolean): string | undefined => {
		if (!s.quit) return "This session has not started yet.";
		s.closing ??= { keepPane };
		setTimeout(() => s.quit?.(), 50); // after the answer has gone out
		return undefined;
	};
}
