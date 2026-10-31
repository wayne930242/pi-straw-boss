import type { IncomingMessage, ServerResponse } from "node:http";
import { page, SCRIPT, wordsOf } from "./entryform.ts";
import { APP, type Access, appCookieFor, cookieFor } from "./remote.ts";

// The installed app's fixed entry on the remote listener (docs/specs/2026-10-26-sb-backend.md, Remote app entry): `/sb-app/` holds no token and no secret, because the token changes with every
// listener and an installed app (on iOS with a cookie jar of its own) cannot follow it. A device with a pairing is sent on to the current page; one without gets a field for the short pairing
// code (paircode.ts), whose POST pairs it as a scanned QR does (remote.ts `entry` and `redeem` decide; this file only speaks HTTP, entryform.ts draws the pages).

const HTML = "text/html; charset=utf-8";
/** Whether the first language the browser asks for is Traditional Chinese: only then does a page speak it. */
export const zhOf = (req: IncomingMessage) => /^\s*zh-(?:tw|hk|mo|hant)\b/i.test(String(req.headers["accept-language"] ?? ""));

/** The handler of every request under `/sb-app/`; `headers` are the page's security headers (a form needs `form-action` as well, which `default-src 'none'` does not cover). */
export function createEntry(access: Access, token: string, headers: Record<string, string>) {
	// `same-origin`, not the pages' `no-referrer`: a form post under no-referrer carries `Origin: null` (Fetch, "append a request Origin header"), and `redeem` takes only the entry's own origin.
	const base = { ...headers, "content-security-policy": `${headers["content-security-policy"]}; form-action 'self'`, "referrer-policy": "same-origin" };
	return (req: IncomingMessage, res: ServerResponse, path: string[]) => {
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
