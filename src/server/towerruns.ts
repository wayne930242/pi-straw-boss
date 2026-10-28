import { readFileSync } from "node:fs";
import { join } from "node:path";

// The one switch of the tower service (docs/specs/2026-10-26-sb-backend.md, Build steps): `towerRuns` in `config.json` of the state directory. B4 to B6 sit behind
// `towerRuns.enabled`, which B6 turns on by default (the release after it removes the flag): only an explicit `false` keeps towers resident and converts nothing. `max` is the
// most pi runs the server starts at once across the machine (B5).

export interface TowerRuns { enabled: boolean; max: number }
export const DEFAULT_MAX = 4;

/** `towerRuns` from `<state dir>/config.json`; on unless `enabled` is `false` (a config that is missing or unreadable means the default, on). */
export function readTowerRuns(stateDir: string): TowerRuns {
	let section: unknown;
	try {
		section = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { towerRuns?: unknown }).towerRuns;
	} catch { /* the default */ }
	const found = typeof section === "object" && section !== null ? (section as { enabled?: unknown; max?: unknown }) : {};
	const max = typeof found.max === "number" && Number.isInteger(found.max) && found.max > 0 ? found.max : DEFAULT_MAX;
	return { enabled: found.enabled !== false, max };
}
export const towerRunsEnabled = (stateDir: string) => readTowerRuns(stateDir).enabled;
