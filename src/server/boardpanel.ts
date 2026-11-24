import { statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IntercomLike } from "./kit.ts";
import { readEntries, removeEntry, safeSession } from "../board.ts";
import type { Reply } from "../control.ts";
import { stamp } from "../header.ts";
import type { Net } from "../net.ts";

// Clear on the head page's work board (docs/specs/2026-11-09-board-view.md, Server routes; boss decisions B3 and B5): `board/clear {session}` deletes one line of this computer's board. Everything is decided from the server's own reading at the
// click, never from the page's claim: the body names a session id and nothing else is read from it, the file has to exist under the board's folder (no path comes from the body), and the row the server's reading makes of it has to be `ended` or
// `stale` (idle over 2 hours). A writer whose session is open is told once, a main that went idle and also one that is no longer a main (B5: unless the agent is closed); a session that is not live at all is told nothing.

/** What a live writer is told when its stale line is cleared. */
export const CLEARED_NOTICE = "The boss cleared your work-board line from the head page (it was idle over 2 hours). If you still work on it, write it again with board_set; if the work is over, nothing to do.";

/** What a writer that is open but no longer a main is told (it cannot write a line with board_set; BV2-F001). */
export const OPEN_NOTICE = "The boss cleared your old work-board line from the head page: your session is no longer a main, so the line had ended. Nothing to do.";

export interface BoardPanelDeps {
	/** The board's folder. */
	dir: string;
	/** A fresh reading of the net with its board rows (the server's own, as the pages get it). */
	read(): Promise<Net>;
	/** One message to a live session, from the server; see `Told`. */
	tell(session: string, text: string): Promise<Told>;
}

/** What became of a notice: `delivered` (the writer's connection took it), `queued` (the broker holds it for a session that is not connected), `false` (not sent, failed, or no word on how). */
export type Told = "delivered" | "queued" | false;

const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

export function createBoardPanel(d: BoardPanelDeps) {
	return {
		async clear(json: Record<string, unknown>): Promise<Reply> {
			const session = json.session;
			if (typeof session !== "string" || !safeSession(session)) return no(400, "bad_request", "Name the session whose line to clear.");
			try {
				if (!statSync(join(d.dir, `${session}.json`)).isFile()) throw new Error("not a file");
			} catch {
				return no(404, "not_found", "That session has no line on the board.");
			}
			const row = (await d.read()).board?.find((r) => r.session === session);
			if (!row?.clearable) return no(409, "refused", "Only a line whose session has ended, or a live main idle for over 2 hours, can be cleared.");
			// The writer may have written the line again since the reading: a fresh line stands (the file is read once more right before it goes).
			if (readEntries(d.dir).find((e) => e.session === session)?.updated !== row.updated) return no(409, "changed", "The line was written again just now, so it stays.");
			removeEntry(d.dir, session);
			const told: Told = row.state === "ended" && !row.open ? false : await d.tell(session, row.state === "ended" ? OPEN_NOTICE : CLEARED_NOTICE).catch((): Told => false);
			return { status: 200, body: { cleared: true, told } };
		},
	};
}
export type BoardPanel = ReturnType<typeof createBoardPanel>;

/** The server's way to tell a live session: one intercom message under a `board_clear` header, from the server's own session id; `delivered` only when the session's connection took it, `queued` when the broker holds it, `false` while it is not connected, when the send fails, or when the broker says nothing of how. */
export const tellVia = (client: () => Pick<IntercomLike, "isConnected" | "send"> | undefined, serverId: string, kind: "board_clear" | "auto_notice" | "capacity_notice" = "board_clear") => async (to: string, text: string): Promise<Told> => {
	const c = client();
	if (!c?.isConnected()) return false;
	const message = stamp({ from: { name: "straw boss", id: serverId, role: "session" }, kind, scope: "session", to: [{ name: to, id: to, role: "session" }], reply: false }, text);
	const sent = await c.send(to, { text: message, messageId: `${kind.replace("_", "-")}-${randomUUID()}` }).catch(() => undefined);
	return sent?.delivered !== true ? false : sent.delivery === "socket_delivered" ? "delivered" : sent.delivery === "queued" ? "queued" : false;
};
