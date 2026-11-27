import { HOST_DEATHS } from "../childdead.ts";

// A worker of sb's host whose pane or pi went away before it reported (docs/how-it-works.md#the-subagent-host): Maestro hands the launching session one
// failed `subagent_result`. Before the model reads it, sb adds one paragraph naming the worker, its session file and the resume call, and does nothing
// else: no revive, no inherit, no nudge, no restore. The paragraph rides on that message (pi's `message_end`), so it is said exactly once, a reload included.

export const LOST_NOTE = "Straw Boss: this worker ended without a result.";

export interface Lost { file: string; name: string; why: string }

/** A `subagent_result`'s details as a worker lost before its report, or undefined: a cancel, a reported error, an exit 0 and a Ctrl-C are not. */
export function lostOf(details: unknown): Lost | undefined {
	if (!details || typeof details !== "object") return undefined;
	const d = details as { sessionFile?: unknown; exitCode?: unknown; errorMessage?: unknown; error?: unknown; cancellation?: unknown; name?: unknown };
	if (typeof d.sessionFile !== "string" || !d.sessionFile || d.error !== undefined || d.cancellation !== undefined) return undefined;
	const name = typeof d.name === "string" && d.name ? d.name : "subagent", code = typeof d.exitCode === "number" ? d.exitCode : undefined;
	if (d.errorMessage !== undefined) {
		const host = HOST_DEATHS.indexOf(String(d.errorMessage));
		return host < 0 ? undefined : { file: d.sessionFile, name, why: host === 0 ? "its pane closed" : "its pi ended" };
	}
	if (code === undefined || code === 0 || code === 130) return undefined;
	return { file: d.sessionFile, name, why: `its pi exited with code ${code}` };
}

export const lostText = (l: Lost) =>
	`${LOST_NOTE} ${JSON.stringify(l.name)} stopped before it reported: ${l.why}. Its session file is ${l.file}. To continue it, call subagent_resume with sessionPath ${JSON.stringify(l.file)} and a message saying what is left to do; Straw Boss does not revive or resume it.`;

/** The result with the lost-worker paragraph, or undefined to leave the message as it is. */
export function annotateLost<M extends { role?: string; customType?: string; content?: unknown; details?: unknown }>(message: M): M | undefined {
	if (message.role !== "custom" || message.customType !== "subagent_result") return undefined;
	const lost = lostOf(message.details);
	if (!lost || JSON.stringify(message.content ?? "").includes(LOST_NOTE)) return undefined;
	const note = lostText(lost);
	const content = typeof message.content === "string" ? `${message.content}\n\n${note}` : Array.isArray(message.content) ? [...message.content, { type: "text", text: note }] : note;
	return { ...message, content };
}
