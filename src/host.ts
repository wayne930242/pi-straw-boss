import { type GuiRecord, readRecord, urlOf } from "./handover.ts";
import type { Membership } from "./membership.ts";
import { every, type LanDeps, type LanReply, revealFiles, showLan } from "./lanface.ts";
import { pairingKeys, showLines } from "./pairing.ts";
import { OPEN_LINE } from "./remote.ts";
import { slotOf } from "./server/record.ts";
import { type Channel, type Kit, REGISTER } from "./state.ts";

/** How a session reaches the sb server: one JSON request over its control socket. `start` says whether an absent server is started for it (the boss's own command), only when the rules allow (an automatic ask), or not at all. */
export type Ask = (request: Record<string, unknown>, options: { start: "boss" | "auto" | "never" }) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

/** What `/boss gui rotate` tells before it does anything. */
const ROTATE_WARNING = "The GUI gets a new address and a new CSRF secret: every open page stops working, and every paired phone is unpaired (a phone pairs again with a QR code or the pairing code). Use it when the address may have leaked.";

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
	// The overlay of /boss gui lan is open until the boss closes it or the session ends; the end of the session closes it, which drops its mark at the server.
	let lanOpen: AbortController | undefined;
	pi.on("session_shutdown", () => lanOpen?.abort());
	const face = cfg.face ?? {};
	/** The deps of the Wi-Fi overlay: control requests that never start a server, the clock and the ticker it renews on, and what it reads of the CA's public files. */
	const lanDeps = (send: (request: Record<string, unknown>, start: "boss" | "never") => Promise<LanReply>, signal: AbortSignal): LanDeps => ({
		ask: (request) => send(request, "never"),
		pane: cfg.env.HERDR_PANE_ID ?? null,
		block: (active) => pi.events.emit("herdr:blocked", { active, label: "Showing the Wi-Fi pairing screen" }),
		now: face.now ?? Date.now, every: face.every ?? every, copy, reveal: face.reveal ?? revealFiles, tell, signal,
		// The server answers with the CA it serves, so nothing is read from a file here.
		async certificate() {
			const r = await send({ cmd: "gui-lan-ca" }, "never");
			return r.ok && typeof r.sha256 === "string" && typeof r.sha1 === "string" ? { sha256: r.sha256, sha1: r.sha1, pairedUnder: r.pairedUnder === true } : undefined;
		},
	});

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
		/** `mode` is "", "stop", "rotate", "remote", "remote off", "lan", "lan off", or "lan reset", and works from any session: the GUI and the access over a network are the server's. */
		async command(mode: string) {
			const send = (request: Record<string, unknown>, start: "boss" | "never"): Promise<LanReply> => asking()(request, { start }).catch((error: Error) => ({ ok: false as const, error: error.message }));
			if (mode === "lan off") {
				// Starts a server when none runs, as `remote off` does: the server clears the wish in lan.json, which a later start would otherwise serve again.
				const r = await send({ cmd: "gui-lan", on: false }, "boss");
				return r.ok ? tell(String(r.text)) : fail({ error: r.error === "stopped" ? "stopped" : String(r.reason ?? r.error) });
			}
			if (mode === "lan" || mode === "lan reset") {
				if (!s.ui) return tell(`/boss gui ${mode} needs the pi screen: the certificate, the risk, and the numbers of new devices are shown there, never in the conversation.`, "error");
				if (lanOpen) return tell("The Wi-Fi screen is already open in this session.", "warning");
				let start: Parameters<typeof showLan>[2];
				if (mode === "lan reset") {
					// A GUI stopped on purpose is started first, as `/boss gui lan` does: the reset face needs it to run, and the boss asked for this by name.
					const g = await send({ cmd: "gui", boss: true }, "boss");
					if (!g.ok) return fail(g);
					start = { screen: "reset" };
				}
				else {
					// Turning it on is the boss's own command: it starts a GUI stopped on purpose. Without a certificate the answer is the warning, and nothing is made before the boss presses y.
					const r = await send({ cmd: "gui-lan", on: true }, "boss");
					if (r.ok) start = { screen: "home", facts: r };
					else if (r.error === "lan_risk") start = { screen: "warning", name: typeof r.name === "string" ? r.name : null };
					else if (r.error === "lan_ca_ended") start = { screen: "reset", ended: true };
					else return tell(String(r.reason ?? r.error ?? "the sb server did not answer"), "error");
				}
				const control = (lanOpen = new AbortController());
				try {
					await showLan(s.ui, lanDeps(send, control.signal), start);
				} catch (error) {
					tell((error as Error).message, "error");
				} finally {
					lanOpen = undefined;
				}
				return;
			}
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
				// A desk shell shows the page itself, so the overlay has no o key and does not list one.
				const desk = cfg.env.STRAW_BOSS_DESK === "1";
				return void (Array.isArray(r.lines) && s.ui && (await showLines(s.ui, (r.lines as string[]).filter((line) => !desk || line !== OPEN_LINE), { block, keys: pairingKeys(link, copy, desk ? undefined : openUrl) })));
			}
			if (mode === "rotate" && (await s.ui?.confirm("Rotate the GUI's address?", ROTATE_WARNING)) !== true) return tell("The GUI's address was not rotated.");
			const r = await send(mode === "rotate" ? { cmd: "gui-rotate" } : { cmd: "gui", boss: true }, "boss");
			if (!r.ok) return fail(r);
			const url = urlOf({ port: Number(r.port), token: String(r.token) } as GuiRecord);
			tell(mode === "rotate" ? `Straw net GUI: ${url} (a new address; every paired device is unpaired)` : `Straw net GUI: ${url}`);
			if (typeof r.remoteNote === "string") tell(r.remoteNote, "warning");
			// A desk shell (STRAW_BOSS_DESK=1) shows the page itself; the URL is still told.
			if (cfg.env.STRAW_BOSS_DESK !== "1") await openUrl(url).catch((error: Error) => tell(`Could not open a browser (${error.message}); open the URL above yourself`, "warning"));
		},
	};
}
