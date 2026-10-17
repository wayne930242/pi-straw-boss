import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { qr, qrLines } from "./qr.ts";

// Remote access over Tailscale, tailnet only (never Funnel). `/boss gui remote` adds one `tailscale serve` entry, HTTPS on 8443 to the local
// server, only when 8443 is free or already ours (remote.json in the state directory remembers our target, so an entry a crashed session
// left is recognised); turning it off, `/boss gui stop`, and the end of the server's session remove that one entry and nothing else.
// Which request is which: serve passes the client's Host through but always adds X-Forwarded-* and Tailscale-* headers (and replaces any a
// client sent), so a local request is Host 127.0.0.1:<port> with none of them. A remote one needs Host exactly <MagicDNS name>:8443,
// no Funnel marker, Tailscale-User-Login equal to this machine's user, and a session cookie (HttpOnly, Secure, SameSite=Strict, scoped to
// the token path) that only a one-time pairing code from the QR gets: a code works once, within ten minutes. Turning remote off ends
// every remote session.

export const PORT = 8443;
const CODE_MS = 10 * 60_000, SESSION_MS = 7 * 24 * 3600_000, MAX_CODES = 16;
const FORWARDED = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via", "tailscale-headers-info", "tailscale-user-login", "tailscale-user-name", "tailscale-funnel-request"];
export type Run = (args: string[]) => Promise<string>;
export interface Identity { host: string; login: string }
/** `origin` for a request let in; `cookie` for a pairing code just exchanged; `status` for a refusal. */
export type Verdict = { origin: string; remote: boolean } | { cookie: string } | { status: 401 | 403 };

export const tailscale: Run = (args) =>
	new Promise((done, fail) => execFile("tailscale", args, { timeout: 15_000 }, (error, out, err) => (error ? fail(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "Tailscale is not installed (no tailscale command on PATH)" : `tailscale ${args.join(" ")} failed: ${err.trim() || error.message}`)) : done(out))));
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
	return { target, foreign: elsewhere || (held && !target), funnel: Boolean(s.AllowFunnel?.[host]) };
}

/** Points 8443 at `target`, when 8443 is free or ours (`target` itself or `stale`); otherwise, or when Funnel is on there, it refuses and touches nothing. */
export async function serveOn(run: Run, host: string, target: string, stale?: string) {
	const now = await served(run, host);
	if (now.funnel) throw new Error(`Funnel is on for ${host}; Straw Boss serves the tailnet only and leaves that entry alone`);
	if (now.foreign || (now.target && ![target, stale].includes(now.target))) throw new Error(`Port ${PORT} already serves something else${now.target ? ` (${now.target})` : ""}; Straw Boss does not touch other serve entries`);
	if (now.target !== target) await run(["serve", "--bg", `--https=${PORT}`, target]);
	const after = await served(run, host);
	if (after.target !== target || after.funnel) {
		if (after.target === target) await run(["serve", `--https=${PORT}`, "off"]);
		throw new Error(`tailscale serve did not take the entry as asked (${after.target ?? "none"}); remote access stays off`);
	}
}

/** Removes the 8443 entry only while it is still ours (only "/", proxying to one of `targets`). */
export async function serveOff(run: Run, host: string, targets: (string | undefined)[]) {
	const now = await served(run, host);
	if (now.foreign || !now.target || !targets.includes(now.target)) return false;
	await run(["serve", `--https=${PORT}`, "off"]);
	return true;
}

/** Who may in: the local page as today, and while remote is on, paired devices of this machine's Tailscale user. */
export function createAccess(token: string, ended: () => void = () => {}) {
	let remote: Identity | undefined;
	const codes = new Map<string, number>(), sessions = new Map<string, number>();
	const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
	return {
		get remote() { return remote; },
		enable(id: Identity) {
			// Another identity voids what the old one paired, and ends its streams.
			if (remote?.host !== id.host || remote.login !== id.login) (remote && ended(), codes.clear(), sessions.clear());
			remote = id;
		},
		disable() {
			remote = undefined;
			codes.clear();
			sessions.clear();
			ended();
		},
		/** A one-time pairing code (128 bits, ten minutes); expired codes go first, and past sixteen waiting the oldest goes. */
		pair(): string | undefined {
			if (!remote) return undefined;
			const code = randomBytes(16).toString("base64url"), now = Date.now();
			for (const [old, until] of codes) if (until < now) codes.delete(old);
			codes.set(code, now + CODE_MS);
			for (const old of codes.keys()) if (codes.size > MAX_CODES) codes.delete(old);
			return code;
		},
		/** `path` is the URL path after the token. A pairing code is used up by its first presentation that passes the identity checks. */
		check(req: IncomingMessage, port: number, given: string | undefined, path: string[]): Verdict {
			const h = req.headers;
			if (!same(given ?? "", token)) return { status: 403 };
			if (h.host === `127.0.0.1:${port}` && !FORWARDED.some((name) => name in h)) return { origin: `http://127.0.0.1:${port}`, remote: false };
			if (!remote || h.host !== remote.host || "tailscale-funnel-request" in h || h["tailscale-user-login"] !== remote.login) return { status: 403 };
			const now = Date.now();
			if (path[0] === "pair" && path.length === 2 && req.method === "GET") {
				const until = codes.get(path[1]!) ?? 0;
				codes.delete(path[1]!);
				if (until < now) return { status: 403 };
				const cookie = randomBytes(32).toString("hex");
				sessions.set(cookie, now + SESSION_MS);
				return { cookie };
			}
			const cookie = /(?:^|;\s*)sb_remote=([0-9a-f]{64})(?:;|$)/.exec(h.cookie ?? "")?.[1];
			return cookie && (sessions.get(cookie) ?? 0) > now ? { origin: `https://${remote.host}`, remote: true } : { status: 401 };
		},
	};
}
export type Access = ReturnType<typeof createAccess>;
const alive = (pid: unknown) => {
	try {
		return typeof pid === "number" && pid > 0 && process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};
export const cookieFor = (token: string, value: string) => `sb_remote=${value}; Path=/${token}/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;

/**
 * `/boss gui remote` and `/boss gui remote off` in the session that runs the server. On: Tailscale's identity, the serve entry, then a
 * pairing QR. Off: the entry goes and every remote session ends. `dir` holds remote.json, the entry's target while it is on.
 */
export async function switchRemote(gui: { port: number; token: string; access: Access }, on: boolean, dir: string, run: Run = tailscale): Promise<{ text: string; lines?: string[]; link?: () => string; changed: boolean }> {
	const target = `http://127.0.0.1:${gui.port}`, file = join(dir, "remote.json");
	let stale: string | undefined;
	try {
		const { target: was, pid } = JSON.parse(readFileSync(file, "utf8"));
		stale = pid === process.pid || !alive(pid) ? was : undefined; // another live server's entry (its session too busy to answer) is not stale
	} catch {} // no entry was recorded
	if (!on) {
		// An entry a crashed session left (recorded in remote.json) is cleaned up too, while it still points where it was recorded.
		const was = gui.access.remote;
		gui.access.disable();
		const id = was ?? (stale ? await identity(run).catch(() => undefined) : undefined);
		if (!id) return { text: "Remote access is off", changed: false };
		const removed = await serveOff(run, id.host, [was && target, stale]);
		rmSync(file, { force: true });
		return { text: removed ? `Remote access is off; the Tailscale serve entry on ${PORT} is removed` : `Remote access is off; the ${PORT} entry no longer pointed here, so it was left alone`, changed: true };
	}
	const id = await identity(run);
	await serveOn(run, id.host, target, stale);
	writeFileSync(file, JSON.stringify({ target, pid: process.pid }), { mode: 0o600 });
	gui.access.enable(id);
	// Every link is a new one-time pairing URL: the QR's own, and one per press of c or o in the overlay.
	const link = () => `https://${id.host}/${gui.token}/pair/${gui.access.pair()}`;
	const lines = [...qrLines(qr(link())), "", "Scan with a device signed in to Tailscale as", id.login, "", "c  copy a new one-time link", "o  open one in this computer's browser", "Esc or q  close"];
	return { text: `Remote access is on for ${id.login}, tailnet only: https://${id.host}/${gui.token}/ (scan the QR; it works once, within ten minutes)`, lines, link, changed: true };
}
