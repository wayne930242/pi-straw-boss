import { homedir } from "node:os";
import { join } from "node:path";
import { checkEntry, writeEntry } from "./board.ts";
import { boardTargets, wentTo } from "./link/boardtargets.ts";

// `board_set` and `straw-net.py board`, one body: a main replaces its whole entry (docs/specs/2026-10-25-straw-link.md, Work board, Writing).

export const NOT_MAIN = "Only the main agent of a tab writes the work board; a member, a demoted main, a tower, or a subagent does not";
export interface BoardSetInput {
	/** The board folder (`<state dir>/board`) and the state directory that holds config.json and link/. */
	dir: string;
	stateDir: string;
	session: string;
	isMain: boolean;
	now: number;
	/** The main's pane directory: which teams the text goes to. */
	cwd: string;
	input: { now: unknown; items?: unknown };
	home?: string;
	agentDir?: string;
	/** The session fills its board from its todo list (boardfill.ts): the answer says when this entry gives way to it. */
	autoFill?: boolean;
}

/** Where a main's entry goes, in words: the local towers and each team bound to the project that holds `cwd`. */
export function whereTo(o: Pick<BoardSetInput, "stateDir" | "cwd" | "home" | "agentDir">): string {
	const home = o.home ?? homedir(), agentDir = o.agentDir ?? join(home, ".pi", "agent");
	try {
		return wentTo(boardTargets(o.stateDir, o.cwd, { home, agentDir }));
	} catch {
		return "local towers";
	}
}

/** Writes the entry of `session` and says where it goes. Refused, with the reason, unless the session is its tab's main at this moment. */
export function setBoard(o: BoardSetInput): { text: string; details: { now: string; items: number; sharedWith: string } } {
	if (!o.isMain) throw new Error(NOT_MAIN);
	const text = checkEntry(o.input);
	writeEntry(o.dir, o.session, text, o.now);
	const sharedWith = whereTo(o);
	return { text: `Board entry set (${text.items.length} item${text.items.length === 1 ? "" : "s"}). It goes to: ${sharedWith}. Allies' towers read it, so keep secrets, credentials, customer data, and paths outside the project out of it.${o.autoFill ? " It stands until your todo list or your name changes; `board_set { auto: true }` hands the board back to auto-fill at once, and `board_set { clear: true }` deletes it when the work is finished." : ""}`, details: { now: text.now, items: text.items.length, sharedWith } };
}
