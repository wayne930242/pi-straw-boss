import type { IncomingMessage, ServerResponse } from "node:http";
import { APP, type Access, appCookieFor, cookieFor } from "./remote.ts";

// The installed app's fixed entry on the remote listener (docs/specs/2026-10-26-sb-backend.md, Remote app entry): `/sb-app/` holds no token and no secret, because the token changes with every
// listener and an installed app (on iOS with a cookie jar of its own) cannot follow it. A device with a pairing is sent on to the current page; one without gets a field for the short pairing
// code (paircode.ts), whose POST pairs it as a scanned QR does (remote.ts `entry` and `redeem` decide; this file only speaks HTTP and draws the pages).

const HTML = "text/html; charset=utf-8";
const TEXT = {
	en: { title: "Straw Net", lead: "This device is not paired. On the computer that runs Straw Boss, run /boss gui remote (or open Phone in the page) and type the code it shows beside the QR.", label: "Pairing code", go: "Pair", paired: "Already paired on this device? Open the straw net", wrong: "That code did not work. Check it, or ask for a new one on the computer.", locked: "Too many wrong codes. Ask for a new code on the computer (/boss gui remote).", done: "Paired. Opening the straw net…" },
	zh: { title: "Straw Net", lead: "這個裝置還沒配對。在執行 Straw Boss 的電腦上執行 /boss gui remote（或在頁面開啟「手機」視窗），輸入 QR code 旁邊顯示的配對碼。", label: "配對碼", go: "配對", paired: "這個裝置已經配對過？開啟 straw net", wrong: "這個配對碼無效。請確認輸入無誤，或在電腦上取得新的配對碼。", locked: "錯誤次數過多。請在電腦上取得新的配對碼（/boss gui remote）。", done: "已配對。正在開啟 straw net…" },
};
/** Whether the first language the browser asks for is Traditional Chinese: only then does a page speak it. */
export const zhOf = (req: IncomingMessage) => /^\s*zh-(?:tw|hk|mo|hant)\b/i.test(String(req.headers["accept-language"] ?? ""));
const page = (zh: boolean, note?: "wrong" | "locked") => {
	const t = TEXT[zh ? "zh" : "en"];
	return `<!doctype html><html lang="${zh ? "zh-Hant" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${t.title}</title><style>body{font:16px system-ui,sans-serif;background:#16161e;color:#c0caf5;margin:0;padding:2rem 1.25rem;max-width:30rem}input,button{font:inherit;padding:.6rem .8rem;border-radius:.4rem;border:1px solid #565f89;background:#1a1b26;color:inherit}input{letter-spacing:.15em;text-transform:uppercase;width:11em}button{background:#7aa2f7;color:#16161e;border-color:#7aa2f7;margin-left:.5rem}.note{color:#f7768e}a{color:#7aa2f7}</style></head><body><h1>${t.title}</h1><p>${t.lead}</p>${note ? `<p class="note" role="alert">${t[note]}</p>` : ""}${note === "locked" ? "" : `<form method="post" action="${APP}pair"><label>${t.label}<br><input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" required autofocus></label><button type="submit">${t.go}</button></form>`}<p><a href="${APP}">${t.paired}</a></p></body></html>`;
};

/** The handler of every request under `/sb-app/`; `headers` are the page's security headers (a form needs `form-action` as well, which `default-src 'none'` does not cover). */
export function createEntry(access: Access, token: string, headers: Record<string, string>) {
	const base = { ...headers, "content-security-policy": `${headers["content-security-policy"]}; form-action 'self'` };
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
				if ("cookie" in who) return send(200, HTML, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${APP}"><p>${TEXT[zh ? "zh" : "en"].done}</p>`, cookies(who.cookie));
				if ("wrong" in who) return send(403, HTML, page(zh, "wrong"));
				return who.status === 429 ? send(429, HTML, page(zh, "locked")) : refuse();
			}).on("error", () => {});
			return;
		}
		const known = req.method === "GET" || req.method === "POST";
		send(known ? 404 : 403, "text/plain", known ? "not found" : "forbidden");
	};
}
