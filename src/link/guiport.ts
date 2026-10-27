import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Channel, REGISTER } from "../state.ts";
import { readLinkConfig } from "./config.ts";
import { holderAlive } from "./election.ts";
import type { LinkSummary } from "./holder.ts";
import { type HolderRecord, LinkStore } from "./store.ts";
import { chunks, NAMESPACE, Reassembler } from "./wire.ts";

// The GUI's way to the link holder from a process that is no candidate for it: the sb server serves the GUI (src/server/guihost.ts) while the holder still runs in a pi session
// (until the holder moves into the server). It asks over the intercom extension channel `straw-boss/link` the way a tower does (runtime.ts `ask`), as the session gui.json names
// as the GUI's owner, which is the one session the holder takes GUI requests from. It imports no pi: the server loads it where pi is not on disk.

/** Longer than the holder's worst case for a send: the lock wait, a reading of Herdr, and the wait for the relay; a caller that gave up earlier would invite a resend of a message that went out. */
export const ASK_MS = 60_000;
/** The GUI's net read waits this long for the holder's summary: a holder that is lost must not freeze the map. */
export const SUMMARY_MS = 2000;
/** A slow holder's last summary is served for this long; after that the map shows nothing rather than stale allies, alerts, and forwarded confirms. */
export const SUMMARY_KEEP_MS = 30_000;
/** The holder is there but did not answer in time: the one failure for which the last summary may stand in. */
export class HolderSlow extends Error {}
export const NO_HOLDER = "No link holder is running on this computer yet. If Straw Link is not set up here, open Teams in the GUI and press Set up; otherwise it starts within a few seconds, and if it stays so a team file or its config.json entry is missing";

export interface GuiLinkOptions {
	/** The event bus the channel registers on (pi's `pi.events`, or the sb server's kit). */
	events: { emit(channel: string, data: unknown): void };
	/** This process's intercom session id: what gui.json names as the GUI's owner. */
	id(): string;
	stateDir: string;
	agentDir: string;
	home?: string;
	now?: () => number;
	alive?: (record: HolderRecord) => boolean;
	askMs?: number;
	summaryMs?: number;
	summaryKeepMs?: number;
	/** Told when the channel cannot be joined (pi-intercom is not there) or a look fails. */
	log?: (text: string) => void;
}
export type GuiAnswer = { ok: boolean; error?: string; code?: string; [key: string]: unknown };
type ChannelEvent = { type: string; fromSessionId?: string; payload?: unknown };

export function createGuiLink(o: GuiLinkOptions) {
	const now = o.now ?? Date.now, store = new LinkStore(join(o.stateDir, "link")), home = o.home ?? homedir(), holderUp = o.alive ?? holderAlive();
	const config = () => readLinkConfig(o.stateDir, { home, agentDir: o.agentDir });
	const inUse = () => config().teams.size > 0 || store.teamIds().length > 0 || store.enabled;
	const nonce = randomUUID().slice(0, 8), reassembler = new Reassembler();
	const pending = new Map<string, { resolve: (body: unknown) => void; holder: string; timer: ReturnType<typeof setTimeout> }>();
	let channel: Channel | undefined, told = false, lastSummary: { at: number; summary: LinkSummary } | undefined;

	const onEvent = (event: ChannelEvent) => {
		const p = event.payload as Record<string, unknown> | undefined, from = event.fromSessionId;
		if (event.type !== "message" || !p || p.version !== 1 || !from || from === o.id() || p.to !== o.id() || p.type !== "res") return;
		const got = reassembler.push(`res/${from}`, p, now()), wait = got && pending.get(got.reqId);
		if (got && wait && wait.holder === from) (clearTimeout(wait.timer), pending.delete(got.reqId), wait.resolve(got.body));
	};
	const connect = (): boolean => {
		if (channel) return true;
		o.events.emit(REGISTER, { namespace: NAMESPACE, ownerEligible: false, onReady: (c: Channel) => (channel = c), onEvent });
		if (!channel && !told) (told = true, o.log?.("Straw Link needs pi-intercom 0.17.1 or newer; it is not loaded, so the GUI cannot reach the link holder"));
		return Boolean(channel);
	};
	/** One request to the holder in its session; throws NO_HOLDER when none runs, HolderSlow when it does not answer in time. */
	const ask = async (op: Record<string, unknown>, ms = o.askMs ?? ASK_MS): Promise<GuiAnswer> => {
		const record = store.readHolder();
		if (!record || !holderUp(record)) throw new Error(NO_HOLDER);
		if (!connect()) throw new Error(NO_HOLDER);
		const reqId = `${o.id()}-${nonce}-${pending.size}-${now()}`;
		const answered = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => (pending.delete(reqId), reject(new HolderSlow(`The link holder did not answer within ${ms / 1000} s`))), ms);
			pending.set(reqId, { resolve, holder: record.session, timer });
		});
		for (const c of chunks("req", record.session, reqId, op)) channel!.publish(c, { audience: "capable" });
		return (await answered) as GuiAnswer;
	};

	return {
		/** A change or a reading for the GUI, through the holder; only the GUI's host session is taken, which this is. */
		async call(name: string, args: Record<string, unknown> = {}): Promise<GuiAnswer> {
			try {
				return await ask({ op: "gui", name, args });
			} catch (error) {
				const message = (error as Error).message;
				return { ok: false, error: message, ...(message === NO_HOLDER ? { code: "no_holder" } : {}) };
			}
		},
		/** Sets Straw Link up on this computer without a team yet (the GUI's Team settings): a session's election starts within a few seconds. */
		async enable(): Promise<void> {
			await store.withLock(() => store.enable());
		},
		/** The compact reading the net snapshot carries; undefined when Straw Link is not set up or no holder answers. */
		async summary(): Promise<LinkSummary | undefined> {
			if (!inUse()) return (lastSummary = undefined), undefined;
			try {
				const answer = await ask({ op: "gui", name: "summary", args: {} }, o.summaryMs ?? SUMMARY_MS);
				lastSummary = answer.ok ? { at: now(), summary: answer.summary as LinkSummary } : undefined;
				return lastSummary?.summary;
			} catch (error) {
				// A holder that is slow: the last reading while it is fresh, so the map does not flicker. One that is gone or refuses shows nothing.
				if (!(error instanceof HolderSlow) || !lastSummary || now() - lastSummary.at > (o.summaryKeepMs ?? SUMMARY_KEEP_MS)) lastSummary = undefined;
				return lastSummary?.summary;
			}
		},
		/** Ends the waits in flight (the server is going). */
		close() {
			for (const [id, wait] of pending) (clearTimeout(wait.timer), pending.delete(id), wait.resolve({ ok: false, error: "The server is going away" }));
		},
	};
}
export type GuiLink = ReturnType<typeof createGuiLink>;
