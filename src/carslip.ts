import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CAR_OFF_NOTE } from "./moments.ts";
import { slipLines, startsSlip } from "./train/accept.ts";

// Car slips at the moment they matter (docs/specs/2026-11-26-just-in-time-prompts.md; boss 2026-11-25 「提示詞可以逐步交付」): main.md no longer says what a car slip a main sends or gets means, so the code says it then.
// With integration off, sb does not answer the sender itself: pi-intercom's outbox carries no reply to an ask, so the sender of an ask would wait on an answer that never comes. The main answers, told how when the slip arrives.

/** A `car: <app> | tickets:` (alias `app:`, `car:`) start of a slip, as `slipLines` in train/accept.ts finds one. */
export const SLIP = /\b(?:car|app):[ \t]*[A-Za-z0-9._-]+[ \t]*\|[ \t]*(?:tickets|car):/i;
/** Whether a text carries a car slip as the integrator reads one: a `car: <app> | tickets:` inside a line, or a slip on lines (a `car:` line). One recognizer for the tower's gate and call_tower's note (quiet-F009). */
export const carriesSlip = (text: string) => SLIP.test(text) || slipLines(text).split(/\r?\n/).some(startsSlip);
export const CAR_OFF_MESSAGE = "straw-boss-car-off";

/** The text and id of a pi-intercom message that carries a slip; none for anything else. */
export function slipMessage(message: unknown): { id: string } | undefined {
	const m = message as { role?: unknown; customType?: unknown; content?: unknown; details?: { bodyText?: unknown; message?: { id?: unknown } } } | null;
	if (m?.role !== "custom" || m.customType !== "intercom_message") return undefined;
	const text = typeof m.details?.bodyText === "string" ? m.details.bodyText : typeof m.content === "string" ? m.content : "";
	if (!SLIP.test(text)) return undefined;
	return { id: typeof m.details?.message?.id === "string" ? m.details.message.id : text };
}

/** `off`: this session is a tab's main, outside a tower run, with integration off on this computer. Each slip message is noted once. */
export function registerCarOff(pi: Pick<ExtensionAPI, "on" | "sendMessage">, off: () => boolean): void {
	const seen = new Set<string>();
	pi.on("message_end", (event, ctx) => {
		const slip = off() ? slipMessage(event.message) : undefined;
		if (!slip || seen.has(slip.id)) return;
		seen.add(slip.id);
		const idle = (() => { try { return ctx.isIdle(); } catch { return false; } })();
		pi.sendMessage({ customType: CAR_OFF_MESSAGE, content: CAR_OFF_NOTE, display: true }, { deliverAs: idle ? "nextTurn" : "steer" });
	});
}
