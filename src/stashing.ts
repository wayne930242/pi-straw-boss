import { existsSync } from "node:fs";
import { postServer, readRecord } from "./handover.ts";
import { workspaces } from "./herdr.ts";
import type { createHost } from "./host.ts";
import { listStashes, nameOk, popBase, stashFile } from "./stash.ts";
import type { Kit } from "./state.ts";

// /boss stash and /boss pop, this session's side (stash.ts holds the checks, the manifest, and the reopening). A stash runs in the session
// that holds the GUI server, the only one that can ask every bridge in the base whether it may be put away and then ask it to quit; this
// session starts that server when none runs, with no browser. A pop needs no server: it runs here, from any session in Herdr.

// The checks take up to three rounds of a few seconds, then every agent has 30 s to quit.
const STASH_MS = 120_000;

export function createStashing({ cfg, s, guiDir, tell }: Kit, { host }: { host: Pick<ReturnType<typeof createHost>, "share" | "sessions"> }) {
	const { run, sleep } = cfg;
	return {
		names: () => listStashes(guiDir),
		/** Stashes this session's base under `name`, by default the workspace label. When this session is in it, it quits with the rest. */
		async stash(given: string | undefined) {
			if (!s.joined && !s.isTower) throw new Error("Only a session of the net stashes its base: this one has not joined");
			const ws = s.at.workspaceId, label = (await workspaces(run)).find((w) => w.workspace_id === ws)?.label ?? ws, name = given?.trim() || label;
			if (!nameOk(name)) throw new Error(`"${name}" cannot name a stash: at most 64 characters, no slash, backslash, or control character, not starting with a dot`);
			if (existsSync(stashFile(guiDir, name))) throw new Error(`Something is stashed as "${name}" already; pop it or pick another name`);
			const shared = await host.share();
			const record = readRecord(guiDir);
			if (shared.stale || !record) throw new Error(`The straw net GUI runs in session ${shared.owner} on a version that cannot stash; /reload that session first`);
			tell(`Stashing ${label} as "${name}"…`);
			const reply = await postServer(record, "close/stash", { workspace: ws, name }, STASH_MS);
			if (reply.status === 200) return tell(`Stashed ${label} as "${name}" (${String(reply.body.sessions)} sessions); /boss pop ${name} brings it back`);
			const why = typeof reply.body.reason === "string" ? reply.body.reason : reply.status ? `the server answered ${reply.status}` : "the GUI server did not answer";
			tell(reply.status === 404 && reply.body.error === "not_found" ? `The GUI server cannot stash yet (an older pi-straw-boss in session ${shared.owner}); /reload it first` : why, "error");
		},
		/** Pops `given`; with no name, the only stash, or the one picked from the list. */
		async pop(given: string | undefined) {
			const names = listStashes(guiDir);
			if (!names.length) return tell("Nothing is stashed");
			const name = given?.trim() || (names.length === 1 ? names[0] : await s.ui?.select("Pop which stash?", names));
			if (!name) return;
			tell(`Opening "${name}"…`);
			const live = async (id: string) => (await host.sessions()).some((x) => x.id === id);
			const r = await popBase({ run, sleep, stateDir: guiDir, live, agentDir: cfg.env.PI_CODING_AGENT_DIR }, name);
			tell(`Popped "${name}": ${r.sessions} sessions are back in ${r.label}`);
		},
	};
}
