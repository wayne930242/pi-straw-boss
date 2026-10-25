// What a relay call can fail with (docs/specs/2026-10-25-straw-link.md, Relay; the relay's README lists each status). Every error from the
// relay is a RelayError with the status and the `{"error": code}` the relay sent; the subclasses are the statuses a caller tells apart.

/** The head of a team's roster: its last entry's seq and hash. */
export interface Head { seq: number; hash: Buffer }

export class RelayError extends Error {
	readonly status: number;
	/** The relay's `error` code, or a code of this client's own for what never reached the relay. */
	readonly code: string;
	/** The parsed body of the answer, when it had one. */
	readonly body: unknown;
	constructor(status: number, code: string, body?: unknown, options?: ErrorOptions) {
		super(status ? `relay answered ${status} ${code}` : code, options);
		this.name = new.target.name;
		this.status = status;
		this.code = code;
		this.body = body;
	}
}
/** 400: the relay could not read the request. A bug in this client, or a proxy in between. */
export class BadRequestError extends RelayError {}
/** 401: not a member (an unknown team answers the same), a bad signature, or a clock more than 5 minutes off (`bad-time`). */
export class UnauthorizedError extends RelayError {}
/** 403: a member that may not do this (`not-signer`, `not-attended`, `from-mismatch`). */
export class ForbiddenError extends RelayError {}
/** 404: no such invite, unknown or expired. */
export class NotFoundError extends RelayError {}
/** 409: a roster append whose `prev` is not the head (`head` says where it is), an invite already used or existing, a team that exists. */
export class ConflictError extends RelayError {
	readonly head: Head | undefined;
	constructor(status: number, code: string, body: unknown, head: Head | undefined) {
		super(status, code, body);
		this.head = head;
	}
}
/** 413: a body over the relay's hard limit. */
export class PayloadTooLargeError extends RelayError {}
/** 422: a roster entry or envelope the rules refuse; `code` is the rule's reason and `seq` the entry's position when the relay names it. */
export class UnprocessableError extends RelayError {
	readonly seq: number | undefined;
	constructor(status: number, code: string, body: unknown, seq: number | undefined) {
		super(status, code, body);
		this.seq = seq;
	}
}
/** 429: a cap (`rate-limited`, `team-full`, `too-many-invites`) or an envelope over 256 KB (`envelope-too-large`, which no retry cures). */
export class RateLimitedError extends RelayError {
	/** From `Retry-After`, in ms; undefined when the relay sent none. */
	readonly retryAfterMs: number | undefined;
	constructor(status: number, code: string, body: unknown, retryAfterMs: number | undefined) {
		super(status, code, body);
		this.retryAfterMs = retryAfterMs;
	}
}
/** 5xx: the relay or a proxy in front of it failed. */
export class ServerError extends RelayError {}
/** The request never got an answer: the connection failed, or it timed out. */
export class NetworkError extends RelayError {
	constructor(message: string, cause?: unknown) {
		super(0, message, undefined, { cause });
	}
}
/** An answer this client cannot use: not JSON, a field out of shape, a hash that does not match its entry. */
export class ProtocolError extends RelayError {}

const isHead = (v: unknown): v is { seq: number; hash: string } => typeof v === "object" && v !== null && Number.isSafeInteger((v as { seq?: unknown }).seq) && /^[0-9a-f]{64}$/.test(String((v as { hash?: unknown }).hash));

/** The error for a non-2xx answer. */
export function errorFor(status: number, body: unknown, retryAfter: string | null): RelayError {
	const obj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	const code = typeof obj.error === "string" ? obj.error : "unknown";
	switch (status) {
		case 400: return new BadRequestError(status, code, body);
		case 401: return new UnauthorizedError(status, code, body);
		case 403: return new ForbiddenError(status, code, body);
		case 404: return new NotFoundError(status, code, body);
		case 409: return new ConflictError(status, code, body, isHead(obj.head) ? { seq: obj.head.seq, hash: Buffer.from(obj.head.hash, "hex") } : undefined);
		case 413: return new PayloadTooLargeError(status, code, body);
		case 422: return new UnprocessableError(status, code, body, Number.isSafeInteger(obj.seq) ? (obj.seq as number) : undefined);
		case 429: {
			const seconds = retryAfter === null ? NaN : Number(retryAfter);
			return new RateLimitedError(status, code, body, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined);
		}
		default: return status >= 500 ? new ServerError(status, code, body) : new RelayError(status, code, body);
	}
}
