import { existsSync } from "node:fs";
import { postServer } from "./handover.ts";
import { workspaces } from "./herdr.ts";
import type { createHost } from "./host.ts";
import { listStashes, nameFor, nameOk, popBase, stashFile } from "./stash.ts";
import type { Kit } from "./state.ts";
import { trustDir } from "./trust/files.ts";

// /boss stash and /boss pop, this session's side (stash.ts holds the checks, the manifest, and the reopening). A stash runs in the sb server's GUI,
// the only one that can ask every bridge in the base whether it may be put away and then ask it to quit; this session asks the server to
// have it running (starting the server when none runs), with no browser. A pop needs no server: it runs here, from any session in Herdr.

// The checks take up to three rounds of a few seconds, then every agent has 30 s to quit.
const STASH_MS = 120_000;
// Both need the server, and start it when none runs, unless it was stopped on purpose: only /boss gui starts that one.
const STOPPED = "The straw net GUI was stopped on purpose; /boss gui starts it, then run this again";

export function createStashing({ cfg, s, guiDir, tell, me }: Kit, { host }: { host: Pick<ReturnType<typeof createHost>, "ensure" | "sessions"> }) {
	const { run, sleep } = cfg;
	return {
		names: () => listStashes(guiDir),
		/** Stashes this session's base under `name`, by default the workspace label. When this session is in it, it quits with the rest. */
		async stash(given: string | undefined) {
			if (!s.joined && !s.isTower) throw new Error("Only a session of the net stashes its base: this one has not joined");
			const ws = s.at.workspaceId, label = (await workspaces(run)).find((w) => w.workspace_id === ws)?.label ?? ws, name = given?.trim() || nameFor(label, guiDir);
			if (!nameOk(name)) throw new Error(`"${name}" cannot name a stash: at most 64 characters, no slash, backslash, or control character, not starting with a dot`);
			if (existsSync(stashFile(guiDir, name))) throw new Error(`Something is stashed as "${name}" already; pop it or pick another name`);
			const shared = await host.ensure();
			if (shared.stopped) throw new Error(STOPPED);
			const record = shared.record;
			if (!record) throw new Error(`The straw net GUI is not running: ${shared.error}`);
			tell(`Stashing ${label} as "${name}"…`);
			const reply = await postServer(record, "close/stash", { workspace: ws, name }, STASH_MS);
			if (reply.status === 200) return tell(`Stashed ${label} as "${name}" (${String(reply.body.sessions)} sessions); /boss pop ${name} brings it back`);
			const why = typeof reply.body.reason === "string" ? reply.body.reason : reply.status ? `the server answered ${reply.status}` : "the GUI server did not answer";
			tell(why, "error");
		},
		/** Quits this base's tower, mains, and members and closes it, or nothing when anything there would be lost. */
		async closeAll() {
			const shared = await host.ensure();
			if (shared.stopped) throw new Error(STOPPED);
			const record = shared.record;
			if (!record) throw new Error(`The straw net GUI is not running: ${shared.error}`);
			tell("Closing this base…");
			const reply = await postServer(record, "close/all", { by: me() }, STASH_MS * 4);
			if (reply.status === 200) return tell(`Closed ${(reply.body.closed as string[]).join(", ")}`);
			// A session still here to read this was not closed: the server went with its own base, timed out, or is down.
			if (reply.status === 0) return tell("The GUI server did not answer (it may have closed with its own base); check what is still open", "warning");
			tell(String(reply.body.reason ?? `the server answered ${reply.status}`), "error");
		},
		/** Pops `given`; with no name, the only stash, or the one picked from the list. */
		async pop(given: string | undefined) {
			const names = listStashes(guiDir);
			if (!names.length) return tell("Nothing is stashed");
			const name = given?.trim() || (names.length === 1 ? names[0] : await s.ui?.select("Pop which stash?", names));
			if (!name) return;
			tell(`Opening "${name}"…`);
			const live = async (id: string) => (await host.sessions()).some((x) => x.id === id);
			const r = await popBase({ run, sleep, stateDir: guiDir, live, agentDir: cfg.env.PI_CODING_AGENT_DIR, trustDir: trustDir(guiDir) }, name);
			tell(`Popped "${name}": ${r.sessions} sessions are back in ${r.label}`);
		},
	};
}
