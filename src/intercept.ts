import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Bus, type Select, selectDigest, UI_PREFIX } from "./owners.ts";

// Lets the GUI answer any extension's ctx.ui.select and ctx.ui.confirm without changing that extension. Every extension's ctx.ui is one object (the
// runner's `uiContext`), so replacing its `select` and `confirm` reaches them all. The wrap is the owner of a dialog contract v1 under UI_PREFIX
// (owners.ts, `uiPrompt`): a call opens pi's own terminal dialog as before and publishes the same dialog on pi's event bus, where the bridge relays
// it like any owner's. The first answer wins and the other side is dismissed: a GUI answer aborts the terminal dialog through its signal (combined with
// the caller's own) and the call resolves with that answer; a terminal answer closes the relayed dialog. The call's result is whatever pi's dialog or
// the GUI answered, once. `input`, `editor` and `custom` are never touched (a secret may be typed there; docs/specs/2026-10-18-dialog-answers.md, SB-F001).
// Never breaking an extension's dialog: a call that cannot be relayed (see `relayable`), or whose relay fails to start, is the original call, untouched.
// A dialog is relayed only when exactly one tool call is in flight (it binds to that call, the way the bash confirmation of an mp-infra hook does), no
// secret_drop is, and no other dialog is open through the wrap; a dialog that opens over a relayed one withdraws it, as the page cannot tell which one an
// answer would dismiss. The wrap marks the object it wrapped, so several loaded copies of this package wrap it once; pi swaps the object on setUIContext,
// so it is checked again before each tool call and put back on the new one. A session without a UI has pi's shared no-op object, which is left alone.

const MARK = Symbol.for("pi-straw-boss.ui-intercept");
const MAX_CHOICES = 100, MAX_TEXT = 12_000, ANSWER_ID = /^[A-Za-z0-9_-]{16,64}$/;
type Kind = "select" | "confirm";
type Opts = { signal?: AbortSignal; timeout?: number } | undefined;
/** What pi's dialogs resolve with: the chosen option, or undefined, for a select; whether it was confirmed, for a confirm. */
type Result = string | boolean | undefined;
type Call = (title: string, second: unknown, opts?: Opts) => Promise<Result>;
type Wrapped = Record<Kind, Call> & { [MARK]?: { restore(): void } };
/** A dialog on the bus: `answer` is the choice the GUI took, set once, before its terminal twin is aborted. */
interface Relay { id: string; digest: string; count: number; ac: AbortController; by?: string; answer?: number; close(by: string): void }

export function interceptUi(pi: ExtensionAPI): void {
	const bus = pi.events as Bus, flying = new Map<string, string>(), relays = new Map<string, Relay>(), closed: string[] = [];
	let open = 0, listening: (() => void) | undefined;
	/** A listener that throws on the bus must not break the call: what is said after the dialog opened is best effort. */
	const tell = (channel: string, data: unknown) => {
		try {
			bus.emit(`${UI_PREFIX}:${channel}`, data);
		} catch {}
	};
	/** The GUI's answers, for every relayed dialog; one that closed a moment ago still hears so (the last 16), as an owner's answer listener lives on after its dialog. */
	const answered = (raw: unknown) => {
		const a = (raw ?? {}) as { id?: unknown; answerId?: unknown; digest?: unknown; selections?: unknown }, r = typeof a.id === "string" ? relays.get(a.id) : undefined;
		if (!r && !(typeof a.id === "string" && closed.includes(a.id))) return;
		const id = String(a.id), answerId = typeof a.answerId === "string" && ANSWER_ID.test(a.answerId) ? a.answerId : "", pick = Array.isArray(a.selections) && a.selections.length === 1 ? (a.selections[0] as unknown) : undefined;
		const result = (accepted: boolean, reason?: string) => tell("answer-result", { version: 1, id, answerId, accepted, ...(reason ? { reason } : {}) });
		if (!r) return result(false, "closed");
		if (a.digest !== r.digest) return result(false, "digest");
		if (!answerId || !Number.isInteger(pick) || (pick as number) < 0 || (pick as number) >= r.count) return result(false, "malformed");
		r.answer = pick as number;
		retire(r, "remote");
		r.ac.abort(); // the terminal dialog goes; the call resolves with this answer
		result(true);
		tell("closed", { version: 1, id, by: "remote", answerId });
	};
	const retire = (r: Relay, by: string) => {
		r.by = by;
		relays.delete(r.id);
		closed.push(r.id);
		if (closed.length > 16) closed.shift();
	};

	/** Starts a relay for a call, or returns undefined when it cannot or should not be relayed. */
	function start(kind: Kind, title: unknown, second: unknown): { r: Relay; taken(): Result } | undefined {
		const options = kind === "select" && Array.isArray(second) ? (second as unknown[]) : undefined;
		const text = kind === "confirm" ? (typeof second === "string" && second ? `${title}\n\n${second}` : String(title)) : String(title);
		if (typeof title !== "string" || (kind === "select" && (!options || !options.length || options.length > MAX_CHOICES || !options.every((o) => typeof o === "string")))) return;
		if (flying.size !== 1 || [...flying.values()][0] === "secret_drop" || text.length > MAX_TEXT || (options && options.reduce((n: number, o) => n + (o as string).length, 0) > MAX_TEXT)) return;
		const select: Select = { title: text, choices: (options ?? ["Yes", "No"]).map((label) => ({ label: label as string })), ...(kind === "confirm" ? { confirm: true as const } : {}) };
		const id = randomUUID(), digest = selectDigest(select), callId = [...flying.keys()][0]!;
		const r: Relay = { id, digest, count: select.choices.length, ac: new AbortController(), close(by) {
			if (r.by) return;
			retire(r, by);
			tell("closed", { version: 1, id, by });
		} };
		listening ??= bus.on(`${UI_PREFIX}:answer`, answered);
		relays.set(id, r);
		try {
			bus.emit(`${UI_PREFIX}:pending`, { version: 1, id, toolCallId: callId, digest, select });
		} catch (error) {
			r.close("error"); // the relay is withdrawn again before the call falls back to the original
			throw error;
		}
		return { r, taken: () => (kind === "confirm" ? r.answer === 0 : options![r.answer!] as string) };
	}

	/** One of ctx.ui's `select` or `confirm`, wrapped: what `orig` answers, or the GUI's answer when it came first. */
	const dialog = (kind: Kind, orig: Call): Call => (title, second, opts) => {
		if (open++ > 0) [...relays.values()].forEach((r) => r.close("error")); // a dialog over a relayed one: the page could not tell which an answer would dismiss
		let relay: ReturnType<typeof start>;
		try {
			relay = open === 1 ? start(kind, title, second) : undefined;
		} catch {
			relay = undefined; // never break the extension's dialog: this call is the original one
		}
		const done = () => void open--;
		if (!relay) {
			try {
				return Promise.resolve(orig(title, second, opts)).finally(done);
			} catch (error) {
				done();
				throw error;
			}
		}
		const { r, taken } = relay, caller = opts?.signal;
		const finish = (v: Result) => {
			done();
			if (r.answer !== undefined) return taken();
			r.close(caller?.aborted ? "abort" : kind === "select" && v === undefined ? "cancel" : "local");
			return v;
		};
		try {
			return Promise.resolve(orig(title, second, { ...opts, signal: caller ? AbortSignal.any([caller, r.ac.signal]) : r.ac.signal })).then(finish, (error) => (done(), r.close("error"), Promise.reject(error)));
		} catch (error) {
			done();
			r.close("error");
			throw error;
		}
	};

	let current: { ui: Wrapped } | undefined;
	/** Wraps the context's `ui` unless it is wrapped already (by this copy or another) or is pi's shared no-op object. */
	const ensure = (ctx: ExtensionContext) => {
		try {
			if (!ctx.hasUI) return;
			// SAFETY: pi's ExtensionUIContext has select and confirm with these signatures; MARK is a key no one else writes.
			const ui = ctx.ui as unknown as Wrapped;
			if (ui[MARK]) return;
			const [select, confirm] = [ui.select, ui.confirm], mine = { select: dialog("select", (t, s, o) => select.call(ui, t, s, o)), confirm: dialog("confirm", (t, s, o) => confirm.call(ui, t, s, o)) };
			Object.assign(ui, mine);
			ui[MARK] = { restore: () => ui.select === mine.select && ui.confirm === mine.confirm && (Object.assign(ui, { select, confirm }), delete ui[MARK]) } as never;
			current = { ui };
		} catch {} // a stale context or a frozen object: the dialogs stay as pi has them
	};
	pi.on("session_start", (_e, ctx) => ensure(ctx));
	pi.on("tool_execution_start", (e, ctx) => (flying.set(e.toolCallId, e.toolName), ensure(ctx)));
	pi.on("tool_execution_end", (e) => void flying.delete(e.toolCallId));
	pi.on("session_shutdown", () => {
		[...relays.values()].forEach((r) => r.close("error"));
		listening?.();
		listening = undefined;
		flying.clear();
		open = 0;
		current?.ui[MARK]?.restore();
		current = undefined;
	});
}
