import { newer } from "../semver.ts";
import { alive as pidAlive } from "../remote.ts";
import { startOf } from "../startof.ts";
import type { HolderRecord, LinkStore } from "./store.ts";

// The link holder's election (docs/specs/2026-10-25-straw-link.md, Link holder; review R-F026). It has its own record, `link/holder.json`, under
// `link/holder.lock`, and does not go through the GUI server's election: that one is UI-only, adopts a stopped server, and has a `stopped`
// record that does not fit a headless unattended device.
//
// Candidates are joined pi sessions, towers first. A session on a newer pi-straw-boss takes the record from a live holder at once; so does a
// tower from a session that is not one on the same build, but never the other way round, so a tower, which outlives the sessions it opens, is
// the holder once it is there. A vacant record, or one whose process is gone, is taken at a candidate's next look: a tower at its first, any
// other session at its second, so a tower that is only a moment behind still gets it. One long-lived tower, the only candidate, takes it at
// its first look and keeps it (straw-boss-desk).

/** What a candidate is: its intercom session id, its pi-straw-boss version, and whether it is a tower. */
export interface Candidate { session: string; version: string; tower: boolean; pid: number; started?: string }

/** Whether `a` has a claim the record of `b` does not: a newer pi-straw-boss, or a tower on the same build against a session that is not one. */
export function outranks(a: Pick<Candidate, "version" | "tower">, b: Pick<Candidate, "version" | "tower">): boolean {
	if (newer(a.version, b.version)) return true;
	if (newer(b.version, a.version)) return false;
	return a.tower && !b.tower;
}

/** Whether the process that wrote a record still runs: its PID is alive and started when the record says (a PID reused after a crash started later). When `ps` cannot say, the record stands. */
export const holderAlive = (alive: (pid: number) => boolean = pidAlive as (pid: number) => boolean, start: (pid: number) => string | undefined = startOf, now: () => number = Date.now) => {
	// `ps` blocks the event loop while it runs, and every candidate looks every 2 s: a start time is asked again only after START_TTL_MS (the PID check, which is cheap, runs every time).
	// An answer that is not in yet (Windows reads it in the background) is asked again after UNKNOWN_TTL_MS, and meanwhile the record stands.
	const known = new Map<number, { at: number; start: string | undefined }>();
	return (record: HolderRecord): boolean => {
		if (!alive(record.pid)) return false;
		if (!record.started) return true;
		let seen = known.get(record.pid);
		if (!seen || now() - seen.at > (seen.start === undefined ? UNKNOWN_TTL_MS : START_TTL_MS)) known.set(record.pid, (seen = { at: now(), start: start(record.pid) }));
		return seen.start === undefined || seen.start === record.started;
	};
};
const START_TTL_MS = 30_000, UNKNOWN_TTL_MS = 2000;

export interface ElectionOptions {
	store: LinkStore;
	/** Read at each look: a session becomes a tower, or upgrades, without a new election object. */
	self: () => Candidate;
	/** Whether the process of a record still runs. */
	alive?: (record: HolderRecord) => boolean;
	now?: () => number;
	/** This session became the holder; start the relay stream. */
	onGain: () => void | Promise<void>;
	/** This session is no longer the holder (displaced, or it released the record); stop it. */
	onLose: () => void | Promise<void>;
}

export class LinkElection {
	private readonly o: ElectionOptions;
	private readonly alive: (record: HolderRecord) => boolean;
	private vacant = 0;
	private had = false;

	constructor(o: ElectionOptions) {
		this.o = o;
		this.alive = o.alive ?? holderAlive();
	}

	/** Whether this session started the holder duties and has not stopped them. */
	get holding(): boolean {
		return this.had;
	}

	private isMine(record: HolderRecord | undefined, me: Candidate): record is HolderRecord {
		return record !== undefined && record.session === me.session && record.pid === me.pid;
	}
	/** Whether the record names this session now. The holder asks it under the lock before it acts on a relay event, so a displaced holder never delivers. */
	isHolder(): boolean {
		return this.isMine(this.o.store.readHolder(), this.o.self());
	}

	/** One look: holder if the record names this session (after taking it when it may), else candidate. */
	async tick(): Promise<"holder" | "candidate"> {
		const me = this.o.self(), seen = this.o.store.readHolder();
		if (this.isMine(seen, me)) {
			if (!seen.started && me.started) await this.complete(me); // the record was written before this process's start time was known (Windows reads it in the background)
			return (await this.gain(), "holder");
		}
		await this.lose();
		const contest = !seen || !this.alive(seen);
		if (!contest && !outranks(me, seen)) return (this.vacant = 0, "candidate");
		if (contest && ++this.vacant < (me.tower ? 1 : 2)) return "candidate";
		return (await this.take(me)) ? "holder" : "candidate";
	}

	private async take(me: Candidate): Promise<boolean> {
		const taken = await this.o.store.withLock(() => {
			// Another candidate may have taken it while this one waited for the lock: the record is judged again, under it.
			const record = this.o.store.readHolder();
			if (this.isMine(record, me)) return true;
			if (record && this.alive(record) && !outranks(me, record)) return false;
			this.o.store.writeHolder({ session: me.session, version: me.version, pid: me.pid, ...(me.started ? { started: me.started } : {}), tower: me.tower, since: (this.o.now ?? Date.now)() });
			return true;
		});
		this.vacant = 0;
		if (!taken) return false;
		await this.gain();
		return true;
	}
	/** Writes the holder record again with this process's start time, if the record is still this session's and still lacks it. */
	private async complete(me: Candidate): Promise<void> {
		await this.o.store.withLock(() => {
			const record = this.o.store.readHolder();
			if (this.isMine(record, me) && !record.started && me.started) this.o.store.writeHolder({ ...record, started: me.started });
		}).catch(() => undefined); // the next look tries again
	}
	private async gain(): Promise<void> {
		if (this.had) return;
		this.had = true;
		try {
			await this.o.onGain();
		} catch (error) {
			// A holder that could not start must not keep the record: the next look takes it again (here or in another session), and the caller is told.
			this.had = false;
			const me = this.o.self();
			await this.o.store.withLock(() => void this.o.store.clearHolder((record) => this.isMine(record, me))).catch(() => undefined);
			throw error;
		}
	}
	private async lose(): Promise<void> {
		if (!this.had) return;
		this.had = false;
		await this.o.onLose();
	}

	/** The session ends or leaves: its own record goes, so the next candidate takes over at its next look. */
	async release(): Promise<void> {
		const me = this.o.self();
		await this.o.store.withLock(() => void this.o.store.clearHolder((record) => this.isMine(record, me)));
		this.vacant = 0;
		await this.lose();
	}
}
