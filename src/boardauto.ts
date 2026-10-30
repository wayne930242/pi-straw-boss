import { posix, win32 } from "node:path";
import { BOARD, type BoardItem, type BoardText, clean, type Count } from "./board.ts";
import type { Todo } from "./items.ts";

// The work board's auto-fill (docs/specs/2026-10-25-straw-link.md, Work board, Auto-fill): a main's todo list and name as a `BoardText`, with the text scrubbed
// of what must not leave the computer. Pure: boardfill.ts reads the session and writes the entry.

/** What a scrubbed-out piece of text becomes. */
export const HIDDEN = "…";
const SECRET = [
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{16,}/g,
	/\bglpat-[A-Za-z0-9_-]{10,}/g,
	/\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/g,
	/\b[0-9a-fA-F]{32,}\b/g,
	/\bnpm_[A-Za-z0-9]{20,}/g,
	/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
	/\b0x[0-9a-fA-F]{32,}/g,
	// A credential named and given in the same breath (a connection string, an env line).
	/\b(?:pass(?:word)?|pwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s;,"']+["']?|\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/giu,
];
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]}]*/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const WIN_PATH = /(?<![\w\\:/])(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|\/\/[^\s/]+\/)[^\s"'`<>|*?]*/gu;
// Always hidden: a home folder (`~/`, `~user/`, `$HOME/`, `%USERPROFILE%\`), a way up out of the working folder (`../`), a Windows path with no drive (`\Users\me`) or a relative one (`c:Users\me`).
const HOME_PATH = /(?<![\w.\\/~-])(?:(?:~[\w.-]*|\$HOME|\$\{HOME\}|%[A-Za-z]+%|\.\.)[\\/]|\\[\w.$-]+\\|[A-Za-z]:[\w.-]+\\)[^\s"'`<>|*?]*/gu;
const POSIX_PATH = /(?<![\w.\\/~-])\/(?=[\w.@+~-])[^\s"'`<>|*?]*/gu;
const BASE64_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
const TAIL = /[.,;:!?)\]}]+$/u;

/** `text` with a part cut off its end that sentence punctuation owns, mapped through `fn`, and the part put back. */
const keepTail = (text: string, fn: (head: string) => string) => {
	const tail = TAIL.exec(text)?.[0] ?? "";
	return fn(text.slice(0, text.length - tail.length)) + tail;
};

/** A path found in the text: relative to `root` when it lies inside it (the lexical test, in the root's own path style), else hidden. */
function pathText(found: string, root: string | undefined): string {
	if (!root || found.startsWith("//")) return HIDDEN; // a UNC path written with slashes is never inside a root
	const style = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root) ? win32 : posix;
	if (!style.isAbsolute(found)) return HIDDEN;
	const rel = style.relative(style.resolve(root), style.resolve(found));
	if (rel === ".." || rel.startsWith(`..${style.sep}`) || style.isAbsolute(rel)) return HIDDEN;
	return rel === "" ? "." : rel.split(style.sep).join("/");
}
const hostOf = (url: string) => {
	try {
		const u = new URL(url);
		return u.username || u.password || !u.hostname ? HIDDEN : u.hostname;
	} catch {
		return HIDDEN;
	}
};

/**
 * What a main's own words may carry to a board: an absolute path inside `root` becomes relative to it, any other path (POSIX, `~/`, `C:\`, UNC) becomes `…`; a URL becomes
 * its host (`…` with userinfo, or when it names none); an email address and a secret-shaped token become `…`. Customer names cannot be found by pattern.
 * The text is cleaned first (NFKC except for `…` itself, whitespace folded, control and format characters removed, look-alike slashes made `/`), so nothing re-joins a token after the check.
 */
export function scrubBoard(raw: string, root?: string): string {
	const text = raw.replace(/[^…]+/gu, (part) => part.normalize("NFKC")).replace(/[\u2044\u2215\u29f8\u2571]/gu, "/").replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
	let out = text.replace(URL_RE, (m) => keepTail(m, hostOf)).replace(EMAIL_RE, HIDDEN);
	for (const re of SECRET) out = out.replace(re, HIDDEN);
	for (const re of [WIN_PATH, HOME_PATH, POSIX_PATH]) out = out.replace(re, (m) => keepTail(m, (p) => (re === HOME_PATH ? HIDDEN : pathText(p, root))));
	// A long run of letters and digits in both cases is a key, not a word (a path's slash and a sentence's dot end a run).
	return out.replace(BASE64_RUN, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? HIDDEN : m));
}

/**
 * The one gate for text that leaves this computer for an ally and that a person typed or a tool named: a label, a name, an opened-by, a task. It scrubs first and cuts last (a cut first leaves
 * the head of a token, a path, or an address that the scrub could no longer recognise). Every envelope field and every tool answer an ally can read goes through it; nothing else calls `scrubBoard`.
 */
export const allyLabel = (text: unknown, max: number = BOARD.label, root?: string): string => (typeof text === "string" ? clean(scrubBoard(text, root), max) : "");

/** An item is dropped when more than half of its words were scrubbed away. */
const mostlyHidden = (text: string) => {
	const words = text.split(" ");
	return words.filter((w) => w.includes(HIDDEN)).length * 2 > words.length;
};

export interface AutoInput {
	/** The session's name; empty when the user never named it (pi's default). */
	name: string;
	todos: readonly Todo[] | undefined;
	/** The project: paths inside it are written relative to it. */
	root?: string | undefined;
}
/** `who` is the scrubbed session name when there is one: what allies get of an auto entry, with the count. */
export interface Derived { text: BoardText; count?: Count; who?: string }

/**
 * The entry the todo list and the name make, or undefined when there is nothing to say: no todo list (a name alone is not work, and would stay on the board after the work is gone). `now` is `<name>: <task in progress>`, else `<name>: next <first pending>`, else
 * `<name>: done (n/n)` (written once; boardfill.ts and the readers drop it 30 minutes later); the items are the tasks, in progress first, then pending in id order, then completed, newest first. Text is cleaned and scrubbed, and only then cut to the board's caps.
 */
export function deriveBoard({ name, todos, root }: AutoInput): Derived | undefined {
	const text = (t: string, max: number) => allyLabel(t, max, root);
	const who = text(name, 40), list = todos ?? [];
	const by = (status: Todo["status"]) => list.filter((t) => t.status === status);
	if (!list.length) return undefined;
	const doing = by("in_progress")[0], pending = by("pending").sort((a, b) => a.id - b.id), done = by("completed").sort((a, b) => b.id - a.id);
	const say = (words: string) => (who ? `${who}: ${words}` : words);
	const task = doing ? say(doing.activeForm || doing.subject) : pending[0] ? say(`next ${pending[0].subject}`) : say(`done (${done.length}/${list.length})`);
	const now = text(task, BOARD.now);
	if (!now) return undefined;
	const items: BoardItem[] = [];
	let hidden = 0;
	for (const t of [...by("in_progress"), ...pending, ...done]) {
		const line = text(t.subject, BOARD.item);
		if (line && !mostlyHidden(line)) items.push({ t: line, done: t.status === "completed" });
		else hidden += 1;
	}
	// The note on hidden tasks takes the last of the eight places; it counts as done, so no reader counts it among the open tasks.
	const shown = items.slice(0, hidden ? BOARD.items - 1 : BOARD.items);
	if (hidden) shown.push({ t: `(${hidden} hidden)`, done: true });
	return { text: { now, items: shown }, ...(list.length ? { count: { done: done.length, total: list.length } } : {}), ...(who ? { who } : {}) };
}
