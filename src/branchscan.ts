// A session branch read again and again (the work board's refresh runs at every tool call): what a reader looks for in it is found once, and each later read walks only the entries appended since.

/**
 * The newest entry of a branch for which `pick` gives a value, as a full walk from the leaf would find it. The reader remembers the leaf it read last and what it found: a branch that still holds that entry
 * at that place has the same entries before it (an entry has one parent, so the path from the root to it is one), and only what follows it is walked. Any other branch (the leaf moved to another branch of the
 * tree or back to an ancestor, a new session) is walked whole. pi hands a new array at each `getBranch()`, with the same entry objects, so entries are compared by identity.
 */
export function newestOf<T>(pick: (entry: unknown) => T | undefined): (branch: readonly unknown[]) => T | undefined {
	let length = 0, leaf: unknown, found: T | undefined;
	return (branch) => {
		const grown = length === 0 || (branch.length >= length && branch[length - 1] === leaf);
		let hit: T | undefined;
		for (let i = branch.length - 1; i >= (grown ? length : 0) && hit === undefined; i--) hit = pick(branch[i]);
		found = hit ?? (grown ? found : undefined);
		[length, leaf] = [branch.length, branch[branch.length - 1]];
		return found;
	};
}
