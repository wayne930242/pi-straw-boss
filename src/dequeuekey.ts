import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Key } from "@earendil-works/pi-tui";

// The key that takes a session's queue back, as pi's own keybindings have it (`app.message.dequeue`). pi's default is Alt+Up, but Alt+Q where it
// uses its Windows keybindings (Windows, and Linux under WSL: dist/core/keybindings.js useWindowsKeybindings), and a user's keybindings.json may
// move it anywhere. An extension can read pi's live bindings (pi-tui's `getKeybindings()`, which pi's loader aliases to its own instance) but cannot
// run the action, so the session's bridge (which runs inside pi) names the key and tells the server, which sends it. Where the live manager lacks
// the id, the bridge works the key out from keybindings.json the way pi does.

/** The keys the server will press for a take-back, as Herdr names them: one modifier and a letter or a move, never a key that stops or ends pi (Ctrl+C clears the editor, Ctrl+D leaves, Ctrl+Z stops). */
export const DEQUEUE_KEY = /^(?:alt\+(?:[a-z]|up|down|left|right|enter|backspace)|ctrl\+(?:[abe-y]|left|right))$/;

/** pi's own test for its Windows key set: Windows, or Linux under WSL. */
export const windowsKeys = (platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) => platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));

/** What pi binds to dequeue when keybindings.json says nothing. */
export const defaultDequeue = (platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) => (windowsKeys(platform, env) ? "alt+q" : "alt+up");

/** The key as the page names it: "alt+q" is Alt+Q. */
export const keyLabel = (key: string) => key.split("+").map((part) => (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))).join("+");

const MODIFIERS = ["ctrl", "shift", "alt", "super"];
const BASE_KEYS = new Set<string>(Object.values(Key).filter((v) => typeof v === "string") as string[]);

/** pi's KeyIdSchema (dist/core/key-id-schema.js): lowercase only, no spaces, at most four distinct modifiers, then a letter, a digit, or a named key. */
export function validKeyId(id: unknown): boolean {
	if (typeof id !== "string") return false;
	const parts = id.split("+"), base = parts.pop()!;
	if (parts.length > 4 || new Set(parts).size !== parts.length || !parts.every((m) => MODIFIERS.includes(m))) return false;
	return /^[a-z0-9]$/.test(base) || BASE_KEYS.has(base);
}

/** A pi key id as Herdr names it, or undefined when it is not one the server presses (more than one modifier, Shift, a key outside DEQUEUE_KEY). */
const sendable = (id: unknown): string | undefined => (typeof id === "string" && DEQUEUE_KEY.test(id) ? id : undefined);

/** What the user's keybindings.json binds to dequeue: undefined when it does not (or when pi would drop the value: the default stands), else the list of key ids, which may be empty (unbound). Like pi, one invalid id drops the whole value. pi's migration of the old name `dequeue` yields to the new one. */
function bound(agentDir: string): string[] | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined; // no file, or one pi cannot read either: pi uses its defaults
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const config = raw as Record<string, unknown>, value = Object.hasOwn(config, "app.message.dequeue") ? config["app.message.dequeue"] : config.dequeue;
	const ids = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
	return ids?.every(validKeyId) ? (ids as string[]) : undefined;
}

/** pi's live bindings for dequeue, or undefined when the live manager does not know the id (pi-tui's own default manager, outside pi). */
function live(): string[] | undefined {
	try {
		const manager = getKeybindings(), id = "app.message.dequeue" as never;
		return manager.getDefinition(id) === undefined ? undefined : manager.getKeys(id);
	} catch {
		return undefined;
	}
}

/** pi's agent directory as this bridge's environment names it (getAgentDir reads process.env, and normalizes a Git Bash path on Windows). */
const agentDirOf = (env: NodeJS.ProcessEnv) => (env === process.env || env.PI_CODING_AGENT_DIR === process.env.PI_CODING_AGENT_DIR ? getAgentDir() : env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[\\/])/, homedir()) || join(homedir(), ".pi", "agent"));

/**
 * The key to press for pi's dequeue: the first of pi's live bindings the server can press; where the live manager lacks the id, the first of the user's
 * keybindings.json the server can press, else the platform's default. `undefined` when it is bound only to keys the server will not press (or to none):
 * pressing a default there would do something else.
 */
export function dequeueKey({ platform = process.platform, env = process.env, bindings = live }: { platform?: string; env?: NodeJS.ProcessEnv; bindings?: () => string[] | undefined } = {}): string | undefined {
	const keys = bindings();
	if (keys) return keys.map(sendable).find((key) => key !== undefined);
	const ids = bound(agentDirOf(env));
	return ids ? ids.map(sendable).find((key) => key !== undefined) : defaultDequeue(platform, env);
}
