import { Buffer } from "node:buffer";
import { encodeEnvelope, type Envelope } from "./envelope.ts";
import { UnauthorizedError } from "./errors.ts";
import { exponentialBackoff, isTransient, retryAfterMs, sleep as realSleep, type Backoff, type Sleep } from "./retry.ts";

// The send side of the relay client: the per-sender outbox that keeps queued envelopes in `seq` order, and the queue of acknowledgements.

/** A built envelope waiting to land: its `seq`, its id (the relay's dedupe key), and the encoded bytes that are posted. */
export interface QueuedEnvelope { seq: number; id: Buffer; bytes: Buffer }

export interface OutboxOptions {
	/** Posts one encoded envelope; it resolves when the relay holds it (a 200 duplicate counts), and throws the client's typed error otherwise. */
	post: (bytes: Buffer, signal: AbortSignal) => Promise<unknown>;
	/**
	 * Gives the next `seq` and makes it durable before it returns: the caller saves its next sequence number (the team file, under the lock) so a
	 * crash never reuses one. The outbox never reads or writes that state, and never asks for a number it will not build with.
	 */
	reserveSeq: () => number | Promise<number>;
	backoff?: Backoff;
	sleep?: Sleep;
	/** The relay holds the envelope. */
	onPosted?: (item: QueuedEnvelope) => void;
	/** The relay refused the envelope for good (422, 403, 413, 429 `envelope-too-large`…). It leaves the queue; the next one goes on, and a gap in `seq` is harmless to receivers. */
	onRejected?: (item: QueuedEnvelope, error: unknown) => void;
	/** A 401: this device is not a member (removed) or its clock is off. The queue is kept and nothing is posted until `resume()`. */
	onHalt?: (item: QueuedEnvelope, error: UnauthorizedError) => void;
	/** A transient failure; the same envelope is tried again in `delayMs`. */
	onRetry?: (item: QueuedEnvelope, error: unknown, delayMs: number) => void;
}

/**
 * Posts queued envelopes one at a time, in `seq` order, and retries one until it lands before it posts the next, because the relay keeps a
 * sender's envelopes in arrival order and does not reorder by `seq` (spec, Envelope). Ephemeral envelopes (seq 0) are not queued: post them directly.
 */
export class Outbox {
	private readonly o: OutboxOptions;
	private readonly queue: QueuedEnvelope[] = [];
	private readonly controller = new AbortController();
	private lastSeq = 0;
	private reserving: Promise<unknown> = Promise.resolve();
	private pumping: Promise<void> | undefined;
	private halted: UnauthorizedError | undefined;
	private idlers: (() => void)[] = [];

	constructor(options: OutboxOptions) {
		this.o = options;
	}

	/** Reserves the next `seq`, builds the envelope with it, and queues it. Calls are served in order, so `seq` order is submit order. */
	submit(build: (seq: number) => Envelope): Promise<QueuedEnvelope> {
		const run = this.reserving.then(async () => {
			const seq = await this.o.reserveSeq();
			const envelope = build(seq);
			if (envelope.header.seq !== seq) throw new RangeError(`built with seq ${envelope.header.seq}, reserved ${seq}`);
			return this.enqueue({ seq, id: envelope.header.id, bytes: encodeEnvelope(envelope) });
		});
		this.reserving = run.catch(() => undefined);
		return run;
	}

	/** Queues an envelope that is already built (one the caller kept from before a restart); `seq` has to be above every one queued so far. */
	enqueue(item: QueuedEnvelope): QueuedEnvelope {
		if (!Number.isSafeInteger(item.seq) || item.seq < 1) throw new RangeError("a queued envelope has a seq of at least 1");
		if (item.seq <= this.lastSeq) throw new RangeError(`seq ${item.seq} is not above ${this.lastSeq}`);
		this.lastSeq = item.seq;
		this.queue.push(item);
		this.kick();
		return item;
	}

	/** Envelopes not yet landed, in order (the head is the one in flight). */
	pending(): QueuedEnvelope[] {
		return [...this.queue];
	}
	get size(): number {
		return this.queue.length;
	}
	/** The error that halted the outbox, until `resume()`. */
	get haltedBy(): UnauthorizedError | undefined {
		return this.halted;
	}

	/** Resolves when the queue is empty, or the outbox is halted or stopped. */
	idle(): Promise<void> {
		return this.settled() ? Promise.resolve() : new Promise((resolve) => this.idlers.push(resolve));
	}

	/** After a halt: try again from the envelope that was refused. */
	resume(): void {
		this.halted = undefined;
		this.kick();
	}

	/** Stops posting and any wait; the queue stays readable through `pending()`. */
	async stop(): Promise<void> {
		this.controller.abort();
		await this.pumping;
		this.release();
	}

	private settled() {
		return this.queue.length === 0 || this.halted !== undefined || this.controller.signal.aborted;
	}

	private release() {
		if (!this.settled()) return;
		for (const resolve of this.idlers.splice(0)) resolve();
	}

	private kick() {
		if (this.pumping || this.settled()) return;
		this.pumping = this.pump().finally(() => {
			this.pumping = undefined;
			this.release();
		});
	}

	private async pump(): Promise<void> {
		const { signal } = this.controller, backoff = this.o.backoff ?? exponentialBackoff(), sleep = this.o.sleep ?? realSleep;
		while (this.queue.length > 0 && !this.halted && !signal.aborted) {
			const item = this.queue[0]!;
			for (let attempt = 1; ; attempt++) {
				try {
					await this.o.post(item.bytes, signal);
					this.queue.shift();
					this.o.onPosted?.(item);
					break;
				} catch (error) {
					if (signal.aborted) return;
					if (isTransient(error)) {
						const delayMs = Math.max(backoff(attempt), retryAfterMs(error) ?? 0);
						this.o.onRetry?.(item, error, delayMs);
						await sleep(delayMs, signal);
						if (signal.aborted) return;
						continue;
					}
					if (error instanceof UnauthorizedError) {
						this.halted = error;
						this.o.onHalt?.(item, error);
						return;
					}
					this.queue.shift();
					this.o.onRejected?.(item, error);
					break;
				}
			}
		}
	}
}

// ---- Acknowledgements ----------------------------------------------------------------------------------------------------------------

export interface AckQueueOptions {
	/** Posts one batch of envelope ids (at most 500 per request is the client's business). */
	ack: (ids: Buffer[], signal: AbortSignal) => Promise<void>;
	/** How long to gather ids before a request, default 25 ms. */
	delayMs?: number;
	backoff?: Backoff;
	sleep?: Sleep;
	/** The ids that could not be acknowledged (the relay refused, or the queue was stopped while the relay was unreachable). They come again on the next stream. */
	onError?: (error: unknown, ids: Buffer[]) => void;
}

/**
 * Acknowledgements for envelopes the caller has delivered. It never acknowledges on its own: `add` is the caller saying so. A failed request is
 * retried with backoff while the relay is merely unreachable; one the relay refuses drops its ids, which then come again on the next stream and
 * are dropped by the receive checks.
 */
export class AckQueue {
	private readonly o: AckQueueOptions;
	private readonly pending = new Map<string, Buffer>();
	/** Aborted by `stop()` to cut a backoff wait short; a request in flight is left to finish. */
	private readonly waits = new AbortController();
	private timer: NodeJS.Timeout | undefined;
	private running: Promise<void> | undefined;
	private final = false;

	constructor(options: AckQueueOptions) {
		this.o = options;
	}

	add(id: Uint8Array): void {
		if (this.final) return;
		this.pending.set(Buffer.from(id).toString("hex"), Buffer.from(id));
		if (!this.running && !this.timer) this.timer = setTimeout(() => this.start(), this.o.delayMs ?? 25);
	}

	/** Sends what is waiting now and resolves when nothing is. */
	async flush(): Promise<void> {
		this.start();
		await this.running;
	}

	/** Ends the queue: no more retries, one last request for what is waiting, then a report of what could not be sent. */
	async stop(): Promise<void> {
		this.final = true;
		this.waits.abort();
		this.start();
		await this.running;
	}

	private start() {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.running || this.pending.size === 0) return;
		this.running = this.drain().finally(() => {
			this.running = undefined;
			if (this.pending.size > 0 && !this.final) this.start();
		});
	}

	private async drain(): Promise<void> {
		const backoff = this.o.backoff ?? exponentialBackoff(), sleep = this.o.sleep ?? realSleep;
		let attempt = 0;
		while (this.pending.size > 0) {
			const batch = [...this.pending.values()];
			try {
				await this.o.ack(batch, new AbortController().signal);
				for (const id of batch) this.pending.delete(id.toString("hex"));
				attempt = 0;
			} catch (error) {
				if (isTransient(error) && !this.final) {
					await sleep(Math.max(backoff(++attempt), retryAfterMs(error) ?? 0), this.waits.signal);
					continue;
				}
				for (const id of batch) this.pending.delete(id.toString("hex"));
				this.o.onError?.(error, batch);
			}
		}
	}
}
