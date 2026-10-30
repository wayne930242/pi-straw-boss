import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after as afterAll, afterEach, mock, test } from "node:test";
import { createDocs, rewrite } from "../src/docs.ts";
import type { Doc } from "../src/documents.ts";

// Documents over Wi-Fi access (docs/specs/2026-10-30-sb-gui-lan.md, "Documents on the LAN"; Steps L4): the load needs the cookie, everything it fetches or answers a ticket that only such a load hands out. The server below is `docs.serve` behind a
// plain listener; a test header (`x-cookie: 1`) stands for "this request carried an allowed device's cookie", which remote.ts `check` decides in the real server (lan-access.test.ts tests that half).

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-lan-docs-")));
const dir = join(scratch, "docs"), sub = join(dir, "sub");
mkdirSync(sub, { recursive: true });
const T = "t".repeat(32), ORIGIN = "https://weis-mbp.local:8445", CAP1 = "1".repeat(32), CAP2 = "2".repeat(32);
const PLAN = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="pic.png"><a href="#top">top</a><form action="cgi-bin:pi-answer" method="post"><input name="choice" value="a"></form></body></html>`;
writeFileSync(join(dir, "plan.html"), PLAN);
writeFileSync(join(dir, "other.html"), "<html><head></head><body>other</body></html>");
writeFileSync(join(dir, "style.css"), "body{color:red}");
writeFileSync(join(dir, "app.js"), "alert(1)");
writeFileSync(join(sub, "inner.css"), "p{}");
const docs: Record<string, Doc> = {
	[CAP1]: { id: "html-1", path: join(dir, "plan.html"), kind: "html", display: "docs/plan.html", reason: "Plan", revision: 1, onScreen: true },
	[CAP2]: { id: "html-2", path: join(dir, "other.html"), kind: "html", display: "docs/other.html", reason: "Other", revision: 1, onScreen: true },
};
const answers: { cap: string; nonce: string; fields: [string, string][] }[] = [];
const hub = {
	doc: (cap: string) => (docs[cap] ? { doc: docs[cap]!, key: "S" } : undefined),
	form: async (cap: string, nonce: string, fields: [string, string][]) => (answers.push({ cap, nonce, fields }), { accepted: true }),
} as unknown as Parameters<typeof createDocs>[0];
const served = createDocs(hub, () => "billing");
const servers: Server[] = [];
afterEach(() => mock.restoreAll());
afterAll(async () => {
	await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
	rmSync(scratch, { recursive: true, force: true });
});

type Res = { status: number; headers: IncomingMessage["headers"]; body: string };
async function lanServer(lan = true) {
	const server = createServer((req, res) => {
		const parts = (req.url ?? "").split("?")[0]!.split("/").slice(3); // ["", token, "doc", cap, ...]
		void served.serve(req, res, parts, ORIGIN, lan ? { token: T, cookie: req.headers["x-cookie"] === "1" } : undefined);
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as AddressInfo).port;
	return (path: string, headers: Record<string, string> = {}) => new Promise<Res>((resolve, reject) => {
		request({ host: "127.0.0.1", port, path, agent: false, headers }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		}).on("error", reject).end();
	});
}
const COOKIE = { "x-cookie": "1", "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" };
const base = (res: Res) => /<base href="(\/t{32}\/doc\/[0-9a-f]{32}\/r\/([0-9a-f]{32})\/)" target="_blank">/.exec(res.body);

test("the document load needs the cookie, and hands a ticket to the page in its <base>; the local and remote rewrite is as it was", async () => {
	const get = await lanServer();
	assert.equal((await get(`/${T}/doc/${CAP1}/`, { "sec-fetch-dest": "iframe" })).status, 401, "no cookie, no document");
	assert.equal((await get(`/${T}/doc/${CAP1}`, { "sec-fetch-dest": "iframe" })).status, 401);
	const load = await get(`/${T}/doc/${CAP1}/`, COOKIE);
	assert.equal(load.status, 200);
	const found = base(load);
	assert.ok(found, load.body);
	assert.equal(found![1], `/${T}/doc/${CAP1}/r/${found![2]}/`);
	assert.match(load.body, /<form action="answer\/[0-9a-f]{32}" method="get" target="_self">/, "the answer form stays relative, so it resolves under the ticket");
	assert.equal(load.headers["cache-control"], "private, no-cache");
	// Local and remote: byte for byte what rewrite gave before, with no ticket.
	const plain = await lanServer(false);
	const bare = await plain(`/${T}/doc/${CAP1}/`, { "sec-fetch-dest": "iframe" });
	assert.equal(bare.status, 200);
	assert.ok(bare.body.includes('<base target="_blank">') && !bare.body.includes("<base href"), "no ticket where the Tailscale identity stands behind the link");
	assert.equal(rewrite("<html><head></head></html>", "n"), '<html><head><base target="_blank"></head></html>');
	assert.equal(rewrite("<html><head></head></html>", "n", "/x/r/y/"), '<html><head><base href="/x/r/y/" target="_blank"></head></html>');
	assert.equal(rewrite("<html><head><base href=\"https://evil.example/\"></head></html>", "n", "/x/"), '<html><head><base href="/x/" target="_blank"></head></html>', "a document's own <base> never survives");
	assert.equal((await plain(`/${T}/doc/${CAP1}/style.css`)).status, 200, "and the ticketless form still serves there");
});

test("a subresource is served under a live ticket of its capability without the cookie, and a ticketless one, an expired one, or another capability's is 401", async () => {
	const get = await lanServer(), t0 = Date.now();
	mock.method(Date, "now", () => t0); // a clock the test moves, so "just inside" is exact
	const ticket = base(await get(`/${T}/doc/${CAP1}/`, COOKIE))![2]!;
	const under = (t: string, path: string, cap = CAP1) => `/${T}/doc/${cap}/r/${t}/${path}`;
	const css = await get(under(ticket, "style.css"));
	assert.deepEqual([css.status, css.headers["content-type"], css.body], [200, "text/css; charset=utf-8", "body{color:red}"], "no cookie needed under the ticket");
	assert.equal((await get(under(ticket, "pic.png"))).status, 404, "a file that is not there");
	assert.equal((await get(under(ticket, "sub/inner.css"))).status, 200, "a file under the folder");
	assert.equal((await get(under(ticket, "app.js"))).status, 404, "a script is never served");
	assert.equal((await get(under(ticket, "..%2Fplan.html"))).status, 404, "nor anything outside the folder");
	assert.equal((await get(under(ticket, "%2e%2e/style.css"))).status, 404);
	assert.equal((await get(`/${T}/doc/${CAP1}/style.css`)).status, 401, "the ticketless form");
	assert.equal((await get(`/${T}/doc/${CAP1}/style.css`, COOKIE)).status, 401, "even with the cookie");
	assert.equal((await get(`/${T}/doc/${CAP1}/sub/inner.css`)).status, 401);
	assert.equal((await get(under("f".repeat(32), "style.css"))).status, 401, "an unknown ticket");
	assert.equal((await get(under("short", "style.css"))).status, 401, "a malformed one");
	// Replayed for another document: the ticket belongs to CAP1.
	assert.equal((await get(under(ticket, "style.css", CAP2))).status, 401, "another capability's");
	const other = base(await get(`/${T}/doc/${CAP2}/`, COOKIE))![2]!;
	assert.equal((await get(under(other, "style.css", CAP2))).status, 200, "its own ticket");
	assert.equal((await get(under(other, "style.css", CAP1))).status, 401, "and not for the first document either");
	// A ticket is reusable until it expires (30 minutes), then 401.
	mock.method(Date, "now", () => t0 + 30 * 60_000 - 1);
	assert.equal((await get(under(ticket, "style.css"))).status, 200, "just inside");
	mock.method(Date, "now", () => t0 + 30 * 60_000 + 1);
	assert.equal((await get(under(ticket, "style.css"))).status, 401, "after thirty minutes");
	assert.equal((await get(`/${T}/doc/${CAP1}/`, COOKIE)).status, 200, "a new load mints a new one");
});

test("an answer goes through under the ticket with its single-use nonce; without the ticket, without the nonce, or twice it does not", async () => {
	const get = await lanServer();
	const load = await get(`/${T}/doc/${CAP1}/`, COOKIE), ticket = base(load)![2]!, nonce = /action="answer\/([0-9a-f]{32})"/.exec(load.body)![1]!;
	const answer = (t: string | undefined, n: string, headers: Record<string, string> = { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" }) => get(`/${T}/doc/${CAP1}/${t ? `r/${t}/` : ""}answer/${n}?choice=a`, headers);
	assert.equal((await answer(undefined, nonce)).status, 401, "the ticketless answer");
	assert.equal(answers.length, 0);
	const wrong = await answer(ticket, "e".repeat(32));
	assert.equal(wrong.status, 409, "a nonce nobody was given");
	const ok = await answer(ticket, nonce);
	assert.equal(ok.status, 200, ok.body);
	assert.deepEqual(answers, [{ cap: CAP1, nonce, fields: [["choice", "a"]] }]);
	assert.equal((await answer(ticket, nonce)).status, 409, "a nonce is spent once");
	// The ticket of another document does not carry the first one's answer.
	const next = base(await get(`/${T}/doc/${CAP1}/`, COOKIE))!, again = /answer\/([0-9a-f]{32})/.exec((await get(`/${T}/doc/${CAP1}/`, COOKIE)).body)![1]!;
	assert.ok(next);
	const foreign = base(await get(`/${T}/doc/${CAP2}/`, COOKIE))![2]!;
	assert.equal((await get(`/${T}/doc/${CAP1}/r/${foreign}/answer/${again}?choice=a`, { "sec-fetch-dest": "iframe" })).status, 401);
});

test("an empty path under a ticket (an in-page link) goes back to the document, whatever the ticket says", async () => {
	const get = await lanServer();
	const ticket = base(await get(`/${T}/doc/${CAP1}/`, COOKIE))![2]!;
	for (const t of [ticket, "f".repeat(32), "junk"]) {
		for (const path of [`/${T}/doc/${CAP1}/r/${t}/`, `/${T}/doc/${CAP1}/r/${t}`]) {
			const res = await get(path);
			assert.deepEqual([res.status, res.headers.location], [303, `/${T}/doc/${CAP1}/`], path);
		}
	}
	assert.equal((await get(`/${T}/doc/${CAP1}/`)).status, 401, "where it needs the cookie, as the load does");
});

test("api/doc answers a text document only to an allowed device's cookie on the LAN; the Tailscale form is as it was", () => {
	assert.equal(served.text(CAP1, { cookie: false }).status, 401);
	assert.equal(served.text(CAP1, { cookie: true }).status, 404, "an html document is not text, as before");
	assert.equal(served.text("x").status, 404, "and without `lan` nothing changes");
});
