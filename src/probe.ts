import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// What Enter would submit from a session's own editor, for the key pad's Enter guard (keys.ts). The bridge (bridge.ts) answers the GUI
// server's probe with a class and at most a command name: the draft itself never leaves the session. The rule for which commands end or
// replace the session lives here, once, for the composer's typed text (control.ts) and the key pad's Enter alike.

/** Commands that end the session or switch its pane to another one: the page asks first, and the server refuses them unconfirmed. */
export const ENDING = /^\s*\/(quit|exit|new|resume|fork|clone|import|reload)(?=\s|$)/;
/** `command`: a draft that starts with `/` and is no ending command: with pi's command menu open (tab, backspace), Enter completes it and
 *  runs the result at once, so it may become any command, an ending one included. A `!` draft is one too: Enter runs it as a shell
 *  command, and `up` recalls earlier ones from history. */
export interface Editor { editor: "empty" | "text" | "command" | "unknown"; ending?: string }
const EDITORS = ["empty", "text", "command", "unknown"];

/** The session's editor as a class: empty, an ending command (by name), another slash command, other text, or unknown without a UI. */
export function probeEditor(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined): Editor {
	let text: unknown;
	try {
		text = ctx?.hasUI ? ctx.ui.getEditorText() : undefined;
	} catch {} // a UI that cannot say is unknown
	if (typeof text !== "string") return { editor: "unknown" };
	const ending = ENDING.exec(text)?.[1];
	return !text.trim() ? { editor: "empty" } : ending ? { editor: "text", ending } : /^\s*[/!]/.test(text) ? { editor: "command" } : { editor: "text" };
}

/** A bridge's answer as the server takes it: one of the classes, and an ending only when it names one of the commands above. */
export function checkProbe(p: Record<string, unknown> | undefined): Editor | undefined {
	if (!p || !EDITORS.includes(p.editor as string)) return undefined;
	if (p.ending === undefined) return { editor: p.editor as Editor["editor"] };
	return p.editor === "text" && typeof p.ending === "string" && ENDING.test(`/${p.ending}`) && /^[a-z]+$/.test(p.ending) ? { editor: "text", ending: p.ending } : undefined;
}
