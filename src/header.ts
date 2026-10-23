// The line that opens every message Straw Boss sends through intercom for a session (call_tower, boss_broadcast, tower_send, a handoff). The code
// writes it, never the model, so a receiver can tell from the line alone who sent the message and in what role, what kind of message it is, who else
// got it, and whether the sender waits for a reply. It has the shape of the line a net sidecar types before a message (src/agent/sidecar.ts), with the
// sender's own fields added:
//   [straw net from=<name> id=<session id> role=<tower|main|member|session> [head=yes] workspace=<label> kind=<kind> scope=<scope> to=<recipients> reply=<expected|none>] <message>
// The sidecar puts its own line, with the role Herdr's tokens give the sender, before this one; the two are not merged.

export type Kind = "call_tower" | "broadcast" | "tower_send" | "handoff";
/** `session` is a pi session that did not join the net (a scope `all` broadcast reaches it). `head`: the tower of the head workspace. */
export interface Party { name: string; id: string; role: "tower" | "main" | "member" | "session"; head?: boolean; workspace?: string }
export interface Stamp { from: Party; kind: Kind; scope: string; to: Party[]; reply: boolean }

/** Control characters and runs of whitespace become one space, so a name cannot start a second line or a second field. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
const quote = (value: string) => (/[\s"\]=;]/.test(clean(value)) ? `"${clean(value).replace(/"/g, "'")}"` : clean(value));
const roleOf = (p: Party) => (p.head ? "head tower" : p.role);
/** A header names at most this many recipients, then how many more there are (a scope `all` broadcast can reach every session on the machine). */
const MAX_NAMED = 20;
const recipient = (p: Party) => `${clean(p.name)} (${roleOf(p)}${p.workspace ? ` of ${clean(p.workspace)}` : ""})`;

export function header({ from, kind, scope, to, reply }: Stamp): string {
	const fields = [
		`from=${quote(from.name || from.id)}`, `id=${quote(from.id)}`, `role=${from.role}`, ...(from.head ? ["head=yes"] : []),
		...(from.workspace ? [`workspace=${quote(from.workspace)}`] : []),
		`kind=${kind}`, `scope=${scope}`, `to=${quote([...to.slice(0, MAX_NAMED).map(recipient), ...(to.length > MAX_NAMED ? [`+${to.length - MAX_NAMED} more`] : [])].join("; "))}`, `reply=${reply ? "expected" : "none"}`,
	];
	return `[straw net ${fields.join(" ")}]`;
}

/** The message under its header. */
export const stamp = (s: Stamp, message: string) => `${header(s)} ${message}`;
