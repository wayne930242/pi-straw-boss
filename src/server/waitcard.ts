import { BASE64_RUN, SECRET } from "../boardauto.ts";
import { clean } from "../board.ts";

// The card of a wait for the boss (docs/specs/2026-11-07-wait-cards.md, The tool): pure checks of the fields a tower run gives `tower_memory`, and the shapes the stored entry keeps. The checks look at shape, length, URL form, command form, secret shape, and
// `from`; they never judge or refuse on language (WC-D3). Every failing field is listed in one refusal, so a single retry can fix them all.

export const CARD = { happened: 160, do: 160, url: 300, command: 300, commandLines: 4, after: 160, label: 24, then: 120, name: 60, from: 200, optionsMin: 2, optionsMax: 4, reason: 120, dueMin: 5, dueMax: 7 * 24 * 60 } as const;
export type CardType = "action" | "choice" | "secret";
export type Lang = "zh-TW" | "en";
export const TYPES: readonly CardType[] = ["action", "choice", "secret"];
/** The session that raised a wait, as the net named it at the write; `gone`: it was not live then. */
export interface Raiser { id: string; name: string; role: string; workspace?: string; tab?: string; gone?: true }
export interface Option { label: string; then: string }
export interface Card {
	type: CardType;
	/** The locale the brief named when the card was written, for display only. */
	lang: Lang;
	happened: string;
	do: string;
	url?: string;
	command?: string;
	after?: string;
	options?: Option[];
	secret?: { name: string };
	/** Absent for `self`: the tower raised the wait itself. */
	from?: Raiser;
}
/** The words of the done button, in the card's language: the brief and the tower's event name what the boss pressed. */
export const DONE_LABEL: Record<Lang, string> = { "zh-TW": "我做完了", en: "I'm done" };
export const ACTS = ["done", "choose", "secret", "decline", "restate"] as const;
export type Act = (typeof ACTS)[number];
/** `asked`: the raiser asked the boss itself (`boss_wait_ask`), so the tool's result told it and no notice was sent. */
export type Delivery = "delivered" | "queued" | "gone" | "failed" | "asked";
/** What the boss pressed, when, and whether the raiser got the notice. `secretAsked`: the first step of a secret card was taken at this time. */
export interface Press { act: Act; option?: number; reason?: string; at: string; main?: { status: Delivery; at: string }; secretAsked?: string }

const chars = (text: string) => Array.from(text).length;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v !== "" && chars(v) <= max;

/** Whether a stored `card` has the shape this build writes; one that fails reads as a legacy wait. */
export function isCard(value: unknown): value is Card {
	const c = value as Partial<Card> | null;
	if (typeof c !== "object" || c === null || !TYPES.includes(c.type as CardType) || (c.lang !== "zh-TW" && c.lang !== "en")) return false;
	if (!isText(c.happened, 4000) || !isText(c.do, 4000)) return false;
	for (const key of ["url", "command", "after"] as const) if (c[key] !== undefined && !isText(c[key], 4000)) return false;
	if (c.options !== undefined && (!Array.isArray(c.options) || !c.options.every((o) => typeof o === "object" && o !== null && isText((o as Option).label, 200) && isText((o as Option).then, 4000)))) return false;
	if (c.secret !== undefined && !(typeof c.secret === "object" && c.secret !== null && isText(c.secret.name, 400))) return false;
	if (c.type === "choice" && !(c.options && c.options.length >= 2)) return false;
	if (c.type === "secret" && !c.secret) return false;
	const f = c.from as Partial<Raiser> | undefined;
	return f === undefined || (typeof f === "object" && f !== null && isText(f.id, 400) && isText(f.name, 400) && typeof f.role === "string");
}
export function isPress(value: unknown): value is Press {
	const p = value as Partial<Press> | null;
	return typeof p === "object" && p !== null && ACTS.includes(p.act as Act) && typeof p.at === "string" && (p.option === undefined || Number.isInteger(p.option)) && (p.main === undefined || (typeof p.main === "object" && p.main !== null && typeof p.main.at === "string"));
}

const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g;
// The board's last pattern names a credential in the same breath (`token: x`); a card narrows it: the value has to look like a secret (six characters or more, a letter and a digit), so "the token: expired" passes.
const KEY_VALUE = /\b(?:pass(?:word)?|pwd|secret|token|api[_-]?key)\s*[=:]\s*["']?([^\s;,"']+)["']?/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/gu;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const NAMED = (re: RegExp) => re.source.startsWith("\\b(?:pass(?:word)?");
const PATTERNS = SECRET.filter((re) => !NAMED(re));
const keyed = (text: string) => [...text.matchAll(KEY_VALUE)].some((m) => m[1]!.length >= 6 && /[A-Za-z]/.test(m[1]!) && /\d/.test(m[1]!));
const mixedRun = (text: string) => (text.match(BASE64_RUN) ?? []).some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run));

/**
 * Whether `text` has the shape of a credential: a pattern of the board's scrub (the key-and-value one narrowed, above), a bearer token, a PEM header, or a long mixed run of base64 characters.
 * `path`: the text is the path of a URL, where a commit's hash or a document's id is ordinary: only the named key shapes count there, not a long hex or mixed run.
 */
export function secretShaped(text: string, { path = false }: { path?: boolean } = {}): boolean {
	if (PEM.test(text) || keyed(text) || text.search(BEARER) >= 0) return true;
	if (PATTERNS.some((re) => (path && re.source === HEX_RUN.source ? false : text.search(re) >= 0))) return true;
	return !path && mixedRun(text);
}
/** A parsed URL's secret check: its path leniently, everything else (user, query, fragment) in full. */
const urlSecretShaped = (u: URL) => secretShaped(u.pathname, { path: true }) || secretShaped(`${u.host}${u.search}${u.hash}`);

export interface CheckContext {
	/** The ids of the senders of the intercom events this run took. */
	senders: ReadonlySet<string>;
	/** The locale the brief named. */
	lang?: Lang;
	/** An open or answered boss wait that `restates` may name: what it has to carry, or nothing when there is no such wait. */
	restates(id: string): { from?: Raiser } | undefined;
}
export type Checked =
	| { ok: true; card: Omit<Card, "from">; from: "self" | { id: string } | { carried: Raiser } | { none: true }; restates?: string; dueMin?: number }
	| { ok: false; lines: string[] };

const NO_SECRET = "looks like a secret or a key. A wait never carries one: name it in secret.name and use type secret";
const WHAT = {
	happened: "Say what happened in one or two plain sentences.",
	do: "Say what the boss does, as an instruction to a person (for a choice, the question; for a secret, which secret and how to get it).",
	after: "Say what happens once the boss has done it: what the tower or the main does next.",
};
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
// A control or format character other than a line break: a command keeps its lines and nothing else.
const BAD_COMMAND = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

/** The first 40 characters of what was given, for a refusal line. */
const shown = (text: string) => `"${chars(text) > 40 ? `${Array.from(text).slice(0, 40).join("")}…` : text}"`;

/** A boss wait's fields, checked. `lines` lists every field that fails, in the order of the table in the spec; nothing is kept on a failure. */
export function checkCard(args: Record<string, unknown>, ctx: CheckContext): Checked {
	const lines: string[] = [];
	const fail = (field: string, what: string) => void lines.push(`- ${field}: ${what}`);
	const type = TYPES.find((t) => t === args.type);
	if (args.type === undefined || args.type === "") fail("type", "missing. Say what kind of card it is: action (the boss does something), choice (the boss picks one option), or secret (a session needs a secret from the boss).");
	else if (!type) fail("type", `${shown(String(args.type))} is not action, choice, or secret`);

	/** A required or optional one-line text field; the cleaned text, or undefined when it failed or is absent. */
	const field = (name: "happened" | "do" | "after", max: number, required: boolean): string | undefined => {
		const raw = args[name];
		if (raw === undefined || (typeof raw === "string" && !raw.trim())) return (required && fail(name, `missing. ${WHAT[name]}`), undefined);
		if (typeof raw !== "string") return (fail(name, "has to be text"), undefined);
		const text = clean(raw, 1_000_000);
		if (!text) return (required && fail(name, `missing. ${WHAT[name]}`), undefined);
		if (chars(text) > max) return (fail(name, `too long: at most ${max} characters`), undefined);
		if (secretShaped(text)) return (fail(name, NO_SECRET), undefined);
		return text;
	};
	const happened = field("happened", CARD.happened, true), doing = field("do", CARD.do, true);
	if (happened && doing && norm(happened) === norm(doing)) fail("do", "says the same as happened: say what the boss does");
	const after = field("after", CARD.after, type === "action" || type === "secret");

	let url: string | undefined;
	if (args.url !== undefined && args.url !== "") {
		const raw = typeof args.url === "string" ? args.url.trim() : "";
		let parsed: URL | undefined;
		try { parsed = /\s|[\u0000-\u001f\u007f-\u009f]/.test(raw) ? undefined : new URL(raw); } catch { /* reported below */ }
		if (chars(raw) > CARD.url) fail("url", `too long: at most ${CARD.url} characters`);
		else if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) fail("url", `${shown(raw)} is not an http(s) address. Give the page's https address, or a command instead.`);
		else if (parsed.username || parsed.password) fail("url", `${shown(raw)} has a user name or password in it. Give the address without them.`);
		else if (chars(parsed.href) > CARD.url) fail("url", `too long: at most ${CARD.url} characters`);
		else if (urlSecretShaped(parsed)) fail("url", NO_SECRET);
		else url = parsed.href;
	}
	let command: string | undefined;
	if (args.command !== undefined && args.command !== "") {
		const raw = typeof args.command === "string" ? args.command.replace(/\r\n?/g, "\n").trim() : undefined;
		if (raw === undefined || BAD_COMMAND.test(raw) || raw.split("\n").length > CARD.commandLines) fail("command", "a command is plain text of at most 4 lines");
		else if (chars(raw) > CARD.command) fail("command", `too long: at most ${CARD.command} characters`);
		else if (secretShaped(raw)) fail("command", NO_SECRET);
		else command = raw;
	}
	if (type === "action" && !url && !command && !lines.some((l) => /^- (url|command): /.test(l))) fail("url", "missing. An action says where the boss does it: give url (an https address) or command (a command they run themselves).");

	let options: Option[] | undefined;
	if (type === "choice") {
		const raw = args.options;
		if (!Array.isArray(raw) || raw.length < CARD.optionsMin || raw.length > CARD.optionsMax) fail("options", `a choice has ${CARD.optionsMin} to ${CARD.optionsMax} options, each { label, then }`);
		else {
			const got: Option[] = [], before = lines.length;
			raw.forEach((o, i) => {
				const v = (typeof o === "object" && o !== null ? o : {}) as { label?: unknown; then?: unknown };
				const label = typeof v.label === "string" ? clean(v.label, 1_000_000) : "", then = typeof v.then === "string" ? clean(v.then, 1_000_000) : "";
				if (!label || !then) return fail("options", `option ${i + 1} needs a label and a then`);
				if (chars(label) > CARD.label) return fail("options", `option ${i + 1} label too long: at most ${CARD.label} characters`);
				if (chars(then) > CARD.then) return fail("options", `option ${i + 1} then too long: at most ${CARD.then} characters`);
				if (secretShaped(label) || secretShaped(then)) return fail("options", `option ${i + 1} ${NO_SECRET}`);
				got.push({ label, then });
			});
			const seen = new Set<string>();
			for (const o of got) {
				if (seen.has(norm(o.label))) { fail("options", `labels must differ: "${o.label}" is there twice`); break; }
				seen.add(norm(o.label));
			}
			if (lines.length === before) options = got;
		}
	} else if (args.options !== undefined) fail("options", "only a choice card has options");

	let secret: { name: string } | undefined;
	if (type === "secret") {
		const name = (args.secret as { name?: unknown } | undefined)?.name;
		if (typeof name !== "string" || !name.trim()) fail("secret", "missing. Name the secret in secret.name (what it is, never its value).");
		else {
			const text = clean(name, 1_000_000);
			if (chars(text) > CARD.name) fail("secret", `name too long: at most ${CARD.name} characters`);
			else if (secretShaped(text)) fail("secret", NO_SECRET);
			else secret = { name: text };
		}
	} else if (args.secret !== undefined) fail("secret", "only a secret card has secret");

	// `from` is checked against what this run received; `restates` carries the old wait's raiser when none is given.
	let restates: string | undefined, carried: { from?: Raiser } | undefined;
	if (args.restates !== undefined) {
		const id = typeof args.restates === "string" ? args.restates : "";
		carried = /^W\d+$/.test(id) ? ctx.restates(id) : undefined;
		if (!carried) fail("restates", `No such wait ${id || String(args.restates)} to restate`);
		else restates = id;
	}
	let from: Extract<Checked, { ok: true }>["from"] | undefined;
	const given = args.from;
	if (given === undefined || given === "") {
		if (carried?.from) from = { carried: carried.from };
		else if (!carried) fail("from", 'missing. Name the session id from the [intercom from …] line of the message that raised it, or "self" when you raised it yourself.');
		else fail("from", 'missing. The wait you restate has no raiser to carry: name the session id from the [intercom from …] line, or "self".');
	} else if (typeof given !== "string" || chars(given) > CARD.from) fail("from", `too long or not text: at most ${CARD.from} characters`);
	else if (given === "self") {
		if (type === "secret") fail("from", 'self cannot raise a secret card: only a session can call secret_drop. Name the session id from the [intercom from …] line of the message that raised it.');
		else from = "self";
	} else if (!ctx.senders.has(given)) fail("from", `${clean(given, 80)} sent you nothing in this run. Name the session id from the [intercom from …] line of the message that raised it, or "self" when you raised it yourself`);
	else from = { id: given };

	if (args.text !== undefined) fail("text", "a wait for the boss takes the card fields (happened, do, …), not text");
	if (args.on !== undefined) fail("on", "a wait for the boss names no session");
	let dueMin: number | undefined;
	if (args.due !== undefined) {
		if (typeof args.due !== "number" || !Number.isFinite(args.due) || args.due < CARD.dueMin || args.due > CARD.dueMax) fail("due", `5 to 10080 minutes (${CARD.dueMin} to ${CARD.dueMax})`);
		else dueMin = args.due;
	}

	if (lines.length) return { ok: false, lines };
	return {
		ok: true, from: from!, ...(restates ? { restates } : {}), ...(dueMin !== undefined ? { dueMin } : {}),
		card: { type: type!, lang: ctx.lang ?? "en", happened: happened!, do: doing!, ...(url ? { url } : {}), ...(command ? { command } : {}), ...(after ? { after } : {}), ...(options ? { options } : {}), ...(secret ? { secret } : {}) },
	};
}

/** The refusal a run reads: every failing field at once. */
export const refusalText = (lines: string[]): string =>
	`Not recorded: a wait for the boss is a card they act on, and ${lines.length} field${lines.length === 1 ? " needs" : "s need"} a fix (nothing was kept; call tower_memory again with every field).\n${lines.join("\n")}`;
