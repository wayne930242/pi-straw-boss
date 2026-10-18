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
// Chrome withholds the SameSite=Strict cookie from a sandboxed frame's requests (remote.ts).

const SIBLING: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
const MAX_DOC = 2 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024, NONCE_MS = 30 * 60_000, MAX_NONCES = 256, MAX_QUERY = 16 * 1024, MAX_ANSWER = 12 * 1024, CAP = /^[0-9a-f]{32}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/; // tab, newline, and CR (a textarea's line break) stay, as Chawan sends them
export const docCsp = (origin: string) => `sandbox allow-forms allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src ${origin} data:; style-src ${origin} 'unsafe-inline'; font-src ${origin} data:; form-action ${origin}; base-uri 'none'; frame-ancestors ${origin}`;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The document as served: other <base> tags dropped, links opening in a new tab, each `cgi-bin:pi-answer` form posting (GET) to this page's nonce,
 *  and what could undo that dropped: a referrer policy of its own (the URL holds the token) and the buttons' formaction, formmethod, formtarget.
 *  Regexes over HTML text are a best effort (an entity or a quoted `>` gets past them); the sandbox and the CSP are what hold. */
export function rewrite(html: string, nonce: string) {
	const forms = html.replace(/<base\b[^>]*>|<meta\b[^>]*\bname\s*=\s*["']?referrer\b[^>]*>/gi, "").replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(/\s(?:referrerpolicy|formaction|formmethod|formtarget)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")).replace(/<form\b[^>]*>/gi, (tag) => (/\saction\s*=\s*(?:"\s*cgi-bin:pi-answer\s*"|'\s*cgi-bin:pi-answer\s*'|cgi-bin:pi-answer(?=[\s>/]))/i.test(tag) ? tag.replace(/\s(?:action|method|target)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "").replace(/^<form/i, `<form action="answer/${nonce}" method="get" target="_self"`) : tag));
	const at = /<head\b[^>]*>/i.exec(forms) ?? /<html\b[^>]*>/i.exec(forms) ?? /<!doctype[^>]*>/i.exec(forms), cut = at ? at.index + at[0].length : 0;
	return `${forms.slice(0, cut)}<base target="_blank">${forms.slice(cut)}`;
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
	const nonces = new Map<string, { cap: string; until: number }>();
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
		/** `parts` is the path after doc/; `origin` the page's own origin, which the document's policy names. */
		async serve(req: IncomingMessage, res: ServerResponse, [cap = "", ...rest]: string[], origin: string) {
			const h = req.headers, base = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": docCsp(origin) };
			const page = (status: number, title: string, text: string) => res.writeHead(status, { ...base, "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><style>body{margin:0;padding:24px;background:#0b1222;color:#dbe6ff;font:15px/1.5 system-ui,sans-serif}h1{margin:0 0 6px;font-size:17px;color:#ffd27a}p{margin:0;color:#8b99ba}</style><h1>${escape(title)}</h1><p>${escape(text)}</p>`);
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
				nonces.set(nonce, { cap, until: now + NONCE_MS });
				// Back and Forward show this copy again (its nonce is spent once sent); a reload fetches a fresh one.
				return void res.writeHead(200, { ...base, "cache-control": "private, no-cache", "content-type": "text/html; charset=utf-8" }).end(rewrite(readFileSync(real, "utf8"), nonce));
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
		text(cap: string): { status: number; body: unknown } {
			const found = CAP.test(cap) ? hub.doc(cap) : undefined, real = found?.doc.kind === "text" ? file(found.doc.path, MAX_DOC) : undefined;
			return real ? { status: 200, body: { kind: "text", display: found!.doc.display, revision: found!.doc.revision, text: readFileSync(real, "utf8") } } : { status: 404, body: { error: "not_found", reason: "This document is not open in the net any more." } };
		},
	};
}
