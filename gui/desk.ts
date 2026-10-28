// Desk mode in the page (desk-mode spec S9): a server that runs with STRAW_BOSS_DESK=1 marks the page with <meta name="sb-desk" content="1">, and the page, which reads it once at load,
// leaves out GUI remote access (the HUD's Phone button and its tile) and stash (each base's Stash button, the HUD's Stashed button and list). It is presentation only: the server's routes stay.

/** Whether the page carries the desk marker. */
export const deskMode = (doc: Pick<Document, "querySelector"> = document): boolean => doc.querySelector<HTMLMetaElement>('meta[name="sb-desk"]')?.content === "1";

/** This page's mode, read when the page loads (a node test has no page: normal mode). */
export const desk = typeof document !== "undefined" && deskMode();

/** Whether the HUD's Phone button is hidden: in desk mode always, otherwise on any page but this computer's own (a paired device comes in by its tailnet name: remote.ts). */
export const phoneHidden = (hostname: string, off = desk) => off || hostname !== "127.0.0.1";
