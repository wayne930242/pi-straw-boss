// The server's write API: a POST with a JSON body and the CSRF secret the server put in the page. Every answer is JSON; a refusal carries its reason.

export interface Answer { ok: boolean; status: number; body: { error?: string; reason?: string } & Record<string, unknown> }

export const post = (path: string, body: Record<string, unknown>): Promise<Answer> =>
	fetch(`api/${path}`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-sb-csrf": document.querySelector<HTMLMetaElement>('meta[name="sb-csrf"]')?.content ?? "" }, body: JSON.stringify(body) })
		.then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));
