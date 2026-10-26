import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The key that takes a session's queue back, as pi's own keybindings have it (`app.message.dequeue`). pi's default is Alt+Up, but Alt+Q where it
// uses its Windows keybindings (Windows, and Linux under WSL: dist/core/keybindings.js useWindowsKeybindings), and a user's keybindings.json may
// move it anywhere. pi gives extensions no way to read its keybindings or to run the action, so the session's bridge (which runs inside pi, on
// the same platform and with the same PI_CODING_AGENT_DIR) works the key out the way pi does and tells the server, which sends that key.

/** The keys the server will press for a take-back, as Herdr names them: one modifier and a letter or a move, never a key that stops or ends pi (Ctrl+C clears the editor, Ctrl+D leaves, Ctrl+Z stops). */
export const DEQUEUE_KEY = /^(?:alt\+(?:[a-z]|up|down|left|right|enter|backspace)|ctrl\+(?:[abe-y]|left|right))$/;

/** pi's own test for its Windows key set: Windows, or Linux under WSL. */
export const windowsKeys = (platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) => platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));

/** What pi binds to dequeue when keybindings.json says nothing. */
export const defaultDequeue = (platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) => (windowsKeys(platform, env) ? "alt+q" : "alt+up");

/** The key as the page names it: "alt+q" is Alt+Q. */
export const keyLabel = (key: string) => key.split("+").map((part) => (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))).join("+");

/** A pi key id as Herdr names it, or undefined when it is not one the server presses (more than one modifier, Shift, a key outside DEQUEUE_KEY). */
const sendable = (id: unknown): string | undefined => {
	const key = typeof id === "string" ? id.trim().toLowerCase() : "";
	return DEQUEUE_KEY.test(key) ? key : undefined;
};

/** What the user's keybindings.json binds to dequeue: undefined when it does not (the default stands), else the list of key ids, which may be empty (unbound). pi's own migration of the old name `dequeue` yields to the new one. */
function bound(agentDir: string): unknown[] | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, "keybindings.json"), "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined; // no file, or one pi cannot read either: pi uses its defaults
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const config = raw as Record<string, unknown>, value = Object.hasOwn(config, "app.message.dequeue") ? config["app.message.dequeue"] : config.dequeue;
	return typeof value === "string" ? [value] : Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined; // pi drops a value of any other shape
}

/**
 * The key to press for pi's dequeue: the first of the user's bindings the server can press, else, when keybindings.json does not bind it, the platform's
 * default. `undefined` when it is bound only to keys the server will not press (or to none): pressing a default there would do something else.
 */
export function dequeueKey({ platform = process.platform, env = process.env }: { platform?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
	const agentDir = env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[\\/])/, homedir()) || join(homedir(), ".pi", "agent");
	const ids = bound(agentDir);
	return ids ? ids.map(sendable).find((key) => key !== undefined) : defaultDequeue(platform, env);
}
