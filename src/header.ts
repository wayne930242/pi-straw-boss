// The line that opens every message Straw Boss sends through intercom for a session (call_tower, boss_broadcast, tower_send, a handoff). The code
// writes it, never the model, so a receiver can tell from the line alone who sent the message and in what role, what kind of message it is, who else
// got it, and whether the sender waits for a reply. It has the shape of the line a net sidecar types before a message (src/agent/sidecar.ts), with the
// sender's own fields added:
//   [straw net from=<name> id=<session id> role=<tower|main|member|session> [head=yes] workspace=<label> kind=<kind> scope=<scope> to=<recipients> reply=<expected|none> [why=<why>]] <message>
// A message that came over Straw Link adds the verified sender after the workspace (docs/specs/2026-10-25-straw-link.md, Header):
//   … workspace=<label> remote=<device label> device=<short id> team=<team> verified=yes kind=tower_send …
// The sidecar puts its own line, with the role Herdr's tokens give the sender, before this one; the two are not merged.

import { restrictLabel } from "./link/text.ts";

export type Kind = "call_tower" | "broadcast" | "tower_send" | "tower_reply" | "handoff" | "link_reply";
/** `session` is a pi session that did not join the net (a scope `all` broadcast reaches it). `head`: the tower of the head workspace. */
export interface Party { name: string; id: string; role: "tower" | "main" | "member" | "session"; head?: boolean; workspace?: string }
/** Why a main calls the tower (D19): a finished milestone, before it touches something shared, or blocked. `unspecified` is a caller that gave none. The code writes it from this set, so the tower reads the reason from the line, not from the message. */
export const WHYS = ["milestone", "shared", "blocked"] as const;
export type Why = (typeof WHYS)[number] | "unspecified";
const WHY = new Set<string>([...WHYS, "unspecified"]);
/** The tower identity a `link_reply` was asked through (`for=`), written by the code from the ask the server recorded. */
const FOR = /^[A-Za-z0-9_.:-]{1,80}$/;
/** The verified sender of a message that came over Straw Link: its device label and short id from the roster, and the team. */
export interface Remote { device: string; short: string; team: string }
/** `origin`: `remote:<device id>` on a message a tower sent to a local session during a Straw Link remote turn, so its receiver knows a peer's text started it. */
export interface Stamp { from: Party; kind: Kind; scope: string; to: Party[]; reply: boolean; remote?: Remote; origin?: string; /** The ask id the message carries (a `tower` with `awaitsReply`): an ally run answers it with `inReplyTo`. */ asks?: string; /** A `link_reply` for a main: the tower identity that asked on its behalf. */ for?: string; /** A `call_tower`: why the main calls. */ why?: Why }
const ORIGIN = /^remote:[a-z2-7]{26}$/;
/** A remote sender's `id=`: never a session id of this machine, so a reply cannot be aimed at a local session by a remote's choice. */
export const REMOTE_ID = /^link:[a-z2-7]{26}$/;

/** Control characters and runs of whitespace become one space, so a name cannot start a second line or a second field. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
const quote = (value: string) => (/[\s"\]=;]/.test(clean(value)) ? `"${clean(value).replace(/"/g, "'")}"` : clean(value));
const roleOf = (p: Party) => (p.head ? "head tower" : p.role);
/** A header names at most this many recipients, then how many more there are (a scope `all` broadcast can reach every session on the machine). */
const MAX_NAMED = 20;
const recipient = (p: Party) => `${clean(p.name)} (${roleOf(p)}${p.workspace ? ` of ${clean(p.workspace)}` : ""})`;

export function header({ from, kind, scope, to, reply, remote, origin, asks, for: asked, why }: Stamp): string {
	if (why !== undefined && !WHY.has(why)) throw new Error("why is milestone, shared, blocked, or unspecified");
	if (asked !== undefined && !FOR.test(asked)) throw new Error("A link_reply names the tower that asked by its identity");
	if (origin !== undefined && !ORIGIN.test(origin)) throw new Error("A remote origin is remote: and a link device id");
	if (asks !== undefined && !/^[0-9a-f]{32}$/.test(asks)) throw new Error("An ask id is 16 random bytes in hex");
	// A remote header's sender-controlled fields are cut to the label character set and 40 characters here as well as where the link code builds them; the team is this computer's own name for it, so it keeps its characters (80 at most).
	if (remote && (!REMOTE_ID.test(from.id) || !/^[a-z2-7]{6}$/.test(remote.short))) throw new Error("A remote header needs a link device id and a short id");
	const text = (value: string) => (remote ? restrictLabel(value) : value);
	const fields = [
		`from=${quote(text(from.name || from.id))}`, `id=${quote(from.id)}`, `role=${from.role}`, ...(from.head ? ["head=yes"] : []),
		...(from.workspace ? [`workspace=${quote(text(from.workspace))}`] : []),
		...(remote ? [`remote=${quote(restrictLabel(remote.device))}`, `device=${remote.short}`, `team=${quote(clean(remote.team).slice(0, 80))}`, "verified=yes"] : []),
		`kind=${kind}`, `scope=${scope}`, `to=${quote([...to.slice(0, MAX_NAMED).map(recipient), ...(to.length > MAX_NAMED ? [`+${to.length - MAX_NAMED} more`] : [])].join("; "))}`, `reply=${reply ? "expected" : "none"}`,
		...(why ? [`why=${why}`] : []),
		...(origin ? [`origin=${origin}`] : []),
		...(asks ? [`asks=${asks}`] : []),
		...(asked ? [`for=${asked}`] : []),
	];
	return `[straw net ${fields.join(" ")}]`;
}

/** The message under its header. */
export const stamp = (s: Stamp, message: string) => `${header(s)} ${message}`;

/**
 * The fields of the header at the very start of a message, or undefined when the message does not open with one. A quoted value keeps its spaces, `=`, and `]`, so a name that spells out
 * `why=blocked` stays inside its own field; the text under the header is never read.
 */
export function fieldsOf(message: string): Record<string, string> | undefined {
	const open = "[straw net ";
	if (!message.startsWith(open)) return undefined;
	const fields: Record<string, string> = {};
	let i = open.length;
	for (;;) {
		while (message[i] === " ") i++;
		if (message[i] === "]") return fields;
		const key = /^[a-z_]+=/.exec(message.slice(i, i + 40))?.[0];
		if (!key) return undefined;
		i += key.length;
		let value: string;
		if (message[i] === '"') {
			const end = message.indexOf('"', i + 1);
			if (end < 0) return undefined;
			value = message.slice(i + 1, end);
			i = end + 1;
		} else {
			const end = /[\s\]"]/.exec(message.slice(i))?.index;
			if (end === undefined) return undefined;
			value = message.slice(i, i + end);
			i += end;
		}
		fields[key.slice(0, -1)] ??= value;
	}
}
