// The folder picker's model (picker.ts draws it): Finder's column view as plain state. The selected folder is `path`; a column lists the folders of each
// level from home down to it, with the next level's name picked in it, and the last column lists the selected folder's own folders. The server names
// every folder (spawn.ts: home only, nothing hidden), by its real path and with its own separator, so a Windows path with backslashes is cut and joined as it is.

export interface Listing { path: string; home: string; sep: string; parent: string | null; dirs: string[]; truncated: boolean }
export interface Col { path: string; dirs: string[]; truncated: boolean; pick?: string }
export interface Crumb { path: string; name: string }
export interface PickerDeps {
	/** The folders in `path`, or in the folder the picker starts from when none is named. */
	list(path?: string): Promise<Listing>;
	/** A new folder `name` in `path`: its path, or a rejection whose message is the server's reason. */
	make(path: string, name: string): Promise<string>;
}
export interface PickerState { path?: string; home: string; sep: string; cols: Col[]; focus: number; crumbs: Crumb[]; back: boolean; forward: boolean; error?: string }
export type Key = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter";

/** The last segment of `path`: the folder's own name, empty for home (a base takes no name from it). */
export const leaf = (path: string, home?: string) => (path === home ? "" : path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1));
/** `name` inside `path`, with the separator the path uses. */
export const child = (path: string, name: string, sep: string) => (path.endsWith(sep) ? path : path + sep) + name;

export function createPicker({ list, make }: PickerDeps) {
	const cache = new Map<string, Listing>(), trail: string[] = [], listeners: (() => void)[] = [];
	let cols: Col[] = [], focus = 0, at = -1, home = "", sep = "/", path: string | undefined, error: string | undefined, turn = 0;
	const emit = () => listeners.forEach((run) => run());
	/** Records `to` as the newest place in the back and forward trail, dropping what was forward of here. */
	const visit = (to: string) => {
		if (trail[at] === to) return;
		trail.splice(at + 1, trail.length, to);
		at = trail.length - 1;
	};
	const load = async (where?: string) => {
		const kept = where === undefined ? undefined : cache.get(where);
		if (kept) return kept;
		const got = await list(where);
		cache.set(got.path, got);
		if (where !== undefined) cache.set(where, got);
		[home, sep] = [got.home, got.sep];
		return got;
	};
	/** The chain of folders from home to `real`: its listing, and the name that continues it in each one. */
	const chain = async (real: Listing): Promise<Col[]> => {
		const names = real.path === real.home || !real.path.startsWith(real.home) ? [] : real.path.slice(real.home.length).split(real.sep).filter(Boolean);
		const paths = names.reduce((all, name) => [...all, child(all.at(-1)!, name, real.sep)], [real.home]);
		const lists = await Promise.all(paths.map((p) => (p === real.path ? real : load(p))));
		return lists.map((l, i) => ({ path: l.path, dirs: l.dirs, truncated: l.truncated, ...(names[i] !== undefined && { pick: names[i] }) }));
	};
	/** Shows `where` as the selected folder; `pushed` is false when history moved it. A stale answer, or a folder that cannot be listed, leaves the picker as it was. */
	async function go(where: string | undefined, pushed = true): Promise<void> {
		const mine = ++turn;
		try {
			const real = await load(where), next = await chain(real);
			if (mine !== turn) return;
			[cols, path, error] = [next, real.path, undefined];
			focus = Math.max(0, cols.length - 2);
			if (pushed) visit(path);
		} catch (e) {
			if (mine === turn) error = (e as Error).message;
		}
		emit();
	}
	/** Picks `name` in column `i`: the columns after it give way to that folder's own. */
	async function pick(i: number, name: string): Promise<void> {
		const there = child(cols[i]!.path, name, sep), mine = ++turn;
		[cols, focus, path, error] = [[...cols.slice(0, i + 1).map((c, n) => (n === i ? { ...c, pick: name } : c))], i, there, undefined];
		emit();
		try {
			const real = await load(there);
			if (mine !== turn) return;
			if (real.path !== there) return void (await go(real.path)); // a link: the folder it leads to
			cols = [...cols, { path: real.path, dirs: real.dirs, truncated: real.truncated }];
			visit(there);
		} catch (e) {
			if (mine === turn) error = (e as Error).message;
		}
		emit();
	}
	const walk = (to: number) => (to >= 0 && to < trail.length ? ((at = to), go(trail[at], false)) : Promise.resolve());
	return {
		state: (): PickerState => ({ path, home, sep, cols, focus, error, back: at > 0, forward: at < trail.length - 1, crumbs: cols.map((c, i) => ({ path: c.path, name: i === 0 ? "" : leaf(c.path) })) }),
		on: (run: () => void) => void listeners.push(run),
		start: (where?: string) => go(where),
		go: (where: string) => go(where),
		pick,
		back: () => walk(at - 1),
		forward: () => walk(at + 1),
		/** A new folder in the selected one, selected as it is made; a refusal is `error`. */
		async make(name: string) {
			if (path === undefined) return;
			try {
				const made = await make(path, name);
				cache.delete(path);
				await go(made);
			} catch (e) {
				error = (e as Error).message;
				emit();
			}
		},
		/** A key in the columns: arrows move between folders (up and down in a column, left and right between columns), Enter chooses. Whether it was the picker's. */
		async key(k: Key): Promise<"chosen" | boolean> {
			const col = cols[focus];
			if (!col) return false;
			if (k === "Enter") return path === undefined ? false : "chosen";
			if (k === "ArrowLeft") {
				if (focus === 0) return true;
				const left = focus - 1;
				[cols, focus, path] = [cols.slice(0, focus + 1).map((c, n) => (n === focus ? { path: c.path, dirs: c.dirs, truncated: c.truncated } : c)), left, cols[focus]!.path];
				visit(path);
				return (emit(), true);
			}
			if (k === "ArrowRight") {
				const here = cols[focus + 1];
				if (!here?.dirs.length) return true; // no folder to go into
				focus++;
				if (here.pick === undefined) await pick(focus, here.dirs[0]!);
				else emit();
				return true;
			}
			if (!col.dirs.length) return true;
			const now = col.pick === undefined ? -1 : col.dirs.indexOf(col.pick);
			await pick(focus, col.dirs[Math.min(col.dirs.length - 1, Math.max(0, k === "ArrowDown" ? now + 1 : now < 0 ? col.dirs.length - 1 : now - 1))]!);
			return true;
		},
	};
}
export type Picker = ReturnType<typeof createPicker>;
