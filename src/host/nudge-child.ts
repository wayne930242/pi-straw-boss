import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildBusy } from "@nubl/maestro/core/child-busy";
import { hasUndeliveredChildren } from "@nubl/maestro/core/undelivered-children";
import { ackFile, isRequestId, nudgeDir, nudgeText, readJson, requestFile, take, writeAtomic, type NudgeAck, type NudgeOutcome, type NudgeRequest } from "./nudge.ts";

// The child's half of the done nudge (docs/specs/2026-11-28-done-nudge.md): sb's child entry takes the parent's request from its run's folder beside its
// session file and sends the nudge into its own session with `pi.sendUserMessage` (the path Maestro's own done nudge and its persistent inbox use), only when
// it is idle, has no queued message, its input box holds no unsent text, and it waits on no subagent of its own. That call returns before pi takes the input,
// so `sent` is acked only once the nudge enters the session as a user message. An auto-exit child sends nothing: a fresh turn there closes it as done.

const POLL_MS = 2000;
/** A nudge sent that has not entered the session this long is acked `lost`. */
export const ACCEPT_MS = 30_000;

type Ctx = Pick<ExtensionContext, "isIdle" | "hasPendingMessages"> & {
	ui?: { getEditorText?: () => string };
	sessionManager?: { getSessionFile?: () => string | undefined };
};

export interface InboxCore {
	/** The session file and the run id the child was launched with (`PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`). */
	file: string;
	runId: string;
	autoExit: boolean;
	ctx: () => Ctx | undefined;
	pi: Pick<ExtensionAPI, "sendUserMessage"> & { events?: ExtensionAPI["events"] };
	undelivered?: () => boolean;
	now?: () => number;
}

export interface Inbox {
	/** Answers the open requests of this run, if any; returns the outcome of each answered. */
	poll(): NudgeOutcome[];
	/** A turn started: a request written before it is stale. */
	turnStarted(): void;
	/** A message entered the session: when it is the nudge in flight, `sent` is acked. */
	messageStarted(message: unknown): void;
}

function textOf(message: unknown): string | undefined {
	const m = message as { role?: unknown; content?: unknown } | undefined;
	if (m?.role !== "user") return undefined;
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return undefined;
	return m.content.filter((p: { type?: unknown }) => p?.type === "text").map((p: { text?: unknown }) => String(p.text ?? "")).join("\n");
}

/** The session the child is in now is the one it was launched with: after a `/resume` elsewhere, the inbox stands still. */
function onLaunchFile(ctx: Ctx | undefined, file: string): boolean {
	try {
		const current = ctx?.sessionManager?.getSessionFile?.();
		return !!current && resolve(current) === resolve(file);
	} catch {
		return false;
	}
}

export function createInbox(d: InboxCore): Inbox {
	const dir = nudgeDir(d.file, d.runId);
	const now = d.now ?? Date.now;
	let lastTurnAt = -Infinity;
	let inflight: { id: string; text: string; at: number } | undefined;
	const ack = (id: string, outcome: NudgeOutcome) => writeAtomic(ackFile(dir, id), { v: 2, id, runId: d.runId, outcome, at: now() } satisfies NudgeAck);

	const outcomeOf = (ctx: Ctx): NudgeOutcome => {
		try {
			if (inflight || !ctx.isIdle() || ctx.hasPendingMessages()) return "busy";
			if (ctx.ui?.getEditorText?.()?.trim()) return "draft";
			if ((d.undelivered ?? hasUndeliveredChildren)() || isChildBusy(d.pi.events)) return "busy";
			return "sent";
		} catch {
			// A context that cannot answer is not one to interrupt.
			return "busy";
		}
	};

	return {
		poll() {
			const ctx = d.ctx();
			if (!ctx || !onLaunchFile(ctx, d.file)) return [];
			if (inflight && now() - inflight.at >= ACCEPT_MS) {
				const id = inflight.id;
				inflight = undefined;
				ack(id, "lost");
			}
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return [];
			}
			const outcomes: NudgeOutcome[] = [];
			for (const name of names.sort()) {
				if (!name.endsWith(".req")) continue;
				const id = name.slice(0, -4);
				if (!isRequestId(id)) continue;
				const req = readJson<NudgeRequest>(requestFile(dir, id));
				// Consumed before it acts, so a slow send is never taken twice; one that is gone was revoked.
				if (!req || !take(requestFile(dir, id))) continue;
				// Another run's or another session's request is not this child's to answer.
				if (req.v !== 2 || req.id !== id || req.runId !== d.runId || typeof req.sessionFile !== "string" || resolve(req.sessionFile) !== resolve(d.file)) continue;
				let outcome: NudgeOutcome;
				if (typeof req.at !== "number" || req.at <= lastTurnAt) outcome = "stale";
				else if (d.autoExit) outcome = "auto-exit";
				else outcome = outcomeOf(ctx);
				if (outcome === "sent") {
					const text = nudgeText(typeof req.idleMs === "number" ? req.idleMs : 0);
					inflight = { id, text, at: now() };
					try {
						d.pi.sendUserMessage(text, { deliverAs: "followUp" });
					} catch {
						inflight = undefined;
						ack(id, "lost");
						outcomes.push("lost");
						continue;
					}
					// Acked when the nudge enters the session (messageStarted), or `lost` after ACCEPT_MS.
				} else ack(id, outcome);
				outcomes.push(outcome);
			}
			return outcomes;
		},
		turnStarted() {
			lastTurnAt = now();
		},
		messageStarted(message) {
			// An input handler of another extension may wrap the text; one that rewrites it leaves the nudge `lost`.
			if (!inflight || !textOf(message)?.includes(inflight.text)) return;
			const id = inflight.id;
			inflight = undefined;
			ack(id, "sent");
		},
	};
}

export interface InboxDeps { env?: NodeJS.ProcessEnv; pollMs?: number; undelivered?: () => boolean; now?: () => number }

/** Polls for the parent's request while the session runs. Not in a persistent specialist (idle between tasks is its normal state) or a session that is no subagent. */
export function nudgeInbox(pi: ExtensionAPI, deps: InboxDeps = {}): Inbox | undefined {
	const env = deps.env ?? process.env;
	const file = env.PI_SUBAGENT_SESSION, runId = env.PI_SUBAGENT_ID;
	if (!file || !runId || env.PI_SUBAGENT_PERSISTENT === "1") return undefined;
	let ctx: Ctx | undefined, timer: ReturnType<typeof setInterval> | undefined;
	const inbox = createInbox({ file, runId, autoExit: env.PI_SUBAGENT_AUTO_EXIT === "1", ctx: () => ctx, pi, undelivered: deps.undelivered, now: deps.now });
	const guard = (f: () => void) => {
		try {
			f();
		} catch {
			// A request that cannot be read or acked now is the parent's to time out.
		}
	};
	pi.on("turn_start", () => guard(() => inbox.turnStarted()));
	pi.on("message_start", (event) => guard(() => inbox.messageStarted((event as { message?: unknown }).message)));
	pi.on("session_start", (_event, c) => {
		ctx = c;
		if (timer) return;
		timer = setInterval(() => guard(() => void inbox.poll()), deps.pollMs ?? POLL_MS);
		(timer as { unref?: () => void }).unref?.();
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx = undefined;
	});
	return inbox;
}
