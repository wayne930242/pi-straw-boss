import { NetworkError, ProtocolError, RateLimitedError, RelayError, ServerError } from "./errors.ts";

// Backoff and the one question every retry loop asks: is this failure worth another try.

/** The wait before attempt `attempt` (1 for the first retry). */
export type Backoff = (attempt: number) => number;
/** Waits `ms`; returns early, without throwing, when `signal` aborts (the caller checks the signal). */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Exponential from `baseMs`, capped at `maxMs`, with up to a quarter of random spread so devices that lost the relay together do not return together. */
export const exponentialBackoff = (o: { baseMs?: number; maxMs?: number; random?: () => number } = {}): Backoff => {
	const base = o.baseMs ?? 500, max = o.maxMs ?? 30_000, random = o.random ?? Math.random;
	return (attempt) => {
		const wait = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
		return Math.round(wait - wait * 0.25 * random());
	};
};

export const sleep: Sleep = (ms, signal) =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});

/**
 * Whether the same request may succeed later: no answer, a 408, a 5xx, a cap that frees up, or an answer this client could not read (a cut-off or
 * garbled body; a post carries its id, so the relay dedupes the repeat). Everything else (401, 403, 404, 409, 413, 422) is an answer.
 */
export const isTransient = (error: unknown): boolean =>
	error instanceof NetworkError || error instanceof ServerError || error instanceof RateLimitedError || error instanceof ProtocolError || (error instanceof RelayError && error.status === 408);

/** What the relay asked us to wait, if it did. */
export const retryAfterMs = (error: unknown): number | undefined => (error instanceof RateLimitedError ? error.retryAfterMs : undefined);
