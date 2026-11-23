import { headTowerOf, type Pane, type Session, type Workspace } from "./herdr.ts";
import { HEAD_KEY } from "./headkey.ts";
import { type Mark, sessionMark } from "./netdata.ts";
import type { Queued, Ref, TowerService, TowerView } from "./net.ts";

// The head tower in the net snapshot (docs/specs/2026-11-04-head-tower.md, The GUI channel): the head unit the page draws, and the registry entry that makes the session key `sb-head` findable before the head exists.

/**
 * One of the head's asks as the page shows it (headasks.ts, docs/specs/2026-11-06-head-page-minimal.md): `group` the id of the first ask of its broadcast, `since` when it was opened, `at` its last forward or answer, `first` the
 * first line of the message, `state` `answered` when it has an answer to the head (never otherwise), else `handled` when the tower sent something in the turn the message started, else `received` when a run took the message,
 * else `waiting` while it is open, else `silent`; `answers` counts them and `last` is the first line of the newest. `sent` is the whole message (docs/specs/2026-11-07-head-log-cards.md), `boss` the boss's own words of the instruction it
 * relays (on the first row of a broadcast only), `supersedes` the group (else the id) of the earlier ask it corrects.
 */
export interface HeadAskRow { id: string; group: string; workspace: string; label: string; since: number; at: number; first: string; state: "waiting" | "answered" | "handled" | "received" | "silent" | "parked"; answers: number; last?: string; sent?: string; boss?: string; supersedes?: string; missed?: true }
/** One chapter of the head's conversation (server/headchapters.ts): its pi session file and why it began. */
export interface HeadChapter { n: number; file: string; from: string; to?: string; why: string }
/** What the net needs of the server to show the head: its key (the identity), its asks and chapters, the time of its newest assistant text in a conversation file, and that text's first line. */
export interface HeadSeam { key: string; asks(): HeadAskRow[]; chapters(): HeadChapter[]; said(file: string | undefined): number | undefined; line(file: string | undefined): string | undefined }
/** `state` is `absent` until the head exists. `mark` is the tower unit's rule, so an idle conversation is `idle`, never `waiting`. `said` drives the crown's dot; `line` is the first line (≤ 160) of the head's newest assistant text, the head band's line when no ask is live (docs/specs/2026-11-07-head-band.md). */
export interface HeadUnit { key: string; name: string; mark: Mark; state: "absent" | TowerService["state"]; service?: TowerService; queued?: Queued[]; asks: HeadAskRow[]; said?: number; line?: string }

/** What a tower the sb server runs shows as its mark: the live run is working unless the boss is the one being waited for, a service with no run is idle; no service, the pane's own mark. */
export const serviceMark = (service: TowerService | undefined, towerMark: Mark): Mark => (!service ? towerMark : service.run ? (towerMark === "idle" || towerMark === "unknown" ? (service.conversation?.idle && !service.conversation.closing ? "idle" : "working") : towerMark) : towerMark === "commanding" ? towerMark : "idle");

interface Input {
	all: Workspace[];
	sessions: Session[];
	ps: Pane[];
	services?(workspace: string): TowerView | undefined;
	seam: HeadSeam;
	/** The file as the registry may keep it (a .jsonl really under pi's sessions folder), or undefined. */
	readable(file?: string): string | undefined;
	keep(ref: Ref): string;
}
/**
 * The head unit and its registry entry. The head workspace is known by its `sb_head` token; its service view is the tower service's, taken by the workspace id. The newest chapter's file is the unit's comms (the one
 * conversation across runs), else the service's own file; the older chapters are kept on the entry for the history to chain through. Without a head workspace the entry has no file and no pane.
 */
export function headUnit({ all, sessions, ps, services, seam, readable, keep }: Input): { head: HeadUnit } {
	const workspace = headTowerOf(all), me = sessions.find((s) => s.id === seam.key), pane = ps.find((p) => p.pane_id === me?.herdrLocation?.paneId);
	const view = workspace ? services?.(workspace.workspace_id) : undefined, { queue, file: runFile, allyFiles: _a, eventFiles: _e, ...rest } = view ?? ({} as Partial<TowerView>);
	const chapters = seam.chapters().flatMap((c) => { const file = readable(c.file); return file ? [{ ...c, file }] : []; });
	const file = chapters.at(-1)?.file ?? (view ? readable(runFile) : undefined), name = me?.name ?? "head tower";
	keep({ key: seam.key, base: workspace?.workspace_id ?? HEAD_KEY, name, role: "head", file, pane: pane?.pane_id, chapters });
	const service = view ? (rest as TowerService) : undefined, said = seam.said(file), line = seam.line(file);
	return { head: { key: seam.key, name, mark: service ? serviceMark(service, me ? sessionMark(me, pane) : "unknown") : "idle", state: service?.state ?? "absent", ...(service ? { service: { ...service, allyRuns: [] } } : {}), ...(queue?.length ? { queued: queue } : {}), asks: seam.asks(), ...(said !== undefined ? { said } : {}), ...(line ? { line } : {}) } };
}
