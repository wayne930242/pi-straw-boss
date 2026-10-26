import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FormMessage, type FormReply, REGISTER } from "../src/bridge.ts";
import { createHub } from "../src/dialogs.ts";
import { fieldsOf, rewrite } from "../src/docs.ts";
import type { Doc } from "../src/documents.ts";
import { type Gui, startGui } from "../src/gui.ts";
import { canonical } from "../src/history.ts";
import type { Found, Ref } from "../src/net.ts";
import { PORT } from "../src/remote.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-docs-test-")));
const bundle = join(scratch, "bundle"), dir = join(scratch, "work", "docs"), outside = join(scratch, "outside");
for (const d of [bundle, join(dir, "sub"), outside]) mkdirSync(d, { recursive: true });
writeFileSync(join(bundle, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const PLAN = `<!doctype html><html><head><base href="https://evil.example/"><link rel="stylesheet" href="style.css"></head><body><img src="pic.png"><form ACTION='cgi-bin:pi-answer' method="post" target="_top"><input name="choice" value="a"></form><form action="https://elsewhere.example/x"></form></body></html>`;
const files: Record<string, string | Buffer> = { "plan.html": PLAN, "style.css": "body{color:red}", "pic.png": Buffer.from([0x89, 0x50]), "font.woff2": Buffer.alloc(8), "sub/inner.css": "p{}", "notes.txt": "plain", "notes.md": "# Notes", "big.png": Buffer.alloc(8 * 1024 * 1024 + 1) };
for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
writeFileSync(join(outside, "secret.css"), "secret{}");
symlinkSync(join(outside, "secret.css"), join(dir, "link.css"));
symlinkSync(join(outside, "secret.css"), join(dir, "linked.html"));
const sessionFile = join(scratch, "2026_S.jsonl");
writeFileSync(sessionFile, "");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const doc = (extra: Partial<Doc> = {}): Doc => ({ id: "html-1", path: join(dir, "plan.html"), kind: "html", display: "docs/plan.html", reason: "Plan ready", revision: 1, onScreen: true, ...extra });
const DOCS = [doc(), doc({ id: "text-1", path: join(dir, "notes.md"), kind: "text", display: "docs/notes.md" }), doc({ id: "link-1", path: join(dir, "linked.html"), display: "linked.html" })];

/** A GUI server with a real hub whose bridge for session S (on pane wA:p1) lists DOCS; `me` is the hub's session, S for the in-process path. */
const accept = (m: FormMessage): FormReply | undefined => ({ version: 1, type: "form-result", bridgeId: "B", id: m.id, answerId: m.answerId, accepted: m.fields.length > 0, ...(m.fields.length ? {} : { reason: "empty" }) });
async function serve({ me = "S", owner, reply = accept }: { me?: string; owner?: string; reply?: typeof accept } = {}) {
	const forms: FormMessage[] = [], channelOwner = owner ?? me;
	const events = { emit: (ch: string, r: never) => ch === REGISTER && (r as { onReady(c: unknown): void }).onReady({ snapshot: () => ({ connected: true, owner: { sessionId: channelOwner, epoch: "e1" } }), publish: () => {} }), on: () => () => {} };
	const local = { deliver: () => {}, sync: () => {}, probe: () => ({ editor: "empty" as const }), commands: () => [], close: () => ({ accepted: false }), stashCheck: () => undefined, pull: () => ({ reason: "no_editor" }), form: (m: FormMessage, r: (x: FormReply) => void) => { forms.push(m); const x = reply(m); if (x) r(x); } };
	const hub = createHub({ events } as unknown as ExtensionAPI, me, local);
	const found: Found = { key: "S", base: "wA", name: "billing-main", role: "main", file: canonical(sessionFile), pane: "wA:p1", live: true };
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: (key) => (key === "S" ? found : undefined), workspace: () => [] }, hub, dir: bundle, pollMs: 50, pingMs: 1000 });
	running.push(gui);
	hub.receive("S", { version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file: sessionFile, dialogs: [], closed: [], documents: DOCS });
	const relayed = hub.relayed([{ id: "S", herdrLocation: { status: "current", paneId: "wA:p1" } }], new Map<string, Ref>([["S", found]]));
	const caps = Object.fromEntries((relayed.docsOf?.("S")?.docs ?? []).map((c) => [c.display, c.cap]));
	return { gui, hub, forms, caps, html: caps["docs/plan.html"]!, text: caps["docs/notes.md"]!, link: caps["linked.html"]! };
}
type Res = { status: number; headers: IncomingMessage["headers"]; body: string };
const get = (gui: Gui, path: string, headers: Record<string, string | undefined> = {}, method = "GET") =>
	new Promise<Res>((resolve, reject) => {
		// A request that names a Host of its own is a tailnet one (`tailscale serve` forwards it to the remote listener); the rest are this computer's.
		const req = request({ host: "127.0.0.1", port: headers.host ? gui.remotePort : gui.port, path, method, headers: Object.fromEntries(Object.entries({ host: `127.0.0.1:${gui.port}`, ...headers }).filter(([, v]) => v !== undefined)) as Record<string, string>, agent: false }, (res) => {
			let body = "";
			res.setEncoding("latin1");
			res.on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		});
		req.on("error", reject).end();
	});
const frame = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
const fromFrame = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" };
const nonceOf = (body: string) => /action="answer\/([0-9a-f]{32})"/.exec(body)![1]!;

test("the rewrite: a pi-answer form (either quote, any case, unquoted) posts here with GET in its own frame; other forms and attributes stay; <base> is replaced by target=_blank", () => {
	const n = "f".repeat(32), out = (form: string) => rewrite(`<html><head><title>t</title></head><body>${form}</body></html>`, n);
	for (const form of [`<form action="cgi-bin:pi-answer">`, `<form action='CGI-BIN:PI-ANSWER' method="post">`, `<FORM class="q" action=cgi-bin:pi-answer target=_top>`, `<form\n  action = "cgi-bin:pi-answer"\n  method='POST'>`])
		assert.match(out(form), new RegExp(`<form action="answer/${n}" method="get" target="_self"[^>]*>`, "i"), form);
	assert.match(out(`<FORM class="q" action=cgi-bin:pi-answer target=_top>`), /target="_self" class="q">/, "other attributes stay");
	assert.ok(out(`<form action="https://elsewhere.example/">`).includes(`<form action="https://elsewhere.example/">`), "another form is left as it is (the policy's form-action stops it)");
	assert.ok(out(`<form action="cgi-bin:pi-answer-not">`).includes(`cgi-bin:pi-answer-not`), "only that exact action");
	const two = out(`<form action="cgi-bin:pi-answer"></form><form action='cgi-bin:pi-answer'></form>`);
	assert.equal(two.split(`answer/${n}`).length, 3, "several forms share the page's nonce");
	assert.equal(rewrite(`<html><head><base href="https://evil.example/"><BASE target=_top></head></html>`, n), `<html><head><base target="_blank"></head></html>`);
	assert.equal(rewrite(`<!doctype html><p>no head`, n), `<!doctype html><base target="_blank"><p>no head`);
	assert.equal(rewrite(`<p>bare`, n), `<base target="_blank"><p>bare`);
	const undo = rewrite(`<head><meta name="referrer" content="unsafe-url"><META NAME=referrer content=origin></head><a href="https://x.example/" referrerpolicy="unsafe-url">x</a><form action="cgi-bin:pi-answer"><button formaction="https://x.example/" formmethod=post formtarget='_top'>go</button></form>`, n);
	assert.ok(!/referrer|formaction|formmethod|formtarget/i.test(undo), `nothing undoes the policy or the rewrite: ${undo}`);
});

test("form fields: as the query decodes them, at most 64, 16 KB of query and 12 KB of answer, no control characters but tab and line breaks", () => {
	assert.deepEqual(fieldsOf("choice=b&note=line+one%0D%0Aline+two&choice=c"), [["choice", "b"], ["note", "line one\r\nline two"], ["choice", "c"]]);
	assert.deepEqual(fieldsOf(""), []);
	assert.match(String(fieldsOf(Array.from({ length: 65 }, (_, i) => `f${i}=1`).join("&"))), /64 fields/);
	assert.match(String(fieldsOf(`a=${"x".repeat(16 * 1024)}`)), /16 KB/);
	assert.match(String(fieldsOf(`a=${"x".repeat(13_000)}`)), /12 KB/, "what the channel carries");
	for (const bad of ["a=%00", "a=%1B%5B3G", "a%07=1", "a=%C2%9B"]) assert.match(String(fieldsOf(bad)), /control/, bad);
});

test("an HTML document is served by its capability, rewritten, under a sandbox policy that names the server's origin; nothing else is", async () => {
	const { gui, html, text, link } = await serve(), at = `/${gui.token}/doc/`;
	const page = await get(gui, `${at}${html}/`, frame);
	assert.equal(page.status, 200);
	assert.equal(page.headers["content-security-policy"], `sandbox allow-forms allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src http://127.0.0.1:${gui.port} data:; style-src http://127.0.0.1:${gui.port} 'unsafe-inline'; font-src http://127.0.0.1:${gui.port} data:; form-action http://127.0.0.1:${gui.port}; base-uri 'none'; frame-ancestors http://127.0.0.1:${gui.port}`);
	assert.deepEqual([page.headers["x-content-type-options"], page.headers["referrer-policy"], page.headers["cache-control"], page.headers["content-type"]], ["nosniff", "no-referrer", "private, no-cache", "text/html; charset=utf-8"]);
	assert.ok(!page.body.includes("evil.example") && page.body.includes(`<head><base target="_blank">`), "its own <base> is gone");
	assert.notEqual(nonceOf(page.body), nonceOf((await get(gui, `${at}${html}/`, frame)).body), "a nonce per served page");
	assert.equal((await get(gui, `${at}${html}`, frame)).status, 308, "the document's URL ends with a slash, so its files resolve beside it");
	assert.equal((await get(gui, `${at}${html}/`, { "sec-fetch-site": "none" })).status, 200, "opened in a tab of its own");
	for (const [what, path, headers] of [
		["a capability nobody listed", `${at}${"0".repeat(32)}/`, frame], ["a malformed one", `${at}..%2Fbundle/`, frame], ["a text document as a page", `${at}${text}/`, frame],
		["a listed path that is a symlink now", `${at}${link}/`, frame], ["a subresource load of the page", `${at}${html}/`, { "sec-fetch-dest": "script" }],
	] as const) {
		const r = await get(gui, path, headers);
		assert.equal(r.status, 404, what);
		assert.match(String(r.headers["content-security-policy"]), /^sandbox /, `${what}: even the refusal is sandboxed`);
	}
	assert.equal((await get(gui, `${at}${html}/`, frame, "POST")).status, 404, "GET only");
	const back = await get(gui, `${at}${html}/`, fromFrame);
	assert.deepEqual([back.status, /Reload the document/.test(back.body), back.body.includes("answer/")], [409, true, false], "a navigation from the document's own frame (WebKit's Back, another site) gets no fresh nonce");
	assert.equal((await get(gui, `/${"0".repeat(32)}/doc/${html}/`, frame)).status, 403, "the token still comes first");
});

test("beside an HTML document only images, stylesheets, and fonts under its own directory are served, within 8 MB, never through a symlink out", async () => {
	const { gui, html, text } = await serve(), at = `/${gui.token}/doc/${html}/`, sub = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style" };
	const css = await get(gui, `${at}style.css`, sub);
	assert.deepEqual([css.status, css.headers["content-type"], css.body], [200, "text/css; charset=utf-8", "body{color:red}"]);
	assert.match(String(css.headers["content-security-policy"]), /^sandbox /, "a file opened on its own is sandboxed too (an SVG runs no script)");
	assert.equal(css.headers["access-control-allow-origin"], undefined);
	assert.equal((await get(gui, `${at}sub/inner.css`, sub)).status, 200);
	assert.equal((await get(gui, `${at}pic.png`)).headers["content-type"], "image/png");
	const font = await get(gui, `${at}font.woff2`, { origin: "null", "sec-fetch-mode": "cors", "sec-fetch-dest": "font" });
	assert.deepEqual([font.status, font.headers["access-control-allow-origin"]], [200, "*"], "a sandboxed frame loads fonts in CORS mode from origin null");
	for (const [what, path] of [["another extension", "notes.txt"], ["a markdown file", "notes.md"], ["the document itself as a file", "plan.html"], ["a symlink out of the directory", "link.css"], ["over 8 MB", "big.png"], ["missing", "gone.png"], ["an encoded ..", "..%2F..%2Foutside%2Fsecret.css"], ["an encoded .. segment", "sub%2F..%2F..%2F..%2Foutside%2Fsecret.css"], ["a NUL", "style.css%00.png"], ["a bad escape", "%E0%A4%A.css"]] as const)
		assert.equal((await get(gui, `${at}${path}`, sub)).status, 404, what);
	assert.equal((await get(gui, `/${gui.token}/doc/${text}/style.css`, sub)).status, 404, "a text document has no files beside it");
});

test("a text document comes as JSON from the API for the page's renderer; an HTML one does not", async () => {
	const { gui, html, text } = await serve();
	const r = await get(gui, `/${gui.token}/api/doc/${text}`);
	assert.equal(r.status, 200);
	assert.deepEqual(JSON.parse(r.body), { kind: "text", display: "docs/notes.md", revision: 1, text: "# Notes" });
	for (const cap of [html, "0".repeat(32), "x"]) assert.equal((await get(gui, `/${gui.token}/api/doc/${cap}`)).status, 404, cap);
});

test("a form answer goes once to the document's owner through its bridge, with the page's nonce as its answerId; a reused, foreign, or expired nonce is refused with a page that says so", async () => {
	const { gui, html, forms } = await serve(), at = `/${gui.token}/doc/${html}/`;
	const n = nonceOf((await get(gui, at, frame)).body);
	const sent = await get(gui, `${at}answer/${n}?choice=b&note=two+words`, fromFrame);
	assert.equal(sent.status, 200);
	assert.match(sent.body, /Sent to billing-main/);
	assert.match(String(sent.headers["content-security-policy"]), /^sandbox /);
	assert.deepEqual(forms, [{ version: 1, type: "form", to: "B", id: "html-1", answerId: n, fields: [["choice", "b"], ["note", "two words"]] }]);
	const again = await get(gui, `${at}answer/${n}?choice=b`, fromFrame);
	assert.deepEqual([again.status, /Already sent/.test(again.body)], [409, true], "Back and submit again");
	assert.equal(forms.length, 1, "delivered once");
	const other = await serve(), theirs = nonceOf((await get(other.gui, `/${other.gui.token}/doc/${other.html}/`, frame)).body);
	assert.equal((await get(gui, `${at}answer/${theirs}?choice=b`, fromFrame)).status, 409, "another server's nonce");
	const n2 = nonceOf((await get(gui, at, frame)).body);
	assert.equal((await get(gui, `${at}answer/${n2}?choice=b`, { ...fromFrame, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).status, 403, "only the form's own navigation sends");
	const n3 = nonceOf((await get(gui, at, frame)).body);
	const empty = await get(gui, `${at}answer/${n3}`, fromFrame);
	assert.deepEqual([empty.status, /no fields/.test(empty.body)], [409, true], "the owner's reason");
	const n4 = nonceOf((await get(gui, at, frame)).body);
	assert.equal((await get(gui, `${at}answer/${n4}?a=%1B%5B3G`, fromFrame)).status, 400, "control characters are refused before anything is sent");
	assert.equal((await get(gui, `${at}answer/${n4}?a=1`, fromFrame)).status, 409, "and that page's nonce is spent");
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		const n5 = nonceOf((await get(gui, at, frame)).body);
		mock.timers.tick(30 * 60_000 + 1);
		const late = await get(gui, `${at}answer/${n5}?choice=b`, fromFrame);
		assert.deepEqual([late.status, /Expired/.test(late.body)], [409, true]);
	} finally {
		mock.timers.reset();
	}
	assert.equal(forms.length, 2, "only the accepted and the empty one reached the bridge");
});

test("an answer the session cannot confirm says so; a document that left its list cannot be answered", async () => {
	const lost = await serve({ me: "G", owner: "Z" }), at = `/${lost.gui.token}/doc/${lost.html}/`;
	const r = await get(lost.gui, `${at}answer/${nonceOf((await get(lost.gui, at, frame)).body)}?choice=b`, fromFrame);
	assert.deepEqual([r.status, /Not confirmed/.test(r.body)], [504, true]);
	const { gui, hub, html } = await serve(), page = `/${gui.token}/doc/${html}/`, n = nonceOf((await get(gui, page, frame)).body);
	hub.receive("S", { version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file: sessionFile, dialogs: [], closed: [], documents: [] });
	assert.equal((await get(gui, `${page}answer/${n}?choice=b`, fromFrame)).status, 404, "closed in the terminal meanwhile");
	assert.equal((await get(gui, page, frame)).status, 404);
});

test("over the tailnet a document and its files need this user's identity and the capability, not the cookie (a sandboxed frame's requests come without it); everything else still needs the cookie", async () => {
	const { gui, html, text } = await serve(), host = `box.tail1.ts.net:${PORT}`, remote = { host, "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.87.7.97" };
	gui.access.enable({ host, login: "me@example.com" });
	const page = await get(gui, `/${gui.token}/doc/${html}/`, { ...remote, ...frame });
	assert.equal(page.status, 200);
	assert.match(String(page.headers["content-security-policy"]), new RegExp(`img-src https://${host} data:`), "its policy names the remote origin");
	assert.equal((await get(gui, `/${gui.token}/doc/${html}/style.css`, remote)).status, 200);
	assert.equal((await get(gui, `/${gui.token}/doc/${html}/answer/${nonceOf(page.body)}?choice=b`, { ...remote, ...fromFrame })).status, 200);
	for (const [what, headers] of [["no Tailscale identity", { ...remote, "tailscale-user-login": undefined }], ["another user", { ...remote, "tailscale-user-login": "other@example.com" }], ["Funnel", { ...remote, "tailscale-funnel-request": "?1" }], ["another host", { ...remote, host: "evil.example:8443" }]] as const)
		assert.equal((await get(gui, `/${gui.token}/doc/${html}/`, { ...headers, ...frame })).status, 403, what);
	assert.equal((await get(gui, `/${gui.token}/doc/${"0".repeat(32)}/`, { ...remote, ...frame })).status, 404, "identity alone serves no capability nobody listed");
	assert.equal((await get(gui, `/${gui.token}/`, remote)).status, 401, "the page needs the cookie");
	assert.equal((await get(gui, `/${gui.token}/api/doc/${text}`, remote)).status, 401, "so does the API, a text document's included");
	assert.equal((await get(gui, `/${gui.token}/events`, remote)).status, 401);
	gui.access.disable();
	assert.equal((await get(gui, `/${gui.token}/doc/${html}/`, { ...remote, ...frame })).status, 403, "remote off");
});

test("the app may frame its own documents and nothing else, and a page a document opens cannot steer its tab", async () => {
	const { gui } = await serve(), app = await get(gui, `/${gui.token}/`);
	assert.match(String(app.headers["content-security-policy"]), /frame-src 'self'; base-uri 'self'; frame-ancestors 'none'/);
	assert.equal(app.headers["cross-origin-opener-policy"], "same-origin");
});
