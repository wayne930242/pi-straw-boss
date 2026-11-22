// Which signal, if any, turned this pi's shutdown into a quit (docs/specs/2026-11-23-tower-revive.md §2). pi turns a SIGHUP or a SIGTERM into its graceful shutdown, and the extension then sees
// `session_shutdown` with reason `quit`, the same as a typed /quit. A listener added after pi's own (pi prepends its handler, so this one runs in the same dispatch, before the async shutdown
// reaches the extension) tells the two apart. It is added only where pi has a handler of its own already: a process without one would stop exiting on the signal.

const SLOT = Symbol.for("straw-boss/signal-seen");
type Seen = { signal?: "SIGHUP" | "SIGTERM"; armed: Set<string> };
const seen = (): Seen => ((globalThis as Record<symbol, Seen | undefined>)[SLOT] ??= { armed: new Set() });

/** Adds the listeners once per process and signal, only for a signal pi already handles. */
export function armSignals(): void {
	if (process.platform === "win32") return;
	const state = seen();
	for (const signal of ["SIGHUP", "SIGTERM"] as const) {
		if (state.armed.has(signal) || process.listenerCount(signal) === 0) continue;
		state.armed.add(signal);
		process.on(signal, () => void (state.signal ??= signal));
	}
}
/** The first signal this process got, or undefined. */
export const signalSeen = (): "SIGHUP" | "SIGTERM" | undefined => seen().signal;
/** Tests: a signal as if it had arrived, or none. */
export const noteSignal = (signal: "SIGHUP" | "SIGTERM" | undefined): void => void (seen().signal = signal);
