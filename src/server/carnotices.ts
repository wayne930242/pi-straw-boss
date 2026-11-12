import { createHash } from "node:crypto";
import type { IntercomLike } from "./kit.ts";
import { stamp } from "../header.ts";
import { type Attempt, type CarState, RETRY_MS, stateLine, type StateEntry, type StateNotice } from "../train/cars.ts";
import type { CarBook } from "./carbook.ts";

// The sb server's sender of car notices (docs/specs/2026-11-07-train-workers.md §5.5, D14): for every car state without a told notice it sends one intercom message to the coordinator's session id under a `car_notice` header, writes what the broker
// answered, tries again at 30 s, 2 min and 5 min, and when the coordinator is not live, or the retries are spent, tells the tower of the setter's workspace once with a `blocked` call. The records are keyed by (car, state), so a state is sent once while the
// server runs. The sender is driven by `tick()` (a 5 s timer and `kick()` after a state is set); a name is never a target, only the session id the slip named and the tower's forward confirmed.

export const TICK_MS = 5000;
const KEEP_MS = 24 * 3600_000, TOWER_RETRY_MS = 30_000, TOWER_TRIES = 10, SEND_TRIES = 1 + RETRY_MS.length;
/** A coordinator found not live is looked for again after 30 s, then at twice the wait each time, up to every 10 min (CR-F005). */
const AWAY_MS = 30_000, MAX_AWAY_MS = 600_000;

export type Intercom = Pick<IntercomLike, "listSessions" | "send">;

export interface NoticeDeps {
	book: CarBook;
	now(): number;
	/** The server's own intercom connection; undefined while the broker is not connected. */
	intercom(): Intercom | undefined;
	/** The tower identity's session id of a Herdr workspace. */
	tower(workspace: string): string;
	log?(event: string, facts: Record<string, string | number | boolean>): void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const short = (text: string, n = 160) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, n);
/**
 * The stem of the message ids of one state's notice: the car and the moment the state was set. The broker keeps the ids a sender used for an hour and does not deliver one again, so a state of a car's later life (#14), or one set again after a
 * restart, needs ids the earlier one did not use; the time the state was set tells them apart.
 */
const idStem = (item: { project: string; file: { app: string; car: { head: string } }; entry: { state: string; at: string } }) => `car-${createHash("sha256").update(`${item.project}/${item.file.app}/${item.file.car.head}/${item.entry.at}`).digest("hex").slice(0, 12)}-${item.entry.state}`;

export class CarNotices {
	private busy = false;
	private again = false;
	private readonly away = new Map<string, { next: number; wait: number }>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly d: NoticeDeps;
	constructor(deps: NoticeDeps) { this.d = deps; }

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick().catch((e: Error) => this.d.log?.("cars-notice", { error: short(e.message) })), TICK_MS);
		this.timer.unref?.();
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
	/** A state was just set: look now instead of at the next tick. */
	kick(): void { void this.tick().catch((e: Error) => this.d.log?.("cars-notice", { error: short(e.message) })); }

	async tick(): Promise<void> {
		if (this.busy) { this.again = true; return; }
		this.busy = true;
		try {
			do {
				this.again = false;
				for (const item of this.d.book.pending()) await this.step(item);
			} while (this.again);
		} finally { this.busy = false; }
	}

	private async step(item: ReturnType<CarBook["pending"]>[number]): Promise<void> {
		const { project, name, file, entry } = item, state = entry.state, record: StateNotice = item.notice ?? { attempts: [] };
		const now = this.d.now();
		if (record.deliveredAt || now - Date.parse(entry.at) > KEEP_MS) return;
		const intercom = this.d.intercom();
		if (!intercom) return;
		// Keyed by the state's own life (its id stem names the moment it was set), not by the car's file name, which a new life takes over (car-forward-F001).
		const key = idStem(item), gone = this.away.get(key);
		if (gone && now < gone.next) return;
		let live: boolean;
		try { live = (await intercom.listSessions()).some((s) => s.id === file.coordinator); } catch { return; } // the broker cannot be asked: not the coordinator's absence
		if (live) this.away.delete(key);
		else { const wait = gone ? Math.min(gone.wait * 2, MAX_AWAY_MS) : AWAY_MS; this.away.set(key, { next: now + wait, wait }); }
		const sends = record.attempts.filter((a) => a.outcome !== "not-live");
		const change = (fn: (r: StateNotice) => void) => this.d.book.updateNotice(project, name, entry, fn);
		if (!live) {
			// Not live at an attempt: told to the tower once; a coordinator that comes back live later still gets the notice.
			if (!record.escalatedAt) {
				if (!record.attempts.some((a) => a.outcome === "not-live")) change((r) => r.attempts.push({ at: iso(now), outcome: "not-live", answer: `${file.coordinator} is not live` }));
				await this.escalate(item, `coordinator ${file.coordinator} is not live`);
			}
			return;
		}
		if (sends.length >= SEND_TRIES) { if (!record.escalatedAt) await this.escalate(item, `${sends.length} sends were not delivered`); return; }
		const due = sends.length === 0 ? now : Date.parse(sends.at(-1)!.at) + RETRY_MS[sends.length - 1]!;
		if (now < due) return;
		const n = sends.length + 1, messageId = `${idStem(item)}-${n}`;
		const at = iso(now);
		// The attempt is written before the send: a server that stops in the middle finds an unknown outcome and tries again, never a send nobody wrote down.
		change((r) => { r.id = messageId; r.attempts.push({ at, outcome: "unknown" }); });
		const done = await this.send(intercom, item, messageId);
		change((r) => {
			const last = r.attempts.at(-1)!;
			Object.assign(last, done.attempt);
			if (done.delivered) r.deliveredAt = iso(this.d.now());
		});
		if (!done.delivered && n >= SEND_TRIES) await this.escalate(item, `${n} sends were not delivered (last: ${done.attempt.answer ?? done.attempt.outcome})`);
	}

	private async send(intercom: Intercom, item: ReturnType<CarBook["pending"]>[number], messageId: string): Promise<{ delivered: boolean; attempt: Pick<Attempt, "outcome" | "answer"> }> {
		const { file, entry } = item;
		const line = this.line(item);
		const by = entry.by, message = stamp({ from: { name: by.name, id: by.session, role: by.role }, kind: "car_notice", scope: "session", to: [{ name: file.coordinator, id: file.coordinator, role: "session" }], reply: false }, line);
		try {
			const result = await intercom.send(file.coordinator, { text: message, messageId });
			if (result.delivered && result.delivery === "socket_delivered") return { delivered: true, attempt: { outcome: "delivered", answer: "socket_delivered" } };
			if (result.delivered && result.delivery === "queued") return { delivered: false, attempt: { outcome: "queued", answer: "queued" } };
			if (result.delivered) return { delivered: false, attempt: { outcome: "unknown", answer: `delivered, delivery ${String(result.delivery)}` } };
			return { delivered: false, attempt: { outcome: result.delivery === "unknown" ? "unknown" : "failed", answer: short(result.reason ?? "not delivered") } };
		} catch (error) {
			return { delivered: false, attempt: { outcome: "failed", answer: short((error as Error).message) } };
		}
	}

	/** The notice line of a state, with the train it concerns (the received state of the same car names it). */
	private line(item: ReturnType<CarBook["pending"]>[number]): string {
		return stateLine(item.file, item.entry);
	}

	/** One `blocked` call to the tower of the setter's workspace, naming the car, the state, the coordinator and the notice text. It counts once the tower's mailbox has it. */
	private async escalate(item: ReturnType<CarBook["pending"]>[number], why: string): Promise<void> {
		const { project, name, file, entry } = item, state = entry.state, record: StateNotice = this.d.book.noticeOf(project, name, entry) ?? { attempts: [] };
		if (record.escalatedAt) return;
		const tries = record.tower ?? [], now = this.d.now();
		if (tries.length >= TOWER_TRIES) return;
		const last = tries.at(-1);
		if (last && now - Date.parse(last.at) < TOWER_RETRY_MS) return;
		const workspace = entry.by.workspace, intercom = this.d.intercom();
		if (!workspace || !intercom) return;
		const to = this.d.tower(workspace), by = entry.by;
		const text = `car ${file.car.tickets[0] ?? "?"} is ${state} (${project}/${file.app}) and its coordinator ${file.coordinator} could not be told: ${why}. The notice: ${this.line(item)}`;
		const message = stamp({ from: { name: by.name, id: by.session, role: by.role }, kind: "call_tower", scope: "tower", to: [{ name: "tower", id: to, role: "tower" }], reply: false, why: "blocked" }, text);
		let attempt: Attempt;
		let taken = false;
		try {
			const result = await intercom.send(to, { text: message, messageId: `${idStem(item)}-tower-${tries.length + 1}` });
			taken = result.delivered === true;
			attempt = { at: iso(now), outcome: taken ? "delivered" : "failed", ...(taken ? {} : { answer: short(result.reason ?? "not delivered") }) };
		} catch (error) {
			attempt = { at: iso(now), outcome: "failed", answer: short((error as Error).message) };
		}
		this.d.book.updateNotice(project, name, entry, (r) => {
			(r.tower ??= []).push(attempt);
			if (taken) r.escalatedAt = iso(this.d.now());
		});
		this.d.log?.("cars-escalate", { project, state: state as CarState, taken });
	}
}
