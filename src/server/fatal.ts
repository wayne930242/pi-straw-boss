/** How long a server may take to leave after a fatal error before the process is ended, so the error does not leave a half-working process. */
const FATAL_EXIT_MS = 20_000;
/** What a test replaces: the process whose events are heard, the end of it, and the timer that bounds the leave. */
export interface FatalWorld {
	proc?: Pick<NodeJS.Process, "on">;
	exit?(code: number): void;
	after?(run: () => void, ms: number): void;
}
/** Calls `leave` once, at the first uncaught exception or unhandled rejection (RVD27-F002: the remote serve entry goes down with the server). The exit timer is armed first, so a `leave` that throws still ends the process. */
export function onFatal(leave: (error: unknown) => void, world: FatalWorld = {}) {
	const { proc = process, exit = (code) => process.exit(code), after = (run, ms) => void (setTimeout(run, ms) as unknown as { unref(): void }).unref() } = world;
	let once = false;
	const fatal = (error: unknown) => {
		if (once) return;
		once = true;
		after(() => exit(1), FATAL_EXIT_MS);
		leave(error);
	};
	proc.on("uncaughtException", fatal);
	proc.on("unhandledRejection", fatal);
}
