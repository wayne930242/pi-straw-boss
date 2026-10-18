import type { Found } from "./net.ts";
import type { Editor } from "./probe.ts";

// The key pad's keys (POST …/sessions/<key>/keys {key, stream, confirmed?}), checked in order after the write guards and the registry:
// the key is on the pad and alone, at most 8 a second per session; the page's stream holds this session's mirror, on its pane, and got a
// frame in the last 3 s; while the session file's open call is `secret_drop` or the unit has an answerable dialog, only Escape; Enter asks
// the session's bridge what it would submit (probe.ts), checks the mirror, the secret, and the dialog again after the answer, and needs the
// confirm the server names for an ending command, another `/` or `!` command, or an editor it could not read. A second Escape within 1 s
// (from when Herdr took the first) to a session that neither works nor waits runs pi's double-Escape action, so it needs a confirm; once
// confirmed both Escapes go, as two writes 60 ms apart (one write of two ESC bytes reads as Ctrl+Alt+[ to a terminal without the kitty
// protocol, and pi pairs Escapes only within 500 ms), or one if the confirm came within 450 ms of the first, which pi pairs with it.
// Letters, `/`, Ctrl, and Alt are never sendable: not on the pad. Stop (`{keys: ["esc"]}`, the composer's) needs no mirror. Herdr 0.9 has no
// names for Home, End, Page Up, and Page Down: those go as the fixed sequences pi reads (pane.send_text writes them raw), and only they.

/** What the pad can send, as Herdr names the keys. */
export const PAD = ["esc", "enter", "up", "down", "left", "right", "tab", "shift+tab", "space", "backspace", "pageup", "pagedown", "home", "end", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
/** The pad keys Herdr cannot name, as the bytes a terminal sends for them. */
export const SEQUENCES: Record<string, string> = { home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~" };
export const RATE = 8, RATE_MS = 1000, DOUBLE_MS = 1000, PAIR_MS = 450;
export interface Reply { status: number; body: unknown }
export interface KeyDeps { fresh(stream: string, key: string, pane: string): boolean; secret(file: string): Promise<boolean>; answerable(key: string): Promise<boolean>; probe(key: string): Promise<Editor | undefined>; now?(): number }
export interface Asked { key: string; stream?: string; confirmed?: unknown }
type Pane = { pane_id: string; agent_status?: string };
/** The keys to send, the Herdr calls that send them, and whether they are the confirmed double-Escape. */
export interface Plan { keys: string[]; calls: [string, Record<string, unknown>][]; double: boolean }

const no = (status: number, error: string, reason: string, extra = {}): Reply => ({ status, body: { error, reason, ...extra } });
const FOCUS = "Enter goes to whatever has focus in the terminal; confirm to send it.";
const ASK: Record<string, string> = {
	unread: `The session's editor could not be read, so Enter might run a command that ends the session. ${FOCUS}`,
	command: `The editor holds a slash command, which Enter may complete and run. ${FOCUS}`,
	"double-esc": "A second Escape on an idle session runs pi's double-Escape action (tree or fork); confirm to run it.",
};
const confirm = (token: string) => no(409, "confirm", ASK[token] ?? `Enter would run /${token} (or the command picked in pi's menu, if it is open), which ends or replaces this session. ${FOCUS}`, { confirm: token });

export function createKeys({ fresh, secret, answerable, probe, now = Date.now }: KeyDeps) {
	const sent = new Map<string, number[]>(), escaped = new Map<string, number>();
	const guard = async (session: string, found: Found, pane: Pane, a: Asked) => {
		if (a.stream !== undefined && !fresh(a.stream, session, pane.pane_id)) throw no(409, "no_mirror", "Keys are sent only while this page shows the session's terminal live; open it again.");
		if (a.key !== "esc" && ((await secret(found.file!)) || (await answerable(session)))) throw no(409, "blocked", "While it waits on a secret or a question only Escape is sent from here; answer the question in its panel or the terminal.");
	};
	return {
		/** The body as one pad key (or Stop's Escape), or why not, before Herdr is asked; a request that passes counts toward the rate. */
		check(session: string, json: Record<string, unknown>): Asked | Reply {
			const stop = json.key === undefined && Array.isArray(json.keys) && json.keys.length === 1 && json.keys[0] === "esc";
			if (!stop && (typeof json.key !== "string" || !PAD.includes(json.key) || json.keys !== undefined)) return no(400, "key", "Only one key from the pad can be sent at a time (never letters, /, Ctrl or Alt).");
			if (!stop && (typeof json.stream !== "string" || !json.stream)) return no(400, "bad_request", "Name this page's stream; reload the page if it reconnected.");
			const t = now(), recent = (sent.get(session) ?? []).filter((at) => t - at < RATE_MS);
			if (recent.length >= RATE) return no(429, "rate", `At most ${RATE} keys a second reach a session.`);
			for (const [s, ats] of sent) if (t - ats.at(-1)! >= RATE_MS) sent.delete(s); // sessions gone quiet leave nothing behind
			for (const [s, at] of escaped) if (t - at >= 60_000) escaped.delete(s);
			sent.set(session, [...recent, t]);
			return stop ? { key: "esc" } : { key: json.key as string, stream: json.stream as string, confirmed: json.confirmed };
		},
		/** The guards that need the pane as Herdr has it now, then the Herdr calls that send the key, in order, 60 ms apart. */
		async send(session: string, found: Found, pane: Pane, a: Asked): Promise<Plan> {
			const { keys, double } = await this.keys(session, found, pane, a), text = SEQUENCES[keys[0]!];
			return { keys, double, calls: text ? [["pane.send_text", { pane_id: pane.pane_id, text }]] : keys.map((k) => ["pane.send_input", { pane_id: pane.pane_id, keys: [k] }]) };
		},
		/** The guards, then the keys: one, or Escape twice for a confirmed double-Escape (`double`: this was the double, sent or paired). */
		async keys(session: string, found: Found, pane: Pane, a: Asked): Promise<{ keys: string[]; double: boolean }> {
			await guard(session, found, pane, a);
			if (a.key === "enter") {
				const e = await probe(session), need = !e || e.editor === "unknown" ? "unread" : (e.ending ?? (e.editor === "command" ? "command" : undefined));
				await guard(session, found, pane, a); // the probe took up to a second: a secret or a dialog may have opened meanwhile
				if (need && a.confirmed !== need) throw confirm(need);
			}
			if (a.key !== "esc") return { keys: [a.key], double: false };
			const idle = pane.agent_status !== "working" && pane.agent_status !== "blocked", last = escaped.get(session) ?? -Infinity, t = now();
			if (idle && t - last < DOUBLE_MS && a.confirmed !== "double-esc") throw confirm("double-esc");
			if (!(idle && a.confirmed === "double-esc" && t - last < 60_000)) return { keys: ["esc"], double: false };
			return { keys: t - last < PAIR_MS ? ["esc"] : ["esc", "esc"], double: true }; // confirmed so fast that pi pairs it with the Escape before
		},
		/** Herdr took the keys: an Escape counts from now; the double leaves none, so the next Escape starts afresh. */
		sent(session: string, { keys, double }: Plan) {
			if (double) escaped.delete(session);
			else if (keys[0] === "esc") escaped.set(session, now());
		},
	};
}
