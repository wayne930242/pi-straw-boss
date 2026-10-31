import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { execFileExe } from "./exe.mjs";
import { qr, qrLines } from "./qr.ts";
import { systemRoot } from "./winpath.ts";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// `/boss gui lan` (docs/specs/2026-10-30-sb-gui-lan.md, "Commands and what the boss sees", "Approval on this computer", Steps L6): the overlay with the warning, certificate, pairing, and reset faces. The server keeps the mark
// that tells a paired device's composer, keys, and take-backs that this overlay is open (`gui-lan-face`); everything here makes that mark true and keeps it from being a lie:
//   - the face is opened at the server before anything is drawn, and nothing is drawn without its acknowledgement;
//   - every face takes only Escape for 1.5 s after the acknowledgement, and answer keys only while a renewal the server answered was sent less than 4 s ago (the server's lease is 5 s);
//   - the 1 s `gui-lan-pending` poll is the renewal; "unknown face" (the server restarted, or the lease lapsed) opens a new mark and waits 1.5 s again;
//   - the mark is dropped on every way out (Escape, an error, the end of the session), and the session reads as `herdr:blocked` meanwhile;
//   - the number of a pending device is typed by the boss, from the phone in their hand, and is never filled in or shown here.

/** What the server answers a control request. */
export interface LanReply { ok: boolean; error?: string; reason?: string; [key: string]: unknown }
/** The seams of the overlay's clock and of the one thing it does outside the process. */
export interface FaceSeams {
	now?: () => number;
	/** Runs `fn` every `ms` until the returned function is called. */
	every?: (fn: () => void, ms: number) => () => void;
	/** Shows the certificate files in the file manager. */
	reveal?: (paths: string[]) => Promise<void>;
}
const SETTLE_MS = 1500, FRESH_MS = 4000, POLL_MS = 1000;
export const every = (fn: () => void, ms: number) => {
	const timer = setInterval(fn, ms);
	timer.unref?.();
	return () => clearInterval(timer);
};
/** The file manager's command: Finder's `open -R`, Explorer's `/select,`, or the folder in the default file manager. */
export const revealCommand = (paths: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] =>
	platform === "darwin" ? ["open", ["-R", ...paths]] : platform === "win32" ? [`${systemRoot(env)}\\explorer.exe`, [`/select,${paths[0]}`]] : ["xdg-open", [dirname(paths[0]!)]];
export const revealFiles = (paths: string[]) =>
	new Promise<void>((done, fail) => {
		const [cmd, args] = revealCommand(paths);
		// Explorer exits 1 after it showed the file; a missing command is the only failure worth telling.
		execFileExe(cmd, args, { timeout: 10_000 }, (error) => (error && (error as NodeJS.ErrnoException).code === "ENOENT" ? fail(new Error(`Could not show the files with ${cmd}`)) : done()));
	});

/** The server's CA as the overlay shows it: `pairedUnder` says a device was allowed over Wi-Fi under this very certificate. */
export interface LanCert { sha256: string; sha1: string; pairedUnder: boolean }
export interface LanDeps {
	/** One control request (never starting a server: the command already found it). */
	ask(request: Record<string, unknown>): Promise<LanReply>;
	/** `HERDR_PANE_ID`, or null outside Herdr. */
	pane: string | null;
	block(active: boolean): void;
	now(): number;
	every(fn: () => void, ms: number): () => void;
	copy(text: string): Promise<void>;
	reveal(paths: string[]): Promise<void>;
	tell(text: string, level?: "info" | "warning" | "error"): void;
	/** The CA's fingerprints, from the server (`gui-lan-ca`); undefined when it cannot be had. */
	certificate(): Promise<LanCert | undefined>;
	/** The end of the session closes the overlay. */
	signal?: AbortSignal;
}
export type LanScreen = "warning" | "certificate" | "pairing" | "reset" | "home";
export interface LanStart { screen: LanScreen; name?: string | null; ended?: boolean; facts?: Record<string, unknown> }

interface Pending { id: string; label: string; peer: string; iface?: string }
type Part = string | { qr: string[] };
const STEP_ANSWER = "Could not reach the sb server";

/** The risk warning, before the certificate exists. */
const warning = (name: string | null | undefined): Part[] => [
	"Wi-Fi access needs a certificate this computer makes for itself, which each phone then trusts.", "",
	`Risk: anyone who copies that certificate's key from this computer (a backup, a program running as you, an agent you run) can pose to your phones, and to any computer that installed it, as ${name ? `${name}.local and as ` : ""}any private-network address, such as your router's or NAS's 192.168.x.x page, on any Wi-Fi they join, until you remove the certificate from each of them.`, "",
	"Not verified yet: whether your phone limits this certificate to this computer's name and private addresses has not been checked. Until it has, assume that a copy of the key could pose as any website to your phone. Use Tailscale instead if you can.", "",
	"We recommend using Wi-Fi access on your phone's hotspot, or on a Wi-Fi that connects the phone directly to this computer, so no one else is on the network.", "",
	"y  make the certificate and turn Wi-Fi access on", "n or Esc  cancel",
];
const resetFace = (ended: boolean): Part[] => [
	...(ended ? ["This computer's Wi-Fi certificate has ended.", ""] : []),
	"Make a new Wi-Fi access certificate?",
	"Every phone and computer that installed the old Straw Boss certificate must remove it and install the new one.",
	"Removing the old one is what ends a copy of its key; a phone may keep trusting it after it ends.",
	"The old key is deleted here; Time Machine's local snapshots may keep a copy of it for up to a day.", "",
	"  iPhone: Settings, General, VPN & Device Management, Straw Boss LAN, Remove Profile.",
	"  Android: Settings, search \"Trusted credentials\", User, Straw Boss LAN CA, Remove.",
	"  Mac: Keychain Access, login, Straw Boss LAN CA, Delete.  Windows: certmgr.msc, Trusted Root, Straw Boss LAN CA, Delete.", "",
	"r  renew: new certificate, devices stay paired (the old one is ending, or the computer was renamed)",
	"u  new certificate and unpair every device paired over Wi-Fi (the key or a phone may have been stolen)",
	"Esc or q  cancel",
];

/** Wraps a line to `width`, keeping its indent and indenting the continuation by two more. */
function wrapLine(line: string, width: number): string[] {
	if ([...line].length <= width) return [line];
	const indent = /^ */.exec(line)![0], out: string[] = [];
	for (const word of line.trim().split(/\s+/)) {
		const last = out.at(-1);
		if (last !== undefined && [...last].length + 1 + [...word].length <= width) out[out.length - 1] = `${last} ${word}`;
		else out.push(`${out.length ? `${indent}  ` : indent}${word}`);
	}
	return out;
}
const hostOf = (url: unknown) => (typeof url === "string" ? /^https:\/\/([^/:]+)/.exec(url)?.[1] : undefined);

/**
 * The overlay of `/boss gui lan`. It opens its mark first and draws nothing without the server's acknowledgement (it throws instead, and nothing is left open); it resolves when the boss closes it, the session ends, or the overlay fails, and the
 * mark is dropped on each of those.
 */
export async function showLan(ui: ExtensionContext["ui"], d: LanDeps, start: LanStart) {
	// One code surface for the whole overlay, kept across a reopen of its mark: a new code voids the earlier one.
	const surface = randomBytes(16).toString("hex");
	let face = "", settleUntil = 0, okSent = -Infinity, dead = "", said = "", busy = false, closed = false, polling = false;
	let screen: LanScreen = start.screen, facts: Record<string, unknown> = start.facts ?? {}, cert: LanCert | undefined, entered = "", pending: Pending[] = [], events: string[] = [], seen: string[] | undefined;
	let code: { qr: string[]; url: string } | { typed: string } | undefined, pick = 0;
	let finish = () => {}, redraw = () => {};

	const reply = (r: LanReply, fallback: string) => String(r.reason ?? r.error ?? fallback);
	/** Opens a mark at the server and takes its acknowledgement as the start of the 1.5 s the face is deaf. */
	async function open() {
		const sent = d.now();
		const r = await d.ask({ cmd: "gui-lan-face", pane: d.pane, open: true }).catch((error: Error) => ({ ok: false, error: error.message }) as LanReply);
		if (!r.ok || typeof r.face !== "string") throw new Error(`${STEP_ANSWER}${r.error ? ` (${r.error})` : ""}`);
		// `dead` stays: a face a paired device typed into ends only with Escape, and digits typed meanwhile are dropped.
		[face, okSent, settleUntil, entered] = [r.face, sent, d.now() + SETTLE_MS, ""];
	}
	const live = () => !dead && !closed && d.now() >= settleUntil && d.now() - okSent < FRESH_MS;
	const absorb = (r: LanReply) => {
		facts = { ...facts, ...Object.fromEntries(["url", "port", "addresses", "on", "note"].filter((k) => k in r || k === "note").map((k) => [k, r[k]])) };
		if (Array.isArray(r.pending)) pending = (r.pending as Pending[]).slice(0, 8);
		if (Array.isArray(r.events)) {
			const next = (r.events as unknown[]).map(String);
			if (seen) {
				// The server keeps the last five lines: what follows the longest overlap with what was seen is new.
				let k = Math.min(seen.length, next.length);
				while (k > 0 && seen.slice(-k).join("\n") !== next.slice(0, k).join("\n")) k--;
				for (const line of next.slice(k)) d.tell(line, /not allowed|wrong codes|void/.test(line) ? "warning" : "info");
			}
			seen = next;
			events = next.slice(-3);
		}
	};
	/** The choices of the address the phone is pointed at: the name (while the certificate names this computer), then each served address. */
	const choices = (): { host: string; form: "name" | "address"; address?: string }[] => {
		const name = hostOf(facts.url), list = Array.isArray(facts.addresses) ? (facts.addresses as { address: string }[]) : [];
		return [...(name?.endsWith(".local") ? [{ host: name, form: "name" as const }] : []), ...list.map((a) => ({ host: a.address, form: "address" as const, address: a.address }))];
	};
	const chosen = () => choices()[pick % Math.max(1, choices().length)];
	const mint = async (): Promise<boolean> => {
		const at = chosen();
		if (!at) return (said = "This computer has no address Wi-Fi access can serve now.", false);
		const r = await d.ask({ cmd: "gui-lan-pair", face, surface, form: at.form, ...(at.address ? { address: at.address } : {}) });
		if (!r.ok || typeof r.url !== "string" || !Array.isArray(r.rows)) return (said = reply(r, "No code was made."), false);
		code = { url: r.url, qr: qrLines((r.rows as string[]).map((row) => [...row].map((c) => c === "1"))) };
		return true;
	};
	const load = async () => (cert = await d.certificate());
	/** Enters a face; the pairing face mints its QR, the certificate face reads the certificate. */
	async function enter(next: LanScreen) {
		said = "";
		if (next === "home") {
			await load();
			next = cert?.pairedUnder ? "pairing" : "certificate";
		}
		if (next === "certificate" && !cert) await load();
		screen = next;
		if (next === "pairing") {
			code = undefined;
			await mint();
		}
	}

	const plain = () => {
		const list = Array.isArray(facts.addresses) ? (facts.addresses as { address: string; interface: string }[]) : [];
		return `Wi-Fi access is on: ${typeof facts.url === "string" ? facts.url : "no address is served yet"}${list.length ? ` (served: ${list.map((a) => `${a.address} (${a.interface})`).join(", ")})` : ""}. Pair in the overlay; you allow each new device here by typing the number its screen shows.`;
	};

	// What the faces say -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	const toggle = (): string => {
		const all = choices();
		if (all.length < 2) return "";
		const next = all[(pick + 1) % all.length]!;
		return next.form === "name" ? `i  use the name ${next.host}` : `i  use the address ${next.host} instead of the name`;
	};
	function certificateFace(): Part[] {
		const at = chosen(), port = facts.port, on = facts.on === true && at && typeof port === "number";
		const out: Part[] = [on ? `Wi-Fi access is on: https://${at.host}:${port}${Array.isArray(facts.addresses) && facts.addresses.length ? ` (served: ${(facts.addresses as { address: string; interface: string }[]).map((a) => `${a.address} (${a.interface})`).join(", ")})` : ""}` : "Wi-Fi access is off: run /boss gui lan to turn it on.", "Step 1, once per phone: give it this computer's certificate.",
			"  Best: f shows the certificate files; send them by AirDrop (iPhone) or Quick Share (Android).", "  No check needed unless the phone asks you to accept a file from an unknown sender.",
			"Not verified yet: whether a phone limits this certificate to this computer's name and private addresses has not been checked, so a copy of its key could pose as any website to it."];
		if (on) {
			out.push("  Or scan this QR on the phone (on a network you trust; a hotspot or direct Wi-Fi is best):", "");
			out.push({ qr: qrLines(qr(`http://${at.host}:${port}/sb-ca/`)) }, "");
		}
		if (cert) out.push("If the phone downloaded it over Wi-Fi, check it on the phone before trusting it: exactly one certificate, with", `SHA-256 starting: ${cert.sha256}`,
			"  iPhone, before Install: Profile Downloaded, the profile. Contains must say only Certificate; More Details must list one certificate and nothing else, with this SHA-256. Otherwise Remove.",
			"  Android, after installing: Encryption & credentials, Trusted credentials, User: exactly one Straw Boss LAN CA and nothing you did not add, with this SHA-256. Otherwise remove them now.",
			"  Mac: Keychain Access, search Straw Boss: exactly one Straw Boss LAN CA, with this SHA-256 in Details.",
			`  Windows: exactly one Security Warning appears, with the SHA-1 thumbprint ${cert.sha1}. If a second appears, choose No, then remove the first in certmgr.msc.`);
		else out.push("The certificate could not be read, so there is nothing to check here: press Esc and run /boss gui lan again.");
		out.push("", ["f  show the certificate files", on ? "p  pairing QR (step 2)" : "", toggle()].filter(Boolean).join("    "), "Esc or q  close");
		return out;
	}
	function pairingFace(): Part[] {
		const out: Part[] = [];
		if (code && "qr" in code) out.push({ qr: code.qr }, "", "Scan with a phone on this network that trusts this computer's certificate, tap Pair,", "then allow it here (its number shows on the phone).", "If the phone warns that the connection is not private, do not go on: press t and install the certificate.");
		else if (code) out.push("Or in an installed app, type these 8 characters (no hyphen; it works once, within ten minutes):", code.typed, "");
		else out.push("No pairing code is on the screen: press p for a new QR.");
		out.push("", ["t  certificate (step 1, once per phone)", toggle()].filter(Boolean).join("    "), [code && "typed" in code ? "p  a new QR" : "k  code for the installed app", "c  copy a new one-time link", "Esc or q  close"].join("    "));
		return out;
	}
	const pendingRows = (): Part[] => (pending.length && (screen === "certificate" || screen === "pairing")
		? [...(pending.length > 1 ? ["More than one device used a code: only one of them can be your phone."] : []), ...pending.map((p) => `Pair request: ${p.label} from ${p.peer}${p.iface ? ` (${p.iface})` : ""}`),
			"Type the number your phone shows, then Enter, to allow it.   n  deny all   Esc  decide later", `Number: ${entered}█`, ""]
		: []);
	const status = (): string[] => [
		...(!live() && !dead && !closed ? [d.now() < settleUntil ? "keys wait 1.5 s" : "No answer from the sb server: keys wait; Esc closes."] : []),
		...(dead ? [dead] : []),
		...(said ? [said] : []),
		...(typeof facts.note === "string" && (screen === "certificate" || screen === "pairing") ? [`Note: ${facts.note}`] : []),
		...events.map((e) => e),
	];
	const parts = (): Part[] => [...pendingRows(), ...(screen === "warning" ? warning(start.name) : screen === "reset" ? resetFace(start.ended === true) : screen === "certificate" ? certificateFace() : pairingFace())];

	// Keys -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	/** Runs one action: a key that finds one in flight does nothing, and a failure is said on the face. */
	const act = (run: () => Promise<void>) => {
		busy = true;
		void run().catch((error: Error) => (said = error.message)).finally(() => ((busy = false), redraw()));
	};
	const answered = (r: LanReply): boolean => {
		if (r.ok) return true;
		if (r.error === "typed_into") (entered = ""), dead = reply(r, "A paired device typed into this session as this screen opened; press Esc and run /boss gui lan again.");
		else said = r.error === "unknown_face" ? "This screen was no longer live; wait a moment and press the key again." : reply(r, "Refused.");
		return false;
	};
	function key(data: string) {
		const is = (k: string) => matchesKey(data, k as "y");
		if (screen === "warning") {
			if (is("n") || is("q")) return finish();
			if (is("y")) act(async () => {
				const r = await d.ask({ cmd: "gui-lan", on: true, accept_risk: true, face });
				if (!answered(r)) return;
				absorb(r);
				cert = undefined;
				d.tell(plain());
				await enter("certificate");
			});
			return;
		}
		if (screen === "reset") {
			if (is("q")) return finish();
			const choice = is("r") ? false : is("u") ? true : undefined;
			if (choice !== undefined) act(async () => {
				const r = await d.ask({ cmd: "gui-lan-reset", face, unpair: choice });
				if (!answered(r)) return;
				absorb(r);
				cert = undefined;
				d.tell(String(r.text ?? "A new Wi-Fi certificate was made"));
				await enter("certificate");
			});
			return;
		}
		if (is("q")) return finish();
		// The number: typed from the phone in the boss's hand; nothing here fills it in.
		if (pending.length) {
			if (/^[0-9]$/.test(data.length === 1 ? data : "") || ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].some((n) => is(n))) {
				const digit = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].find((n) => is(n))!;
				if (entered.length < 4) entered += digit;
				return redraw();
			}
			if (is("backspace")) return void ((entered = entered.slice(0, -1)), redraw());
			if (is("enter")) {
				if (!/^\d{4}$/.test(entered)) return void ((said = "Type the four digits the phone shows."), redraw());
				const number = entered;
				entered = "";
				return act(async () => {
					const r = await d.ask({ cmd: "gui-lan-approve", face, number });
					if (r.ok) return void (said = "");
					if (r.error === "no_match") return void (said = "No request has that number");
					answered(r);
				});
			}
			if (is("n")) return act(async () => void (answered(await d.ask({ cmd: "gui-lan-approve", face, deny: "all" })) && (said = "Denied every request")));
		}
		if (is("t")) return act(() => enter("certificate"));
		if (is("f")) return act(async () => {
			const r = await d.ask({ cmd: "gui-lan-files" });
			if (!r.ok || !Array.isArray(r.files)) return void (said = reply(r, "The certificate files could not be written."));
			await d.reveal(r.files as string[]);
			said = `The certificate files are in ${String(r.dir)}`;
		});
		if (is("i") && choices().length > 1) return act(async () => {
			pick = (pick + 1) % choices().length;
			if (screen === "pairing") await mint();
		});
		if (screen === "certificate") return void (is("p") && act(() => enter("pairing")));
		if (is("p")) return act(async () => void (await mint()));
		if (is("k")) return act(async () => {
			const at = chosen();
			const r = await d.ask({ cmd: "gui-lan-pair", face, surface, form: "typed", ...(at?.address ? { address: at.address } : {}) });
			if (!r.ok || typeof r.code !== "string") return void (said = reply(r, "No code was made."));
			code = { typed: r.code };
			said = "";
		});
		if (is("c")) return act(async () => {
			if (!(await mint()) || !code || !("qr" in code)) return;
			await d.copy(code.url);
			said = "Copied a new one-time link; it works once, within ten minutes.";
		});
	}

	// The renewal ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

	async function tick() {
		if (polling || closed) return;
		polling = true;
		const sent = d.now();
		try {
			const r = await d.ask({ cmd: "gui-lan-pending", face });
			if (closed) return;
			if (r.ok) {
				okSent = sent;
				absorb(r);
			} else if (r.error === "unknown_face") await open();
		} catch {
			// Unanswered: the last acknowledged renewal ages, and the keys lapse 4 s after it was sent.
		} finally {
			polling = false;
			redraw();
		}
	}

	await open();
	d.block(true);
	let stop = () => {};
	try {
		if (start.screen === "home") d.tell(plain());
		await enter(start.screen);
		await ui.custom<void>((tui, _theme, _keys, done) => {
			finish = () => ((closed = true), done());
			redraw = () => tui.requestRender();
			stop = d.every(() => void tick(), POLL_MS);
			if (d.signal?.aborted) finish();
			else d.signal?.addEventListener("abort", finish, { once: true });
			return {
				render: (width) => {
					const wide = Math.max(1, ...parts().map((p) => (typeof p === "string" ? 0 : Math.max(...p.qr.map((line) => [...line].length)))));
					const lines = parts().flatMap((p) => (typeof p === "string" ? wrapLine(p, width) : width >= wide ? p.qr : wrapLine(`This pane is ${width} columns wide; the QR code needs ${wide}. Widen it, or use Phone in the GUI.`, width)));
					const below = status();
					return [...lines, ...(below.length ? ["", ...below.flatMap((line) => wrapLine(line, width))] : [])].map((line) => [...line].slice(0, width).join(""));
				},
				invalidate() {},
				handleInput(data) {
					if (matchesKey(data, "escape")) return finish();
					if (busy || !live()) return;
					key(data);
					tui.requestRender();
				},
			};
		});
	} finally {
		closed = true;
		stop();
		d.block(false);
		await d.ask({ cmd: "gui-lan-face", face, open: false }).catch(() => {});
	}
}
