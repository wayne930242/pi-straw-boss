import { clean, readEntries } from "./board.ts";
import { capDir, readDevice } from "./capacity.ts";
import { type BoardReadInput, liveMains } from "./boardread.ts";
import { boardRows, boardText } from "./boardview.ts";

// `/boss board` (docs/specs/2026-11-09-board-view.md): the same rows as the head page's work board, as text, for this computer only. No clear and no ask from pi in this change.

export function boardCommand(o: { dir: string; now: number; net: BoardReadInput["net"] }): string {
	// A main that commands work shows the mark the head page shows (`commanding`), not the session's own `idle`; every session of the net is open.
	const mains = liveMains(o.net, o.now, (text) => clean(text, 40)).map((m) => (m.commanding ? { ...m, state: "commanding" } : m));
	const dev = readDevice(capDir(o.dir), o.now); // the capacity row the sb server writes (docs/specs/2026-11-24-capacity.md)
	return boardText(boardRows(readEntries(o.dir), mains, o.now, new Set(o.net.sessions.map((s) => s.id)), dev), o.now, dev);
}
