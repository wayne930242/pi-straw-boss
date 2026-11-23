// The live transcript of a workspace's headless runs (docs/specs/2026-11-23-f-entry.md §2.7): the last RING_MAX lines the server renders from a run's RPC events, in memory only (the session file stays the
// record). The server writes every prefix; model text never does, and every line is cut of control characters and escape sequences (CSI, OSC, a split SGR) before it is kept. A ring line is never read as a card,
// a key, or a command: the viewer's card view draws only from the cards digest of `prompt-poll`.

export const RING_MAX = 300;
/** The lines a viewer is given when it starts or switches to a ring. */
export const RING_TAIL = 40;
const LINE_MAX = 400;

/** One line, with no control or escape left: CSI and OSC sequences go whole, a lone ESC or C1 byte and every other control character become a space. */
export const plain = (text: string) => text
	.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g, "")
	.replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, "")
	.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
	.replace(/\p{Cf}/gu, "")
	.replace(/\s+$/, "")
	.slice(0, LINE_MAX);
const short = (value: unknown, max: number) => plain(typeof value === "string" ? value : JSON.stringify(value) ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export interface RingLine { n: number; text: string }
export interface Ring {
	/** Adds a line the server wrote (its prefix included), cleaned. */
	add(text: string): void;
	/** Takes one RPC record of a run: text deltas fold per message, tool calls and results are one line each. Returns the whole text of an assistant message that just ended, cleaned. */
	record(rec: Record<string, unknown>): string | undefined;
	/** The lines after `cursor` (the last RING_TAIL when the cursor is unknown or fell off the ring), and the new cursor. */
	since(cursor?: number): { lines: string[]; cursor: number };
	readonly size: number;
}
export function createRing(max = RING_MAX): Ring {
	const lines: RingLine[] = [];
	let n = 0, partial = "", message = "";
	const add = (text: string) => {
		lines.push({ n: ++n, text: plain(text) });
		if (lines.length > max) lines.splice(0, lines.length - max);
	};
	const flushText = (all: boolean) => {
		let at = partial.indexOf("\n");
		while (at >= 0) {
			add(`│ ${partial.slice(0, at)}`);
			partial = partial.slice(at + 1);
			at = partial.indexOf("\n");
		}
		if (all && partial.trim()) add(`│ ${partial}`);
		if (all) partial = "";
	};
	return {
		add,
		record(rec) {
			const type = rec.type;
			if (type === "message_update") {
				const ev = rec.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
				if (ev?.type === "text_delta" && typeof ev.delta === "string") (partial += ev.delta, (message += ev.delta), flushText(false));
			} else if (type === "message_end") {
				flushText(true);
				const whole = plain(message.replace(/\s+/g, " ")).trim();
				message = "";
				return whole || undefined;
			}
			else if (type === "tool_execution_start") add(`▸ ${short(rec.toolName, 40)} ${short(rec.args, 80)}`);
			else if (type === "tool_execution_end") add(`${rec.isError ? "✗" : "✓"} ${short(rec.toolName, 40)}`);
			else if (type === "agent_start") add("· working");
			else if (type === "agent_settled") (flushText(true), add("· idle"));
			return undefined;
		},
		since(cursor) {
			const first = lines[0]?.n ?? n + 1;
			const from = cursor === undefined || cursor < first - 1 || cursor > n ? lines.slice(-RING_TAIL) : lines.filter((l) => l.n > cursor);
			return { lines: from.map((l) => l.text), cursor: n };
		},
		get size() { return lines.length; },
	};
}
