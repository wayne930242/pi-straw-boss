import { clean } from "../board.ts";
import type { Locale } from "../towerprompt/messages.ts";
import { UNATTENDED } from "./autoops.ts";
import type { Log } from "./log.ts";
import type { Slot } from "./record.ts";
import { cut, type Entry, findWait, hhmm, iso, MEM, type Memory, memoryView, Refused, updateMemory } from "./towermemory.ts";
import { ACTS, type Act, CARD, type Card, type Delivery, DONE_LABEL, type Press, secretShaped } from "./waitcard.ts";

// The press of a wait card (docs/specs/2026-11-07-wait-cards.md, The press): the boss's button on a card is one op of the memory route. The memory changes first (by id, so a double press finds the first one), then the raiser is told through
// intercom by its session id, and only then the tower's event is queued: the event says whether the raiser got the notice. There is no retry loop; the tower owns a notice that did not arrive.

/** How long the raiser's notice may take before the event goes on without it. */
export const NOTICE_WAIT_MS = 5000;

/** What intercom's outbox answered, as the press records it. */
export function deliveryOf(status: string | undefined): Delivery {
	if (status === "sent" || status === "delivered") return "delivered";
	return status === "queued" ? "queued" : "failed";
}

/** The door a press came in by, as the log records it (never the text): pi's `/boss wait` or `/boss memory`, the tower prompt's picker, the pane of a tower run, the GUI, or the dialog sb drew for an agent's `boss_wait_ask` (waitask.ts). */
export type PressDoor = "pi" | "prompt" | "run-pane" | "gui" | "ask";
/** The doors a control request may name (main.ts): the GUI's is its own route's, never a client's word. */
export const doorOf = (via: unknown): PressDoor => (via === "prompt" || via === "run-pane" || via === "ask" ? via : "pi");
/**
 * `boss_wait_ask` on a device with no boss at it (autoops.ts `UNATTENDED`): its read of the list (`boss-waits` with `ask: true`) and its press (`tower-memory` with `via: "ask"`) are refused, so no card is drawn there.
 * The list and the memory themselves stay as they are: `/boss wait` and the prompt's picker are a controller's own doors.
 */
export const askRefused = (request: Record<string, unknown>, unattended: () => boolean): string | undefined =>
	((request.cmd === "boss-waits" && request.ask === true) || (request.cmd === "tower-memory" && request.via === "ask")) && unattended() ? UNATTENDED : undefined;
export interface PressDeps {
	slot: Slot;
	now(): number;
	log: Log;
	/** sb's locale: the label of the done button the event names. */
	locale: Locale;
	/** Whether a session id is live in the net now. */
	live(id: string): Promise<boolean>;
	/** One intercom message from the tower's identity to the session with this id, under a `wait_card` header for this wait; resolves with intercom's result. */
	send(to: string, text: string, wait: string): Promise<{ status?: string }>;
	/** The tower's event: the boss's text, marked as a press. */
	boss(text: string): void;
	waitMs?: number;
	/** Whether auto mode is on: a secret card's start button is refused then (the boss is not at the keyboard; docs/specs/2026-11-09-auto-mode.md §6, AM-F013). */
	autoOn?(): boolean;
}

/** What a press decided: the notice for the raiser and how the event reads once the delivery is known. */
interface Plan { entry: Entry; card?: Card; act: Act; notice?: string; event(delivery: string): string }

const quoted = (reason: string | undefined) => (reason ? `: "${reason}"` : "");
const trimStop = (text: string) => text.replace(/[.。]+$/u, "");

/**
 * The memory change of one press. Refusals (a wait that is gone, a second press, the wrong act for the card's type) are `Refused` (409); a request that is wrong (an unknown act, an option that is no number, a reason too long) is an error (400).
 * The caller runs it inside `updateMemory`, so a refusal writes nothing.
 */
export function pressWait(m: Memory, now: number, json: Record<string, unknown>, locale: Locale): Plan {
	const act = ACTS.find((a) => a === json.act);
	if (!act) throw new Error(`act is ${ACTS.join(", ")}`);
	const e = findWait(m, json.id), id = e.id, card = e.card;
	if (e.for !== "boss") throw new Refused(`${id} waits for a session, not for the boss`);
	let reason: string | undefined;
	if (json.reason !== undefined && json.reason !== "") {
		if (act !== "decline") throw new Error("only a decline takes a reason");
		if (typeof json.reason !== "string") throw new Error("The reason has to be text");
		reason = clean(json.reason, 1_000_000);
		if (Array.from(reason).length > CARD.reason) throw new Error(`The reason is too long: at most ${CARD.reason} characters`);
		if (secretShaped(reason)) throw new Refused("a reason never carries a secret");
		if (!reason) reason = undefined;
	}
	const at = iso(now), raiserName = card?.from?.name ?? "the raiser", who = card?.from;
	const what = card?.do ?? e.text;
	/** The sentence that closes an event: whether the raiser got the notice. Nothing for a wait with no raiser. */
	const delivery = (status: string) => (!who ? "" : status === "delivered" || status === "queued" || status === "asked" ? ` ${raiserName} got it.` : ` ${raiserName} was not reached (${status}): tell it yourself, or tell its owner if it is gone.`);

	if (act === "decline") {
		if (e.state !== "open" && e.state !== "answered") throw new Refused(`${id} is ${e.state} already`);
		const outcome = cut(`declined by the boss${reason ? `: ${reason}` : ""}`, MEM.outcome);
		Object.assign(e, { state: "resolved", ended: at, outcome, press: { act, at, ...(reason ? { reason } : {}) } satisfies Press });
		delete e.shown;
		return {
			entry: e, ...(card ? { card } : {}), act,
			...(who ? { notice: `The boss will not do what wait ${id} asked (${what})${quoted(reason)}. The tower decides what comes next.` } : {}),
			event: (status) => `The boss declined wait ${id} (${what})${quoted(reason)}. Do not ask again unless something changed; tell the raiser what happens instead.${delivery(status)}`,
		};
	}
	// A reply in the card's box marks the wait `answered` with no press: it is not a press, so the card stays pressable (a secret card's first step leaves a press that is not the last word either).
	if (!(e.state === "open" || (e.state === "answered" && (!e.press || e.press.act === "secret")))) {
		const p = e.press;
		throw new Refused(p && p.act !== "secret" ? `${id} was pressed already: ${p.act === "choose" && card?.options?.[p.option ?? -1] ? card.options[p.option!]!.label : p.act === "restate" ? "restate" : DONE_LABEL[card?.lang ?? locale]} at ${hhmm(p.at)}` : `${id} is ${e.state} already`);
	}
	if (!card) {
		if (act !== "restate") throw new Refused(`${id} is an old free-text wait: it has no buttons; ask the tower to rewrite it as a card (restate)`);
		Object.assign(e, { state: "answered", answered: at, press: { act, at } satisfies Press });
		return { entry: e, act, event: () => `The boss asks you to record wait ${id} again as a card (tower_memory add kind wait with restates: "${id}"); its old text: ${e.text}` };
	}
	const asked = e.press?.secretAsked;
	switch (act) {
		case "restate":
			throw new Refused(`${id} is a card already`);
		case "done": {
			if (card.type === "choice") throw new Refused(`${id} is a choice: press one of its options`);
			if (card.type === "secret" && !asked) throw new Refused(`${id} needs the secret entered first: press the start button, then done`);
			Object.assign(e, { state: "answered", answered: at, press: { act, at, ...(asked ? { secretAsked: asked } : {}) } satisfies Press });
			const label = DONE_LABEL[card.lang];
			return {
				entry: e, card, act, ...(who ? { notice: `The boss did what wait ${id} asked: ${card.do}` } : {}),
				event: (status) => `The boss pressed "${label}" on wait ${id} (${card.do}). Check it, then resolve ${id}: ${card.after ?? "see what it asked"}${delivery(status)}`,
			};
		}
		case "choose": {
			if (card.type !== "choice") throw new Refused(`${id} is not a choice: it has no options`);
			const n = json.option;
			if (typeof n !== "number" || !Number.isInteger(n)) throw new Error("option is the number of the option picked");
			const picked = card.options?.[n];
			if (!picked) throw new Refused(`${id} has no option ${n}`);
			Object.assign(e, { state: "answered", answered: at, press: { act, option: n, at } satisfies Press });
			return {
				entry: e, card, act, ...(who ? { notice: `The boss chose "${picked.label}" on wait ${id}: ${picked.then}` } : {}),
				event: (status) => `The boss chose "${picked.label}" on wait ${id} (${card.do}): ${trimStop(picked.then)}. Act on it, then resolve ${id}.${delivery(status)}`,
			};
		}
		case "secret": {
			if (card.type !== "secret") throw new Refused(`${id} is not a secret card`);
			if (asked) throw new Refused(`${id}: the secret was asked for already at ${hhmm(asked)}`);
			const name = card.secret!.name;
			e.press = { act, at, secretAsked: at } satisfies Press;
			return {
				entry: e, card, act, ...(who ? { notice: `The boss is at this computer to enter ${name} (wait ${id}): call secret_drop now for it, in this session. Tell the tower with call_tower when it is stored.` } : {}),
				event: (status) => `The boss is ready to enter ${name} for wait ${id}; ${raiserName} was told to call secret_drop now.${delivery(status)}`,
			};
		}
	}
}

/** The error the memory route answers: a refusal is 409 `refused`, a wrong request 400, an unreadable file 409 `unreadable`. */
const failure = (cause: unknown): { status: number; body: Record<string, unknown> } => {
	const error = cause as Error;
	const unreadable = /memory\.json/.test(error.message);
	return { status: error instanceof Refused || unreadable ? 409 : 400, body: { error: error instanceof Refused ? "refused" : unreadable ? "unreadable" : "bad_request", reason: error.message } };
};

/** The notice of a press whose raiser asked it itself (`asked`), kept in memory for `lateNotice`: the tool's result is that notice, unless its turn was stopped and the result never came (R-F006). A restart forgets them. */
const held = new Map<string, string>();

/** `{ op: "wait-notice", id, asker }` at the `ask` door: the asker's turn was stopped after its press, so the raiser (the asker) is sent the notice the result would have been. Once, and only to the session that asked. */
export async function lateNotice(d: PressDeps, workspace: string, json: Record<string, unknown>, via: PressDoor = "pi"): Promise<{ status: number; body: Record<string, unknown> }> {
	const key = `${workspace}\n${String(json.id)}`, notice = held.get(key);
	const raiser = updateMemory(d.slot, workspace, d.now(), () => undefined).memory.entries.find((e) => e.id === json.id)?.card?.from?.id;
	if (via !== "ask" || !notice || !raiser || json.asker !== raiser) return { status: 409, body: { error: "refused", reason: "no notice is held for that session" } };
	held.delete(key);
	const status = await d.live(raiser).then(async (live) => (live ? deliveryOf((await d.send(raiser, notice, String(json.id))).status) : "gone"), () => "failed" as const);
	try {
		updateMemory(d.slot, workspace, d.now(), (m) => void (m.entries.find((x) => x.id === json.id)?.press && Object.assign(m.entries.find((x) => x.id === json.id)!.press!, { main: { status, at: iso(d.now()) } })));
	} catch { /* the wait is gone meanwhile */ }
	return { status: 200, body: { delivery: status } };
}

/**
 * `{ op: "press", id, act, option?, reason? }` of the boss's route. The raiser is told by its session id: a card whose raiser is not live now is `gone` and nothing is sent. The tower's event is queued last, with the delivery in its text.
 * At the `ask` door the press may name its `asker` (the session whose `boss_wait_ask` drew the dialog): when that is the raiser, the tool's own result is its notice, so none is sent and the delivery is `asked`.
 */
export async function pressRequest(d: PressDeps, workspace: string, json: Record<string, unknown>, via: PressDoor = "pi"): Promise<{ status: number; body: Record<string, unknown> }> {
	if (typeof json.id !== "string") return { status: 400, body: { error: "bad_request", reason: "A press names the wait (id)" } };
	if (json.act === "secret" && d.autoOn?.()) return { status: 409, body: { error: "refused", reason: "end auto mode first (/boss auto off): a secret is entered at the keyboard" } };
	if (json.value !== undefined) return { status: 400, body: { error: "bad_request", reason: "A press carries no value: a secret is entered in the terminal, never here" } };
	let plan: Plan;
	const now = d.now();
	try {
		plan = updateMemory(d.slot, workspace, now, (m) => pressWait(m, now, json, d.locale)).value;
	} catch (cause) {
		return failure(cause);
	}
	const raiser = plan.card?.from?.id;
	let status: Delivery | undefined;
	if (plan.notice && raiser) {
		const asked = via === "ask" && json.asker === raiser;
		status = await (async (): Promise<Delivery> => {
			try {
				if (asked) return (held.set(`${workspace}\n${plan.entry.id}`, plan.notice!), [...held.keys()].slice(0, -64).forEach((k) => held.delete(k)), "asked");
				if (!(await d.live(raiser))) return "gone";
				let timer: ReturnType<typeof setTimeout> | undefined;
				const cutOff = new Promise<{ status?: string }>((resolve) => { timer = setTimeout(() => resolve({ status: "failed" }), d.waitMs ?? NOTICE_WAIT_MS); timer.unref?.(); });
				try {
					return deliveryOf((await Promise.race([d.send(raiser, plan.notice!, plan.entry.id), cutOff])).status);
				} finally {
					clearTimeout(timer);
				}
			} catch {
				return "failed";
			}
		})();
		try {
			updateMemory(d.slot, workspace, d.now(), (m) => {
				const e = m.entries.find((x) => x.id === plan.entry.id);
				if (e?.press && e.press.act === plan.act && e.press.at === plan.entry.press?.at) e.press.main = { status: status!, at: iso(d.now()) };
			});
		} catch { /* the wait was resolved or dropped meanwhile: the event below still goes */ }
	}
	const text = plan.event(status ?? "");
	d.boss(text);
	d.log.line("tower-memory", { workspace, op: "press", act: plan.act, id: plan.entry.id, by: "boss", via, ...(status ? { delivery: status } : {}) });
	const kept = updateMemory(d.slot, workspace, d.now(), () => undefined).memory;
	return { status: 200, body: { ...memoryView(kept), id: plan.entry.id, ...(kept.entries.find((x) => x.id === plan.entry.id)?.press ? { press: kept.entries.find((x) => x.id === plan.entry.id)!.press } : {}) } };
}
