import { type Entry, finished } from "./board.ts";
import type { Derived } from "./boardauto.ts";

/** The custom entry a main keeps in its session when it withdraws the line for a derived entry (`board_set { clear }`, or a finished list's 30 minutes): a /reload reads it back, so the line is not written again. */
export const BOARD_ENTRY = "straw-boss-board";

/** The key of the newest withdrawal the session branch holds. */
export function withdrawnKey(branch: readonly unknown[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type?: string; customType?: string; data?: { cleared?: unknown } };
		if (e.type === "custom" && e.customType === BOARD_ENTRY && typeof e.data?.cleared === "string") return e.data.cleared;
	}
	return undefined;
}

/** What the auto-fill starts from on its first refresh after a start or /reload: `last` (the key it believes is written or withdrawn) and `doneAt` (when a finished line was written). */
export interface Seed { last?: string; doneAt?: number }

/**
 * - a `board_set` line stands until the todo list or the name moves;
 * - an auto line that says what the list says is kept as it stands, with its own age (a finished one is not made fresh for another 30 minutes);
 * - no line and the entry withdrawn for this very key: it stays withdrawn;
 * - at a session start only: no line and a finished list in the branch (a /reload): a tower's read purged it after 30 minutes, so it is not written again unless the list moves. A list that finishes during the session is written.
 */
export function seedBoard({ own, derived, key, withdrawn, atStart = false }: { own: Entry | undefined; derived: Derived | undefined; key: string; withdrawn: string | undefined; atStart?: boolean }): Seed {
	if (own) {
		if (own.src === "set") return { last: key };
		if (derived && own.now === derived.text.now && JSON.stringify(own.items) === JSON.stringify(derived.text.items)) return finished(own) ? { last: key, doneAt: own.updated } : { last: key };
		return {};
	}
	if (withdrawn === key) return { last: key };
	if (atStart && derived && finished({ src: "todo", ...(derived.count ? { count: derived.count } : {}) })) return { last: key };
	return {};
}
