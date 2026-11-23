import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// Whether a restored subagent's session ends mid-turn, read from the jsonl pi keeps for it, and what to tell the child then.
//
// pi writes an assistant message when the model has finished it, before its tool calls run, and each tool result when the tool returns. A Herdr restart or a reboot in between leaves the
// transcript ending in an assistant tool call with no result (`call`), in a result the model never read (`result`), in a message nobody answered (`prompt`: a user message, or a custom
// message that starts a turn, such as an intercom message or a monitor's wake), or in a reply that was being written when the process died (`stream`). The restored pi waits at its prompt and does nothing of its own, so the child has to be
// told to go on. An assistant message that stopped for any other reason ended its turn: an abort is the boss's own stop, a stop or a length limit is an end, and an error is no cut unless its message
// is the one a restart leaves (claude-bridge's Claude Code process terminated by SIGHUP, or exited with code 129; a SIGTERM or code 143 is a kill by hand as well, and nothing here shows a restart came after it, so it is no cut). A turn that stands at a question (ask_user_question,
// caller_ping, an intercom ask) is waiting, not cut. Only `message` entries and the custom messages that start a turn count; a custom entry or a model change says nothing of the turn.

export interface Cut {
	kind: "call" | "result" | "prompt" | "stream";
	/** The tool calls with no result (`call`), or the tool whose result was not read (`result`). */
	tools: string[];
	/** When the last step of the transcript was recorded. */
	at: string;
}

/** What claude-bridge records when the Claude Code process behind it dies of the hangup a restart sends (a terminate is no proof of one: someone may have killed the process). */
const RESTART = /\bprocess (?:terminated by signal SIGHUP|exited with code 129)\b/i;
const NAME = /^[\w.:-]{1,64}$/, TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/, MORE = 10;
/** The custom messages that start a turn in a child (an intercom message, a nested launcher's result, a monitor's wake, an aaaav second-thought or a document-review notice, a robot-hand follow-up; pi-anchorloop 3.0.0 sends no second-thought); they are followed by an assistant message in real sessions. Others, such as a tower notice, are left out: missing one is a false negative (no nudge), never a wrong send. */
const WAKES = new Set(["intercom_message", "subagent_result", "subagent_ping", "pi-loop-monitor", "aaaav-second-thought", "doc-review", "robot-hand-follow-up", "robot-hand-herdr"]);
const QUESTIONS = new Set(["ask_user_question", "caller_ping"]);
const CHUNK = 64 * 1024, LIMIT = 16 * 1024 * 1024;
type Block = { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
interface Step { at: unknown; custom?: true; message: { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown; toolName?: unknown; toolCallId?: unknown } }

/** The steps in `text`, the end of a file; unless `whole` (it starts at the file's start), its first line, which may begin before it, is dropped. */
function stepsOf(text: string, whole: boolean): Step[] {
	const steps: Step[] = [];
	const lines = text.split("\n");
	if (!whole) lines.shift();
	for (const line of lines) {
		try {
			const row = JSON.parse(line) as { type?: unknown; timestamp?: unknown; message?: unknown; customType?: unknown };
			if (row.type === "message" && row.message && typeof row.message === "object") steps.push({ at: row.timestamp, message: row.message });
			else if (row.type === "custom_message" && WAKES.has(String(row.customType))) steps.push({ at: row.timestamp, custom: true, message: { role: "user" } });
		} catch {} // a line cut off by the restart itself says nothing
	}
	return steps;
}

/** The end of the file as steps: a chunk from the end that grows until it holds the last assistant message, or a step that needs nothing before it (a prompt), or the whole file (LIMIT at most). */
function tail(file: string): Step[] | undefined {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		for (let want = CHUNK; ; want *= 4) {
			const from = Math.max(0, size - want), buffer = Buffer.alloc(size - from);
			let got = 0;
			while (got < buffer.length) {
				const n = readSync(fd, buffer, got, buffer.length - got, from + got);
				if (!n) break;
				got += n;
			}
			const steps = stepsOf(buffer.subarray(0, got).toString("utf8"), from === 0);
			const turn = steps.filter((s) => ["user", "assistant", "toolResult"].includes(String(s.message.role)));
			if (from === 0 || turn.at(-1)?.message.role === "user" || turn.some((s) => s.message.role === "assistant")) return steps;
			if (want >= LIMIT) return undefined;
		}
	} finally {
		closeSync(fd);
	}
}

/** The cut the session at `file` ends in, or undefined when it ends its turn, stands at a question, cannot be read, or has no step. */
export function cutOf(file: string): Cut | undefined {
	let steps: Step[] | undefined;
	try {
		steps = tail(file);
	} catch {
		return undefined;
	}
	const turn = (steps ?? []).filter((s) => ["user", "assistant", "toolResult"].includes(String(s.message.role)));
	const last = turn.at(-1);
	if (!last || typeof last.at !== "string" || !TIME.test(last.at)) return undefined;
	if (last.message.role === "user") return { kind: "prompt", tools: [], at: last.at };
	// The tool calls of the last assistant message that have no result after it; results come one by one, so the last step may be a result and calls still be open.
	const from = turn.findLastIndex((s) => s.message.role === "assistant");
	const assistant = from < 0 ? undefined : turn[from]!.message;
	// A message that ended its turn is no cut, but a restart's error is, and so is a call that was still being written then.
	const stopReason = assistant?.stopReason;
	if (stopReason === "error" && typeof assistant?.errorMessage === "string" && RESTART.test(assistant.errorMessage) && from === turn.length - 1) return { kind: "stream", tools: [], at: last.at };
	const blocks = !assistant || !Array.isArray(assistant.content) || (stopReason !== undefined && stopReason !== "toolUse") ? [] : (assistant.content as unknown[]).filter((block): block is Block => Boolean(block) && typeof block === "object" && (block as Block).type === "toolCall");
	const answered = new Set(turn.slice(from + 1).filter((s) => s.message.role === "toolResult").map((s) => s.message.toolCallId));
	const open = blocks.filter((c) => !answered.has(c.id));
	if (open.some((c) => QUESTIONS.has(String(c.name)) || (c.name === "intercom" && (c.arguments as { action?: unknown } | null | undefined)?.action === "ask"))) return undefined;
	const named = (name: unknown) => (typeof name === "string" && NAME.test(name) ? name : "a tool");
	if (open.length) return { kind: "call", tools: open.slice(0, MORE).map((c) => named(c.name)), at: last.at };
	if (last.message.role === "toolResult") return { kind: "result", tools: [named(last.message.toolName)], at: last.at };
	return undefined;
}

const quote = (tools: string[]) => tools.map((t) => (t === "a tool" ? t : `\`${t}\``)).join(", ");

/** What happened to the child's last turn, in a clause. */
export function describe(cut: Cut): string {
	if (cut.kind === "prompt") return "its last message got no answer";
	if (cut.kind === "stream") return "its reply was cut off while it was being written";
	if (cut.kind === "result") return `the result of the tool call ${quote(cut.tools)} arrived, but its turn did not go on`;
	return `the tool ${cut.tools.length === 1 ? "call" : "calls"} ${quote(cut.tools)} got no result`;
}

/**
 * The one message that tells a restored child its turn was cut, and to check before it re-runs anything. `to`: the launcher a worktree child reports to over intercom, as orphan.ts asks
 * a child to; a resumed run reports through subagent_result and is given none.
 */
export function continueText(cut: Cut, to?: { id: string; name: string }): string {
	const what = cut.kind === "prompt" ? "The last message you were given got no answer."
		: cut.kind === "stream" ? "Your reply was cut off while it was being written."
		: cut.kind === "result" ? `The result of the tool call ${quote(cut.tools)} arrived, but your turn did not go on.`
		: `The tool ${cut.tools.length === 1 ? "call" : "calls"} ${quote(cut.tools)} got no result.`;
	const report = to ? `. When you are done, send your final report to "${to.name.replace(/["\n]/g, " ")}" (intercom session ${to.id}) with the intercom tool (action "send", to "${to.id}"): the outcome, what changed, and the evidence.` : " and report your result.";
	return `Straw Boss: your last turn was cut by a Herdr restart or reboot (your last recorded step was at ${cut.at}). ${what} Check the current state before re-running anything that changes state, then continue the task you were given${report}`;
}
