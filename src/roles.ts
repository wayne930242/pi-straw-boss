import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Kit } from "./state.ts";

// What a Herdr restore cannot keep. After `herdr server stop` and a new server, Herdr resumes each pi pane into its session file, but a role lives in
// things the restore drops: STRAW_BOSS_ROLE in the pane's environment, the pane and workspace tokens, and, for a session without a conversation yet, the
// session entry pi never wrote. Each tower and main therefore records its role in the state directory, keyed by its session file (the one thing a resumed
// pane keeps, even when pi had not written it), together with the pane and tab it held. A resumed session takes the role back only in that same pane and
// tab; anywhere else, or with no record, it stays a member.
// A record is dropped when the session is closed on purpose (Closing). A /quit, a guard demotion, and a Herdr stop all look alike from inside the process, and
// a stop demotes the mains just before it ends them, so none of those drops it: a record outlives a demotion, which is why a restored main never opens its tower
// (the tower comes back with its own record, and a base without one clears its mains, guard.ts).

const KEEP_MS = 90 * 24 * 3600_000;
export interface RoleRecord { role: "tower" | "main"; pane: string; tab: string; workspace: string; at: number }

const keyOf = (file: string) => createHash("sha256").update(file).digest("hex").slice(0, 32);

/** The role records of the sessions on this machine, in `roles/` of the state directory. */
export function createRoles({ cfg, s, guiDir, tell }: Kit) {
	const dir = join(guiDir, "roles");
	const path = (file: string) => join(dir, `${keyOf(file)}.json`);
	const read = (file: string): RoleRecord | undefined => {
		let raw: string;
		try {
			raw = readFileSync(path(file), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			tell(`Straw Boss: could not read this session's role record: ${(error as Error).message}`, "warning");
			return undefined;
		}
		try {
			const r = JSON.parse(raw) as Partial<RoleRecord>;
			return (r.role === "tower" || r.role === "main") && typeof r.pane === "string" && typeof r.tab === "string" && typeof r.workspace === "string" ? (r as RoleRecord) : undefined;
		} catch {
			return undefined; // a record that cannot be read proves nothing
		}
	};
	return {
		/** The role this session recorded for the pane (and tab, once it knows its place) it is in now; undefined when it recorded none there. */
		held(pane: string | undefined, tab?: string): RoleRecord["role"] | undefined {
			const record = s.file && pane ? read(s.file) : undefined;
			return record && record.pane === pane && (tab === undefined || record.tab === tab) ? record.role : undefined;
		},
		remember(role: RoleRecord["role"]) {
			if (!s.file) return; // a session pi does not keep has nothing to resume
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				const file = path(s.file), temp = `${file}.${process.pid}.tmp`, at = cfg.now();
				writeFileSync(temp, JSON.stringify({ role, pane: s.at.paneId, tab: s.at.tabId, workspace: s.at.workspaceId, at } satisfies RoleRecord), { mode: 0o600 });
				renameSync(temp, file);
				for (const name of readdirSync(dir)) if (name.endsWith(".json") && at - statSync(join(dir, name)).mtimeMs > KEEP_MS) rmSync(join(dir, name), { force: true });
			} catch (error) {
				tell(`Straw Boss: could not record this session's role, so a Herdr restore will not bring it back: ${(error as Error).message}`, "warning");
			}
		},
		forget() {
			if (s.file) rmSync(path(s.file), { force: true });
		},
	};
}
export type Roles = ReturnType<typeof createRoles>;
