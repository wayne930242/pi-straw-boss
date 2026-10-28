import { randomUUID } from "node:crypto";
import { type Bus, REQUEST_PREFIX, type Select, selectDigest } from "../owners.ts";
import { REQUEST_MS } from "./request.ts";

// The approval dialog of a `link_request` (docs/specs/2026-10-25-straw-link.md, GUI, Link actions an agent asks for). It is published through the dialog
// contract (owners.ts, `linkRequest`, keyed by the tool call's id), so the page, a paired device, and the terminal can answer it; the first answer wins.
// A high-risk action (`HERE_ONLY` in request.ts) marks Approve `hereOnly`: control.ts refuses it from a paired device, which can still deny.
// Only an explicit Approve resolves to approval: Deny, the end of the tool call, a timeout, and anything the dialog cannot show all resolve to refusal.
// There is no setting, level, or earlier approval that skips it: the only caller of `approve` is the tool, once per request.

const ANSWER_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SERVED = 16;
/** Tells the ctx.ui wrap (src/intercept.ts) not to relay this confirm: the dialog is published here, and a second copy would be a second dialog on the page. */
const NO_RELAY = Symbol.for("pi-straw-boss.no-relay");
/** The longest text the dialog shows; a request with more is refused, since a confirm of a cut text would be a confirm of something else. */
export const MAX_TEXT = 12_000;
/** The terminal's confirm waits this long after the dialog is published: pi's confirm takes Enter as Yes, and a paired device's Enter that was checked just before the tool call opened could still be on its way to the pane (control.ts). The page and a paired device see the dialog at once. */
export const TERMINAL_DELAY_MS = 1_500;
export interface Verdict { approved: boolean; by: string; reason: string }

export function createApproval({ bus, timeoutMs = REQUEST_MS, terminalDelayMs = TERMINAL_DELAY_MS, onError = () => {} }: { bus: Bus; timeoutMs?: number; terminalDelayMs?: number; onError?: (what: string, error: Error) => void }) {
	const open = new Map<string, { digest: string; take(choice: number, answerId: string): void }>(), served: string[] = [];
	let listening: (() => void) | undefined;
	const tell = (channel: string, data: unknown) => {
		try {
			bus.emit(`${REQUEST_PREFIX}:${channel}`, data);
		} catch (error) {
			onError(channel, error as Error);
		}
	};
	const answered = (raw: unknown) => {
		const a = (raw ?? {}) as { id?: unknown; answerId?: unknown; digest?: unknown; selections?: unknown };
		if (typeof a.id !== "string") return;
		const dialog = open.get(a.id);
		if (!dialog && !served.includes(a.id)) return;
		const answerId = typeof a.answerId === "string" && ANSWER_ID.test(a.answerId) ? a.answerId : "";
		const result = (accepted: boolean, reason?: string) => tell("answer-result", { version: 1, id: a.id, answerId, accepted, ...(reason ? { reason } : {}) });
		if (!dialog) return result(false, "closed");
		const pick = Array.isArray(a.selections) && a.selections.length === 1 ? (a.selections[0] as unknown) : undefined;
		if (a.digest !== dialog.digest) return result(false, "digest");
		if (!answerId || typeof pick !== "number" || !Number.isInteger(pick) || pick < 0 || pick > 1) return result(false, "malformed");
		result(true);
		dialog.take(pick, answerId);
	};

	/** Puts the request to the boss; resolves with the first answer. `lines` is what the holder says the action does, `asker` which session asked. */
	function approve(req: { toolCallId: string; lines: string[]; asker: string; hereOnly?: boolean; ui?: { confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean> }; signal?: AbortSignal }): Promise<Verdict> {
		const body = req.lines.join("\n"), heading = `Link request from ${req.asker}`;
		if (body.length > MAX_TEXT) return Promise.resolve({ approved: false, by: "refused", reason: `a link request whose description is ${body.length} characters long cannot be confirmed (the most is ${MAX_TEXT}); it is refused` });
		const select: Select = { title: `${heading}\n\n${body}`, choices: [{ label: "Approve", ...(req.hereOnly ? { hereOnly: true as const, note: "Approved on this computer only; a paired device can deny" } : {}) }, { label: "Deny" }] };
		const id = randomUUID(), digest = selectDigest(select);
		listening ??= bus.on(`${REQUEST_PREFIX}:answer`, answered);
		return new Promise<Verdict>((resolve) => {
			const terminal = new AbortController(), offs: (() => void)[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined, done = false;
			const finish = (approved: boolean, by: string, reason: string, answerId?: string) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				offs.splice(0).forEach((off) => off());
				open.delete(id);
				served.push(id);
				if (served.length > SERVED) served.shift();
				terminal.abort();
				tell("closed", { version: 1, id, by, allow: approved, ...(answerId ? { answerId } : {}) });
				resolve({ approved, by, reason });
			};
			const declined = (why: string) => `the boss declined the link request${why ? `: ${why}` : ""}`;
			open.set(id, { digest, take: (choice, answerId) => finish(choice === 0, "remote", choice === 0 ? "approved from a page" : declined(""), answerId) });
			tell("pending", { version: 1, id, toolCallId: req.toolCallId, digest, select });
			timer = setTimeout(() => finish(false, "timeout", declined(`no answer within ${Math.round(timeoutMs / 60_000) || 1} minutes`)), timeoutMs);
			timer.unref();
			if (req.signal) {
				const stop = () => finish(false, "abort", declined("the call was aborted"));
				if (req.signal.aborted) return stop();
				req.signal.addEventListener("abort", stop, { once: true });
				offs.push(() => req.signal!.removeEventListener("abort", stop));
			}
			if (req.ui) {
				const ui = req.ui;
				const ask = setTimeout(() => {
					if (done) return;
					Promise.resolve(ui.confirm(heading, body, { signal: terminal.signal, [NO_RELAY]: true } as { signal: AbortSignal })).then(
						(yes) => finish(yes === true, "local", yes === true ? "approved in the terminal" : declined("")),
						() => finish(false, "local", declined("")),
					);
				}, terminalDelayMs);
				ask.unref();
				offs.push(() => clearTimeout(ask));
			}
		});
	}
	return { approve, dispose: () => (listening?.(), (listening = undefined)) };
}
export type Approval = ReturnType<typeof createApproval>;
