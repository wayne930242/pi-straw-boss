import { readFileSync } from "node:fs";
import { join } from "node:path";

// The one switch of the tower service (docs/specs/2026-10-26-sb-backend.md, Build steps): `towerRuns` in `config.json` of the state directory. B4 to B6 sit behind
// `towerRuns.enabled`, which B6 turns on by default (the release after it removes the flag): only an explicit `false` keeps towers resident and converts nothing. `max` is the
// most pi runs the server starts at once across the machine (B5).

export interface TowerRuns {
	enabled: boolean;
	max: number;
	/** F (docs/specs/2026-11-23-lite-b2-d-e-f.md §4): runs are pi in RPC mode as the server's children, with no pane. Off unless `headless` is `true`; off is 0.84.0's behavior. */
	headless: boolean;
	/** pi's CLI file for headless runs, when the `pi` on the PATH is not the one (runchild.ts `resolvePi`). */
	pi?: string;
	/** Set when the file exists but cannot be read or parsed: the service stays on, and the server tells the boss (the default would otherwise override an `enabled: false` without a word). */
	problem?: string;
}
export const DEFAULT_MAX = 4;

/** `towerRuns` from `<state dir>/config.json`; on unless `enabled` is `false` (a config that is missing means the default, on; one that cannot be parsed means the default as well, with a `problem` to tell). */
export function readTowerRuns(stateDir: string): TowerRuns {
	let section: unknown, problem: string | undefined;
	try {
		section = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { towerRuns?: unknown }).towerRuns;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") problem = `${join(stateDir, "config.json")} cannot be read (${(cause as Error).message.slice(0, 120)}), so towerRuns.enabled and max are the defaults: the tower service is on`;
	}
	const found = typeof section === "object" && section !== null ? (section as { enabled?: unknown; max?: unknown; headless?: unknown; pi?: unknown }) : {};
	const max = typeof found.max === "number" && Number.isInteger(found.max) && found.max > 0 ? found.max : DEFAULT_MAX;
	return { enabled: found.enabled !== false, max, headless: found.headless === true, ...(typeof found.pi === "string" && found.pi ? { pi: found.pi } : {}), ...(problem ? { problem } : {}) };
}
export const towerRunsEnabled = (stateDir: string) => readTowerRuns(stateDir).enabled;
