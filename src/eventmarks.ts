/** The marker and optional crash flag a tower run writes before the event body (`eventText` in runmode.ts); the GUI and head recap read them back. The head's brief opens with its own `BRIEF_MARK` and is not an event. */
export const BOSS_MARK = "[the boss writes to you from the GUI or /boss tower; this is an instruction]";
export const CRASH_FLAG = "[possibly handled by a run that crashed: check before acting]", BRIEF_MARK = "[brief from the sb server]";
export const eventIdMark = (id: string) => ` [event id: ${id}]`;
/** Read only the first line. Old session entries have no suffix. */
export const eventMarker = (line = "") => line.replace(/ \[event id: [0-9a-f]{16}\]$/, "");

/** Strip the code-written boss header and crash flag, not words the boss wrote. */
export function bossTurn(text: string | undefined): { body: string; crashed: boolean } | undefined {
	const lines = (text ?? "").split("\n");
	if (eventMarker(lines[0]) !== BOSS_MARK) return undefined;
	const crashed = lines[1] === CRASH_FLAG;
	return { body: lines.slice(crashed ? 2 : 1).join("\n"), crashed };
}

/**
 * A name from outside the sb server (an intercom sender, a device label) cleaned for a line the server or the GUI writes. An allowlist: terminal escape sequences (7- and 8-bit, finished or not) and controls become spaces, then only
 * letters, digits, spaces and ._-@ are kept (NFC first, so accented letters stay whole); the cut counts code points. Known limits (docs/how-it-works.md): bracket-like letters stay, combining marks go.
 */
export const cleanLabel = (v = "", max = 80) => [...v.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").normalize("NFC").replace(/[^\p{L}\p{N}\s._@-]/gu, "").replace(/\s+/g, " ").trim()].slice(0, max).join("");
