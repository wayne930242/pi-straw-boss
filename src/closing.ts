import { spawn } from "node:child_process";
import type { Kit } from "./state.ts";

/** Closes a pane once the pi process `pid` has exited, from a process of its own, so pi's shutdown runs to the end first. */
export const afterExit = (pid: number, args: string[]) => {
	const herdr = process.env.HERDR_BIN_PATH || "herdr";
	const script = `i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done; exec "$0" "$@"`;
	spawn("sh", ["-c", script, herdr, ...args], { detached: true, stdio: "ignore" }).unref();
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
