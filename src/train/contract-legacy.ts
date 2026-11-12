import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// The transition of the merge-train contract (contract.ts), and the only place Straw Boss names a skills package. pi-anchorloop implemented contract 1 from 2.11.0 on, before there was a declaration to carry: a skill with no
// declaration that sits in that package (`<package>/skills/<name>/SKILL.md`), at that version or newer, counts as declaring "1". A declaration always wins over this. Remove this file, its one call in contract.ts and its test
// once the pi-anchorloop that declares the contract is the oldest in use.

const PACKAGE = "pi-anchorloop", SINCE = [2, 11, 0];

export function legacyContract(skillFile: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(join(dirname(realpathSync(skillFile)), "..", "..", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
		const found = pkg.name === PACKAGE && typeof pkg.version === "string" ? /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(pkg.version) : null;
		if (!found) return undefined;
		const at = [1, 2, 3].map((i) => Number(found[i])), differs = at.findIndex((n, i) => n !== SINCE[i]);
		// A pre-release of the first version is older than it.
		return (differs < 0 ? found[4] === undefined : at[differs]! > SINCE[differs]!) ? "1" : undefined;
	} catch { return undefined; }
}
