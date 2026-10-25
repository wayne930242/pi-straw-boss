// The line that opens every message Straw Boss sends through intercom for a session (call_tower, boss_broadcast, tower_send, a handoff). The code
// writes it, never the model, so a receiver can tell from the line alone who sent the message and in what role, what kind of message it is, who else
// got it, and whether the sender waits for a reply. It has the shape of the line a net sidecar types before a message (src/agent/sidecar.ts), with the
// sender's own fields added:
//   [straw net from=<name> id=<session id> role=<tower|main|member|session> [head=yes] workspace=<label> kind=<kind> scope=<scope> to=<recipients> reply=<expected|none>] <message>
// A message that came over Straw Link adds the verified sender after the workspace (docs/specs/2026-10-25-straw-link.md, Header):
//   … workspace=<label> remote=<device label> device=<short id> team=<team> verified=yes kind=tower_send …
// The sidecar puts its own line, with the role Herdr's tokens give the sender, before this one; the two are not merged.

import { restrictLabel } from "./link/text.ts";

export type Kind = "call_tower" | "broadcast" | "tower_send" | "handoff";
/** `session` is a pi session that did not join the net (a scope `all` broadcast reaches it). `head`: the tower of the head workspace. */
export interface Party { name: string; id: string; role: "tower" | "main" | "member" | "session"; head?: boolean; workspace?: string }
/** The verified sender of a message that came over Straw Link: its device label and short id from the roster, and the team. */
export interface Remote { device: string; short: string; team: string }
/** `origin`: `remote:<device id>` on a message a tower sent to a local session during a Straw Link remote turn, so its receiver knows a peer's text started it. */
export interface Stamp { from: Party; kind: Kind; scope: string; to: Party[]; reply: boolean; remote?: Remote; origin?: string }
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

export function header({ from, kind, scope, to, reply, remote, origin }: Stamp): string {
	if (origin !== undefined && !ORIGIN.test(origin)) throw new Error("A remote origin is remote: and a link device id");
	// A remote header's sender-controlled fields are cut to the label character set and 40 characters here as well as where the link code builds them; the team is this computer's own name for it, so it keeps its characters (80 at most).
	if (remote && (!REMOTE_ID.test(from.id) || !/^[a-z2-7]{6}$/.test(remote.short))) throw new Error("A remote header needs a link device id and a short id");
	const text = (value: string) => (remote ? restrictLabel(value) : value);
	const fields = [
		`from=${quote(text(from.name || from.id))}`, `id=${quote(from.id)}`, `role=${from.role}`, ...(from.head ? ["head=yes"] : []),
		...(from.workspace ? [`workspace=${quote(text(from.workspace))}`] : []),
		...(remote ? [`remote=${quote(restrictLabel(remote.device))}`, `device=${remote.short}`, `team=${quote(clean(remote.team).slice(0, 80))}`, "verified=yes"] : []),
		`kind=${kind}`, `scope=${scope}`, `to=${quote([...to.slice(0, MAX_NAMED).map(recipient), ...(to.length > MAX_NAMED ? [`+${to.length - MAX_NAMED} more`] : [])].join("; "))}`, `reply=${reply ? "expected" : "none"}`,
		...(origin ? [`origin=${origin}`] : []),
	];
	return `[straw net ${fields.join(" ")}]`;
}

/** The message under its header. */
export const stamp = (s: Stamp, message: string) => `${header(s)} ${message}`;
