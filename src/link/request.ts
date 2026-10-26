import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Done, Fail, TeamAdmin, TeamView } from "./admin.ts";
import { LEVELS, type Level, type Share } from "./config.ts";
import { idOk, labelOk, shortId } from "./device.ts";
import { decodeInvite, originOf } from "./join.ts";
import { projectProblem } from "./routing.ts";

// `link_request` (docs/specs/2026-10-25-straw-link.md, GUI, Link actions an agent asks for): an agent may ask for a link action, and the boss approves
// each request. This module is the link holder's half: it checks a request, says in words what it would do (the approval dialog shows these lines, never
// the agent's own description), remembers it for ten minutes, and carries it out when the session that asked comes back with the boss's approval. The
// holder alone does the action; the requesting session never touches the keys or the team files. There is no path that runs an action without the
// session's request id, and an id is used once.

export const ACTIONS = ["create", "invite", "invite-unattended", "join", "trust", "leave", "remove", "role", "rotate"] as const;
export type Action = (typeof ACTIONS)[number];
/** The arguments an agent may pass; each action takes the ones it names and refuses the rest. */
/** C0 and C1 control characters, the Unicode line and paragraph separators, and the bidi marks and overrides: a line break, an escape, or a reordering in an argument could add lines to the approval dialog or disguise them. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** The agent's reason as one line: every run of whitespace, control characters, and bidi marks becomes one space. */
const oneLine = (s: string) => s.replace(/[\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").trim();
export interface RequestArgs { team?: string; relay?: string; project?: string; share?: string; device?: string; level?: string; role?: string; text?: string; label?: string }
const FIELDS: Record<Action, (keyof RequestArgs)[]> = {
	create: ["relay", "project", "share", "label"],
	invite: ["team"],
	"invite-unattended": ["team", "device"],
	join: ["text", "label", "project", "share"],
	trust: ["device", "level"],
	leave: ["team"],
	remove: ["team", "device"],
	role: ["team", "device", "role"],
	rotate: ["team"],
};
const REQUIRED: Record<Action, (keyof RequestArgs)[]> = {
	create: ["relay", "project"], invite: ["team"], "invite-unattended": ["team", "device"], join: ["text"], trust: ["device", "level"], leave: ["team"], remove: ["team", "device"], role: ["team", "device", "role"], rotate: ["team"],
};
/** Actions whose approval only this computer may give (the boss: "高風險動作只能在本機核准"): a paired device sees the dialog and can deny, not approve. Every other action is approvable from a paired device. */
export const HERE_ONLY: readonly Action[] = ["trust", "remove", "role", "rotate", "leave"];
/** Actions only an admin of the team may do. */
const ADMIN: Action[] = ["remove", "role", "rotate"];
export const REQUEST_MS = 10 * 60_000;
const MAX_PENDING = 20;

interface Pending { id: string; session: string; action: Action; args: RequestArgs; reason: string; team?: string; device?: string; at: number }

const no = (error: string): Fail => ({ ok: false, error });
const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Whether an action and its arguments are well formed (the holder checks the rest against the teams it has). */
export function shapeProblem(action: unknown, args: unknown): string | undefined {
	if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return `An action is one of ${ACTIONS.join(", ")}`;
	const a = (typeof args === "object" && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
	const allowed = FIELDS[action as Action];
	for (const key of Object.keys(a)) if (!(allowed as string[]).includes(key)) return `${action} takes ${allowed.join(", ")}, not ${key}`;
	for (const key of Object.keys(a)) if (typeof a[key] !== "string") return `${key} has to be text`;
	// The dialog shows relay, project, and label as given, so those are tested whole (a leading or trailing line break counts); an invite's text is never shown, and a pasted one may end in a newline.
	for (const key of ["relay", "project", "label"]) if (typeof a[key] === "string" && CONTROL.test(a[key] as string)) return `${key} may not contain line breaks or other control characters`;
	if (typeof a.text === "string" && CONTROL.test(a.text.trim())) return "text may not contain line breaks or other control characters";
	for (const key of REQUIRED[action as Action]) if (!a[key] || !String(a[key]).trim()) return `${action} needs ${key}`;
	return undefined;
}

export interface RequestDeps {
	admin: TeamAdmin;
	teams(): TeamView[];
	now(): number;
	/** Whether this computer is an attended device: `link_request` is refused on any other. */
	attended(): boolean;
	home: string;
	agentDir: string;
}

export class Requests {
	private readonly d: RequestDeps;
	private pending = new Map<string, Pending>();

	constructor(d: RequestDeps) {
		this.d = d;
	}

	private team(query: string | undefined): TeamView | Fail {
		const q = (query ?? "").trim().toLowerCase(), teams = this.d.teams();
		const hit = teams.filter((t) => t.team === q || (q.length >= 6 && t.team.startsWith(q)) || t.name.toLowerCase() === q);
		if (hit.length === 1) return hit[0]!;
		return no(hit.length > 1 ? `"${query}" fits ${hit.length} teams (${hit.map((t) => `${t.name} ${t.team.slice(0, 6)}`).join(", ")}); name one by its id` : `No team "${query}" on this computer. Teams: ${teams.map((t) => `${t.name} ${t.team.slice(0, 6)}`).join(", ") || "none"}`);
	}
	private device(team: TeamView, query: string | undefined): { id: string; label: string } | Fail {
		const q = (query ?? "").trim(), id = q.toLowerCase();
		const hit = team.members.filter((m) => m.id === id || m.short === id || m.label === q);
		if (hit.length === 1) return hit[0]!;
		return no(hit.length > 1 ? `"${q}" fits ${hit.length} devices: ${hit.map((m) => `${m.label} (${m.short})`).join(", ")}. Name one by its short id` : `No device "${q}" in team ${team.name}`);
	}

	/** Checks a request and remembers it; the lines are what the boss is shown. */
	open(session: string, action: unknown, raw: unknown, reason: string): Done<{ id: string; lines: string[]; reason: string }> {
		if (!this.d.attended()) return no("link_request is refused on an unattended device: its teams and trust come from its infra's policy file and join.txt only");
		const bad = shapeProblem(action, raw);
		if (bad) return no(bad);
		const act = action as Action, args = raw as RequestArgs ?? {};
		if ((act === "create" || act === "join") && args.label !== undefined && !labelOk(args.label)) return no("A label is 1 to 40 letters, digits, spaces, and . _ - with no space at either end");
		const now = this.d.now();
		for (const [id, p] of this.pending) if (now - p.at > REQUEST_MS) this.pending.delete(id);
		if (this.pending.size >= MAX_PENDING) return no("Too many link requests wait for the boss; try again after they are answered");
		const lines: string[] = [`Action: ${act}`];
		const p: Pending = { id: randomUUID(), session, action: act, args, reason: clip(oneLine(reason) || "(none given)", 400), at: now };
		switch (act) {
			case "create": {
				const share = args.share;
				const origin = originOf(args.relay!.trim());
				if (!origin) return no("The relay has to be an https origin like https://relay.example, without a path (http only for this computer)");
				args.relay = origin;
				if (!isAbsolute(args.project!)) return no("The project has to be an absolute folder path");
				const problem = projectProblem(args.project!, { home: this.d.home, agentDir: this.d.agentDir });
				if (problem) return no(problem);
				if (share !== undefined && share !== "presence" && share !== "status") return no('share is "presence" or "status"');
				lines.push(`Relay: ${args.relay}`, `Project folder: ${args.project}`, `Share: ${share ?? "status"}`, ...(args.label ? [`Label of this computer: ${args.label}`] : []), "Approving opens the Create team screen with these filled in; you type the relay's team token there, so the agent never sees it.");
				break;
			}
			case "join": {
				const invite = decodeInvite(args.text!);
				if (!invite) return no("That is not a Straw Link invite: it starts with strawlink1:");
				if (args.project) {
					const problem = projectProblem(args.project, { home: this.d.home, agentDir: this.d.agentDir });
					if (problem) return no(problem);
				}
				if (args.share !== undefined && args.share !== "presence" && args.share !== "status") return no('share is "presence" or "status"');
				lines.push(`Relay: ${invite.relay}`, `Invited by device: ${shortId(invite.inviterId)}`, ...(invite.forDevice ? [`Pinned to device: ${shortId(invite.forDevice)}`] : []), ...(args.label ? [`Label of this computer: ${args.label}`] : []), ...(args.project ? [`Project folder: ${args.project}`] : []), ...(args.share ? [`Share: ${args.share}`] : []), "Approving only opens the Join screen with the invite filled in; the safety words are still compared by you.");
				break;
			}
			case "trust": {
				const id = (args.device ?? "").trim().toLowerCase();
				if (!LEVELS.includes(args.level as Level)) return no("A trust level is reply, forward, or dispatch");
				const found = this.d.teams().flatMap((t) => t.members.filter((m) => m.id === id || m.short === id || m.label === args.device!.trim()).map((m) => ({ ...m, team: t.name })));
				const unique = [...new Map(found.map((m) => [m.id, m])).values()];
				if (unique.length !== 1) return no(unique.length ? `"${args.device}" fits ${unique.length} devices; name one by its id` : `No device "${args.device}" in this computer's teams`);
				if (unique[0]!.self) return no("Trust names other devices");
				p.device = unique[0]!.id;
				lines.push(`Device: ${unique[0]!.label} (${unique[0]!.short}) of team ${unique[0]!.team}`, `Trust level: ${args.level}`, "Raises what a remote turn from that device may do on this computer.");
				break;
			}
			default: {
				const team = this.team(args.team);
				if ("ok" in team) return team;
				p.team = team.team;
				lines.push(`Team: ${team.name} (${team.team.slice(0, 6)})`, `Relay: ${team.relay}`, `Project folder: ${team.project}`);
				if (ADMIN.includes(act) && team.self.role !== "admin") return no(`This device is not an admin of ${team.name}, so it cannot ${act}`);
				if (act === "invite") lines.push("Returns an invite that lapses after 10 minutes; whoever holds it and is shown its words can ask to join.");
				if (act === "invite-unattended" || act === "remove" || act === "role") {
					const dev = act === "invite-unattended" ? undefined : this.device(team, args.device);
					if (dev && "ok" in dev) return dev;
					if (act === "invite-unattended") {
						const id = (args.device ?? "").trim().toLowerCase();
						if (!idOk(id)) return no("A device id is 26 characters (a to z, 2 to 7), the one in the unattended device's link/device.id");
						p.device = id;
						lines.push(`Device id: ${id}`, "Returns an invite pinned to that device for up to 24 hours.");
					} else {
						p.device = (dev as { id: string }).id;
						lines.push(`Device: ${(dev as { label: string }).label} (${shortId(p.device)})`);
						if (act === "role") {
							if (args.role !== "admin" && args.role !== "member") return no("A role is admin or member");
							lines.push(`New role: ${args.role}`);
						} else lines.push("The device is banned from the team and the key is rotated.");
					}
				}
				if (act === "rotate") lines.push("Every other device gets a new team key.");
				if (act === "leave") lines.push("This computer forgets the team (its team file and config entry). The roster at the relay is untouched; an admin removes this device.");
			}
		}
		this.pending.set(p.id, p);
		return { ok: true, id: p.id, lines, reason: p.reason };
	}

	/** The boss approved: the holder does the action. The id works once, only for the session that asked, and only within ten minutes. */
	async run(id: string, session: string): Promise<Done<{ text: string }>> {
		const p = this.pending.get(id);
		if (!p || p.session !== session) return no("That request is unknown, was answered, or belongs to another session");
		this.pending.delete(id);
		if (this.d.now() - p.at > REQUEST_MS) return no("That request timed out and was refused");
		if (!this.d.attended()) return no("link_request is refused on an unattended device");
		const a = p.args, admin = this.d.admin;
		const fail = (r: Done) => (r.ok ? undefined : r.error);
		switch (p.action) {
			case "create":
				admin.setPrefill({ kind: "create", relay: a.relay!.trim(), project: a.project!, ...(a.label ? { label: a.label } : {}), ...(a.share ? { share: a.share as Share } : {}), reason: p.reason, session });
				return { ok: true, text: "The Create team screen is open in the boss's GUI with the relay and project filled in. The boss types the relay's team token there; nothing is created until then." };
			case "join":
				admin.setPrefill({ kind: "join", text: a.text!.trim(), ...(a.project ? { project: a.project } : {}), ...(a.label ? { label: a.label } : {}), ...(a.share ? { share: a.share as Share } : {}), reason: p.reason, session });
				return { ok: true, text: "The Join screen is open in the boss's GUI with the invite filled in. The boss compares the safety words there; nothing is joined until then." };
			case "invite": case "invite-unattended": {
				const made = await admin.invite({ team: p.team!, ...(p.action === "invite-unattended" ? { forDevice: p.device! } : {}) });
				return made.ok ? { ok: true, text: `Invite (valid until ${new Date(made.expires).toISOString()}): ${made.text}` } : made;
			}
			case "trust": {
				const done = await admin.trust({ device: p.device!, level: a.level as Level });
				return fail(done) ? done as Fail : { ok: true, text: `Trust for that device is now ${a.level}.` };
			}
			case "leave": {
				const done = await admin.leave({ team: p.team! });
				return fail(done) ? done as Fail : { ok: true, text: "This computer left the team." };
			}
			case "remove": {
				const done = await admin.remove({ team: p.team!, device: p.device! });
				return fail(done) ? done as Fail : { ok: true, text: "The device was removed and the key rotated." };
			}
			case "role": {
				const done = await admin.role({ team: p.team!, device: p.device!, role: a.role as "admin" | "member" });
				return fail(done) ? done as Fail : { ok: true, text: `The role is now ${a.role}.` };
			}
			case "rotate": {
				const done = await admin.rotate({ team: p.team! });
				return fail(done) ? done as Fail : { ok: true, text: "The team key was rotated." };
			}
		}
	}

	/** The boss denied, or nobody answered in time: the request is gone. */
	drop(id: string, session: string): void {
		if (this.pending.get(id)?.session === session) this.pending.delete(id);
	}
}
