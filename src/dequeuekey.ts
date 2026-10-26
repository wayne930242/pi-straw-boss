// The key that takes a session's queue back, as pi's own keybindings have it (`app.message.dequeue`). pi's default is Alt+Up, but Alt+Q where it
// uses its Windows keybindings (Windows, and Linux under WSL: dist/core/keybindings.js useWindowsKeybindings), and a user's keybindings.json may
// move it anywhere. An extension can read pi's live bindings (pi-tui's `getKeybindings()`, which pi's loader aliases to its own instance) but cannot
// run the action, so the session's bridge (which runs inside pi) names the key and tells the server, which sends it. Where the live manager lacks
// the id, the bridge works the key out from keybindings.json the way pi does (dequeuebind.ts). This module imports nothing from pi, so the server
// side (control.ts, keys.ts, pull.ts) can load it without a pi.

/** The keys the server will press for a take-back, as Herdr names them: one modifier and a letter or a move, never a key that stops or ends pi (Ctrl+C clears the editor, Ctrl+D leaves, Ctrl+Z stops). */
export const DEQUEUE_KEY = /^(?:alt\+(?:[a-z]|up|down|left|right|enter|backspace)|ctrl\+(?:[abe-y]|left|right))$/;

/** pi's own test for its Windows key set: Windows, or Linux under WSL. */
export const windowsKeys = (platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) => platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));

/** What pi binds to dequeue when keybindings.json says nothing. */
export const defaultDequeue = (platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) => (windowsKeys(platform, env) ? "alt+q" : "alt+up");

/** The key as the page names it: "alt+q" is Alt+Q. */
export const keyLabel = (key: string) => key.split("+").map((part) => (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))).join("+");
