import type { Item } from "../src/items.ts";
/** From a session's newest items when the alert arrives: its last line, the open tool call it waits on, and `at`, the entry Open comms lands on. */
export function intel(items: Item[]): Intel {
	const answered = new Set(items.flatMap((i) => (i.kind === "result" && i.callId ? [i.callId] : [])));
	const replies = items.filter((i) => i.kind === "assistant"), last = replies.at(-1), open = last?.tools?.find((t) => !answered.has(t.id));
	let said: string | undefined, fence = "";
	for (const line of (replies.findLast((i) => i.text?.trim())?.text ?? "").split("\n")) {
		const trimmed = line.trim(), marker = trimmed.match(/^(`{3,}|~{3,})/)?.[0];
		if (fence && marker === trimmed && marker.startsWith(fence)) fence = "";
		else if (!fence && marker) fence = marker;
		else if (!fence && trimmed) said = trimmed;
	}
	return { said: said?.slice(0, 280), pending: open && `${open.name} · ${open.summary}`.slice(0, 200), at: (last ?? items.findLast((i) => i.kind !== "result"))?.id };
}
export interface Intel { said?: string; pending?: string; at?: string; failed?: boolean }
