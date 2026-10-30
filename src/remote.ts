import { execFileExe } from "./exe.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { createDevices, SESSION_MS, labelOf, type Listed } from "./devices.ts";
import { APP, createLanAccess, type LanAccessDeps, type LanAt } from "./lan/access.ts";
import { createTypedCodes } from "./paircode.ts";
import { qr, qrLines } from "./qr.ts";
import { forgetStart, startedLater, startOf } from "./startof.ts";

// Remote access over Tailscale, tailnet only (never Funnel). `/boss gui remote` adds one `tailscale serve` entry, HTTPS on 8443 to the server's
// remote listener (a second loopback port, see gui.ts), only when 8443 is free or already ours (remote.json in the state directory remembers our target, the server's PID, and when that
// process started, so an entry a crashed session left is recognised even after its PID went to another process); turning it off, `/boss gui stop`, and the end of the server's session remove that one entry and nothing else.
// Which request is which is decided by the listener it arrived on, not by what it says about itself: everything on the remote listener is
// remote whatever its Host or headers, and the local listener lets in only a request with Host 127.0.0.1:<port> and none of the forwarding
// headers serve always adds (X-Forwarded-*, Tailscale-*), a second guard, and refuses anything else, so an entry that still points at the
// local port cannot reach the server at all. A remote request needs Host exactly <MagicDNS name>:8443,
// no Funnel marker, Tailscale-User-Login equal to this machine's user, and a session cookie (HttpOnly, Secure, SameSite=Strict, scoped to
// the token path, and a second copy scoped to the fixed app entry) that only a one-time pairing code from the QR gets: a code works once, within ten minutes. The same pairing can be made by typing a short code into the fixed entry
// of the installed app (APP, `/sb-app/`, remote listener only: no token, no secret on its pages; see `entry` and `redeem`), because an app has its own cookie jar and its start URL cannot follow the token. A pairing is durable
// (devices.ts): it survives remote off and on, and ends when the GUI gets a new token (a listener that could not bind its stored ports, a missing or corrupt gui-secrets.json, or `/boss gui rotate`: `guihost` unpairs every device then), when the desktop unpairs the device, the Tailscale
// identity changes, or 90 days pass without a use (each use slides the expiry). Remote access is remembered as wanted until turned off
// explicitly: stopping the server removes the serve entry but not the wish, so the next server turns it on again.
// Wi-Fi access (the LAN) shares `createAccess` and nothing else of this: its codes, pending devices, cookie (`__Secure-sb_lan`), and lan.json are src/lan/access.ts (docs/specs/2026-10-30-sb-gui-lan.md).

export const PORT = 8443;
/** The fixed, token-free entry of the installed app on the remote and LAN listeners (the manifest's start_url there). */
export { APP };
/** The line under the QR that names the **o** key; a desk shell shows the page itself, so its sessions drop the line with the key (host.ts). */
export const OPEN_LINE = "o  open one in this computer's browser";
const CODE_MS = 10 * 60_000, MAX_CODES = 16;
const FORWARDED = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via", "tailscale-headers-info", "tailscale-user-login", "tailscale-user-name", "tailscale-funnel-request"];
export type Run = (args: string[]) => Promise<string>;
export interface Identity { host: string; login: string }
/** What the fixed entry says of a GET: `cookie` for a paired device (its cookie's value), `unpaired` for this machine's user without a pairing, `status` for a refusal. */
export type Entry = { cookie: string } | { unpaired: true } | { status: 403 };
/** What a typed code did: `cookie` is the new pairing, `wrong` a code that did not work, `status` a refusal (429: too many wrong codes). */
export type Redeemed = { cookie: string } | { wrong: true } | { status: 403 | 429 };
/** `origin` for a request let in (`device` the paired device it came from, `reissue` its cookie when the pairing was just renewed, `net` "lan" for one that came over Wi-Fi access); `cookie` for a pairing code just exchanged; `status` for a refusal (429 on the LAN: a peer that made too many). */
export type Verdict = { origin: string; remote: boolean; device?: string; reissue?: string; net?: "lan" } | { cookie: string } | { status: 401 | 403 | 429 };
/** A network a device is paired on: Tailscale, or Wi-Fi access (the LAN). */
export type Net = "tailnet" | "lan";

export const tailscale: Run = (args) =>
	new Promise((done, fail) => execFileExe("tailscale", args, { timeout: 15_000 }, (error, out, err) => (error ? fail(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "Tailscale is not installed (no tailscale command on PATH)" : `tailscale ${args.join(" ")} failed: ${err.trim() || error.message}`)) : done(out))));
interface Status { BackendState?: string; Self?: { DNSName?: string; UserID?: number; Tags?: string[] }; User?: Record<string, { LoginName?: string }> }
interface Serve { TCP?: Record<string, { HTTPS?: boolean }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean>; Foreground?: Record<string, Serve> }
function parse<T>(text: string, what: string): T {
	try {
		// With nothing configured, `serve status --json` can print null.
		return (JSON.parse(text.trim() || "{}") ?? {}) as T;
	} catch {
		throw new Error(`tailscale ${what} --json did not answer JSON`);
	}
}

/** This machine on the tailnet: its MagicDNS name with the remote port, and its user's login. */
export async function identity(run: Run): Promise<Identity> {
	const s = parse<Status>(await run(["status", "--json"]), "status"), dns = String(s.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase(), login = s.User?.[String(s.Self?.UserID)]?.LoginName;
	if (s.BackendState !== "Running") throw new Error(`Tailscale is not connected here (${s.BackendState ?? "unknown state"}); sign in with tailscale up`);
	if (!dns) throw new Error("This machine has no MagicDNS name; turn MagicDNS on for the tailnet");
	if (s.Self?.Tags?.length || typeof login !== "string") throw new Error("This machine is a tagged node, so Tailscale names no user to check remote requests against");
	return { host: `${dns}:${PORT}`, login };
}

/**
 * What 8443 serves now: `target` when the background config holds it as one HTTPS "/" proxy on our host (the only shape Straw Boss writes),
 * `foreign` when anything else holds the port (a foreground serve, another host name, other handlers, a TCP forward), and Funnel for our host.
 */
async function served(run: Run, host: string) {
	const s = parse<Serve>(await run(["serve", "status", "--json"]), "serve status"), held = s.TCP?.[PORT] !== undefined;
	const handlers = Object.entries(s.Web?.[host]?.Handlers ?? {}), target = held && s.TCP?.[PORT]?.HTTPS && handlers.length === 1 && handlers[0]![0] === "/" ? handlers[0]![1].Proxy : undefined;
	const elsewhere = Object.keys(s.Web ?? {}).some((h) => h !== host && h.endsWith(`:${PORT}`)) || Object.values(s.Foreground ?? {}).some((f) => f.TCP?.[PORT] !== undefined);
	// Any host's "/" handler on 8443, to tell an entry that is gone from one under another host (an identity change).
	const anywhere = Object.entries(s.Web ?? {}).filter(([h]) => h.endsWith(`:${PORT}`)).flatMap(([, w]) => Object.entries(w.Handlers ?? {}).filter(([p]) => p === "/").map(([, x]) => x.Proxy));
	return { target, anywhere, foreign: elsewhere || (held && !target), funnel: Boolean(s.AllowFunnel?.[host]) };
}

/** Points 8443 at `target`, when 8443 is free or ours (`target` itself or one of `stale`); otherwise, or when Funnel is on there, it refuses and touches nothing. */
export async function serveOn(run: Run, host: string, target: string, stale: (string | undefined)[] = []) {
	const now = await served(run, host);
	if (now.funnel) throw new Error(`Funnel is on for ${host}; Straw Boss serves the tailnet only and leaves that entry alone`);
	if (now.foreign || (now.target && ![target, ...stale].includes(now.target))) throw new Error(`Port ${PORT} already serves something else${now.target ? ` (${now.target})` : ""}; Straw Boss does not touch other serve entries`);
	if (now.target !== target) await run(["serve", "--bg", `--https=${PORT}`, target]);
	const after = await served(run, host);
	if (after.target !== target || after.funnel) {
		if (after.target === target) await run(["serve", `--https=${PORT}`, "off"]);
		throw new Error(`tailscale serve did not take the entry as asked (${after.target ?? "none"}); remote access stays off`);
	}
}

/** Removes the 8443 entry only while it is still ours (only "/", proxying to one of `targets`). */
export async function serveOff(run: Run, host: string, targets: (string | undefined)[], elsewhere?: { remains: boolean }) {
	const now = await served(run, host);
	if (elsewhere) elsewhere.remains = now.anywhere.some((t) => t !== undefined && targets.includes(t));
	if (now.foreign || !now.target || !targets.includes(now.target)) return false;
	await run(["serve", `--https=${PORT}`, "off"]);
	return true;
}

/** Who may in: the local page as today, and while remote is on, paired devices of this machine's Tailscale user; while Wi-Fi access is on, devices the boss allowed over the LAN (lan/access.ts, which holds that half: its own codes, pending devices,
 *  and lan.json). `file` keeps the paired devices (devices.ts: each cookie's SHA-256, name, and expiry, with the identity that paired them) and whether remote is wanted on.
 *  `ended(device, net)` is told when a device's streams must end (all of them when it names none, all of a network's when it names only that). */
export function createAccess(token: string, ended: (device?: string, net?: Net) => void = () => {}, file?: string, lanDeps: Partial<Omit<LanAccessDeps, "token" | "ended">> = {}) {
	let remote: Identity | undefined;
	const codes = new Map<string, number>(), typed = createTypedCodes(CODE_MS, MAX_CODES), devices = createDevices(file), hash = (c: string) => createHash("sha256").update(c).digest("hex");
	const lan = createLanAccess({ ...lanDeps, token, ended: (device) => ended(device, "lan") });
	/** A request that comes through `tailscale serve` for this machine's identity: remote on, the exact host, no Funnel marker, this machine's user. */
	const admitted = (h: IncomingMessage["headers"]) => Boolean(remote) && h.host === remote!.host && !("tailscale-funnel-request" in h) && h["tailscale-user-login"] === remote!.login;
	const cookieOf = (h: IncomingMessage["headers"]) => /(?:^|;\s*)sb_remote=([0-9a-f]{64})(?:;|$)/.exec(h.cookie ?? "")?.[1];
	const forget = () => (codes.clear(), typed.clear());
	const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
	return {
		get remote() { return remote; },
		/** Whether remote access is wanted on: set by turning it on, kept by a stop, cleared only by turning it off. */
		get wanted() { return devices.wanted; },
		/** The identity the saved devices were paired under (or the current one while on): a restart turns remote on again only as this one. */
		get remembered() { return remote ?? devices.identity; },
		/** Why paired.json could not be written last time, or undefined; the devices are then kept in memory only. */
		get saveError() { return devices.error; },
		/** What a failed save of paired.json or lan.json means (the change holds until the server stops), or undefined while the files are current. */
		unsaved(): string | undefined {
			const [name, why] = devices.error ? ["paired.json", devices.error] : ["lan.json", lan.error];
			return why && `${name} could not be saved (${why}); the change holds until the server stops, and a restart loses it`;
		},
		/** Wi-Fi access: its switches, codes, pending devices and approval, and the checks the LAN listener's handler makes (lan/access.ts). */
		lan,
		/** The devices of both networks: one list, newest use first, and an unpair that names either. */
		devices: {
			list: (): Listed[] => [...devices.list(), ...lan.store.list()].sort((a, b) => b.seen - a.seen),
			unpair(id: string) {
				// An id names one device in both stores together: a prefix that fits two, one in each, names none.
				const [tail, wifi] = [devices.match(id), lan.store.match(id)];
				if (tail.length + wifi.length !== 1) return false;
				return (tail.length ? ((gone) => (ended(gone, "tailnet"), gone))(devices.remove(id)) : ((gone) => (ended(gone, "lan"), gone))(lan.store.remove(id))) !== undefined;
			},
			unpairAll() {
				const n = devices.clear() + lan.store.clear();
				return n > 0 ? (ended(), n) : 0;
			},
		},
		enable(id: Identity) {
			// Another identity voids what the old one paired, and ends its streams.
			const was = remote ?? devices.identity;
			if (was?.host !== id.host || was.login !== id.login) (remote && ended(undefined, "tailnet"), forget(), devices.clear());
			remote = id;
			devices.set({ identity: id, wanted: true });
		},
		/** `stop`: the server is going away (a stop, a takeover, the session's end), so remote stays wanted; otherwise it was turned off. Paired devices are kept either way. */
		disable(stop = false) {
			remote = undefined;
			forget();
			if (!stop) devices.set({ wanted: false });
			ended(undefined, "tailnet");
		},
		/** A one-time pairing code (128 bits, ten minutes); expired codes go first, and past sixteen waiting the oldest goes. On the LAN `surface` names the overlay face or tile that shows it: its earlier code is void. */
		pair(net: Net = "tailnet", surface?: string): string | undefined {
			if (net === "lan") return lan.pair(surface ?? "");
			if (!remote) return undefined;
			const code = randomBytes(16).toString("base64url"), now = Date.now();
			for (const [old, until] of codes) if (until < now) codes.delete(old);
			codes.set(code, now + CODE_MS);
			for (const old of codes.keys()) if (codes.size > MAX_CODES) codes.delete(old);
			return code;
		},
		/** A short one-time code to type into the installed app's entry (paircode.ts): shown beside the QR; a new one gives the five tries back. */
		pairCode(net: Net = "tailnet", surface?: string): string | undefined { return net === "lan" ? lan.pairCode(surface ?? "") : remote && typed.issue(); },
		/** Whether a request has this machine's identity (remote on, the exact host, no Funnel marker, this machine's user), whatever else it carries. */
		admits: (req: IncomingMessage) => admitted(req.headers),
		/** The fixed entry's GET (a document load of `/sb-app/`): the same identity checks as a page, then whether this device holds a pairing. No token or secret is needed or given. The LAN's is `lan.entry`. */
		entry(req: IncomingMessage): Entry {
			if (!admitted(req.headers)) return { status: 403 };
			const cookie = cookieOf(req.headers);
			return cookie && devices.use(hash(cookie)) ? { cookie } : { unpaired: true };
		},
		/**
		 * The fixed entry's POST: a typed code pairs this device as a scanned QR does (the identity checks, one use, ten minutes). The request must be a form post from the entry's own page
		 * (`Origin` is the https name, `Sec-Fetch-Site` same-origin when sent), which never counts against the tries.
		 */
		redeem(req: IncomingMessage, text: string): Redeemed {
			const h = req.headers;
			if (!admitted(h) || req.method !== "POST" || h.origin !== `https://${remote!.host}` || (h["sec-fetch-site"] ?? "same-origin") !== "same-origin" || !String(h["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return { status: 403 };
			const got = typed.take(new URLSearchParams(text).get("code") ?? "");
			if (got !== "ok") return got === "locked" ? { status: 429 } : { wrong: true };
			const cookie = randomBytes(32).toString("hex");
			devices.add(hash(cookie), labelOf(String(h["user-agent"] ?? "")));
			return { cookie };
		},
		/**
		 * `path` is the URL path after the token; `listener` is the one the request arrived on, `port` that listener's port. Only the local listener
		 * lets a request in as local, and only without a forwarding header; a request on the remote listener is remote whatever it claims, and
		 * the local listener refuses everything else. A pairing code is used up by its first presentation that passes the identity checks. A request on a LAN listener (`at` is what that listener tells of it)
		 * gets lan/access.ts's judgement: its host, the token, and an allowed device's own cookie.
		 */
		check(req: IncomingMessage, listener: "local" | "remote" | "lan", port: number, given: string | undefined, path: string[], at?: LanAt): Verdict {
			const h = req.headers;
			if (listener === "lan") return lan.check(req, port, given, path, at);
			if (!same(given ?? "", token)) return { status: 403 };
			if (listener === "local") return h.host === `127.0.0.1:${port}` && !FORWARDED.some((name) => name in h) ? { origin: `http://127.0.0.1:${port}`, remote: false } : { status: 403 };
			if (!remote || !admitted(h)) return { status: 403 };
			const now = Date.now();
			if (path[0] === "pair" && path.length === 2 && req.method === "GET") {
				const until = codes.get(path[1]!) ?? 0;
				codes.delete(path[1]!);
				if (until < now) return { status: 403 };
				const cookie = randomBytes(32).toString("hex");
				devices.add(hash(cookie), labelOf(String(h["user-agent"] ?? "")));
				return { cookie };
			}
			const cookie = cookieOf(h), used = cookie ? devices.use(hash(cookie)) : undefined; // a document's own requests (/doc/) come without it from Chrome's sandboxed frame: docs.ts takes the capability instead
			if (cookie && used) return { origin: `https://${remote.host}`, remote: true, device: hash(cookie), ...(used.renewed && { reissue: cookie }) };
			return path[0] === "doc" ? { origin: `https://${remote.host}`, remote: true } : { status: 401 };
		},
	};
}
export type Access = ReturnType<typeof createAccess>;
export const alive = (pid: unknown) => {
	try {
		return typeof pid === "number" && pid > 0 && process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" || (forgetStart(pid as number), false); // gone: a process that takes the number later is read afresh
	}
};
/**
 * Whether the server that recorded an entry still runs: its PID is alive and that process is the one that wrote the entry (same start
 * time; an entry from before start times were recorded: a process that started after the file was written is not its writer). When ps
 * cannot say, the entry counts as live, so another live server's entry is never taken for stale.
 */
export function runs({ pid, started }: { pid?: unknown; started?: string }, wrote: number, start: (pid: number) => string | undefined = startOf) {
	if (!alive(pid)) return false;
	const now = start(pid as number);
	if (!now) return true;
	return started ? now === started : !(Date.parse(/Z$/.test(now) ? now : `${now} UTC`) > wrote);
}
/** The session cookie, good for 90 days from now: issued at pairing and again each time a use renews the pairing. */
export const cookieFor = (token: string, value: string) => `sb_remote=${value}; Path=/${token}/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
/** The same cookie for the fixed entry (`/sb-app/`): the path does not change with the token, and no other path is covered, so a pairing is never sent to anything else on the host. */
export const appCookieFor = (value: string) => `sb_remote=${value}; Path=${APP}; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;

/**
 * `/boss gui remote` and `/boss gui remote off` in the session that runs the server. On: Tailscale's identity, the serve entry (pointed at
 * the remote listener, also over an entry that still points at this server's local port), then a pairing QR. Off: the entry goes and every
 * remote stream ends, but the paired devices stay. `stop` is the server going away (a stop, a takeover, a /reload, the session's end): the
 * entry goes the same way, and remote stays wanted, so the next server turns it on again. `dir` holds remote.json, the entry's target while it is on.
 */
export async function switchRemote(gui: { port: number; remotePort: number; token: string; access: Access }, on: boolean, dir: string, run: Run = tailscale, stop = false): Promise<{ text: string; plain: string; lines?: string[]; link?: () => string; changed: boolean }> {
	// An entry from before the remote listener points at the local port; it is this server's own, so it is repointed or removed like a recorded one.
	const target = `http://127.0.0.1:${gui.remotePort}`, old = `http://127.0.0.1:${gui.port}`, file = join(dir, "remote.json");
	let stale: string | undefined;
	try {
		const record = JSON.parse(readFileSync(file, "utf8"));
		stale = record.pid === process.pid || !runs(record, statSync(file).mtimeMs) ? record.target : undefined; // another live server's entry (its session too busy to answer) is not stale
	} catch {} // no entry was recorded
	if (!on) {
		// An entry a crashed session left (recorded in remote.json) is cleaned up too, while it still points where it was recorded.
		const was = gui.access.remote;
		gui.access.disable(stop);
		const id = was ?? (stale ? await identity(run).catch(() => undefined) : undefined);
		if (!id) return { text: "Remote access is off", plain: "Remote access is off", changed: false };
		const left = { remains: false }, removed = await serveOff(run, id.host, [was && target, stale, old], left);
		if (removed || !left.remains) rmSync(file, { force: true }); // an entry of ours under another host (the identity changed) is still to remove: its record stays
		const text = removed ? `Remote access is off; the Tailscale serve entry on ${PORT} is removed` : `Remote access is off; the ${PORT} entry no longer pointed here, so it was left alone`;
		return { text, plain: text, changed: true };
	}
	const id = await identity(run);
	await serveOn(run, id.host, target, [stale, old]);
	const started = startOf(process.pid);
	writeFileSync(file, JSON.stringify({ target, pid: process.pid, started }), { mode: 0o600 });
	if (!started) void startedLater(process.pid, { hold: false }).then((known) => { // Windows reads its own start time in the background: the entry is written again with it, if it is still this one
		try {
			const now = JSON.parse(readFileSync(file, "utf8")) as { target?: string; pid?: number; started?: string };
			if (known && now.pid === process.pid && now.target === target && !now.started) writeFileSync(file, JSON.stringify({ ...now, started: known }), { mode: 0o600 });
		} catch {} // the entry is gone: nothing to complete
	});
	gui.access.enable(id);
	// Every link is a new one-time pairing URL: the QR's own, and one per press of c or o in the overlay.
	const link = () => `https://${id.host}/${gui.token}/pair/${gui.access.pair()}`;
	const code = gui.access.pairCode();
	const lines = [...qrLines(qr(link())), "", "Scan with a device signed in to Tailscale as", id.login, "", "Or in an installed app, type this code (it works once, within ten minutes):", code!, "", "c  copy a new one-time link", OPEN_LINE, "Esc or q  close"];
	const plain = `Remote access is on for ${id.login}, tailnet only: https://${id.host}/${gui.token}/`; // `plain`: for a server that starts again, where no QR is shown
	return { text: `${plain} (scan the QR; it works once, within ten minutes)`, plain, lines, link, changed: true };
}
