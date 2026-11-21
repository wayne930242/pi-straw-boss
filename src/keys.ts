import { DEQUEUE_KEY } from "./dequeuekey.ts";
import type { Overlay } from "./lan/faces.ts";
import type { Found } from "./net.ts";
import { type Editor, operateKeyRefusal, operateRawRefusal, operateRefusal } from "./probe.ts";
import type { Taken } from "./runs.ts";

// The key pad's keys (POST …/sessions/<key>/keys {key, stream, confirmed?}), checked in order after the write guards and the registry:
// the key is on the pad and alone, at most 8 a second per session; the page's stream holds this session's mirror, on its pane, and got a
// frame in the last 3 s; while the session file's open call is `secret_drop` or the unit has an answerable dialog, only Escape (the same on every page, a paired device's too); while it has an open `link_request` call a paired device (`remote`) too sends only Escape (its approval is given on this computer only, and Enter in the terminal confirm is Yes); Enter asks
// the session's bridge what it would submit (probe.ts), checks the mirror, the secret, and the dialog again after the answer, and needs the
// confirm the server names for an ending command, another `/` or `!` command, or an editor it could not read. An Enter that names the answer which put a command in the prompt (`run`, runs.ts) passes the `command`
// confirm alone, and only when the bridge's MAC of the prompt line (under the nonce the grant gave with the probe) is the MAC of that command: a line edited, emptied, or turned into text since, another session's or an unknown, spent, or stale answer is refused (run_changed, run_unknown, run_expired), and an old bridge's `command` line without a MAC gets the confirm. A second Escape within 1 s
// (from when Herdr took the first) to a session that neither works nor waits runs pi's double-Escape action, so it needs a confirm; once
// confirmed both Escapes go, as two writes 60 ms apart (one write of two ESC bytes reads as Ctrl+Alt+[ to a terminal without the kitty
// protocol, and pi pairs Escapes only within 500 ms), or one if the confirm came within 450 ms of the first, which pi pairs with it.
// Letters, `/`, Ctrl, and Alt are never a pad key. A desktop's keyboard, while the terminal has focus, sends more, each under the same guards
// and rate: typed text (`{text, stream}`), one raw write of at most 64 printable characters, so no Enter, Escape, or escape sequence rides
// along and Enter still comes alone and probed; a paste (`{paste, stream}`), up to 4,000 characters with line breaks and tabs but no other
// control character, inside the bracketed-paste markers so pi takes it as one paste and a line break submits nothing; Delete; and Ctrl or
// Alt chords (COMBOS) as Herdr names them. Ctrl+Z never goes (pi would stop in the background, where nothing here brings it back), Ctrl+D
// asks first (it leaves pi on an empty editor), and so does a second Ctrl+C within a second (pi leaves on the second). The composer's Edit sends pi's dequeue key (`dequeue`: Alt+Up, Alt+Q on Windows and WSL, or the user's own binding, which the session's bridge names, dequeuekey.ts), under the guard (a paired device's too: no link_request open) and the rate and with no mirror, as typing needs none. Stop (`{keys: ["esc"]}`, the composer's) needs no mirror. Herdr 0.9 has no
// names for Home, End, Page Up, and Page Down: those go as the fixed sequences pi reads (pane.send_text writes them raw), and only they.

/** What the pad can send, as Herdr names the keys. */
export const PAD = ["esc", "enter", "up", "down", "left", "right", "tab", "shift+tab", "space", "backspace", "pageup", "pagedown", "home", "end", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
/** A desktop keyboard's chords beyond the pad: Ctrl or Alt with a letter (Ctrl+Z aside), Alt+Enter, Alt+Backspace, and word moves. */
export const COMBOS = /^(?:ctrl\+[a-y]|alt\+[a-z]|alt\+(?:enter|backspace)|(?:ctrl|alt)\+(?:left|right))$/;
/**
 * What an operate session's chords are, as an explicit list (docs/specs/2026-11-07-link-operate.md §7.3): pi's editor-local keys only (`tui.editor.*` in pi-tui: cursor and word moves, line and word kills, yank, and `app.clear`'s Ctrl+C), and Alt+Enter, which is probed like Enter.
 * Every other Ctrl or Alt letter is some pi app action (model and thinking cycles, copy, paste of a file, the tool output toggle, and `app.editor.external`, which hands the terminal to another program), and a few leave the editor altogether, where the
 * probe no longer says what the next key does. tests/operate-keys.test.ts compares the list with the installed pi's own keybindings.
 */
export const OPERATE_COMBOS = /^(?:ctrl\+[abefkuwyc]|alt\+[bdfy]|alt\+(?:enter|backspace)|(?:ctrl|alt)\+(?:left|right))$/;
/** The keys Herdr cannot name, as the bytes a terminal sends for them. */
export const SEQUENCES: Record<string, string> = { home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~", delete: "\x1b[3~" };
export const RATE = 8, RATE_MS = 1000, DOUBLE_MS = 1000, PAIR_MS = 450, MAX_TYPED = 64, MAX_PASTE = 4000;
/** C0 and C1 controls and DEL: what could end a line, start an escape sequence, or signal; typed text holds none, a paste only line breaks and tabs. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/, PASTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
export interface Reply { status: number; body: unknown }
export interface KeyDeps { /** The marks of the `/boss gui lan` overlay (lan/faces.ts): a paired device sends Escape only to a marked pane. */ overlay?: Overlay; fresh(stream: string, key: string, pane: string): boolean; secret(file: string): Promise<boolean>; answerable(key: string): Promise<boolean>; linkRequest?(found: Found, session: string): Promise<boolean>; /** The editor class; with a `nonce` the bridge also tells the MAC of a command line under it (probe.ts). */ probe(key: string, nonce?: string, flags?: boolean): Promise<Editor | undefined>; /** The one-tap grants (runs.ts): the nonce to probe with, and what an answer id says of the prompt line's MAC. */ run?: { nonce(session: string, answerId: string): string | undefined; take(session: string, answerId: string, mac: string | undefined): Taken }; now?(): number }
/** `text`: typed characters, sent as they are, or a paste already inside its markers (key is then "text" or "paste"). */
export interface Asked { key: string; stream?: string; confirmed?: unknown; text?: string; remote?: boolean; /** An operate session's key (docs/specs/2026-11-07-link-operate.md §7): Enter and Alt+Enter are probed for a shell line or a /boss command, and Ctrl+M is never sent. */ operate?: true; /** The answer id of a one-tap run (Enter only). */ run?: string }
type Pane = { pane_id: string; agent_status?: string };
/** The keys to send, the Herdr calls that send them, and whether they are the confirmed double-Escape. */
export interface Plan { keys: string[]; calls: [string, Record<string, unknown>][]; double: boolean }

const no = (status: number, error: string, reason: string, extra = {}): Reply => ({ status, body: { error, reason, ...extra } });
const FOCUS = "Enter goes to whatever has focus in the terminal; confirm to send it.";
const ASK: Record<string, string> = {
	unread: `The session's editor could not be read, so Enter might run a command that ends the session. ${FOCUS}`,
	command: `The editor holds a command (a / command or a ! shell command), which Enter may complete and run. ${FOCUS}`,
	"double-esc": "A second Escape on an idle session runs pi's double-Escape action (tree or fork); confirm to run it.",
	"ctrl-d": "Ctrl+D leaves pi when its editor is empty, which ends this session; confirm to send it.",
	"double-ctrl-c": "A second Ctrl+C within a second leaves pi, which ends this session; confirm to send it.",
};
const RUN_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** Why a one-tap run was refused (the Enter itself is not lost: pressing it again, with no `run`, asks the usual confirm). */
const refusedRun = (taken: Taken): Reply =>
	taken === "changed" || taken === "nohash" ? no(409, "run_changed", "The prompt no longer holds the command that was placed there, so nothing was sent; read it in the terminal.")
	: taken === "expired" ? no(409, "run_expired", "The command waited too long to run in one tap; press Enter again to confirm it.")
	: no(409, "run_unknown", "That command was not placed by an answer here, or it was already run; press Enter again to confirm it.");
const confirm = (token: string) => no(409, "confirm", ASK[token] ?? `Enter would run /${token} (or the command picked in pi's menu, if it is open), which ends or replaces this session. ${FOCUS}`, { confirm: token });

export function createKeys({ overlay, fresh, secret, answerable, linkRequest = async () => false, probe, run, now = Date.now }: KeyDeps) {
	const sent = new Map<string, number[]>(), escaped = new Map<string, number>(), interrupted = new Map<string, number>();
	const guard = async (session: string, found: Found, pane: Pane, a: Asked) => {
		if (a.stream !== undefined && !fresh(a.stream, session, pane.pane_id)) throw no(409, "no_mirror", "Keys are sent only while this page shows the session's terminal live; open it again.");
		if (a.key !== "esc" && ((await secret(found.file!)) || (await answerable(session)))) throw no(409, "blocked", "While it waits on a secret or a question only Escape is sent from here; answer the question in its panel or the terminal.");
		// A link_request's approval dialog in the terminal takes Enter as Yes, and its high-risk actions are approved on this computer only: a paired device sends Escape (No) and nothing else.
		// A face of /boss gui lan answers on keys: while one is open on this pane, a paired device (either network) sends Escape and nothing else; control.ts looks again right before each write.
		if (a.key !== "esc" && a.remote && overlay?.marked(found.pane)) throw no(409, "lan_overlay_open", "A /boss gui lan screen is open in this session; only Escape can be sent to it from a paired device.");
		if (a.key !== "esc" && a.remote && (await linkRequest(found, session))) throw no(403, "local_only", "While it waits on a link request, a paired device can only send Escape; approve it on this computer's own page or terminal.");
	};
	/** Counts a key toward the session's rate, or says it is past it. */
	const counted = (session: string): Reply | undefined => {
		const t = now(), recent = (sent.get(session) ?? []).filter((at) => t - at < RATE_MS);
		if (recent.length >= RATE) return no(429, "rate", `At most ${RATE} keys a second reach a session.`);
		for (const [s, ats] of sent) if (t - ats.at(-1)! >= RATE_MS) sent.delete(s); // sessions gone quiet leave nothing behind
		for (const [s, at] of escaped) if (t - at >= 60_000) escaped.delete(s);
		sent.set(session, [...recent, t]);
	};
	return {
		/** The composer's Edit (`dequeue` in control.ts): pi's own dequeue key (`key`, one the session's bridge named, DEQUEUE_KEY), which takes back the queue. Like typing it needs no mirror, and like any key but Escape it is not sent while a secret or a question waits; it counts toward the rate. */
		async dequeue(session: string, found: Found, pane: Pane, key: string, remote = false): Promise<Plan> {
			if (!DEQUEUE_KEY.test(key)) throw no(409, "no_key", "pi's dequeue key is not one this page can send; press it in the terminal.");
			const limited = counted(session);
			if (limited) throw limited;
			await guard(session, found, pane, { key, remote });
			return { keys: [key], double: false, calls: [["pane.send_input", { pane_id: pane.pane_id, keys: [key] }]] };
		},
		/** The body as one pad key (or Stop's Escape), or why not, before Herdr is asked; a request that passes counts toward the rate. */
		check(session: string, json: Record<string, unknown>, remote = false, operate = false): Asked | Reply {
			const stop = json.key === undefined && Array.isArray(json.keys) && json.keys.length === 1 && json.keys[0] === "esc";
			const alone = json.key === undefined && json.keys === undefined, typed = alone && json.text !== undefined && json.paste === undefined, pasted = alone && json.paste !== undefined && json.text === undefined;
			if (typed && (typeof json.text !== "string" || !json.text || [...json.text].length > MAX_TYPED || CONTROL.test(json.text))) return no(400, "text", `Typed text is 1 to ${MAX_TYPED} printable characters, without line breaks, tabs, or control keys.`);
			if (pasted && (typeof json.paste !== "string" || !json.paste || [...json.paste].length > MAX_PASTE || PASTE_CONTROL.test(json.paste))) return no(400, "paste", `A paste is 1 to ${MAX_PASTE} characters, with line breaks and tabs but no other control character.`);
			if (json.key === "ctrl+z") return no(400, "key", "Ctrl+Z is never sent: it would stop pi in the background, where nothing here can bring it back.");
			if (operate && json.key === "ctrl+m") return no(403, "operate_refused", "Ctrl+M is Enter without the editor check; send Enter.", { why: "enter-chord" }); // a terminal reads it as a carriage return
			if (operate && typeof json.key === "string" && COMBOS.test(json.key) && !OPERATE_COMBOS.test(json.key)) return no(403, "operate_refused", "That chord is a pi action outside its editor; an operate session sends the editor's own keys only.", { why: "chord" });
			if (!stop && !typed && !pasted && (json.text !== undefined || json.paste !== undefined || typeof json.key !== "string" || !(PAD.includes(json.key) || json.key === "delete" || (operate ? OPERATE_COMBOS : COMBOS).test(json.key)) || json.keys !== undefined)) return no(400, "key", "One key at a time: a pad key, Delete, or a Ctrl or Alt chord (never a letter alone).");
			if (json.run !== undefined && (json.key !== "enter" || typeof json.run !== "string" || !RUN_ID.test(json.run) || json.confirmed !== undefined)) return no(400, "key", "`run` names the answer that put a command in the prompt, on Enter alone and without a confirm.");
			if (!stop && (typeof json.stream !== "string" || !json.stream)) return no(400, "bad_request", "Name this page's stream; reload the page if it reconnected.");
			const limited = counted(session);
			if (limited) return limited;
			const op = operate ? { operate: true as const } : {};
			if (pasted) return { key: "paste", text: `\x1b[200~${json.paste as string}\x1b[201~`, stream: json.stream as string, remote, ...op };
			return stop ? { key: "esc", remote, ...op } : typed ? { key: "text", text: json.text as string, stream: json.stream as string, remote, ...op } : { key: json.key as string, stream: json.stream as string, confirmed: json.confirmed, remote, ...op, ...(json.run !== undefined && { run: json.run as string }) };
		},
		/**
		 * The calls that send a checked key to a pane an answer opened (answerpane.ts), which is no pi session (`live` has just refused it, ending its grant, if it runs an agent or carries `sb_role`): only the mirror precondition (this page's stream holds that pane's mirror, live) and the keys `check` let through.
		 * Nothing of a session's guards applies (a secret, a dialog, a link_request, the LAN overlay, the editor probe, the confirms for Enter, Ctrl+D, Ctrl+C and a second Escape): they guard what pi does with a key, and this pane runs a shell
		 * (or a wrapper that shows a command and waits for Enter). Whoever may answer the dialog that opened it may key into it, as the boss's keyboard would.
		 */
		bare(grant: string, pane: string, a: Asked): Plan {
			if (a.stream !== undefined && !fresh(a.stream, grant, pane)) throw no(409, "no_mirror", "Keys are sent only while this page shows the pane's terminal live; open it again.");
			if (a.text !== undefined) return { keys: [], double: false, calls: [["pane.send_text", { pane_id: pane, text: a.text }]] };
			const text = SEQUENCES[a.key];
			return { keys: [a.key], double: false, calls: [text ? ["pane.send_text", { pane_id: pane, text }] : ["pane.send_input", { pane_id: pane, keys: [a.key] }]] };
		},
		/** The guards that need the pane as Herdr has it now, then the Herdr calls that send the key, in order, 60 ms apart. */
		async send(session: string, found: Found, pane: Pane, a: Asked): Promise<Plan> {
			if (a.text !== undefined) {
				await guard(session, found, pane, a);
				if (a.operate) { // typed text and a paste go into whatever has the terminal: pi's raw mode, told by the bridge, is the proof that it is pi's editor
					const barred = operateRawRefusal(await probe(session, undefined, true));
					if (barred) throw no(403, "operate_refused", barred.reason, { why: barred.why });
					await guard(session, found, pane, a); // the probe took up to 4 s (dialogs.ts): a secret or a dialog may have opened meanwhile
				}
				return { keys: [], double: false, calls: [["pane.send_text", { pane_id: pane.pane_id, text: a.text }]] };
			}
			const { keys, double } = await this.keys(session, found, pane, a), text = SEQUENCES[keys[0]!];
			return { keys, double, calls: text ? [["pane.send_text", { pane_id: pane.pane_id, text }]] : keys.map((k) => ["pane.send_input", { pane_id: pane.pane_id, keys: [k] }]) };
		},
		/** The guards, then the keys: one, or Escape twice for a confirmed double-Escape (`double`: this was the double, sent or paired). */
		async keys(session: string, found: Found, pane: Pane, a: Asked): Promise<{ keys: string[]; double: boolean }> {
			await guard(session, found, pane, a);
			// Alt+Enter acts as Enter in pi while it is not streaming (it submits the draft, a `!` line included), so an operate session's is probed like Enter.
			const probed = a.key === "enter" || (a.operate && a.key === "alt+enter");
			// An operate session's every key is first checked against pi's live bindings on the box: a user's keybindings.json may put the external editor, or any app action, on a key the pad sends (Tab and the arrows too).
			const own = a.operate && !probed ? await probe(session, undefined, true) : undefined;
			if (a.operate && !probed) {
				const barred = operateKeyRefusal(own, a.key);
				if (barred) throw no(403, "operate_refused", barred.reason, { why: barred.why });
				await guard(session, found, pane, a);
			}
			if (probed) {
				const e = await probe(session, a.run === undefined ? undefined : run?.nonce(session, a.run), a.operate); // the grant's nonce goes with a `run` Enter's probe only: no other Enter has a MAC of the draft made
				await guard(session, found, pane, a); // the probe took up to 4 s (dialogs.ts): a secret or a dialog may have opened meanwhile
				const barred = a.operate ? operateRefusal(e) : undefined; // an operate session's Enter never runs a shell line or a /boss command, and no confirm lifts that
				if (barred) throw no(403, "operate_refused", barred.reason, { why: barred.why });
				const unbound = a.operate ? operateKeyRefusal(e, a.key) : undefined; // and Enter's own binding, as the bridge's pi has it, must be the editor's
				if (unbound) throw no(403, "operate_refused", unbound.reason, { why: unbound.why });
				let need = !e || e.editor === "unknown" ? "unread" : (e.ending ?? (e.editor === "command" ? "command" : undefined));
				if (a.run !== undefined) {
					const taken = run?.take(session, a.run, e?.mac) ?? "unknown";
					// Only the plain `command` confirm is ever met by the MAC: an ending command or an unreadable editor still asks. Where the editor was read, `run` sends only a line that matched: an edited, emptied, or ending line, a spent or unknown grant is refused. The one exception is a `command` line with no MAC, an old bridge, which gets the confirm.
					if (e && e.editor !== "unknown" && taken !== "match" && !(taken === "nohash" && e.editor === "command")) throw refusedRun(taken);
					if (taken === "match" && need === "command") need = undefined;
				}
				if (need && a.confirmed !== need) throw confirm(need);
			}
			if (a.key === "ctrl+d" && a.confirmed !== "ctrl-d") throw confirm("ctrl-d");
			// A second Ctrl+C leaves pi and a second Escape opens its tree or fork menu: both leave the editor, which the probe is about, and no confirm lifts that for an operate session (the first one still goes).
			if (a.operate && a.key === "ctrl+c" && now() - (interrupted.get(session) ?? -Infinity) < DOUBLE_MS) throw no(403, "operate_refused", "A second Ctrl+C within a second leaves pi; wait a moment.", { why: "leaves-editor" });
			if (a.operate && a.key === "esc" && now() - (escaped.get(session) ?? -Infinity) < DOUBLE_MS) throw no(403, "operate_refused", "A second Escape within a second runs pi's double-Escape action, which leaves the editor; wait a moment.", { why: "leaves-editor" });
			if (a.key === "ctrl+c" && now() - (interrupted.get(session) ?? -Infinity) < DOUBLE_MS && a.confirmed !== "double-ctrl-c") throw confirm("double-ctrl-c");
			if (a.key === "ctrl+c") return { keys: [a.key], double: a.confirmed === "double-ctrl-c" };
			if (a.key !== "esc") return { keys: [a.key], double: false };
			const idle = pane.agent_status !== "working" && pane.agent_status !== "blocked", last = escaped.get(session) ?? -Infinity, t = now();
			if (idle && t - last < DOUBLE_MS && a.confirmed !== "double-esc") throw confirm("double-esc");
			if (a.operate || !(idle && a.confirmed === "double-esc" && t - last < 60_000)) return { keys: ["esc"], double: false };
			return { keys: t - last < PAIR_MS ? ["esc"] : ["esc", "esc"], double: true }; // confirmed so fast that pi pairs it with the Escape before
		},
		/** Herdr took the keys: an Escape counts from now; the double leaves none, so the next Escape starts afresh. */
		sent(session: string, { keys, double }: Plan) {
			if (keys[0] === "ctrl+c") return void (double ? interrupted.delete(session) : interrupted.set(session, now()));
			for (const [s, at] of interrupted) if (now() - at >= 60_000) interrupted.delete(s);
			if (double) escaped.delete(session);
			else if (keys[0] === "esc") escaped.set(session, now());
		},
	};
}
