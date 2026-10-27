import { type GuiRecord, readRecord, urlOf } from "./handover.ts";
import type { Membership } from "./membership.ts";
import { pairingKeys, showLines } from "./pairing.ts";
import { slotOf } from "./server/record.ts";
import { type Channel, type Kit, REGISTER } from "./state.ts";

/** How a session reaches the sb server: one JSON request over its control socket. `start` says whether an absent server is started for it (the boss's own command), only when the rules allow (an automatic ask), or not at all. */
export type Ask = (request: Record<string, unknown>, options: { start: "boss" | "auto" | "never" }) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

/**
 * The session's side of the GUI. The GUI itself runs in the sb server (src/server/guihost.ts), one for the machine, and this session no longer hosts it, adopts it, or holds a dialog hub: `/boss gui` and its
 * variants ask the server over the control socket (server-look.ts), and the pairing overlay for `/boss gui remote` is drawn here from the server's answer, so the QR never reaches the server's log
 * or the model's conversation. What stays in the session is the read of the sessions on the intercom net for orphan nudges and a pop (`sessions`).
 */
export function createHost({ pi, cfg, s, guiDir, tell }: Kit, { connected, ask }: { connected: Membership["connected"]; ask?: Ask }) {
	const { copy, openUrl } = cfg;
	// /boss gui is a read-only viewer: any session may open it, and it joins nothing and writes no token. A session outside the net
	// reads the sessions through a channel of its own that never takes part in a tab (no owner, no role).
	const sessions = async () => {
		if (!s.c && !s.viewer) {
			const namespace = `straw-boss/view/${Buffer.from(cfg.env.HERDR_PANE_ID!).toString("hex")}`;
			pi.events.emit(REGISTER, { namespace, ownerEligible: false, onReady: (channel: Channel) => (s.viewer = channel), onEvent: () => {} });
			if (!s.viewer) throw new Error("pi-intercom is not loaded (Straw Boss needs pi-intercom >= 0.17.1)");
			await connected(s.viewer);
		}
		return (s.c ?? s.viewer!).listSessions();
	};
	const asking = (): Ask => ask ?? (async () => ({ ok: false, error: "The sb server is not available in this session." }));
	/** gui.json of this session's server: the page's token and CSRF secret, which a stash or a close-all posts with. */
	const record = (): GuiRecord | undefined => readRecord(slotOf(guiDir, cfg.env).dir);
	const fail = (r: { error?: string }) => tell(r.error === "stopped" ? "The straw net GUI was stopped on purpose; /boss gui starts it" : `Straw net GUI: ${r.error ?? "the sb server did not answer"}`, "error");
	const unsaved = (r: Record<string, unknown>) => void (typeof r.warning === "string" && tell(r.warning, "warning"));
	const block = (active: boolean) => pi.events.emit("herdr:blocked", { active, label: "Showing the remote pairing QR code" });

	return {
		sessions,
		/**
		 * Makes sure the server's GUI runs for a stash or a close-all, unless it was stopped on purpose (`stopped`; only /boss gui starts that one). The record gives the page's token and CSRF secret.
		 * `error` says why it is not there (the server cannot be started, or it did not answer).
		 */
		async ensure(): Promise<{ record?: GuiRecord; stopped?: boolean; error?: string }> {
			const r = await asking()({ cmd: "gui", boss: false }, { start: "auto" }).catch((error: Error) => ({ ok: false as const, error: error.message }));
			if (r.error === "stopped") return { stopped: true };
			const found = r.ok ? record() : undefined;
			return found ? { record: found } : { error: r.error ?? "the server wrote no gui.json" };
		},
		/** `mode` is "", "stop", "remote", or "remote off", and works from any session: the GUI and remote access are the server's. */
		async command(mode: string) {
			const send = (request: Record<string, unknown>, start: "boss" | "never") => asking()(request, { start }).catch((error: Error) => ({ ok: false as const, error: error.message }));
			if (mode === "stop") {
				const r = await send({ cmd: "gui-stop" }, "never");
				return r.ok ? tell(r.was ? "Straw net GUI stopped" : "The straw net GUI is not running") : tell(r.error === "no server" ? "The straw net GUI is not running" : `Straw net GUI: ${r.error}`, r.error === "no server" ? "info" : "error");
			}
			if (mode === "remote off") {
				const r = await send({ cmd: "gui-remote", on: false }, "boss");
				return r.ok ? (tell(String(r.text)), unsaved(r)) : fail(r);
			}
			if (mode === "remote") {
				const r = await send({ cmd: "gui-remote", on: true }, "boss");
				if (!r.ok) return fail(r);
				tell(String(r.text));
				unsaved(r);
				// Every key mints its own one-time link from the server, so a copied or opened link never spends the QR's code.
				const link = async () => {
					const next = await send({ cmd: "gui-pair" }, "never");
					if (!next.ok) throw new Error(`The server gave no pairing link: ${next.error}`);
					return String(next.url);
				};
				return void (Array.isArray(r.lines) && s.ui && (await showLines(s.ui, r.lines as string[], { block, keys: pairingKeys(link, copy, openUrl) })));
			}
			const r = await send({ cmd: "gui", boss: true }, "boss");
			if (!r.ok) return fail(r);
			const url = urlOf({ port: Number(r.port), token: String(r.token) } as GuiRecord);
			tell(`Straw net GUI: ${url}`);
			if (typeof r.remoteNote === "string") tell(r.remoteNote, "warning");
			// A desk shell (STRAW_BOSS_DESK=1) shows the page itself; the URL is still told.
			if (cfg.env.STRAW_BOSS_DESK !== "1") await openUrl(url).catch((error: Error) => tell(`Could not open a browser (${error.message}); open the URL above yourself`, "warning"));
		},
	};
}
