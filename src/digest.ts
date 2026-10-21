import type { HerdrRun } from "./herdr.ts";
import { workspaces } from "./herdr.ts";

// The tower's digest: one line per thing that happened in its workspace (a session joined, a subagent started, a session renamed), kept
// in Herdr as workspace tokens, so it lives as long as the workspace and needs no file. Herdr holds at most 32 tokens on a workspace and
// changes at most 16 per report, and cuts a value to 80 characters: one token per line, at most KEEP of them, the oldest dropped first.

const PREFIX = "sbd_";
const SOURCE = "straw-boss-digest"; // its own source: Straw Boss's other tokens carry a TTL, these wait for the tower however long it is idle
const KEEP = 20;
const WIDTH = 80;
const BATCH = 16;

const report = (run: HerdrRun, workspaceId: string, flags: string[]) => run(["workspace", "report-metadata", workspaceId, "--source", SOURCE, ...flags]);
const entries = async (run: HerdrRun, workspaceId: string) => {
	const tokens = (await workspaces(run)).find((w) => w.workspace_id === workspaceId)?.tokens ?? {};
	return Object.entries(tokens).filter(([key]) => key.startsWith(PREFIX)).sort(([a], [b]) => (a < b ? -1 : 1));
};

export function createDigest(run: HerdrRun, now: () => number) {
	let seq = 0;
	return {
		/** Adds one line, stamped with the local time, dropping the oldest lines past KEEP in the same report. */
		async note(workspaceId: string, text: string) {
			const at = new Date(now());
			const line = Array.from(`${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")} ${text.replace(/\s+/g, " ").trim()}`).slice(0, WIDTH).join("");
			const key = `${PREFIX}${now().toString(36).padStart(9, "0")}${process.pid.toString(36)}${(seq++ % 36).toString(36)}`;
			const old = await entries(run, workspaceId);
			const drop = old.slice(0, Math.min(BATCH - 1, Math.max(0, old.length - (KEEP - 1)))).flatMap(([k]) => ["--clear-token", k]);
			await report(run, workspaceId, [...drop, "--token", `${key}=${line}`]);
		},
		/** Returns the lines, oldest first, and clears them: the tower reads each one once. */
		async take(workspaceId: string) {
			const found = await entries(run, workspaceId);
			// A batch that fails to clear is read again next time, never lost: the lines already read are returned all the same.
			for (let i = 0; i < found.length; i += BATCH) await report(run, workspaceId, found.slice(i, i + BATCH).flatMap(([k]) => ["--clear-token", k])).catch(() => {});
			return found.map(([, line]) => line);
		},
	};
}
export type Digest = ReturnType<typeof createDigest>;
