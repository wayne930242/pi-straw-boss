import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Found } from "../src/net.ts";
import { MAX_UPLOAD, safeName, upload } from "../src/upload.ts";

// A file pasted, dropped, or picked in the composer (upload.ts): its bytes go into a private temp folder and the page gets the path.
// The origin, CSRF, and content type checks before it are control.ts's.

const dir = join(mkdtempSync(join(tmpdir(), "psb-upload-test-")), "uploads");
process.on("exit", () => rmSync(join(dir, ".."), { recursive: true, force: true }));
const live: Found = { key: "s1", base: "wA", name: "s1", role: "member", pane: "wA:p1", file: "/f.jsonl", live: true };
const req = (chunks: Buffer[], headers: Record<string, string> = {}) => Object.assign(Readable.from(chunks), { headers: { "x-sb-name": encodeURIComponent("shot.png"), ...headers } }) as unknown as IncomingMessage;

test("a file name keeps only its last part and safe characters", () => {
	assert.equal(safeName(encodeURIComponent("../../etc/passwd")), "passwd");
	assert.equal(safeName(encodeURIComponent("截圖 1.png")), "截圖 1.png");
	assert.equal(safeName(encodeURIComponent(".bashrc")), "bashrc");
	assert.equal(safeName("%E0%A4%A"), "file");
	assert.equal(safeName(encodeURIComponent("a;b$c.txt")), "a_b_c.txt");
});

test("an upload stores the bytes privately and answers the path; an unknown or ended session, an empty file, or one over 20 MB stores nothing", async () => {
	const ok = await upload(req([Buffer.from("png "), Buffer.from("bytes")]), live, dir);
	assert.equal(ok.status, 200);
	const path = (ok.body as { path: string }).path;
	assert.ok(path.startsWith(`${dir}/`) && path.endsWith("-shot.png"), path);
	assert.equal(readFileSync(path, "utf8"), "png bytes");
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal((await upload(req([Buffer.from("x")]), undefined, dir)).status, 404);
	assert.equal((await upload(req([Buffer.from("x")]), { ...live, live: false }, dir)).status, 409);
	assert.equal((await upload(req([]), live, dir)).status, 400);
	assert.equal((await upload(req([Buffer.alloc(1)], { "content-length": String(MAX_UPLOAD + 1) }), live, dir)).status, 413);
	assert.equal((await upload(req([Buffer.alloc(MAX_UPLOAD), Buffer.alloc(1)]), live, dir)).status, 413, "a body longer than it said is cut off too");
	assert.equal(readdirSync(dir).length, 1);
});
