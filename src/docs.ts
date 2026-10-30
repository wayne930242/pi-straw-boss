import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import { dirname, extname, resolve, sep } from "node:path";
import type { Hub } from "./dialogs.ts";
import type { Fields } from "./documents.ts";

// Serving the documents a session shows (documents.ts) to the page, by capability: the hub's current binding is the allow list, and paths never
// come from the browser. GET /<t>/doc/<cap>/ is an HTML document, rewritten so its pi-answer forms submit here; GET /<t>/doc/<cap>/<path> an
// image, stylesheet, or font under its own directory; GET /<t>/doc/<cap>/answer/<nonce>?<fields> takes one form answer to the owner;
// GET /<t>/api/doc/<cap> a text document as JSON, which the page renders. Every /doc/ response carries a CSP `sandbox` without scripts, so a
// document (or an SVG opened on its own) runs no script and has an opaque origin: it cannot read the API or the cookie. The sources name the
// server's origin, because WebKit does not match 'self' in a sandboxed document; Chrome loads fonts there in CORS mode with Origin: null,
// so fonts allow any origin. Answers are never logged. A remote request reaches /doc/ with the Tailscale identity and the capability only:
// Chrome withholds the SameSite=Strict cookie from a sandboxed frame's requests (remote.ts). Over Wi-Fi access nothing like the Tailscale identity stands behind a link (docs/specs/2026-10-30-sb-gui-lan.md, "Documents on the LAN"), so
// there the document load and `api/doc` need an allowed device's cookie (remote.ts `check` sees to that, and `serve` asks again), the load mints a ticket into the `<base>` it inserts, and everything the document fetches or answers is
// served only under that ticket: GET /<t>/doc/<cap>/r/<ticket>/<path> and /r/<ticket>/answer/<nonce>. The ticketless forms answer 401 there, and an empty path under a ticket (an in-page #link) goes back to the document.
// A ticket and the nonces of a LAN load belong to the device whose cookie made the load (`revoke` ends them with the device: Unpair, Unpair all, Wi-Fi access off), and a top-level navigation (a link in the document, opened in a tab of its own)
// is sent on to the ticketless URL, where the cookie decides, so a ticket is never in the address bar.

const SIBLING: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
const MAX_DOC = 2 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024, NONCE_MS = 30 * 60_000, MAX_NONCES = 256, TICKET_MS = 30 * 60_000, MAX_TICKETS = 256, TICKET = /^[0-9a-f]{32}$/, MAX_QUERY = 16 * 1024, MAX_ANSWER = 12 * 1024, CAP = /^[0-9a-f]{32}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/; // tab, newline, and CR (a textarea's line break) stay, as Chawan sends them
export const docCsp = (origin: string) => `sandbox allow-forms allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src ${origin} data:; style-src ${origin} 'unsafe-inline'; font-src ${origin} data:; form-action ${origin}; base-uri 'none'; frame-ancestors ${origin}`;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The document as served: other <base> tags dropped, links opening in a new tab, each `cgi-bin:pi-answer` form posting (GET) to this page's nonce,
 *  and what could undo that dropped: a referrer policy of its own (the URL holds the token) and the buttons' formaction, formmethod, formtarget.
 *  Regexes over HTML text are a best effort (an entity or a quoted `>` gets past them); the sandbox and the CSP are what hold. */
export function rewrite(html: string, nonce: string, ticketBase?: string) {
	const forms = html.replace(/<base\b[^>]*>|<meta\b[^>]*\bname\s*=\s*["']?referrer\b[^>]*>/gi, "").replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(/\s(?:referrerpolicy|formaction|formmethod|formtarget)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")).replace(/<form\b[^>]*>/gi, (tag) => (/\saction\s*=\s*(?:"\s*cgi-bin:pi-answer\s*"|'\s*cgi-bin:pi-answer\s*'|cgi-bin:pi-answer(?=[\s>/]))/i.test(tag) ? tag.replace(/\s(?:action|method|target)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "").replace(/^<form/i, `<form action="answer/${nonce}" method="get" target="_self"`) : tag));
	const at = /<head\b[^>]*>/i.exec(forms) ?? /<html\b[^>]*>/i.exec(forms) ?? /<!doctype[^>]*>/i.exec(forms), cut = at ? at.index + at[0].length : 0;
	return `${forms.slice(0, cut)}<base ${ticketBase ? `href="${escape(ticketBase)}" ` : ""}target="_blank">${forms.slice(cut)}`;
}
/** A form's fields as the answer route takes them: at most 64, the query at most 16 KB and the answer 12 KB, no control characters. */
export function fieldsOf(query: string): Fields | string {
	if (query.length > MAX_QUERY) return "The answers are longer than 16 KB.";
	const fields = [...new URLSearchParams(query)];
	if (fields.length > 64) return "The form has more than 64 fields.";
	if (fields.some(([name, value]) => CONTROL.test(name) || CONTROL.test(value))) return "The answers hold control characters.";
	return Buffer.byteLength(JSON.stringify(fields)) > MAX_ANSWER ? "The answers are longer than 12 KB together." : fields;
}

export function createDocs(hub: Pick<Hub, "doc" | "form">, name: (key: string) => string) {
	// `lan` marks what a Wi-Fi load handed out; `device` is the allowed device (the hash of its cookie) whose load it was, when the caller named it (an entry without one goes with any revocation).
	type Held = { cap: string; until: number; lan?: true; device?: string };
	const nonces = new Map<string, Held>(), tickets = new Map<string, Held>();
	/** A file the document may use: the listed one itself, or one under its directory, as its real path, within `max` bytes. */
	const file = (path: string, max: number, under?: string) => {
		try {
			const real = realpathSync(path), root = under && realpathSync(under);
			return (root ? real.startsWith(root + sep) : real === path) && statSync(real).isFile() && statSync(real).size <= max ? real : undefined;
		} catch {
			return undefined;
		}
	};
	return {
		/** Ends the tickets and answer nonces that the loads of `device` handed out, or every LAN one when it names none (a network-wide end, or Unpair all). Those that name no device go with any call. The access's `ended(device, net)` calls it for the LAN. */
		revoke(device?: string) {
			for (const map of [tickets, nonces]) for (const [key, v] of map) if (v.lan && (!device || !v.device || v.device === device)) map.delete(key);
		},
		/** `parts` is the path after doc/; `origin` the page's own origin, which the document's policy names. `lan` is set for a request that came in over Wi-Fi access: the token (for the ticket's URL), whether the request carried an allowed device's cookie, and that device (the hash `check` returned as `device`), whose Unpair ends what its load hands out. */
		async serve(req: IncomingMessage, res: ServerResponse, [cap = "", ...path]: string[], origin: string, lan?: { token: string; cookie: boolean; device?: string }) {
			const h = req.headers, base = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": docCsp(origin) };
			const page = (status: number, title: string, text: string) => res.writeHead(status, { ...base, "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><style>body{margin:0;padding:24px;background:#0b1222;color:#dbe6ff;font:15px/1.5 system-ui,sans-serif}h1{margin:0 0 6px;font-size:17px;color:#ffd27a}p{margin:0;color:#8b99ba}</style><h1>${escape(title)}</h1><p>${escape(text)}</p>`);
			let rest = path;
			const root = lan && `/${lan.token}/doc/${cap}/`;
			if (lan && req.method === "GET" && CAP.test(cap)) {
				if (rest[0] === "r" && rest.length >= 2) {
					// Under a ticket: an empty path (an in-page #link resolves against the base) goes back to the document whatever the ticket says; anything else needs a live ticket of this capability.
					if (rest.length === 2 || (rest.length === 3 && rest[2] === "")) return void res.writeHead(303, { ...base, location: root! }).end();
					// A tab of its own (a link in the document; Sec-Fetch-Dest is "document" only for a top-level navigation) must not stay on a URL that holds the ticket: it goes on to the ticketless one, which takes the cookie. An answer is not
					// moved (its fields are in the query and only the ticket route takes it), and a browser that sends no Sec-Fetch-Dest is not told apart from an embed (the residual named in the spec).
					if (h["sec-fetch-dest"] === "document" && rest[2] !== "answer") return void res.writeHead(303, { ...base, location: `${root}${rest.slice(2).join("/")}` }).end();
					const t = TICKET.test(rest[1]!) ? tickets.get(rest[1]!) : undefined;
					if (!t || t.cap !== cap || t.until < Date.now()) return void page(401, "Not allowed", "This link does not carry a ticket this document handed out. Open the document again from the page.");
					rest = rest.slice(2);
				} else if (!(lan.cookie && (rest.length === 0 || (rest.length === 1 && rest[0] === "") || (h["sec-fetch-dest"] === "document" && rest[0] !== "answer")))) {
					return void page(401, "Not allowed", "A document opens only from a paired device's page on this network, and what it fetches only with the ticket that page gave it.");
				}
			}
			const found = req.method === "GET" && CAP.test(cap) ? hub.doc(cap) : undefined;
			if (!found) return void page(404, "Not found", "This document is not open in the net any more.");
			const { doc, key } = found, dest = h["sec-fetch-dest"], site = h["sec-fetch-site"];
			if (!rest.length) return void res.writeHead(308, { ...base, location: `${cap}/` }).end();
			if (rest.length === 1 && rest[0] === "") {
				// The document itself: a navigation of the page's frame or tab (Sec-Fetch-*, when the browser sends them), never another site's.
				const real = doc.kind === "html" ? file(doc.path, MAX_DOC) : undefined;
				if (!real || (dest && dest !== "iframe" && dest !== "document")) return void page(404, "Not found", "This document cannot be shown here.");
				// From the document's own frame (WebKit's Back after an answer, a link to itself), never with a fresh nonce: a form is never sent twice.
				if (site && site !== "same-origin" && site !== "none") return void page(409, "Reload the document", "Use Reload on its tile, or open it again, to see it and send its form again.");
				const nonce = randomBytes(16).toString("hex"), now = Date.now();
				for (const [n, v] of nonces) if (v.until < now || nonces.size >= MAX_NONCES) nonces.delete(n);
				nonces.set(nonce, { cap, until: now + NONCE_MS, ...(lan && { lan: true as const, ...(lan.device && { device: lan.device }) }) });
				let ticketBase: string | undefined;
				if (lan) {
					const ticket = randomBytes(16).toString("hex");
					for (const [t, v] of tickets) if (v.until < now || tickets.size >= MAX_TICKETS) tickets.delete(t);
					tickets.set(ticket, { cap, until: now + TICKET_MS, lan: true, ...(lan.device && { device: lan.device }) });
					ticketBase = `${root}r/${ticket}/`;
				}
				// Back and Forward show this copy again (its nonce is spent once sent); a reload fetches a fresh one.
				return void res.writeHead(200, { ...base, "cache-control": "private, no-cache", "content-type": "text/html; charset=utf-8" }).end(rewrite(readFileSync(real, "utf8"), nonce, ticketBase));
			}
			if (rest[0] === "answer" && rest.length === 2) {
				const n = nonces.get(rest[1]!), url = req.url ?? "", query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
				if ((h["sec-fetch-mode"] && h["sec-fetch-mode"] !== "navigate") || (dest && dest !== "iframe" && dest !== "document")) return void page(403, "Not sent", "A form answer comes only from the document's own form.");
				nonces.delete(rest[1]!); // one answer per served page, whatever happens next
				if (!n || n.cap !== cap) return void page(409, "Already sent", "This page's answer was already sent. Reload the document to send again.");
				if (n.until < Date.now()) return void page(409, "Expired", "This page was served more than 30 minutes ago. Reload the document to send again.");
				const fields = fieldsOf(query);
				if (typeof fields === "string") return void page(400, "Not sent", fields);
				const r = await hub.form(cap, rest[1]!, fields);
				if (!r) return void page(504, "Not confirmed", "Check the terminal: the session did not confirm the answer, so it may or may not have arrived.");
				if (r.accepted) return void page(200, `Sent to ${name(key)}`, "The agent has your answers.");
				return void page(409, "Not sent", r.reason === "closed" ? "The document is no longer open in its session." : r.reason === "empty" ? "The form has no fields to send." : `The session refused it (${r.reason ?? "no reason"}).`);
			}
			let rel: string;
			try {
				rel = rest.map(decodeURIComponent).join("/");
			} catch {
				return void page(404, "Not found", "No such file.");
			}
			const type = SIBLING[extname(rel).toLowerCase()], real = doc.kind === "html" && type && !rel.includes("\0") ? file(resolve(dirname(doc.path), rel), MAX_FILE, dirname(doc.path)) : undefined;
			if (!real) return void page(404, "Not found", "No such file beside the document.");
			res.writeHead(200, { ...base, "content-type": type!, ...(type!.startsWith("font/") ? { "access-control-allow-origin": "*" } : {}) });
			pipeline(createReadStream(real), res, () => {}); // a file that went meanwhile, or a reader that left, closes both ends
		},
		/** GET /<t>/api/doc/<cap>: a text document for the page's renderer. */
		text(cap: string, lan?: { cookie: boolean }): { status: number; body: unknown } {
			if (lan && !lan.cookie) return { status: 401, body: { error: "not_paired", reason: "A document opens only from a paired device on this network." } };
			const found = CAP.test(cap) ? hub.doc(cap) : undefined, real = found?.doc.kind === "text" ? file(found.doc.path, MAX_DOC) : undefined;
			return real ? { status: 200, body: { kind: "text", display: found!.doc.display, revision: found!.doc.revision, text: readFileSync(real, "utf8") } } : { status: 404, body: { error: "not_found", reason: "This document is not open in the net any more." } };
		},
	};
}
