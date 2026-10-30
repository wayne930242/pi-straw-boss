import { join } from "node:path";
import { ENDED_MS, finished, readEntries, removeEntry, writeEntry } from "./board.ts";
import { type Derived, deriveBoard } from "./boardauto.ts";
import { BOARD_ENTRY, seedBoard, withdrawnKey } from "./boardseed.ts";
import type { Kit } from "./state.ts";
import { todosOfBranch } from "./todo.ts";

// The work board fills itself (docs/specs/2026-10-25-straw-link.md, Work board, Auto-fill): the main's own session turns its todo list and its name into its entry and writes it
// with `writeEntry`, as `board_set` does, marked `src: "todo"`. The server takes no part. boardauto.ts is the derivation and the scrub.

export interface BoardFill {
	/** Writes the entry the todo list and the name make, when that differs from what this session wrote last; a main only. */
	refresh(): void;
	/** `board_set { clear: true }`: the entry is deleted, and auto-fill does not write it again until the todo list or the name moves. Refused unless this session is its tab's main. */
	clear(): void;
	/** `board_set { auto: true }`: the derived entry now, whatever the last write was; nothing derivable removes the entry. Refused unless this session is its tab's main. */
	handBack(): Derived | undefined;
}

export function createBoardFill({ pi, cfg, s, guiDir, me, role, tell }: Kit): BoardFill {
	const dir = join(guiDir, "board");
	let ctx: { cwd?: string; sessionManager?: { getBranch(): readonly unknown[] } } | undefined, last: string | undefined, seeded = false, startPending = false, warned = false, doneAt: number | undefined;
	/** The name the user or the agent gave the session; pi's default (none, or the session id) is no name. */
	const named = () => {
		const name = pi.getSessionName()?.trim() ?? "";
		return name === me() || name === me().slice(0, 8) ? "" : name;
	};
	const derive = () => {
		return deriveBoard({ name: named(), todos: todosOfBranch(branchOf()), root: ctx?.cwd ?? process.cwd() });
	};
	const branchOf = (): readonly unknown[] => {
		try { return ctx?.sessionManager?.getBranch() ?? []; } catch { return []; } // a replaced session's context throws
	};
	const withdraw = (key: string) => { try { pi.appendEntry(BOARD_ENTRY, { cleared: key }); } catch { /* a replaced session's pi throws */ } };
	const write = (d: Derived) => {
		writeEntry(dir, me(), d.text, cfg.now(), { src: "todo", ...(d.count ? { count: d.count } : {}), ...(d.who ? { who: d.who } : {}) });
		s.boardId = me(); // remembered for the shutdown that deletes the file (session.ts)
		doneAt = finished({ src: "todo", ...(d.count ? { count: d.count } : {}) }) ? cfg.now() : undefined;
	};
	const refresh = () => {
		if (role() !== "main" || !me()) return;
		try {
			const d = derive(), key = JSON.stringify(d ?? null);
			// An entry that outlived the extension's own reload is this session's: its quit deletes it (s.boardId), and a board_set one stands until the todo list or the name moves, as one written in this instance does.
			if (!seeded) {
				seeded = true;
				const own = readEntries(dir).find((e) => e.session === me());
				if (own) s.boardId = me();
				const seed = seedBoard({ own, derived: d, key, withdrawn: withdrawnKey(branchOf()), atStart: startPending }); startPending = false;
				last = seed.last ?? last; // what the session start seeded (a finished list) stands
				doneAt = seed.doneAt ?? doneAt;
			}
			// A finished list is said once: the line goes 30 minutes after it was written (readers also hide it, and a tower's read deletes it).
			if (key === last && doneAt !== undefined && cfg.now() - doneAt > ENDED_MS) {
				removeEntry(dir, me());
				withdraw(key);
				doneAt = undefined;
			}
			if (key === last) return;
			last = key;
			if (d) write(d);
			else if (readEntries(dir).find((e) => e.session === me())?.src === "todo") removeEntry(dir, me()); // nothing to say any more: the old auto line must not stay
		} catch (error) {
			if (!warned) tell(`Straw Boss: the work board could not be filled from the todo list: ${(error as Error).message}`, "warning");
			warned = true;
		}
	};
	const again = (c: unknown) => {
		ctx = (c as typeof ctx) ?? ctx;
		refresh();
	};
	pi.on("session_start", (_e, c) => {
		[ctx, last, seeded, doneAt, startPending] = [c as typeof ctx, undefined, false, undefined, true]; // pi-intercom sets the id in its own session_start, after this one: if absent, the first refresh that finds it seeds as the start
		// A line a reload kept is this session's from the start: a quit before any turn deletes it (s.boardId), as one written here would be.
		try {
			if (!me()) return; startPending = false;
			const own = readEntries(dir).find((e) => e.session === me());
			if (own) s.boardId = me();
			// A finished list this reload carries, whose line a tower's read purged, is not written again.
			const d = derive();
			({ last, doneAt } = seedBoard({ own, derived: d, key: JSON.stringify(d ?? null), withdrawn: withdrawnKey(branchOf()), atStart: true }));
		} catch { /* no board yet */ }
	});
	pi.on("turn_end", (_e, c) => again(c));
	pi.on("session_tree", (_e, c) => again(c));
	pi.on("session_compact", (_e, c) => again(c));
	pi.on("tool_execution_end", (_e, c) => again(c)); // the todo tool, boss_rename, and boss_promote end here
	return {
		refresh,
		clear() {
			if (role() !== "main") throw new Error("Only the main agent of a tab writes the work board; a member, a demoted main, a tower, or a subagent does not");
			last = JSON.stringify(derive() ?? null);
			seeded = true;
			doneAt = undefined;
			removeEntry(dir, me());
			withdraw(last);
		},
		handBack() {
			if (role() !== "main") throw new Error("Only the main agent of a tab writes the work board; a member, a demoted main, a tower, or a subagent does not");
			const d = derive();
			last = JSON.stringify(d ?? null);
			seeded = true;
			if (d) write(d);
			else removeEntry(dir, me());
			return d;
		},
	};
}
