/**
 * A clock the test moves. Its `sleep` advances it at once, so a wait of N ms takes none, and what a wait took is read off the clock (`elapsed`), not off a machine that may run its timers a second late (a load average of 100 was seen). `at` runs a function
 * when the clock reaches a time since the start, as a lock is released in the middle of a wait; `advance` moves the clock for code that reads it from its own timers (the tower runs' watcher). A `sleep` raced against another promise (client.ts `denied`) advances the clock by the full amount. Only waits that start no real process belong on it: a start
 * that waits for a server to answer needs the machine's time.
 */
export function fakeClock(start = Date.now()) {
	let t = start;
	const timed: { at: number; fn: () => void }[] = [];
	const advance = (ms: number) => {
		t += ms;
		for (const entry of timed.filter((x) => x.at <= t)) (timed.splice(timed.indexOf(entry), 1), entry.fn());
	};
	return {
		now: () => t,
		advance,
		sleep: async (ms: number) => advance(ms),
		elapsed: () => t - start,
		at: (ms: number, fn: () => void) => void timed.push({ at: start + ms, fn }),
	};
}
