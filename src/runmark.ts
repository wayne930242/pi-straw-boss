// Whether this pi process is a tower run of the sb server (runmode.ts marks it; balance.ts reads it). Its own module, because the two are separate pi extensions that share only the process.
const MARK = Symbol.for("pi-straw-boss.run.mark");

/** The run mode took this process (a flag, or a standing pane the server handed over): it stays a run until it exits. An ally run's pane is closed by the server, a local run's pane stays. */
export const markRun = (kind: "local" | "ally" = "local"): void => void ((globalThis as Record<symbol, unknown>)[MARK] = kind);

/** Started for a run (`--sb-run`, in either form), or marked by the run mode since. */
export const inRun = (argv: readonly string[] = process.argv): boolean =>
	(globalThis as Record<symbol, unknown>)[MARK] !== undefined || argv.some((arg) => arg === "--sb-run" || arg.startsWith("--sb-run="));

/** A run whose pane stays after pi quits: a local run, or a flagged pi whose claim has not (yet) said what it is. An ally run's pane is closed by the server. */
export const inStandingRun = (argv: readonly string[] = process.argv): boolean => (globalThis as Record<symbol, unknown>)[MARK] !== "ally" && inRun(argv);
