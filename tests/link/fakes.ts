// Fakes for the relay client's tests: a fetch that records what it is asked and answers from a script, and helpers to read what it saw.

export interface Seen { method: string; url: URL; headers: Headers; body: Buffer; signal: AbortSignal | undefined }
export type Answer = Response | Error | ((seen: Seen) => Response | Promise<Response>);

/** A fetch that answers each call with the next scripted answer (the last one repeats), and records every call. */
export function scriptedFetch(...script: Answer[]) {
	const seen: Seen[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const body = init?.body == null ? Buffer.alloc(0) : Buffer.from(init.body as Uint8Array);
		const call: Seen = { method: init?.method ?? "GET", url: new URL(String(input)), headers: new Headers(init?.headers), body, signal: init?.signal ?? undefined };
		seen.push(call);
		const next = script[Math.min(seen.length - 1, script.length - 1)]!;
		if (next instanceof Error) throw next;
		return typeof next === "function" ? next(call) : next.clone();
	};
	return { fetch: fetch as typeof globalThis.fetch, seen };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A response whose body is the chunks given to `push`, until `end` or `fail`; aborting its signal errors the read, as a real fetch does. */
export function liveStream(signal?: AbortSignal, status = 200) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
	signal?.addEventListener("abort", () => { try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* already closed */ } }, { once: true });
	return {
		response: new Response(body, { status, headers: { "content-type": "text/event-stream" } }),
		push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
		end: () => controller.close(),
		fail: (error: Error) => controller.error(error),
	};
}

/** Resolves when `check` returns truthy, polling every few ms; rejects after `ms`. */
export async function until<T>(check: () => T | undefined | false, ms = 3000, what = "condition"): Promise<T> {
	const stop = Date.now() + ms;
	for (;;) {
		const v = check();
		if (v) return v;
		if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

export const noSleep = async () => undefined;
