import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { projectProblem } from "./routing.ts";

// What the user chose, in `<pi agent dir>/straw-boss/config.json` under `link` (docs/specs/2026-10-25-straw-link.md, Storage and policy):
//   { "link": { "relay": "https://relay.example", "teams": { "<team id, hex>": { "project": "~/projects/moldplan-center", "share": "status" } }, "trust": {…} } }
// `project` is the directory a workspace's cwd has to be inside to take the team's messages; `share` is `presence` or `status` (the default).
// `trust` raises named senders above `reply` for the remote-turn gate (turn.ts). A team that is wrong is left out and listed in `problems`, never half used.

export type Share = "presence" | "status";
/** `name` is how the team reads in a header: the project's folder name, which this computer chose, never a name a sender gave. */
export interface TeamPolicy { project: string; share: Share; name: string }
/** What a remote turn from a sender may do (docs/specs/2026-10-25-straw-link.md, Trust levels); a sender with no entry is at `reply`. */
export type Level = "reply" | "forward" | "dispatch";
export const LEVELS: readonly Level[] = ["reply", "forward", "dispatch"];
/**
 * The boss's delegate (docs/specs/2026-11-21-box-mac-waits.md §15, D14): a teammate device whose main decides, for the boss, the cards this device's towers would put on the boss's list; `owner` names that main (by default the
 * device's standing main). config.json's `link.delegate` on an attended device, the policy file's `delegate` on an unattended one.
 */
export interface Delegate { device: string; owner?: string }
export interface LinkConfig { relay?: string; teams: Map<string, TeamPolicy>; trust: Map<string, Level>; problems: string[]; delegate?: Delegate }

/** A `delegate` entry: `{ device: <26-character id>, owner?: <a main's name, at most 40 characters> }`; anything else is a problem and no delegate. */
export function delegateOf(raw: unknown, report: (reason: string) => void): Delegate | undefined {
	if (raw === undefined) return undefined;
	const v = raw as { device?: unknown; owner?: unknown } | null;
	if (typeof v !== "object" || v === null || Array.isArray(v) || typeof v.device !== "string" || !/^[a-z2-7]{26}$/.test(v.device)) return void report("delegate: device has to be a device id, 26 characters of a-z and 2-7");
	if (v.owner !== undefined && (typeof v.owner !== "string" || !v.owner.trim() || Array.from(v.owner).length > 40)) return void report("delegate: owner is a main's name of at most 40 characters");
	return { device: v.device, ...(typeof v.owner === "string" ? { owner: v.owner.trim() } : {}) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readLinkConfig(stateDir: string, { home, agentDir }: { home: string; agentDir: string }): LinkConfig {
	const out: LinkConfig = { teams: new Map(), trust: new Map(), problems: [] };
	let link: unknown;
	try {
		link = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { link?: unknown }).link;
	} catch {
		return out;
	}
	if (!isObject(link)) return out;
	if (typeof link.relay === "string") out.relay = link.relay;
	const delegate = delegateOf(link.delegate, (reason) => out.problems.push(reason));
	if (delegate) out.delegate = delegate;
	if (isObject(link.trust)) {
		for (const [device, level] of Object.entries(link.trust)) {
			if (!/^[a-z2-7]{26}$/.test(device)) out.problems.push(`trust ${device}: a device id is 26 characters of a-z and 2-7`);
			else if (!LEVELS.includes(level as Level)) out.problems.push(`trust ${device}: the level has to be reply, forward, or dispatch`);
			else out.trust.set(device, level as Level);
		}
	}
	if (!isObject(link.teams)) return out;
	for (const [team, policy] of parseTeams(link.teams, { home, agentDir }, (reason) => out.problems.push(reason), true)) out.teams.set(team, policy);
	return out;
}

/**
 * The teams of a `teams` object, config.json's or the policy file's: a team id of 32 hex digits, a `project` that passes `projectProblem`, a `share` of `presence` or
 * `status` (the default). A team that is wrong is left out and said through `bad`. `tilde` lets `~` and `~/…` stand for the home folder (config.json does; the policy file
 * names absolute paths only).
 */
export function parseTeams(raw: Record<string, unknown>, { home, agentDir }: { home: string; agentDir: string }, report: (reason: string) => void, tilde: boolean): Map<string, TeamPolicy> {
	const teams = new Map<string, TeamPolicy>();
	for (const [team, value] of Object.entries(raw)) {
		const bad = (reason: string) => report(`team ${team}: ${reason}`);
		if (!/^[0-9a-f]{32}$/.test(team)) { bad("the team id has to be 32 hex digits"); continue; }
		if (!isObject(value) || typeof value.project !== "string" || !value.project) { bad("it has no project"); continue; }
		if (value.share !== undefined && value.share !== "presence" && value.share !== "status") { bad('share has to be "presence" or "status"'); continue; }
		const project = !tilde ? value.project : value.project === "~" ? home : value.project.startsWith("~/") ? join(home, value.project.slice(2)) : value.project;
		const problem = projectProblem(project, { home, agentDir });
		if (problem) { bad(problem); continue; }
		const path = isAbsolute(project) ? resolve(project) : project;
		teams.set(team, { project: path, share: value.share ?? "status", name: basename(path) });
	}
	return teams;
}

/**
 * Edits the `link` section of config.json in place and leaves every other key as it was (the user's `towerModel` among them). An unreadable file
 * is never replaced: a config.json that is not a JSON object stops the edit with the reason. The caller holds the link lock, so two writers of
 * this section do not interleave; the file itself is replaced by a rename, so a reader sees the old file or the new one.
 */
export function editLinkConfig(stateDir: string, edit: (link: Record<string, unknown>) => void): void {
	let path = join(stateDir, "config.json");
	// A config.json that is a symlink (a dotfile setup) keeps being one: the file written is the one it points to.
	try { path = realpathSync(path); } catch { /* no file yet */ }
	let root: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isObject(parsed)) throw new Error("config.json is not a JSON object, so Straw Link did not change it");
		root = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof SyntaxError ? new Error(`config.json is not valid JSON (${error.message}), so Straw Link did not change it`) : error;
	}
	const link = isObject(root.link) ? root.link : {};
	edit(link);
	root.link = link;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const mode = statSync(path, { throwIfNoEntry: false })?.mode ?? 0o600, tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { mode: mode & 0o777 });
	try { chmodSync(tmp, mode & 0o777); } catch { /* a file system without modes */ }
	renameSync(tmp, path);
}
