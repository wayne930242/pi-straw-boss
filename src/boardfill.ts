import { join } from "node:path";
import { ENDED_MS, finished, readEntries, removeEntry, writeEntry } from "./board.ts";
import { type Derived, deriveBoard } from "./boardauto.ts";
import type { Kit } from "./state.ts";
import { todosOfBranch } from "./todo.ts";

/** The custom entry a main keeps in its session when it withdraws the line for a derived entry (`board_set { clear }`, or a finished list's 30 minutes): a /reload reads it back, so the line is not written again. */
const BOARD_ENTRY = "straw-boss-board";

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
	let ctx: { cwd?: string; sessionManager?: { getBranch(): readonly unknown[] } } | undefined, last: string | undefined, seeded = false, warned = false, doneAt: number | undefined;
	/** The name the user or the agent gave the session; pi's default (none, or the session id) is no name. */
	const named = () => {
		const name = pi.getSessionName()?.trim() ?? "";
		return name === me() || name === me().slice(0, 8) ? "" : name;
	};
	const derive = () => {
		let branch: readonly unknown[] = [];
		try { branch = ctx?.sessionManager?.getBranch() ?? []; } catch { /* a replaced session's context throws */ }
		return deriveBoard({ name: named(), todos: todosOfBranch(branch), root: ctx?.cwd ?? process.cwd() });
	};
	/** The key of the newest withdrawal this session's branch holds. */
	const withdrawn = (): string | undefined => {
		let branch: readonly unknown[] = [];
		try { branch = ctx?.sessionManager?.getBranch() ?? []; } catch { /* a replaced session's context throws */ }
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i] as { type?: string; customType?: string; data?: { cleared?: unknown } };
			if (e.type === "custom" && e.customType === BOARD_ENTRY && typeof e.data?.cleared === "string") return e.data.cleared;
		}
		return undefined;
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
				if (own?.src === "set") last = key;
				// An auto line this reload finds is kept as it stands, with its own age: a finished one is not made fresh for another 30 minutes.
				else if (own && d && own.now === d.text.now && JSON.stringify(own.items) === JSON.stringify(d.text.items)) {
					last = key;
					if (finished(own)) doneAt = own.updated;
				// No line, and one withdrawn for this very entry: it stays withdrawn.
				} else if (!own && withdrawn() === key) last = key;
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
		[ctx, last, seeded, doneAt] = [c as typeof ctx, undefined, false, undefined];
		// A line a reload kept is this session's from the start: a quit before any turn deletes it (s.boardId), as one written here would be.
		try { if (me() && readEntries(dir).some((e) => e.session === me())) s.boardId = me(); } catch { /* no board yet */ }
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
