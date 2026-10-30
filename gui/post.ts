// The server's write API: a POST with a JSON body and the CSRF secret the server put in the page. Every answer is JSON; a refusal carries its reason.

export interface Answer { ok: boolean; status: number; body: { error?: string; reason?: string } & Record<string, unknown> }

const csrf = () => document.querySelector<HTMLMetaElement>('meta[name="sb-csrf"]')?.content ?? "";
/** A file's bytes to a session's upload, which answers the path it stored the file at. */
export const sendFile = (path: string, file: File): Promise<Answer> =>
	fetch(`api/${path}`, { method: "POST", cache: "no-store", headers: { "content-type": "application/octet-stream", "x-sb-name": encodeURIComponent(file.name || "pasted"), "x-sb-csrf": csrf() }, body: file })
		.then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));

export const post = (path: string, body: Record<string, unknown>): Promise<Answer> =>
	fetch(`api/${path}`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-sb-csrf": csrf() }, body: JSON.stringify(body) })
		.then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));

/** A read: the same JSON answer, no body (the Wi-Fi tab polls `lan/pending`). */
export const get = (path: string): Promise<Answer> =>
	fetch(`api/${path}`, { cache: "no-store" }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));
