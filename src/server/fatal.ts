/** How long a server may take to leave after a fatal error before the process is ended, so the error does not leave a half-working process. */
const FATAL_EXIT_MS = 20_000;
/** Calls `leave` once, at the first uncaught exception or unhandled rejection (RVD27-F002: the remote serve entry goes down with the server). */
export function onFatal(leave: (error: unknown) => void) {
	let once = false;
	const fatal = (error: unknown) => {
		if (once) return;
		once = true;
		leave(error);
		setTimeout(() => process.exit(1), FATAL_EXIT_MS).unref();
	};
	process.on("uncaughtException", fatal);
	process.on("unhandledRejection", fatal);
}
