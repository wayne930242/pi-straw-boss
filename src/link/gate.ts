import { randomUUID } from "node:crypto";
import { type Bus, GATE_PREFIX, type Select, selectDigest } from "../owners.ts";
import type { RemoteSender } from "./turn.ts";

// The gate of a remote turn (docs/specs/2026-10-25-straw-link.md, Remote turns, The gate). A tool call the allowlist does not cover is put to the boss
// as a dialog this module owns: it publishes it through the dialog contract (owners.ts, `linkGate`, a gate and not a twin) keyed by the call's
// toolCallId, so the GUI can answer it even when other calls of a parallel batch are in flight (the ctx.ui.confirm relay gives up then). The terminal
// shows the same confirm. The first answer wins: the page's, the terminal's, or, at `forward`, the sender's device's; the others close. Deny, no answer
// within 10 minutes, and the end of the tool call all block it.

export const GATE_MS = 10 * 60_000;
/** The most characters of arguments the dialog shows; a call with more is refused, since a confirm of a cut text would be a confirm of something else. */
export const MAX_ARGS = 12_000;
const ANSWER_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SERVED = 16;
/** Tells the ctx.ui wrap (src/intercept.ts) not to relay this confirm: the gate publishes it itself, and a second copy would be a second dialog on the page. */
const NO_RELAY = Symbol.for("pi-straw-boss.no-relay");

/** The sender's device that is asked too, at `forward`: `send` delivers the request; `listen` hears its answer (the holder checked device, digest, and once). */
export interface ForwardPort {
	send(req: { team: string; device: string; dialogId: string; digest: string; tool: string; args: string; tower: string }): Promise<void>;
	listen(dialogId: string, on: (allow: boolean) => void): () => void;
}
export interface GateAsk {
	toolCallId: string;
	tool: string;
	input: Record<string, unknown>;
	/** Every remote sender of the run, for the dialog's heading. */
	senders: RemoteSender[];
	/** At `forward`, the sender whose device is asked as well. */
	forwardTo?: RemoteSender;
	/** The tower's own name, for the sender's alert. */
	tower: string;
	ui?: { confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean> };
	signal?: AbortSignal;
}
export interface Outcome { allow: boolean; reason: string; by: string }
export const DECLINED = "the boss declined a remote request";

/** The arguments of a call as the dialog shows them. */
export const argsText = (input: Record<string, unknown>) => JSON.stringify(input, null, 2) ?? "{}";
const nameOf = (senders: RemoteSender[]) => senders.map((s) => `${s.label} (${s.short})`).join(", ") || "an unknown device";

export function createGate({ bus, forward, timeoutMs = GATE_MS, onError = () => {} }: { bus: Bus; forward?: ForwardPort; timeoutMs?: number; onError?: (what: string, error: Error) => void }) {
	const open = new Map<string, { digest: string; count: number; take(choice: number, answerId: string): void }>(), served: string[] = [];
	let listening: (() => void) | undefined;
	const tell = (channel: string, data: unknown) => {
		try {
			bus.emit(`${GATE_PREFIX}:${channel}`, data);
		} catch (error) {
			onError(channel, error as Error); // a listener that throws on the bus must not break the call
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
		if (!answerId || typeof pick !== "number" || !Number.isInteger(pick) || pick < 0 || pick >= dialog.count) return result(false, "malformed");
		result(true);
		dialog.take(pick, answerId);
	};

	/** Puts a call to the boss and resolves with the first answer. */
	async function ask(req: GateAsk): Promise<Outcome> {
		const args = argsText(req.input);
		if (args.length > MAX_ARGS) return { allow: false, by: "refused", reason: `a remote request whose arguments are ${args.length} characters long cannot be confirmed (the most is ${MAX_ARGS}); it is refused` };
		const heading = `Remote request from ${nameOf(req.senders)}: ${req.tool}`;
		const select: Select = { title: `${heading}\n\n${args}`, choices: [{ label: "Allow" }, { label: "Deny" }] };
		const id = randomUUID(), digest = selectDigest(select);
		listening ??= bus.on(`${GATE_PREFIX}:answer`, answered);
		return new Promise<Outcome>((resolve) => {
			const terminal = new AbortController(), offs: (() => void)[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined, done = false;
			const finish = (allow: boolean, by: string, reason: string, answerId?: string) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				offs.splice(0).forEach((off) => off());
				open.delete(id);
				served.push(id);
				if (served.length > SERVED) served.shift();
				terminal.abort(); // the terminal's confirm goes with the first answer from elsewhere; an answer from the terminal has settled it already
				tell("closed", { version: 1, id, by, ...(answerId ? { answerId } : {}) });
				resolve({ allow, by, reason });
			};
			open.set(id, { digest, count: 2, take: (choice, answerId) => finish(choice === 0, "remote", choice === 0 ? "allowed from a page" : DECLINED, answerId) });
			tell("pending", { version: 1, id, toolCallId: req.toolCallId, digest, select });
			timer = setTimeout(() => finish(false, "timeout", `${DECLINED}: no answer within ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.max(1, Math.round(timeoutMs / 1000))} seconds`}`), timeoutMs);
			timer.unref();
			if (req.signal) {
				const stop = () => finish(false, "abort", `${DECLINED}: the call was aborted`);
				if (req.signal.aborted) return stop();
				req.signal.addEventListener("abort", stop, { once: true });
				offs.push(() => req.signal!.removeEventListener("abort", stop));
			}
			if (req.ui) {
				Promise.resolve(req.ui.confirm(heading, args, { signal: terminal.signal, [NO_RELAY]: true } as { signal: AbortSignal })).then(
					(yes) => finish(yes === true, "local", yes === true ? "allowed in the terminal" : DECLINED),
					() => finish(false, "local", DECLINED),
				);
			}
			if (forward && req.forwardTo) {
				offs.push(forward.listen(id, (allow) => finish(allow, "forward", allow ? "allowed by the sender's device" : DECLINED)));
				forward.send({ team: req.forwardTo.team, device: req.forwardTo.id, dialogId: id, digest, tool: req.tool, args, tower: req.tower }).catch((error: Error) => onError("forward", error));
			}
		});
	}
	return { ask, dispose: () => (listening?.(), (listening = undefined)) };
}
export type Gate = ReturnType<typeof createGate>;
