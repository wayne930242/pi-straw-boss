import { restrictLabel } from "../link/text.ts";
import type { Slot } from "./record.ts";
import { lastNote } from "./towerrunstore.ts";

// The receipts of an unattended box (docs/specs/2026-11-21-box-mac-waits.md §4, C4 (a); boss decision D6): an ally run that took a message carrying an ask and ended without answering it makes the server answer the ask itself, so the
// asking main on the controller hears that its message was taken and how the run ended, instead of nothing. The text is the code's, and the run's own tower_done note, which `unit-status` already sends as the last report.

export const RECEIPT_NOTE_MAX = 1024;
export interface ReceiptDeps {
	slot: Slot;
	now(): number;
	/** Whether this device is an unattended box: only a box sends receipts. */
	unattended(): boolean;
	/** Whether the run answered the ask itself (towers.ts `answered`). */
	answered(run: string, ask: string): boolean;
	/** This box's label, as its controllers know it. */
	label(): string;
	/** A `tower-reply` to the ask (the holder sends a plain `tower` to a build that takes no replies). */
	send(workspace: string, device: string, text: string, inReplyTo: string): Promise<unknown>;
	log(event: string, facts: Record<string, string | number | boolean>): void;
}
const cut = (text: string, max: number) => (Buffer.byteLength(text) <= max ? text : `${Buffer.from(text).subarray(0, max - 3).toString("utf8").replace(/�+$/u, "")}...`);

export function allyReceipts(d: ReceiptDeps) {
	return (end: { run: string; workspace: string; device: string; outcome: "done" | "crashed" | "timeout" | "quit"; asks: string[] }): void => {
		if (!d.unattended()) return;
		const open = [...new Set(end.asks)].filter((ask) => !d.answered(end.run, ask));
		if (!open.length) return;
		const note = end.outcome === "done" ? lastNote(d.slot, end.workspace, "ally", end.device) : undefined;
		const mine = note?.run === end.run ? note.note : undefined;
		const text = `${restrictLabel(d.label())} took your message in ally run ${end.run.slice(0, 8)} at ${new Date(d.now()).toISOString().slice(11, 16)} UTC and it ended ${end.outcome} without an answer.${mine ? ` Its note: «${cut(mine, RECEIPT_NOTE_MAX)}».` : ""}`;
		const failed = (error: string) => d.log("link-receipt-failed", { run: end.run.slice(0, 8), error: error.slice(0, 160) });
		for (const ask of open) void d.send(end.workspace, end.device, text, ask).then((a) => ((a as { ok?: unknown; error?: unknown } | undefined)?.ok === false ? failed(String((a as { error?: unknown }).error)) : d.log("link-receipt", { run: end.run.slice(0, 8), outcome: end.outcome })), (e: Error) => failed(e.message));
	};
}
