import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { type AgentFiles, type Held, judge, parseHeld, readRaw } from "./paths.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The pane's state file claimed: written whole to a file of its own and linked into place, so it is never seen half written and only one claimer gets it. A leftover is removed only if it is still the very one judged stale. */
export async function claim(files: AgentFiles, mine: Held, pane: string, now: () => number) {
	const tmp = `${files.state}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				linkSync(tmp, files.state);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 4) throw error;
			}
			const raw = readRaw(files), other = await judge(files, parseHeld(raw), now);
			if (other) throw new Error(`pane ${pane} is already held by a net sidecar (pid ${other.held.pid}, session ${other.held.session})`);
			if (raw !== undefined) await removeLeftover(files, raw);
		}
	} finally {
		rmSync(tmp, { force: true });
	}
}
/** Removes the state file if it still holds `raw`. Claimers take turns at this, so none removes the file another has just claimed (a lock older than 10 s was left by a process that died). */
async function removeLeftover(files: AgentFiles, raw: string) {
	const lock = `${files.state}.reap`;
	for (let wait = 0; ; wait++) {
		try {
			closeSync(openSync(lock, "wx", 0o600));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || wait > 100) throw error;
			try { if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true }); } catch { /* released meanwhile */ }
			await pause(30);
		}
	}
	try {
		if (readRaw(files) === raw) unlinkSync(files.state);
	} finally {
		rmSync(lock, { force: true });
	}
}
