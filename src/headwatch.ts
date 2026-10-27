import type { Digest } from "./digest.ts";
import { headOf, type HerdrRun, workspaces } from "./herdr.ts";
import type { HerdrEvents } from "./server-watch.ts";

// The head tower is the tower of the first workspace in Herdr's list that is not a sub workspace, so it changes when workspaces come, go, or move. A tower
// that sees it change writes one digest line in its own workspace ("head tower is now Alpha"), which it reads at its next run (digest.ts): each tower
// notes it for itself, so every tower hears of it however it was told to coordinate before.
const HEAD_EVENTS = ["workspace.created", "workspace.closed", "workspace.moved", "workspace.reordered"];

/**
 * The reading behind a head watch: a function to call whenever the workspaces may have changed. The first reading is the baseline and notes nothing; a change is noted in each of
 * `workspaces()`, which is read at the change (the sb server stands in for every tower on one events connection). Readings run one at a time, so two events in a row note a change once.
 */
export function headReader({ run, digest, workspaces: watching }: { run: HerdrRun; digest: Digest; workspaces(): string[] }): () => void {
	let known: string | undefined, reading: Promise<unknown> = Promise.resolve();
	return () => void (reading = reading.then(async () => {
		const head = headOf(await workspaces(run));
		if (!head) return;
		if (known !== undefined && known !== head.workspace_id) for (const workspaceId of watching()) await digest.note(workspaceId, `head tower is now ${head.label}`).catch(() => {});
		known = head.workspace_id;
	}).catch(() => {}));
}

/** Watches the head workspace from now on, for the workspaces `workspaces()` names. Returns the stop function. */
export function watchHeads({ events, ...rest }: { run: HerdrRun; events: HerdrEvents; digest: Digest; workspaces(): string[] }): () => void {
	const read = headReader(rest);
	return events(HEAD_EVENTS, () => read());
}

/** Watches the head workspace for one tower: a change is noted in its workspace. */
export const watchHead = ({ workspaceId, ...rest }: { run: HerdrRun; events: HerdrEvents; digest: Digest; workspaceId: string }) => watchHeads({ ...rest, workspaces: () => [workspaceId] });
