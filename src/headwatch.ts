import type { Digest } from "./digest.ts";
import { headOf, type HerdrRun, workspaces } from "./herdr.ts";
import type { HerdrEvents } from "./server-watch.ts";

// The head tower is the tower of the first workspace in Herdr's list that is not a sub workspace, so it changes when workspaces come, go, or move. A tower
// that sees it change writes one digest line in its own workspace ("head tower is now Alpha"), which it reads at its next run (digest.ts): each tower
// notes it for itself, so every tower hears of it however it was told to coordinate before.
const HEAD_EVENTS = ["workspace.created", "workspace.closed", "workspace.moved", "workspace.reordered"];

/** Watches the head workspace from now on; the first reading is the baseline and notes nothing. Returns the stop function. */
export function watchHead({ run, events, digest, workspaceId }: { run: HerdrRun; events: HerdrEvents; digest: Digest; workspaceId: string }): () => void {
	let known: string | undefined, reading: Promise<unknown> = Promise.resolve();
	// Readings run one at a time, so two events in a row note a change once.
	const read = () => void (reading = reading.then(async () => {
		const head = headOf(await workspaces(run));
		if (!head) return;
		if (known !== undefined && known !== head.workspace_id) await digest.note(workspaceId, `head tower is now ${head.label}`);
		known = head.workspace_id;
	}).catch(() => {}));
	return events(HEAD_EVENTS, () => read());
}
