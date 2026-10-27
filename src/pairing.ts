import { execFileExe } from "./exe.mjs";
import { system32, system32Path } from "./winpath.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

// The pairing panel `/boss gui remote` shows in the terminal: the QR code, and keys that act on new one-time links (remote.ts mints them).
// It is an overlay, so the QR never enters the conversation the model reads.

/** The pairing overlay's keys. Each mints its own one-time link, so a copied or opened link never spends the QR's code. */
export const pairingKeys = (link: () => string, copy: (text: string) => Promise<void>, open: (url: string) => Promise<void>): Record<string, () => Promise<string>> => ({
	c: async () => (await copy(link()), "Copied a new one-time link; it works once, within ten minutes."),
	o: async () => (await open(link()), "Opened a new one-time link in this computer's browser."),
});

/** The clipboard command: on Windows `clip.exe` by absolute path (a bare name is looked for in the current folder first). */
export const clipboardCommand = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) =>
	platform === "darwin" ? ["pbcopy"] : platform === "win32" ? [system32Path("clip.exe", env)] : env.WAYLAND_DISPLAY ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
const CLIPBOARD = clipboardCommand();
/** Puts text on the system clipboard (`command` is for tests). */
export const copyText = (text: string, [cmd, ...args] = CLIPBOARD) =>
	new Promise<void>((done, fail) => {
		const child = execFileExe(cmd!, args, { timeout: 5_000, ...(process.platform === "win32" && cmd === CLIPBOARD[0] ? { cwd: system32() } : {}) }, (error) => (error ? fail(new Error(`Could not copy with ${cmd}: ${error.message}`)) : done()));
		// A missing command fails the child; its stdin then errors too (EPIPE), which unhandled would take the host pi down.
		child?.stdin?.on("error", () => {}).end(text);
	});

/**
 * Shows lines in an overlay, so the pairing QR stays out of the conversation the model reads; `keys` run on their letter and say what they did
 * under it. While it is open the overlay takes every key, so `block` reports the session as waiting on a dialog (Herdr's `herdr:blocked`):
 * input from the GUI or Herdr is refused instead of vanishing into it.
 */
export async function showLines(ui: ExtensionContext["ui"], lines: string[], { block = () => {}, keys = {} }: { block?: (active: boolean) => void; keys?: Record<string, () => Promise<string>> } = {}) {
	const wide = Math.max(...lines.map((line) => [...line].length));
	const wrap = (text: string, width: number) => text.split(" ").reduce<string[]>((out, word) => ([...(out.at(-1) ?? "")].length + word.length < width && out.length ? (out[out.length - 1] += ` ${word}`) : out.push(word), out), []);
	const narrow = (width: number) => [...wrap(`This pane is ${width} columns wide; the QR code needs ${wide}. Widen it, or use Phone in the GUI.`, width), "", ...lines.slice(-3).flatMap((line) => wrap(line, width))];
	block(true);
	try {
		await ui.custom<void>((tui, _theme, _keys, done) => {
			let said = "";
			return {
				render: (width) => [...(width < wide ? narrow(width) : lines), ...(said ? ["", ...wrap(said, width)] : [])].map((line) => [...line].slice(0, width).join("")),
				invalidate() {},
				// pi-tui's matcher, not raw bytes: with the kitty keyboard protocol on, Escape and letters can arrive as escape sequences.
				handleInput(data) {
					if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) return done();
					const run = Object.entries(keys).find(([key]) => matchesKey(data, key as "c"))?.[1];
					if (run) void run().catch((error: Error) => error.message).then((text) => ((said = text), tui.requestRender()));
				},
			};
		});
	} finally {
		block(false);
	}
}
