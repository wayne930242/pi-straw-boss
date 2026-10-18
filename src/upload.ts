import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Reply } from "./control.ts";
import type { Found } from "./net.ts";

// A file pasted, dropped, or picked in a session's composer: the page posts its bytes, the server stores them in a private folder under the
// temp directory, and the page puts the path into the message, the way a picture pasted into pi's terminal lands as a temp file path. The
// session reads it with its own tools. The checks before it (origin, CSRF, paired device) are control.ts's; the name only names the file.
//   POST /<token>/api/sessions/<key>/upload  (application/octet-stream, X-Sb-Name: the URI-encoded file name)  {path}

export const MAX_UPLOAD = 20 * 1024 * 1024;
export const UPLOADS = join(tmpdir(), "pi-straw-boss-uploads");
const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

/** A file name safe to keep: its last part, letters, digits, and `._ -` only, no leading dot, at most 120 characters. */
export function safeName(raw: unknown) {
	let name = "";
	try {
		name = decodeURIComponent(String(raw ?? ""));
	} catch {} // not URI-encoded: it gets the default name
	return basename(name.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[.\s]+/, "").slice(-120) || "file";
}

export async function upload(req: IncomingMessage, found: Found | undefined, dir = UPLOADS): Promise<Reply> {
	if (!found) return no(404, "not_found", "No such session.");
	if (!found.live || !found.pane) return no(409, "not_live", "This session is no longer live in a pane.");
	if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD) return (req.resume(), no(413, "too_large", "The file is larger than 20 MB."));
	const parts: Buffer[] = [];
	let size = 0;
	const whole = await new Promise<boolean>((done) => {
		req.on("data", (chunk: Buffer) => ((size += chunk.length) <= MAX_UPLOAD && parts.push(chunk)));
		req.on("end", () => done(size <= MAX_UPLOAD));
		req.on("error", () => done(false));
	});
	if (!whole) return no(413, "too_large", "The file is larger than 20 MB, or it did not arrive whole.");
	if (!size) return no(400, "bad_request", "The file is empty.");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName(req.headers["x-sb-name"])}`);
	await writeFile(path, Buffer.concat(parts), { mode: 0o600, flag: "wx" });
	return { status: 200, body: { path } };
}
