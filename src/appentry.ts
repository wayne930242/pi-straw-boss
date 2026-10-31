import type { IncomingMessage, ServerResponse } from "node:http";
import { askPage, noticePage, page, SCRIPT, waitPage, wordsOf } from "./entryform.ts";
import { lanAppCookieFor, lanCookieFor, type LanAt } from "./lan/access.ts";
import { APP, type Access, appCookieFor, cookieFor } from "./remote.ts";

// The installed app's fixed entry on the remote listener (docs/specs/2026-10-26-sb-backend.md, Remote app entry): `/sb-app/` holds no token and no secret, because the token changes with every
// listener and an installed app (on iOS with a cookie jar of its own) cannot follow it. A device with a pairing is sent on to the current page; one without gets a field for the short pairing
// code (paircode.ts), whose POST pairs it as a scanned QR does (remote.ts `entry` and `redeem` decide; this file only speaks HTTP, entryform.ts draws the pages).
// On a Wi-Fi access (LAN) listener the same entry takes an `at` and speaks the LAN's pairing (docs/specs/2026-10-30-sb-gui-lan.md, "Approval on this computer"): the QR's link carries a code and no token, and its GET only shows a Pair button;
// a posted code makes a pending device that is given the entry's cookie and nothing else, with a waiting page that shows the number to type on the computer; the token-bearing redirect comes only once the device is allowed.

const HTML = "text/html; charset=utf-8";
/** Whether the first language the browser asks for is Traditional Chinese: only then does a page speak it. */
export const zhOf = (req: IncomingMessage) => /^\s*zh-(?:tw|hk|mo|hant)\b/i.test(String(req.headers["accept-language"] ?? ""));

/** The handler of every request under `/sb-app/`; `headers` are the page's security headers (a form needs `form-action` as well, which `default-src 'none'` does not cover). `at` is set for a request that came in on a LAN listener. */
export function createEntry(access: Access, token: string, headers: Record<string, string>) {
	// `same-origin`, not the pages' `no-referrer`: a form post under no-referrer carries `Origin: null` (Fetch, "append a request Origin header"), and `redeem` takes only the entry's own origin (on the LAN too).
	const base = { ...headers, "content-security-policy": `${headers["content-security-policy"]}; form-action 'self'`, "referrer-policy": "same-origin" };
	/** The entry on a LAN listener (see the header). The device's cookie decides: allowed, it goes on to the page; pending, to the waiting page; neither, it is asked for a code. */
	const lan = (req: IncomingMessage, res: ServerResponse, path: string[], at: LanAt) => {
		const send = (code: number, type: string, body: string, more: Record<string, string | string[]> = {}) => void res.writeHead(code, { ...base, "content-type": type, ...more }).end(body);
		const zh = zhOf(req), refuse = (status: 403 | 429 = 403) => (status === 429 ? send(429, HTML, noticePage(zh, "limited")) : send(403, "text/plain", "forbidden"));
		if (req.method === "GET" && path.length === 0) return void (access.lan.admits(req, at) ? res.writeHead(308, { ...base, location: APP }).end() : refuse());
		if (req.method === "GET" && path.length === 1 && path[0] === "") {
			const who = access.lan.entry(req, at), site = req.headers["sec-fetch-site"], mode = req.headers["sec-fetch-mode"], dest = req.headers["sec-fetch-dest"];
			if ("status" in who) return void refuse(who.status);
			// The token is given to an allowed device alone, and only to a navigation.
			if ("cookie" in who) return void ((mode === undefined || mode === "navigate") && (dest === undefined || dest === "document") ? send(302, "text/plain", "", { location: `/${token}/`, "set-cookie": [lanCookieFor(token, who.cookie), lanAppCookieFor(who.cookie)] }) : refuse());
			if ("pending" in who) return void send(302, "text/plain", "", { location: `${APP}pair/wait` });
			if (dest === "document" && typeof site === "string" && site !== "same-origin") return void send(200, HTML, `<!doctype html><meta http-equiv="refresh" content="0"><p><a href="">Open the straw net</a></p>`);
			return void send(200, HTML, page(zh, undefined, true));
		}
		if (req.method === "GET" && path.length === 1 && path[0] === "entry.js") return void (access.lan.admits(req, at) ? send(200, "text/javascript; charset=utf-8", SCRIPT) : refuse());
		if (req.method === "GET" && path.length === 2 && path[0] === "pair") {
			if (path[1] === "wait") {
				const w = access.lan.waiting(req, at);
				if ("status" in w) return void refuse(w.status);
				return void (w.state === "allowed" ? send(302, "text/plain", "", { location: APP }) : send(200, HTML, waitPage(zh, w)));
			}
			// The QR's page: it shows a button and uses nothing up.
			return void (access.lan.admits(req, at) && /^[A-Za-z0-9_-]{20,64}$/.test(path[1]!) ? send(200, HTML, askPage(zh, at.host, path[1]!)) : refuse());
		}
		if (req.method === "POST" && path.length === 1 && path[0] === "pair") {
			if (!access.lan.admits(req, at)) return void refuse();
			let text = "", big = false;
			req.setEncoding("utf8");
			req.on("data", (chunk: string) => {
				if (big || (text += chunk).length <= 1024) return;
				big = true;
				res.once("finish", () => req.destroy());
				send(413, "text/plain", "too large", { connection: "close" });
			}).on("end", () => {
				if (big) return;
				const who = access.lan.redeem(req, text, at);
				// The device is given the entry's cookie and nothing more: no token in the body, a header, or a path, until the boss allows it.
				if ("cookie" in who) return send(200, HTML, waitPage(zh, { state: "pending", number: who.number }), { "set-cookie": [lanAppCookieFor(who.cookie)] });
				if ("wrong" in who) return send(403, HTML, page(zh, "wrong", true));
				if ("busy" in who) return send(503, HTML, noticePage(zh, "busy"));
				return who.status === 429 ? send(429, HTML, page(zh, "locked", true)) : refuse();
			}).on("error", () => {});
			return;
		}
		const known = req.method === "GET" || req.method === "POST";
		send(known ? 404 : 403, "text/plain", known ? "not found" : "forbidden");
	};
	return (req: IncomingMessage, res: ServerResponse, path: string[], at?: LanAt) => {
		if (at) return lan(req, res, path, at);
		const send = (code: number, type: string, body: string, more: Record<string, string | string[]> = {}) => void res.writeHead(code, { ...base, "content-type": type, ...more }).end(body);
		const refuse = () => send(403, "text/plain", "forbidden"), zh = zhOf(req), cookies = (value: string) => ({ "set-cookie": [cookieFor(token, value), appCookieFor(value)] });
		if (req.method === "GET" && path.length === 0) return void (access.admits(req) ? res.writeHead(308, { ...base, location: APP }).end() : refuse());
		if (req.method === "GET" && path.length === 1 && path[0] === "") {
			const who = access.entry(req), site = req.headers["sec-fetch-site"];
			if ("status" in who) return void refuse();
			// Only a navigation gets the token-bearing redirect: a script's same-origin fetch would read the token off the followed URL (fetch cannot forge Sec-Fetch-*; a browser without them is allowed).
			const mode = req.headers["sec-fetch-mode"], dest = req.headers["sec-fetch-dest"];
			if ("cookie" in who) return void ((mode === undefined || mode === "navigate") && (dest === undefined || dest === "document") ? send(302, "text/plain", "", { location: `/${token}/`, ...cookies(who.cookie) }) : refuse());
			// The same bounce as a tokened page's: a launch from another site leaves the SameSite=Strict cookie behind, and the same-origin reload carries it.
			if (req.headers["sec-fetch-dest"] === "document" && typeof site === "string" && site !== "same-origin") return void send(200, HTML, `<!doctype html><meta http-equiv="refresh" content="0"><p><a href="">Open the straw net</a></p>`);
			return void send(200, HTML, page(zh));
		}
		if (req.method === "GET" && path.length === 1 && path[0] === "entry.js") return void (access.admits(req) ? send(200, "text/javascript; charset=utf-8", SCRIPT) : refuse());
		if (req.method === "POST" && path.length === 1 && path[0] === "pair") {
			if (!access.admits(req)) return void refuse(); // nothing is read from a request that is not this machine's user
			let text = "", big = false;
			req.setEncoding("utf8");
			req.on("data", (chunk: string) => {
				if (big || (text += chunk).length <= 1024) return;
				big = true;
				res.once("finish", () => req.destroy());
				send(413, "text/plain", "too large", { connection: "close" });
			}).on("end", () => {
				if (big) return;
				const who = access.redeem(req, text);
				if ("cookie" in who) return send(200, HTML, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${APP}"><p>${wordsOf(zh).done}</p>`, cookies(who.cookie));
				if ("wrong" in who) return send(403, HTML, page(zh, "wrong"));
				return who.status === 429 ? send(429, HTML, page(zh, "locked")) : refuse();
			}).on("error", () => {});
			return;
		}
		const known = req.method === "GET" || req.method === "POST";
		send(known ? 404 : 403, "text/plain", known ? "not found" : "forbidden");
	};
}
