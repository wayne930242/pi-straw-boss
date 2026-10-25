import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { projectProblem } from "./routing.ts";

// What the user chose, in `<pi agent dir>/straw-boss/config.json` under `link` (docs/specs/2026-10-25-straw-link.md, Storage and policy):
//   { "link": { "relay": "https://relay.example", "teams": { "<team id, hex>": { "project": "~/projects/moldplan-center", "share": "status" } }, "trust": {…} } }
// `project` is the directory a workspace's cwd has to be inside to take the team's messages; `share` is `presence` or `status` (the default).
// `trust` is for the remote-turn gate (a later step). A team that is wrong is left out and listed in `problems`, never half used.

export type Share = "presence" | "status";
/** `name` is how the team reads in a header: the project's folder name, which this computer chose, never a name a sender gave. */
export interface TeamPolicy { project: string; share: Share; name: string }
export interface LinkConfig { relay?: string; teams: Map<string, TeamPolicy>; problems: string[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readLinkConfig(stateDir: string, { home, agentDir }: { home: string; agentDir: string }): LinkConfig {
	const out: LinkConfig = { teams: new Map(), problems: [] };
	let link: unknown;
	try {
		link = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { link?: unknown }).link;
	} catch {
		return out;
	}
	if (!isObject(link)) return out;
	if (typeof link.relay === "string") out.relay = link.relay;
	if (!isObject(link.teams)) return out;
	for (const [team, value] of Object.entries(link.teams)) {
		const bad = (reason: string) => void out.problems.push(`team ${team}: ${reason}`);
		if (!/^[0-9a-f]{32}$/.test(team)) { bad("the team id has to be 32 hex digits"); continue; }
		if (!isObject(value) || typeof value.project !== "string" || !value.project) { bad("it has no project"); continue; }
		if (value.share !== undefined && value.share !== "presence" && value.share !== "status") { bad('share has to be "presence" or "status"'); continue; }
		const project = value.project === "~" ? home : value.project.startsWith("~/") ? join(home, value.project.slice(2)) : value.project;
		const problem = projectProblem(project, { home, agentDir });
		if (problem) { bad(problem); continue; }
		const path = isAbsolute(project) ? resolve(project) : project;
		out.teams.set(team, { project: path, share: value.share ?? "status", name: basename(path) });
	}
	return out;
}
