import { rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildBusy } from "@nubl/maestro/core/child-busy";
import { hasUndeliveredChildren } from "@nubl/maestro/core/undelivered-children";
import { ACK_SUFFIX, NUDGE_SUFFIX, nudgeText, readJson, writeAtomic, type NudgeAck, type NudgeOutcome, type NudgeRequest } from "./nudge.ts";

// The child's half of the done nudge (docs/specs/2026-11-28-done-nudge.md): sb's child entry takes the parent's request from beside its session file and sends
// the nudge into its own session with `pi.sendUserMessage` (the path Maestro's own done nudge and its persistent inbox use), only when it is idle, has no queued
// message, its input box holds no unsent text, and it waits on no subagent of its own. It acks what it did, so the parent counts only a nudge that went in.

const POLL_MS = 2000;

type Ctx = Pick<ExtensionContext, "isIdle" | "hasPendingMessages"> & { ui?: { getEditorText?: () => string } };

export interface AnswerDeps {
	file: string;
	autoExit: boolean;
	ctx: Ctx | undefined;
	pi: Pick<ExtensionAPI, "sendUserMessage"> & { events?: ExtensionAPI["events"] };
	undelivered?: () => boolean;
	now?: () => number;
}

function outcomeOf(d: AnswerDeps): NudgeOutcome {
	try {
		if (!d.ctx || !d.ctx.isIdle() || d.ctx.hasPendingMessages()) return "busy";
		if (d.ctx.ui?.getEditorText?.()?.trim()) return "draft";
		if ((d.undelivered ?? hasUndeliveredChildren)() || isChildBusy(d.pi.events)) return "busy";
		return "sent";
	} catch {
		// A context that cannot answer is not one to interrupt.
		return "busy";
	}
}

/** Takes an open request, if any: sends the nudge when the session may take it, and acks the outcome. Returns it, or undefined when nothing was open. */
export function answerNudge(d: AnswerDeps): NudgeOutcome | undefined {
	const requestFile = d.file + NUDGE_SUFFIX;
	const req = readJson<NudgeRequest>(requestFile);
	if (!req) return undefined;
	// Consumed before it acts, so a slow send is never taken twice.
	try {
		rmSync(requestFile);
	} catch {
		return undefined;
	}
	if (req.v !== 1 || typeof req.id !== "string") return undefined;
	const outcome = outcomeOf(d);
	if (outcome === "sent") d.pi.sendUserMessage(nudgeText(d.autoExit, typeof req.idleMs === "number" ? req.idleMs : 0), { deliverAs: "followUp" });
	writeAtomic(d.file + ACK_SUFFIX, { v: 1, id: req.id, outcome, at: (d.now ?? Date.now)() } satisfies NudgeAck);
	return outcome;
}

export interface InboxDeps { env?: NodeJS.ProcessEnv; pollMs?: number; undelivered?: () => boolean }

/** Polls for the parent's request while the session runs. Not in a persistent specialist (idle between tasks is its normal state) or a session that is no subagent. */
export function nudgeInbox(pi: ExtensionAPI, deps: InboxDeps = {}): void {
	const env = deps.env ?? process.env;
	const file = env.PI_SUBAGENT_SESSION;
	if (!file || env.PI_SUBAGENT_PERSISTENT === "1") return;
	const autoExit = env.PI_SUBAGENT_AUTO_EXIT === "1";
	let ctx: Ctx | undefined, timer: ReturnType<typeof setInterval> | undefined;
	pi.on("session_start", (_event, c) => {
		ctx = c;
		if (timer) return;
		timer = setInterval(() => {
			try {
				answerNudge({ file, autoExit, ctx, pi, undelivered: deps.undelivered });
			} catch {
				// A request that cannot be read or acked now is the parent's to time out.
			}
		}, deps.pollMs ?? POLL_MS);
		(timer as { unref?: () => void }).unref?.();
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
