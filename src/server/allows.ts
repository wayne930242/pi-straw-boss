import { createHash } from "node:crypto";
import type { AllowNote } from "../dialogs.ts";
import type { Session } from "../herdr.ts";

// The Allows the dialog hub holds (docs/specs/2026-10-26-sb-backend.md, Tower tools in a run, The gate's Allow, checked by the server). The gate of a remote turn runs in the ally run's own pi; the
// server does not trust it alone. For a gated call the run sends its tool call id and the arguments, and the server takes the call only when the hub saw a gate dialog for that call id close with an
// explicit yes (the page, the terminal, or the sender's device: the dialog's `closed` carries `allow`), over arguments with the same digest, relayed by a session the broker places on the run's
// pane, and not yet used. The Allow is then used up: a second call with the same id, other arguments, or another run's pane is refused. The same holds for the approval of a `link_request` (`takeRequest`).
// This file has no pi dependency: it runs in the server's bundle.

/** Allows are good this long after they were given (a tool call waits for its gate for 10 minutes at most). */
const KEEP_MS = 15 * 60_000;
const MAX = 64;
const GATE = "straw-link-gate", REQUEST = "straw-link-request";

/** The arguments as JSON with every object's keys sorted, so the digest does not depend on the order a dialog or a run wrote them in. */
export function canonicalArgs(value: unknown): string {
	// SAFETY: a value that came through JSON (a dialog's text, a socket request) is a Json.
	const order = (v: Json): Json => (Array.isArray(v) ? v.map(order) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, order(v[k]!)])) : v);
	return JSON.stringify(order(value as Json)) ?? "null";
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const argsDigest = (value: unknown): string => createHash("sha256").update(canonicalArgs(value), "utf8").digest("hex");

export type TakeResult = { ok: true } | { ok: false; reason: string };
type Placed = () => Promise<Pick<Session, "id" | "herdrLocation">[]>;
export interface AllowsOptions {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** How long a call waits for an Allow that has not reached the hub yet (the gate answers on the run's bus, the hub hears it over pi-intercom, and the run's tool request is on the socket): 3 s. */
	waitMs?: number;
}
interface Held { note: AllowNote; used: boolean }

/** The gate dialog's title: `Remote request from <senders>: <tool>` and, after a blank line, the arguments as the gate showed them. */
function parseGate(title: string): { tool: string; digest: string } | undefined {
	const cut = title.indexOf("\n\n");
	if (cut < 0) return undefined;
	const heading = title.slice(0, cut), at = heading.lastIndexOf(": ");
	if (!heading.startsWith("Remote request from ") || at < 0) return undefined;
	try {
		return { tool: heading.slice(at + 2), digest: argsDigest(JSON.parse(title.slice(cut + 2))) };
	} catch {
		return undefined;
	}
}

export function createAllows(o: AllowsOptions = {}) {
	const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const held: Held[] = [];
	const prune = () => {
		const cutoff = now() - KEEP_MS;
		for (let i = held.length - 1; i >= 0; i--) if (held[i]!.note.at < cutoff || held[i]!.used) held.splice(i, 1);
		while (held.length > MAX) held.shift();
	};
	/** The first unused Allow of `owner` for the call on `pane` whose dialog `fits`, once a session of the broker is placed on that pane for it. */
	async function find(owner: string, pane: string, toolCallId: string, sessions: Placed, deadline: number, fits: (note: AllowNote) => string | undefined): Promise<TakeResult & { held?: Held }> {
		let why = "";
		for (;;) {
			prune();
			why = `the hub holds no Allow for tool call ${toolCallId} of this run`;
			for (const h of held.filter((x) => !x.used && x.note.owner === owner && x.note.toolCallId === toolCallId && x.note.pane === pane)) {
				const problem = fits(h.note);
				if (problem) {
					why = problem;
					continue;
				}
				// The pane a bridge names is its own claim; the broker places the session.
				const placed = (await sessions().catch(() => [])).find((s) => s.id === h.note.from);
				if (placed?.herdrLocation?.paneId !== pane) {
					why = "the session that relayed the Allow is not on this run's pane";
					continue;
				}
				// Used up in the same turn of the event loop as the check, so a second call that waited on `sessions()` meanwhile finds it gone.
				if (h.used) {
					why = "the Allow was used by another call";
					continue;
				}
				h.used = true;
				return { ok: true, held: h };
			}
			if (now() >= deadline) return { ok: false, reason: why };
			await sleep(100);
		}
	}
	const wait = () => o.waitMs ?? 3000;
	return {
		/** The hub saw a gate or an approval close with a yes. */
		note(note: AllowNote): void {
			held.push({ note, used: false });
			prune();
		},
		/** A gated tool call of the run on `pane`: its call id, tool, and arguments. */
		async take(q: { pane: string; toolCallId: string; tool: string; args: unknown; sessions: Placed }): Promise<TakeResult> {
			const digest = argsDigest(q.args);
			const got = await find(GATE, q.pane, q.toolCallId, q.sessions, now() + wait(), (note) => {
				const parsed = parseGate(note.title);
				if (!parsed) return "the Allow's dialog is not one this server can read";
				if (parsed.tool !== q.tool) return `the Allow was given for another tool (${parsed.tool}), not ${q.tool}`;
				return parsed.digest === digest ? undefined : "the Allow was given for other arguments than this call has";
			});
			return got.ok ? { ok: true } : got;
		},
		/** The approval of a `link_request` call: its dialog body starts with the lines the holder said the request does. */
		async takeRequest(q: { pane: string; toolCallId: string; lines: string[]; sessions: Placed }): Promise<TakeResult> {
			const expected = q.lines.join("\n");
			const got = await find(REQUEST, q.pane, q.toolCallId, q.sessions, now() + wait(), (note) => {
				const cut = note.title.indexOf("\n\n");
				return cut >= 0 && note.title.slice(cut + 2).startsWith(expected) ? undefined : "the approval was given for another request";
			});
			return got.ok ? { ok: true } : got;
		},
	};
}
export type Allows = ReturnType<typeof createAllows>;
