/** The two lines the sb server writes at the head of a tower run's event (runmode.ts `eventText`); the GUI reads them back (gui/towerturns.ts), so both share these. */
export const BOSS_MARK = "[the boss writes to you from the GUI or /boss tower; this is an instruction]";
export const CRASH_FLAG = "[possibly handled by a run that crashed: check before acting]";

/**
 * A name from outside the sb server (an intercom sender, a device label) cleaned for a line the server or the GUI writes. An allowlist: terminal escape sequences (7- and 8-bit, finished or not) and controls become spaces, then only
 * letters, digits, spaces and ._-@ are kept (NFC first, so accented letters stay whole); the cut counts code points. Known limits (docs/how-it-works.md): bracket-like letters stay, combining marks go.
 */
export const cleanLabel = (v = "", max = 80) => [...v.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").normalize("NFC").replace(/[^\p{L}\p{N}\s._@-]/gu, "").replace(/\s+/g, " ").trim()].slice(0, max).join("");
