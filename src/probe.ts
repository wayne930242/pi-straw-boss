import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENDING } from "./ending.ts";
import { lineMac, NONCE } from "./runs.ts";

// What Enter would submit from a session's own editor, for the key pad's Enter guard (keys.ts). The bridge (bridge.ts) answers the GUI
// server's probe with a class and at most a command name: the draft itself never leaves the session. The rule for which commands end or
// replace the session lives here, once, for the composer's typed text (control.ts) and the key pad's Enter alike. For a `command` draft (and only that class), and only when the server gave a nonce with the probe (the
// Enter of a one-tap run, runs.ts), it also tells HMAC-SHA-256(nonce, line), so the server can tell the line an answer put there from an edited one; a probe with no nonce, and a draft of any other class, tells nothing of
// the line, and the text itself never leaves.

export { ENDING };
/** `command`: a draft that starts with `/` and is no ending command: with pi's command menu open (tab, backspace), Enter completes it and
 *  runs the result at once, so it may become any command, an ending one included. A `!` draft is one too: Enter runs it as a shell
 *  command, and `up` recalls earlier ones from history. */
export interface Editor { editor: "empty" | "text" | "command" | "unknown"; ending?: string; mac?: string; /** Only when the probe asked for the flags (an operate session's, docs/specs/2026-11-07-link-operate.md §7), and only on a `command` draft: it is a `!` shell line, or a `/boss` command. */ shell?: boolean; boss?: boolean;
	/** Only when the probe asked for the flags, and all three together (bindings.ts): the pad keys (as Herdr names them) that pi's live keybindings bind, by the bytes the pad sends, to an action outside the editor; the pad keys that hold submit, follow-up, clear and interrupt; and whether pi has the terminal in raw mode. Absent when the bridge could not tell, which refuses every operate key. */
	keys?: string[]; holds?: Holds; raw?: boolean }
const EDITORS = ["empty", "text", "command", "unknown"];

/** A draft pi runs as a shell command, and a `/boss` command (and not `/bossy`): the two lines an operate session never submits. */
const SHELL = /^\s*!/, BOSS = /^\s*\/boss(\s|$)/;

/** The session's editor as a class: empty, an ending command (by name), another slash command, other text, or unknown without a UI. With `flags`, a `command` draft also says which kind (`shell`, `boss`); without them nothing of the kind is told, so an older bridge's answer has none and the server then cannot tell. */
export function probeEditor(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, nonce?: unknown, flags?: unknown, report?: () => Report | undefined): Editor {
	const bound = flags === true ? report?.() : undefined, keys = bound ? { keys: bound.keys, holds: bound.holds, raw: bound.raw } : {};
	let text: unknown;
	try {
		text = ctx?.hasUI ? ctx.ui.getEditorText() : undefined;
	} catch {} // a UI that cannot say is unknown
	if (typeof text !== "string") return { editor: "unknown", ...keys };
	const ending = ENDING.exec(text)?.[1];
	return !text.trim() ? { editor: "empty", ...keys } : ending ? { editor: "text", ending, ...keys } : /^\s*[/!]/.test(text) ? { editor: "command", ...(typeof nonce === "string" && NONCE.test(nonce) && { mac: lineMac(nonce, text) }), ...(flags === true && { shell: SHELL.test(text), boss: BOSS.test(text) }), ...keys } : { editor: "text", ...keys };
}

/** A bridge's answer as the server takes it: one of the classes, and an ending only when it names one of the commands above. */
export function checkProbe(p: Record<string, unknown> | undefined): Editor | undefined {
	if (!p || !EDITORS.includes(p.editor as string)) return undefined;
	const mac = p.editor === "command" && typeof p.mac === "string" && /^[0-9a-f]{64}$/.test(p.mac) ? { mac: p.mac } : {};
	const kind = p.editor === "command" ? { ...(typeof p.shell === "boolean" && { shell: p.shell }), ...(typeof p.boss === "boolean" && { boss: p.boss }) } : {};
	const names = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 400 && v.every((k) => typeof k === "string" && /^[A-Za-z0-9+]{1,40}$/.test(k));
	const holds = p.holds && typeof p.holds === "object" && !Array.isArray(p.holds) && Object.entries(p.holds).every(([a, v]) => a in HOME && names(v)) ? { holds: p.holds as Holds } : {};
	// The three travel together: one that is missing or malformed leaves the others out, so the server refuses (an older bridge says none).
	const keys = names(p.keys) && "holds" in holds && typeof p.raw === "boolean" ? { keys: p.keys, ...holds, raw: p.raw } : {};
	if (p.ending === undefined) return { editor: p.editor as Editor["editor"], ...mac, ...kind, ...keys };
	return p.editor === "text" && typeof p.ending === "string" && ENDING.test(`/${p.ending}`) && /^[a-z]+$/.test(p.ending) ? { editor: "text", ending: p.ending, ...keys } : undefined;
}

/** The home of each action the pad's keys may hold only where its guard is written for it (keys.ts): submit and follow-up on Enter and Alt+Enter, which are probed for the draft, the clear key on Ctrl+C, whose double press is counted, and the interrupt on Escape, whose double press is. On any other pad key they would act with no guard. */
export const HOME: Record<"submit" | "followUp" | "clear" | "interrupt", string[]> = { submit: ["enter", "alt+enter"], followUp: ["enter", "alt+enter"], clear: ["ctrl+c"], interrupt: ["esc"] };
export type Holds = Partial<Record<keyof typeof HOME, string[]>>;
/** What the bridge tells with an operate probe: the pad keys bound to an action outside the editor, the keys that hold each guarded action, and whether pi has the terminal in raw mode (pi's TUI restores cooked mode before it hands the terminal to $EDITOR or stops on Ctrl+Z). */
export interface Report { keys: string[]; holds: Holds; raw: boolean }

export type OperateWhy = "noanswer" | "shell" | "boss-command" | "command" | "unread" | "draft";

/** No answer at all (the bridge was not reached, or answered neither the probe nor its resend, dialogs.ts) is not an answer of `unknown`: every operate refusal says it first, so the page can say try again (docs/specs/2026-11-21-operate-probe.md). */
const NOANSWER = { why: "noanswer", reason: "The session did not answer in time (it may be busy), so nothing is sent from here; try again in a moment." } as const;

/**
 * Why an operate session's key may not go, from what the bridge's pi says of itself: it could not say (an older bridge, or a pi whose app actions the live manager does not hold), pi does not hold the terminal in raw mode (an external editor or
 * a suspended pi runs below it), the user's keybindings put another app action, the external editor among them, or an extension's shortcut, on this key, or put submit, follow-up, clear or interrupt on a key whose guard is not written for it.
 * Checked before every operate key, whatever it is: a rebound Tab or arrow is as much a way out of the editor as a rebound chord.
 */
export function operateKeyRefusal(e: Editor | undefined, key: string): { why: "noanswer" | "binding" | "binding-unread" | "terminal"; reason: string } | undefined {
	if (!e) return NOANSWER;
	if (!e.keys || !e.holds) return { why: "binding-unread", reason: "pi's key bindings on the box could not be read, so nothing is sent from here: a key might do something other than edit." };
	const raw = operateRawRefusal(e);
	if (raw) return raw;
	if (e.keys.includes(key) || Object.entries(e.holds).some(([action, held]) => held.includes(key) && !HOME[action as keyof typeof HOME]?.includes(key))) return { why: "binding", reason: "pi on the box binds that key to an action outside its editor, so it is not sent from here." };
	return undefined;
}

/** Why anything written into the pane may not go, from the probe: pi did not say it holds the terminal in raw mode, which pi's own TUI leaves before it starts $EDITOR or stops. */
export function operateRawRefusal(e: Editor | undefined): { why: "noanswer" | "terminal"; reason: string } | undefined {
	return !e ? NOANSWER : e.raw === true ? undefined : { why: "terminal", reason: "pi does not hold the terminal right now (an external editor or a suspended pi may), or the box cannot say, so nothing is sent from here." };
}

/**
 * Why an operate session's Enter (or the composer's text) may not go, from what the probe says of the draft, or nothing when it may: a `!` shell line, a `/boss` command, any other `/` draft (see below), or an editor that cannot be read well enough to tell
 * (no UI, or a `command` whose bridge did not tell the flags, which an older bridge never does; no answer at all is `noanswer`, above). The confirms a paired device may give do not lift any of them.
 */
export function operateRefusal(e: Editor | undefined): { why: OperateWhy; reason: string } | undefined {
	if (!e) return NOANSWER;
	if (e.editor === "unknown" || (e.editor === "command" && (typeof e.shell !== "boolean" || typeof e.boss !== "boolean"))) return { why: "unread", reason: "The session's editor could not be read well enough to tell what Enter would run, so nothing is sent from here." };
	if (e.shell) return { why: "shell", reason: "A shell line (`!`) is not run from here: the box takes no arbitrary shell over the link." };
	if (e.boss) return { why: "boss-command", reason: "A /boss command is not run from here: on the box it reaches other teams' sessions and the box's own settings." };
	// A `/` draft is refused whole, not only `/boss`: with the command menu open (a bare `/`, `/b`, `/bos`), Enter applies the highlighted completion and runs it, so the draft as typed does not say what runs.
	if (e.editor === "command") return { why: "command", reason: "A slash command is not run from here: Enter would apply the command menu's highlighted choice, which this page cannot tell from the draft." };
	return undefined;
}

/**
 * Why the composer's text may not be sent: the Enter's refusals above, and any draft already in the editor. The text is pasted at the cursor and submitted with the draft (docs/specs/2026-11-07-link-operate.md §7.2), so a draft
 * the pad left there (`/`, `boss`, a `/bos` the text completes) would join it into a line this page never looked at; under operate it goes only into an empty editor.
 */
export function operateTextRefusal(e: Editor | undefined): { why: OperateWhy | "terminal"; reason: string } | undefined {
	return operateRefusal(e) ?? operateRawRefusal(e) ?? (e?.editor === "empty" ? undefined : { why: "draft", reason: "The session's editor holds a draft, and the text would join it; clear the draft first, or send from an empty editor." });
}
