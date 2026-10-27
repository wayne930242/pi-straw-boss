import { createHash } from "node:crypto";

// What the dialog bridge (bridge.ts, in every pi session) and the hub (dialogs.ts, in the sb server) agree on, apart from the bridge's own code: bridge.ts imports pi's packages, and the server must not.

/** pi-intercom's extension API as a constant: the event a module registers a channel on. */
export const REGISTER = "intercom:extension-register";
/** The channel of one GUI server's hub: only the server's intercom session `g` is owner-eligible on it. */
export const guiNamespace = (g: string) => `straw-boss/gui/${createHash("sha256").update(g).digest("hex").slice(0, 32)}`;
/** At most this many queued messages go to the GUI (the oldest, which are delivered first), each cut to this many characters. */
export const MAX_QUEUED = 5, QUEUED_TEXT = 200;
