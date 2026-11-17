import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HEAD_LABEL, type HerdrApi, type HerdrRun, type Pane, report, result, type Session, type Sleep, workspaces } from "../herdr.ts";
import type { Incoming, IntercomLike } from "./kit.ts";
import { HEAD_NEEDS_SERVICE } from "../headkey.ts";
import { localeOf } from "../towerprompt/messages.ts";
import type { Log } from "./log.ts";
import { headId, headName, type Slot } from "./record.ts";
import type { SeatVerdict } from "./typegate.ts";
import { bindDir, headDir, type ServiceRecord, writeService } from "./towerstore.ts";

// What the head tower is made of that is not the tower service's machinery (docs/specs/2026-11-04-head-tower.md, The head tower process; build step H1): its workspace, its folder, its label, and the words
// every channel gives when there can be no head tower. The service itself (the identity, the standing pane, the seat, the tokens, the close) is one of towers.ts's services, of kind `head`, so a tower
// and the head share the rules F10 pins in typegate.ts; this module only makes what the head stands in.

export { HEAD_NEEDS_SERVICE };
/** What the gate tells a sender of anything the head takes no part in; in H1 nothing reaches the head, so every message gets it. */
export const HEAD_REFUSAL = "The head tower takes only the boss's words and answers to its own asks.";
/** The head workspace's token (the head service writes it, as a tower writes `tower`) and the pane's sort key: the head workspace is first in the sidebar's net view. */
export const HEAD_TOKEN = "sb_head";
export const HEAD_ORDER = "000.0";

/** A message to the head identity that the gate does not let in: refused with a receipt, nothing queued or woken, no text in the log. */
export function refuseHead(client: IntercomLike, from: Session, message: Incoming, log: Log, now: () => number): void {
	log.line("head-refused", { from: from.id });
	client.sendMessageReceipt?.({ messageId: message.id, status: "expired", timestamp: now(), detail: HEAD_REFUSAL });
}

/** The workspace's label, only for show: `主塔台` when sb's language is Traditional Chinese (src/locale.ts: the `locale` setting, else the server's environment), else `Head tower`. */
export const headLabel = (env: NodeJS.ProcessEnv, stateDir?: string): string => (localeOf(env, stateDir) === "zh-TW" ? "主塔台" : "Head tower");
/** The head's working folder: an empty one beside the state folder and the music folder, made by the server, where no project's files are. */
export const headFolder = (env: NodeJS.ProcessEnv): string => join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "straw-boss-head");

export interface MadeHead {
	workspace: string;
	label: string;
	tab: string;
	pane: string;
	cwd: string;
}
/**
 * Makes the head workspace: `workspace create` in the head's folder without focus, the first tab labelled with the crown and its pane marked `sb_role=head` with the first sort key, then the workspace moved to the first
 * place over the socket API. The workspace token is written at once, before the move, so no reader takes the new workspace for a base while the identity registers (HH1-F002); the service writes it again
 * once the identity is registered. A move that fails is a warning (the head works in any place); a workspace that could not be marked is closed again, so a failed ask leaves no stray workspace.
 */
export async function makeHead(d: { run: HerdrRun; api: HerdrApi; env: NodeJS.ProcessEnv; log: Log; id: string; slot?: { stateDir: string } }): Promise<MadeHead> {
	const cwd = headFolder(d.env), label = headLabel(d.env, d.slot?.stateDir);
	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	chmodSync(cwd, 0o700);
	const made = await result(d.run, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
	const workspace: string = made.workspace.workspace_id, tab: string = made.tab.tab_id, pane: string = made.root_pane.pane_id;
	try {
		await d.run(["tab", "rename", tab, HEAD_LABEL]);
		await Promise.all([report(d.run, "pane", pane, { sb_role: "head", sb_order: HEAD_ORDER }), report(d.run, "workspace", workspace, { [HEAD_TOKEN]: d.id })]);
	} catch (cause) {
		await d.run(["workspace", "close", workspace]).catch(() => {});
		throw cause;
	}
	await d.api("workspace.move", { workspace_id: workspace, insert_index: 0 }).catch((cause: Error) => d.log.line("error", { code: "workspace-move", text: cause.message.slice(0, 300) }));
	return { workspace, label, tab, pane, cwd };
}

/** What `ensure` answers: the service's identity and where it stands. The tab and pane are always there, since the head's workspace is one the server made. */
export interface HeadEnsured { id: string; workspace: string; label: string; tab: string; pane: string; opened: boolean; live: boolean }
/** What a live head service shows of itself (towers.ts's `Live`, structurally); any service under a workspace id has these. */
interface HeadLive { record: ServiceRecord; seated: boolean; state: string; starting?: Promise<void> }
/** What `ensure` says when the head's tab is not found in the minute after a Herdr restart: the service stays, and nothing is made. */
export const HEAD_RESTORING = "The head tower is being restored after a Herdr restart; ask again in a moment";
/** What the head needs of the tower service's machinery (towers.ts hands it over): the head is one of its services, so the seat proof, the loss, and the adoption are the tower service's own. */
export interface HeadDeps<L extends HeadLive> {
	slot: Slot;
	run: HerdrRun;
	api: HerdrApi;
	env: NodeJS.ProcessEnv;
	log: Log;
	sleep: Sleep;
	now(): number;
	/** How long `ensure` waits for the identity to register before it answers. */
	registerMs: number;
	enabled(): boolean;
	stopped(): boolean;
	/** Starts the tower service (adopts every record); idempotent. */
	activate(): Promise<void>;
	/** The head service that stands now, if any. */
	live(): L | undefined;
	/** The service of any kind that holds this Herdr workspace id, if any (a stale tower's, when Herdr numbered a new workspace the way a lost one was). */
	holder(workspace: string): L | undefined;
	/** Whether a Herdr restart's minute is open: the head's tab may stand under other ids, or not be back yet. */
	recovering(): boolean;
	/** The head's standing pane: the recorded one, or (`fallback`, in the minute after a restart) the crown tab's only pane; `notId` is a pane already found to be a stranger's. */
	locate(l: L, fallback: boolean, notId?: string): Promise<Pane | undefined>;
	prove(l: L, pane: Pane): Promise<SeatVerdict | "unknown">;
	lose(l: L, why: string, stranger: boolean): Promise<void>;
	/** Adopts the record as a service whose pane the caller made: seated, and a shell nobody has used. */
	adopt(record: ServiceRecord): L;
	answer(l: L, opened: boolean): HeadEnsured;
}
/**
 * The head tower's `ensure`: the live service when its tab is still there, else a workspace made for it (`makeHead`) and a service of kind `head` in `head/`. It makes nothing before it is first asked for, one ask at a time,
 * and a service whose tab is gone (or whose ids name a stranger's tab) is lost first, as a tower's is, so the head is made again with its conversation, memory, asks, and chapters where they were. In the minute after a
 * Herdr restart a tab that is not found is not a tab that is gone: the crown tab is looked for under other ids, and when it is not back yet the ask fails and the service stays (HH1-F003).
 */
export function createHead<L extends HeadLive>(d: HeadDeps<L>): { ensure(): Promise<HeadEnsured> } {
	let heading: Promise<HeadEnsured> | undefined;
	const open = async (): Promise<HeadEnsured> => {
		const existing = d.live();
		if (existing) {
			const restoring = d.recovering();
			// A pane list that fails is unknown: the ask fails, the service stays.
			let here = await d.locate(existing, restoring);
			let stranger = here && !existing.seated && (await d.prove(existing, here)) === "stranger";
			if (stranger && restoring) (here = await d.locate(existing, true, here!.pane_id), stranger = false);
			if (!here && restoring) throw new Error(HEAD_RESTORING);
			if (here && !stranger) {
				if (existing.state !== "waiting") await Promise.race([existing.starting, d.sleep(d.registerMs)]);
				return d.answer(existing, false);
			}
			// No tab is no proof of whose workspace it is: an unseated service writes to it only while it still carries the label the service made.
			const foreign = stranger || (!existing.seated && (await workspaces(d.run).catch(() => [])).find((w) => w.workspace_id === existing.record.workspace)?.label !== existing.record.label);
			await d.lose(existing, stranger ? "its workspace now holds another tab under the ids it made" : "its tab is gone", Boolean(foreign));
		}
		const made = await makeHead({ ...d, id: headId(d.slot) });
		// Herdr numbers a new workspace as it numbered a lost one, so a service of another kind may still hold this id: it is a stranger's now, ended before the id is bound to head/ (HH1-F001).
		const stale = d.holder(made.workspace);
		if (stale) await d.lose(stale, "its workspace id was given to the head tower", true);
		const record: ServiceRecord = { workspace: made.workspace, label: made.label, id: headId(d.slot), name: headName(d.slot), pane: made.pane, tab: made.tab, cwd: made.cwd, created: new Date(d.now()).toISOString(), seq: 0, kind: "head" };
		bindDir(d.slot, record.workspace, headDir(d.slot));
		writeService(d.slot, record);
		const l = d.adopt(record);
		d.log.line("head-opened", { workspace: record.workspace, id: record.id, pane: record.pane, tab: record.tab });
		await Promise.race([l.starting, d.sleep(d.registerMs)]);
		return d.answer(l, true);
	};
	return {
		ensure: async () => {
			if (!d.enabled()) throw new Error(HEAD_NEEDS_SERVICE);
			if (d.stopped()) throw new Error("the sb server is stopping");
			await d.activate();
			return (heading ??= open().finally(() => (heading = undefined)));
		},
	};
}
