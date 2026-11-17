import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The one language of sb's own words (docs/how-it-works.md, Language): the sb server's (the stand-in, the head's label, the briefs' card language), the tower prompt's, a tower run's, and the /boss commands'.
// `locale` in `<state dir>/config.json` ("zh-TW" or "en") wins; without it the environment says, as a shell reads it (LC_ALL, then LC_MESSAGES, then LANG), else the system's own language. Every other language,
// Simplified Chinese included, is English. Plain Node: the tower prompt loads it. A card keeps the language it was written in.

export type Locale = "en" | "zh-TW";
export const LOCALES: readonly Locale[] = ["zh-TW", "en"];
export const isLocale = (value: unknown): value is Locale => value === "zh-TW" || value === "en";

/** The language the environment names; with none set, the system's own. */
export function envLocale(env: NodeJS.ProcessEnv): Locale {
	const set = env.LC_ALL || env.LC_MESSAGES || env.LANG || systemLanguage();
	return /^zh[_-](tw|hk|mo|hant)/i.test(set) ? "zh-TW" : "en";
}
function systemLanguage(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale;
	} catch {
		return "en";
	}
}

const configOf = (stateDir: string) => join(stateDir, "config.json");
/** The setting in `config.json`: undefined when it is absent, the file is missing or unreadable, or the value is no locale this build knows (the environment decides then). */
export function localeSetting(stateDir: string | undefined): Locale | undefined {
	if (!stateDir) return undefined;
	try {
		const value = (JSON.parse(readFileSync(configOf(stateDir), "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown> | null)?.locale;
		return isLocale(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
/** sb's language: the setting in `<stateDir>/config.json`, else the environment's. Read at each call, so a change counts at once. */
export const localeOf = (env: NodeJS.ProcessEnv, stateDir?: string): Locale => localeSetting(stateDir) ?? envLocale(env);

/**
 * Sets `locale` in `config.json` (`auto` removes it), keeping every other key; written by rename, 2-space JSON. A file that cannot be parsed, or holds no JSON object, is refused and left as it is.
 * Returns the setting now in force.
 */
export function writeLocale(stateDir: string, value: Locale | "auto"): Locale | undefined {
	const file = configOf(stateDir);
	let text: string | undefined;
	try {
		text = readFileSync(file, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file} cannot be read (${(cause as Error).message}); the language is unchanged`);
	}
	let config: Record<string, unknown> = {};
	if (text !== undefined && text.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
		} catch (cause) {
			throw new Error(`${file} cannot be parsed (${(cause as Error).message}); fix it first, the language is unchanged`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} holds no JSON object; fix it first, the language is unchanged`);
		config = parsed as Record<string, unknown>;
	}
	const { locale: _, ...rest } = config;
	const next = value === "auto" ? rest : { ...rest, locale: value };
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
	} catch (cause) {
		rmSync(temp, { force: true });
		throw cause;
	}
	return value === "auto" ? undefined : value;
}

const WORDS = {
	en: {
		usage: "Usage: /boss locale [zh-TW | en | auto]",
		shown: (now: Locale, set: Locale | undefined) => `sb's language: ${now === "zh-TW" ? "Traditional Chinese (zh-TW)" : "English (en)"}, ${set ? "set in config.json (locale)" : "from the environment (LC_ALL, LC_MESSAGES, LANG); /boss locale zh-TW or en sets it"}.`,
		set: (now: Locale, set: Locale | undefined) => `sb's language is now ${now === "zh-TW" ? "Traditional Chinese (zh-TW)" : "English (en)"}${set ? "" : ", from the environment"}: the sb server and /boss commands use it at once, a tower prompt from its next start, a tower run from its next brief. Cards already written keep theirs.`,
	},
	"zh-TW": {
		usage: "用法：/boss locale [zh-TW | en | auto]",
		shown: (now: Locale, set: Locale | undefined) => `sb 的語言：${now === "zh-TW" ? "繁體中文（zh-TW）" : "英文（en）"}，${set ? "由 config.json 的 locale 設定" : "取自環境變數（LC_ALL、LC_MESSAGES、LANG）；用 /boss locale zh-TW 或 en 設定"}。`,
		set: (now: Locale, set: Locale | undefined) => `sb 的語言改為${now === "zh-TW" ? "繁體中文（zh-TW）" : "英文（en）"}${set ? "" : "，取自環境變數"}：sb 伺服器與 /boss 指令立即生效，塔台提示在下次啟動時、塔台執行在下次簡報時生效；已寫好的卡片保留原本的語言。`,
	},
};

/** `/boss locale [zh-TW | en | auto]`: shows the language and where it comes from, or sets it. Returns the line to tell and whether it is a warning. */
export function localeCommand(args: string, env: NodeJS.ProcessEnv, stateDir: string): { text: string; warn?: true } {
	const word = args.trim(), before = localeOf(env, stateDir);
	if (!word) return { text: WORDS[before].shown(before, localeSetting(stateDir)) };
	const value = word.toLowerCase() === "auto" ? "auto" : LOCALES.find((l) => l.toLowerCase() === word.toLowerCase());
	if (!value) return { text: WORDS[before].usage, warn: true };
	const set = writeLocale(stateDir, value), now = localeOf(env, stateDir);
	return { text: WORDS[now].set(now, set) };
}
