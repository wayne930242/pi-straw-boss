import { boardState, readTrainboards, type Writer } from "../train/board.ts";
import type { Log } from "./log.ts";
import { writerAlive } from "./traingate.ts";

// Whether a restart would cut a train (0.80.17, A3): the server keeps the car book and which train it opened in memory, so a restart in the middle of a train loses them, and the train's land step is then refused ("this server did not
// open train …"). A manual restart is refused while a train runs, unless the boss's own command asks or `cli.mjs restart --force` gives a reason; the automatic upgrade waits for a later look instead.

export interface RunningTrain { project: string; code: string; pid: number }

/** The trains on this computer that run now: the board reads live and its session's process is the one that wrote it. A board that cannot be read is not counted: what it is cannot be known, and it would block every restart. */
export function runningTrains(stateDir: string, deps: { now?: () => number; alive?: (writer: Writer) => boolean } = {}): RunningTrain[] {
	const now = (deps.now ?? Date.now)(), alive = deps.alive ?? ((w: Writer) => writerAlive(w));
	return readTrainboards(stateDir).trains.flatMap((read) => {
		if (!read.ok) return [];
		const { board } = read;
		// An ended board is never asked about its writer (that costs a `ps`).
		if (boardState(board, { now, alive: true, ...(read.end ? { end: read.end } : {}) }) === "ended" || !alive(board.writer)) return [];
		return [{ project: board.project, code: board.code, pid: board.writer.pid }];
	});
}

/** The words of a refused restart, or undefined when no train runs. `how` says what would restart anyway. */
export function trainsRefusal(trains: readonly RunningTrain[], how: string): string | undefined {
	if (!trains.length) return undefined;
	const list = trains.map((t) => `${t.project} ${t.code} (pid ${t.pid})`).join(", ");
	return `sb: ${trains.length === 1 ? "a train runs" : `${trains.length} trains run`} on this computer: ${list}. A restart now loses the server's car book and which train it opened, and the train's land step is then refused; wait until it ends (cli.mjs train status --state live), or ${how}`;
}

const deferred = new Map<string, string>();
/**
 * Whether an upgrade waits for the trains that run (A3). The server's log says so once per episode (SBR-F003): when the trains it waits for change, not at every look; a look that finds none ends the episode. A train the server opened whose
 * board is not written yet is not seen here: the open is in the server's memory, and its board comes with the train's first todo.
 */
export function upgradeWaits(log: Pick<Log, "line">, stateDir: string, trains: readonly RunningTrain[], by: string): boolean {
	if (!trains.length) return (deferred.delete(stateDir), false);
	const names = trains.map((t) => `${t.project} ${t.code}`).join(", ");
	if (deferred.get(stateDir) !== names) (deferred.set(stateDir, names), log.line("upgrade-deferred", { trains: names, by }));
	return true;
}
