import { readFileSync } from "node:fs";
import { join } from "node:path";

// The one switch of the tower service (docs/specs/2026-10-26-sb-backend.md, Build steps): `towerRuns` in `config.json` of the state directory. B4 to B6 sit behind
// `towerRuns.enabled`, off by default, so a release between them never leaves a tower that takes no events or link mail with no taker. With it off, towers stay resident and
// nothing is converted. `max` is the most pi runs the server starts at once across the machine (B5).

export interface TowerRuns { enabled: boolean; max: number }
export const DEFAULT_MAX = 4;

/** `towerRuns` from `<state dir>/config.json`; anything unreadable, or any value that is not `true`, means off. */
export function readTowerRuns(stateDir: string): TowerRuns {
	let section: unknown;
	try {
		section = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { towerRuns?: unknown }).towerRuns;
	} catch { /* off */ }
	const found = typeof section === "object" && section !== null ? (section as { enabled?: unknown; max?: unknown }) : {};
	const max = typeof found.max === "number" && Number.isInteger(found.max) && found.max > 0 ? found.max : DEFAULT_MAX;
	return { enabled: found.enabled === true, max };
}
export const towerRunsEnabled = (stateDir: string) => readTowerRuns(stateDir).enabled;
