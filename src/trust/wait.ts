import type { Sleep } from "../herdr.ts";
import { clean } from "./found.ts";
import { listRequests } from "./files.ts";
import type { TrustRequest } from "./types.ts";

// A new pi that waits on a trust question has not joined, so the openings that wait for one (the page's opens, boss_open_main, a tower's start, a pop) stop counting while its
// pane has a request in <state>/trust/, and give up on a question nobody answers after ten minutes (D6). Towers and the opener run in sessions that are not the server; they read the
// same directory, which is why the channel is files.

export const TRUST_MAX_MS = 600_000;
/** `dir`: <state>/trust. `pane`: the pane the new pi runs in. `on`: told when a request for the pane appears (with it) and when it is gone (without). */
export interface TrustWatch { dir: string; pane: string; on?(request: TrustRequest | undefined): void }

/** `waitFor` (herdr.ts) that does not count the time a trust question for `trust.pane` is open, and fails after ten minutes of it. */
export async function waitPastTrust<T>(sleep: Sleep, check: () => T | Promise<T>, ms: number, step = 100, trust?: TrustWatch): Promise<Awaited<T> | undefined> {
	let waited = 0, asking = 0, seen: string | undefined;
	for (;;) {
		const value = await check();
		const ask = trust && listRequests(trust.dir).find((r) => r.pane === trust.pane);
		if (value) return (seen && trust?.on?.(undefined), value);
		if (ask?.id !== seen) trust?.on?.(ask), (seen = ask?.id);
		if (ask) {
			if ((asking += step) > TRUST_MAX_MS) throw new Error(`No trust decision for ${clean(ask.cwd)} within ${TRUST_MAX_MS / 60_000} minutes`);
		} else if ((waited += step) > ms) return undefined;
		await sleep(step);
	}
}
