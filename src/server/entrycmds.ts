import { type HerdrRun, isHead, isSub, parentOf, workspaces } from "../herdr.ts";
import type { Towers } from "./towers.ts";

// The boss's entry under headless runs (docs/specs/2026-11-23-f-entry.md, kept to the boss's minimum): `@<workspace>` from the head's viewer or a workspace viewer goes straight to that tower as his words, `/stop`
// aborts a run's turn, a run's dialog is answered from a viewer, and `prompt-poll` carries the live transcript. All of them are the boss's commands on the control socket: a run token is refused them (rungate.ts,
// the default), and none exists with `towerRuns.headless` off, so that switch off is 0.84.0's behavior.

type Reply = Record<string, unknown> & { ok: boolean };
const OFF = "this needs headless tower runs (towerRuns.headless in config.json)";
const text = (value: unknown, max = 300) => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);

/** Resolves the `to` of a direct line as `/boss tower -w` resolves a workspace: an id or an exact label; a label two workspaces share, the head's workspace, and a token that names none are refused; a sub workspace goes to its parent. */
export async function resolveTo(run: HerdrRun, to: string): Promise<{ workspace: string; label: string }> {
	const all = await workspaces(run);
	const byId = all.find((w) => w.workspace_id === to), byLabel = all.filter((w) => w.label === to);
	if (!byId && byLabel.length > 1) throw new Error(`Several workspaces are labelled "${to}": ${byLabel.map((w) => w.workspace_id).join(", ")}; name one by its id`);
	const asked = byId ?? byLabel[0];
	if (!asked) throw new Error(`No workspace matches "${to}"`);
	const target = isSub(asked) ? parentOf(all, asked) : asked;
	if (!target) throw new Error(`${asked.label} is a sub workspace with no open parent workspace, so it has no tower`);
	if (isHead(target)) throw new Error("That is the head tower's own workspace: write to the head without @");
	return { workspace: target.workspace_id, label: target.label };
}

/** The entry's commands, or undefined for any other. `door`: the line was typed at a viewer on this computer. */
export function entryReply(towers: Towers | undefined, run: HerdrRun, request: Record<string, unknown> & { cmd: string }): Promise<Reply> | undefined {
	const cmd = request.cmd;
	const direct = cmd === "head-event" && request.to !== undefined;
	if (cmd !== "run-abort" && cmd !== "run-dialog" && !direct) return undefined;
	const go = async (work: (t: Towers) => Promise<Record<string, unknown>>): Promise<Reply> => {
		if (!towers) return { ok: false, error: "the server is still starting" };
		if (!towers.runs.headless()) return { ok: false, error: OFF };
		try {
			return { ok: true, ...(await work(towers)) };
		} catch (cause) {
			return { ok: false, error: (cause as Error).message };
		}
	};
	if (cmd === "run-abort") {
		const workspace = text(request.workspace);
		return workspace ? go(async (t) => ({ aborted: t.runs.abort(workspace) })) : Promise.resolve({ ok: false, error: "run-abort needs a workspace" });
	}
	if (cmd === "run-dialog") {
		const key = text(request.key, 200);
		if (!key) return Promise.resolve({ ok: false, error: "run-dialog needs the dialog's key" });
		return go(async (t) => {
			const answered = t.runs.kids()?.answer(key, { ...(typeof request.value === "string" ? { value: request.value } : {}), ...(typeof request.confirmed === "boolean" ? { confirmed: request.confirmed } : {}), ...(request.cancelled === true ? { cancelled: true } : {}) }) ?? false;
			if (!answered) throw new Error("That dialog is not waiting any more (it was answered, cancelled, or its run ended), or the answer is not one it takes (a select takes one of its options, an approval a yes or a no)");
			return { answered };
		});
	}
	const to = text(request.to), body = text(request.text, 16_384);
	if (!to || !body) return Promise.resolve({ ok: false, error: "a direct line needs `to` and text" });
	return go((t) => directLine(t, run, to, body, bossDoor(request.door)));
}

/** Where the boss's line was written: a viewer on this computer (`viewer`), this computer's page (`page`), or, with headless runs off, the standing pane's prompt (`pane`, 0.84.0's word, kept as it is). Anything else carries none. */
export type Door = "pane" | "viewer" | "page";
export const bossDoor = (door: unknown): Door | undefined => (door === "viewer" || door === "pane" || door === "page" ? door : undefined);

/**
 * `@<workspace>`: the boss's words straight to that tower, exactly as `/boss tower -w` sends them (docs/specs/2026-11-23-f-entry.md §2.4): the head's queue, its asks, and its model see nothing of it. The service is ensured
 * with no tab, and the head's viewer follows the tower's run. The viewer, the head page's composer, and a paired device's head composer all come here.
 */
export async function directLine(t: Towers, run: HerdrRun, to: string, body: string, door?: Door): Promise<{ queued: string; workspace: string; label: string }> {
	const target = await resolveTo(run, to);
	await t.ensure({ workspace: target.workspace });
	const queued = t.runs.boss(target.workspace, body, "the boss", { present: true, ...(door ? { door } : {}) }).id;
	const head = t.head.status()?.workspace;
	if (head) t.runs.kids()?.follow(target.workspace, target.label, head);
	return { queued, workspace: target.workspace, label: target.label };
}

/** `prompt-poll` under headless runs: the transcript lines after the viewer's cursor, and the dialogs its runs wait on. Unchanged with the switch off. */
export function withLines<T extends object>(towers: Towers, workspace: string, cursor: unknown, reply: T): T {
	const kids = towers.runs.headless() ? towers.runs.kids() : undefined;
	if (!kids || (reply as { ok?: unknown }).ok !== true) return reply;
	const got = kids.ring(workspace).since(typeof cursor === "number" && Number.isInteger(cursor) ? cursor : undefined);
	// The head's viewer lists every run's dialogs (its own first); a workspace's viewer its own (docs/specs/2026-11-23-f-entry.md §2.6).
	const head = towers.head.status()?.workspace === workspace;
	const dialogs = kids.dialogs(head ? undefined : workspace).sort((a, b) => Number(b.workspace === workspace) - Number(a.workspace === workspace)).map((d) => ({ key: d.key, method: d.method, title: d.title, ...(d.message ? { message: d.message } : {}), ...(d.options ? { options: d.options } : {}) }));
	// The head's viewer: the other towers' open cards, so its card view reads them again when one comes or goes (docs/specs/2026-11-23-f-entry.md §2.6).
	let elsewhere: string[] = [];
	if (head) try { elsewhere = towers.waitList(undefined, workspace).towers.filter((t) => !t.own).flatMap((t) => t.waits.filter((r) => r.state === "open").map((r) => `${t.workspace}:${r.id}`)); } catch { /* a memory that cannot be read lists nothing */ }
	return { ...reply, lines: got.lines, cursor: got.cursor, ...(dialogs.length ? { dialogs } : {}), ...(elsewhere.length ? { elsewhere } : {}) };
}
