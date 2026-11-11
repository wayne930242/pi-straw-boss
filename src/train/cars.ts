import { parseSlip, slipBlocks } from "./accept.ts";
import { isCode, isObject, isName, isoTime, MAX_CAR_TICKETS, MAX_TICKET_CHARS, SHA_RE, shortCode } from "./spec.ts";

// A car's states and notices (docs/specs/2026-11-07-train-workers.md §5.5, D14), as data: which states a car has, the fields each carries, the car file they are appended to, the text of each notice, and when a notice counts as told.
// The train and the integrator only set a state; the sb server sends the intercom, records the broker's answer, and holds the step that depends on it (task 5a builds the tool and the sender). Pure: nothing here sends or writes.

export const CAR_STATES = ["received", "returned", "dropped", "landed"] as const;
export type CarState = (typeof CAR_STATES)[number];
export const TERMINAL_STATES = ["returned", "dropped", "landed"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];
/** Delays before the retries of a notice the broker did not deliver: 30 s, 2 min, 5 min (§5.5). */
export const RETRY_MS = [30_000, 120_000, 300_000] as const;
const MAX_REASON = 600;

const present = (value: unknown) => value !== undefined;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const isTerminal = (state: string): state is TerminalState => (TERMINAL_STATES as readonly string[]).includes(state);

/** What each state carries, and how each field is read. */
const FIELDS: Record<CarState, { name: string; ok: (v: unknown) => boolean; help: string }[]> = {
	received: [
		{ name: "train", ok: isCode, help: "must be YYYY-MM-DD-<letters>" },
		{ name: "departs", ok: (v) => text(v, 300), help: "must be the departure conditions in words, at most 300 characters" },
	],
	returned: [{ name: "reason", ok: (v) => text(v, MAX_REASON), help: `must be 1 to ${MAX_REASON} characters` }],
	dropped: [
		{ name: "round", ok: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1, help: "must be a whole number from 1" },
		{ name: "reason", ok: (v) => text(v, MAX_REASON), help: `must be 1 to ${MAX_REASON} characters` },
		{ name: "evidence", ok: (v) => text(v, 1024), help: "must be a path of 1 to 1024 characters" },
	],
	landed: [
		{ name: "version", ok: (v) => text(v, 128), help: "must be a non-empty string" },
		{ name: "commit", ok: (v) => SHA_RE.test(String(v)), help: "must be 40 hex" },
	],
};

/** What a state is refused for, from the fields given with it. Whether the commit is on the base's remote branch, or the evidence path exists, is the tool's to check (it reads git and the disk). */
export function validateStateFields(state: CarState, fields: Record<string, unknown>): string[] {
	if (!(CAR_STATES as readonly string[]).includes(state)) return [`sb: state "${String(state)}" is not one of ${CAR_STATES.join(", ")}`];
	const spec = FIELDS[state], out: string[] = [];
	for (const { name, ok, help } of spec) {
		if (!present(fields[name]) || fields[name] === "") out.push(`sb: ${state} needs ${name}`);
		else if (!ok(fields[name])) out.push(`sb: ${state}.${name} ${help}`);
	}
	for (const key of Object.keys(fields)) if (present(fields[key]) && !spec.some((f) => f.name === key)) out.push(`sb: ${state}.${key} is not a field`);
	return out;
}

/** Who set a state: the session's role, name and id, and the Herdr workspace it runs in (where an escalation goes) when the server knew it. */
export interface Setter { role: "train" | "main"; name: string; session: string; workspace?: string }
export type StateEntry = { state: CarState; at: string; by: Setter } & Record<string, unknown>;
export interface CarFile {
	v: 1; project: string; app: string;
	car: { tickets: string[]; branch: string; head: string };
	/** The session id the slip named and the tower's forward confirmed: the one every notice goes to. */
	coordinator: string;
	states: StateEntry[];
}

export function emptyCar(car: { project: string; app: string; tickets: string[]; branch: string; head: string; coordinator: string }): CarFile {
	return { v: 1, project: car.project, app: car.app, car: { tickets: [...car.tickets], branch: car.branch, head: car.head }, coordinator: car.coordinator, states: [] };
}

/** `<app>-<first 12 hex of the head>.json`: a car that comes back reworked has a new head and so a new file. */
export function carFileName(app: string, head: string): string {
	if (!isName(app)) throw new Error(`sb: app "${app}" is not a path-safe name`);
	if (!SHA_RE.test(head)) throw new Error(`sb: head "${head}" is not 40 hex`);
	return `${app}-${head.slice(0, 12)}.json`;
}

const label = (file: { car: { tickets: string[] } }) => file.car.tickets[0] ?? "?";

/** A second terminal state is refused, and `received` only comes first: the word of the refusal, or nothing. */
function sequence(states: readonly { state: string }[], next: string, car: string): string | undefined {
	if (next === "received" && states.some((s) => s.state === "received")) return `sb: car ${car} is already received`;
	const terminal = states.find((s) => isTerminal(s.state));
	return terminal && (isTerminal(next) || next === "received") ? `sb: car ${car} is already ${terminal.state}` : undefined;
}

/** The car file with one more state, or an error in the guard's words; the file given is not changed. */
export function addState(file: CarFile, set: { state: CarState; fields: Record<string, unknown>; by: Setter; at: string }): CarFile {
	const refusals = validateStateFields(set.state, set.fields);
	if (refusals.length) throw new Error(refusals.join("; "));
	if (!isoTime(set.at)) throw new Error("sb: at must be an ISO time with its zone");
	const refusal = sequence(file.states, set.state, label(file));
	if (refusal) throw new Error(refusal);
	return { ...file, states: [...file.states, { state: set.state, at: set.at, by: { ...set.by }, ...set.fields }] };
}

/** What a car file is refused for: its shape, each state's fields, and the order of the states. */
export function validateCarFile(value: unknown): string[] {
	if (!isObject(value)) return ["sb: car file must be an object"];
	const out = Object.keys(value).filter((k) => present(value[k]) && !["v", "project", "app", "car", "coordinator", "states"].includes(k)).map((k) => `sb: car.${k} is not a field`);
	if (value.v !== 1) out.push("sb: car.v must be 1");
	for (const key of ["project", "app"]) if (!(typeof value[key] === "string" && isName(value[key]))) out.push(`sb: car.${key} must be a path-safe name`);
	const car = isObject(value.car) ? value.car : undefined;
	if (!car) out.push("sb: car.car must be an object");
	else {
		if (!(Array.isArray(car.tickets) && car.tickets.length > 0 && car.tickets.length <= MAX_CAR_TICKETS && car.tickets.every((t) => text(t, MAX_TICKET_CHARS)))) out.push(`sb: car.car.tickets must be a list of 1 to ${MAX_CAR_TICKETS} tickets`);
		if (!text(car.branch, 255)) out.push("sb: car.car.branch must be a non-empty string");
		if (!SHA_RE.test(String(car.head))) out.push("sb: car.car.head must be 40 hex");
	}
	if (!text(value.coordinator, 128)) out.push("sb: car.coordinator must be a non-empty string");
	if (!Array.isArray(value.states)) return [...out, "sb: car.states must be an array"];
	const name = car && Array.isArray(car.tickets) ? String(car.tickets[0]) : "?", seen: { state: string }[] = [];
	value.states.forEach((entry, i) => {
		const at = `states[${i}]`;
		if (!isObject(entry)) return void out.push(`sb: ${at} must be an object`);
		const { state, at: when, by, ...fields } = entry;
		if (!isoTime(when)) out.push(`sb: ${at}.at must be an ISO time with its zone`);
		if (!isObject(by) || !text(by.name, 128) || !text(by.session, 128)) out.push(`sb: ${at}.by must name the session that set it`);
		else if (by.role !== "train" && by.role !== "main") out.push(`sb: ${at}.by.role must be train or main`);
		const refusals = validateStateFields(state as CarState, fields);
		out.push(...refusals.map((r) => r.replace(/^sb: /, `sb: ${at}: `)));
		if (!refusals.length || (CAR_STATES as readonly string[]).includes(state as string)) {
			const order = sequence(seen, String(state), name);
			if (order) out.push(order.replace(/^sb: /, `sb: ${at}: `));
		}
		seen.push({ state: String(state) });
	});
	return out;
}

export interface NoticeContext { ticket: string; head: string; train?: string; departs?: string; reason?: string; round?: number; evidence?: string; version?: string; commit?: string }

/** The line the coordinator is sent for a state (the table of §5.5). */
export function noticeText(state: CarState, c: NoticeContext): string {
	const need = (field: keyof NoticeContext) => {
		const v = c[field];
		if (v === undefined || v === "") throw new Error(`sb: ${state} needs ${field}`);
		return String(v);
	};
	const head = c.head.slice(0, 12), train = () => shortCode(need("train"));
	switch (state) {
		case "received": return `received: your car ${c.ticket} (${head}) rides train ${train()}; it departs ${need("departs")}`;
		case "returned": return `returned: your car ${c.ticket} (${head}): ${need("reason")}`;
		case "dropped": return `dropped from train ${train()} round ${need("round")}: ${need("reason")}; evidence ${need("evidence")}`;
		case "landed": return `landed in ${need("version")}, your commit is ${need("commit")}`;
	}
}

/** The line sent for one state entry of a car file: the received state of the same car names the train. Throws as `noticeText` does when a field is missing. */
export function stateLine(file: CarFile, entry: StateEntry): string {
	const received = file.states.find((s) => s.state === "received"), f = entry as Record<string, unknown>, train = received?.train ?? f.train;
	return noticeText(entry.state, {
		ticket: file.car.tickets[0] ?? "?", head: file.car.head,
		...(typeof train === "string" ? { train } : {}),
		...(typeof f.departs === "string" ? { departs: f.departs } : {}), ...(typeof f.reason === "string" ? { reason: f.reason } : {}),
		...(typeof f.round === "number" ? { round: f.round } : {}), ...(typeof f.evidence === "string" ? { evidence: f.evidence } : {}),
		...(typeof f.version === "string" ? { version: f.version } : {}), ...(typeof f.commit === "string" ? { commit: f.commit } : {}),
	});
}

export const OUTCOMES = ["delivered", "queued", "failed", "not-live", "unknown"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export interface Attempt { at: string; outcome: Outcome; answer?: string }
/** `tower`: the attempts to tell the tower that the coordinator could not be (§5.5, step 5); `escalatedAt` is set when one of them was taken. */
export interface StateNotice { id?: string; attempts: Attempt[]; deliveredAt?: string; escalatedAt?: string; tower?: Attempt[] }
/** `<car file>.notice.json`: per state, what the server sent and what the broker answered (the server is its one writer). */
export interface NoticeRecord { v: 1; states: Partial<Record<CarState, StateNotice>> }
const MAX_ATTEMPTS = 64, MAX_ANSWER = 600;
function attemptRefusals(value: unknown, path: string): string[] {
	if (!isObject(value)) return [`${path} must be an object`];
	const out: string[] = [];
	if (!isoTime(value.at)) out.push(`${path}.at must be an ISO time with its zone`);
	if (!(OUTCOMES as readonly unknown[]).includes(value.outcome)) out.push(`${path}.outcome must be one of ${OUTCOMES.join(", ")}`);
	if (present(value.answer) && !(typeof value.answer === "string" && value.answer.length <= MAX_ANSWER)) out.push(`${path}.answer must be a string of at most ${MAX_ANSWER} characters`);
	return out;
}
/** What a notice record is refused for, strictly (the file is model-writable: a train could write it): each state a car state, its attempts and tower attempts (at most 64) with an ISO `at`, one of the outcomes and a short string `answer`, and `deliveredAt`/`escalatedAt` ISO times. Fields the readers do not use are not looked at. */
export function validateNoticeRecord(value: unknown): string[] {
	if (!isObject(value)) return ["notice record must be an object"];
	if (value.v !== 1) return ["notice record v must be 1"];
	if (!isObject(value.states)) return ["notice record states must be an object"];
	const out: string[] = [];
	for (const [state, entry] of Object.entries(value.states)) {
		const path = `states.${state}`;
		if (!(CAR_STATES as readonly string[]).includes(state)) out.push(`${path} is not a car state`);
		if (!isObject(entry)) { out.push(`${path} must be an object`); continue; }
		for (const key of ["attempts", "tower"] as const) {
			const list = entry[key];
			if (key === "tower" && list === undefined) continue;
			if (!Array.isArray(list) || list.length > MAX_ATTEMPTS) out.push(`${path}.${key} must be a list of at most ${MAX_ATTEMPTS} attempts`);
			else list.forEach((attempt, i) => out.push(...attemptRefusals(attempt, `${path}.${key}[${i}]`)));
		}
		for (const key of ["deliveredAt", "escalatedAt"] as const) if (present(entry[key]) && !isoTime(entry[key])) out.push(`${path}.${key} must be an ISO time with its zone`);
		if (present(entry.id) && !text(entry.id, 128)) out.push(`${path}.id must be a string of at most 128 characters`);
	}
	return out;
}
export type NoticeStatus = { kind: "pending"; attempts: number; last?: string } | { kind: "delivered" | "escalated"; attempts: number; at: string };

/** A notice is told when the broker said `socket_delivered` (`deliveredAt`) or the tower was told the coordinator is gone (`escalatedAt`); queued, failed and unknown attempts are not. */
export function noticeStatus(record: NoticeRecord | undefined, state: CarState): NoticeStatus {
	const entry = record?.states[state], attempts = entry?.attempts ?? [];
	if (entry && isoTime(entry.deliveredAt)) return { kind: "delivered", attempts: attempts.length, at: entry.deliveredAt };
	if (entry && isoTime(entry.escalatedAt)) return { kind: "escalated", attempts: attempts.length, at: entry.escalatedAt };
	const last = attempts.at(-1);
	return last ? { kind: "pending", attempts: attempts.length, last: last.answer ?? last.outcome } : { kind: "pending", attempts: 0 };
}

/** The latest time a car file was changed; a file with no state yet is the oldest. */
const latest = (file: CarFile) => file.states.reduce((at, s) => (s.at > at ? s.at : at), "");

/**
 * The `notice` check (§6.3): every named car's terminal state is `state` and its notice is told. Returns what is still missing, in words; an empty list passes.
 * A ticket whose car came back is in several car files (§5.5: a new head, a new file); the one changed last is its current life, and two changed at the same time are refused, not guessed. `app` leaves out another app's car of the same ticket.
 */
export function noticeSatisfied(cars: readonly CarView[], tickets: readonly string[], state: TerminalState | readonly TerminalState[], opts: { app?: string } = {}): string[] {
	const wanted: readonly TerminalState[] = typeof state === "string" ? [state] : state;
	return tickets.flatMap((ticket) => {
		const found = currentCar(cars, ticket, opts.app);
		if (typeof found === "string") return [found];
		const terminal = found.file.states.find((s) => isTerminal(s.state));
		if (!terminal) return [`sb: car ${ticket} has no terminal state yet`];
		if (!(wanted as readonly string[]).includes(terminal.state)) return [`sb: car ${ticket} is ${terminal.state}, not ${wanted.join(" or ")}`];
		return toldRefusals(found, ticket, terminal.state as CarState);
	});
}

/** The car file and notice of the ticket's current life, or the refusal in words (none, or two changed at the same moment). */
function currentCar(cars: readonly CarView[], ticket: string, app?: string): CarView | string {
	const files = cars.filter((c) => c.file.car.tickets.includes(ticket) && (app === undefined || c.file.app === app));
	if (files.length === 0) return `sb: car ${ticket} has no car file`;
	const newest = files.reduce((top, c) => (latest(c.file) > latest(top.file) ? c : top));
	const tied = files.filter((c) => latest(c.file) === latest(newest.file));
	if (tied.length > 1) return `sb: car ${ticket} has ${tied.length} car files with the same latest state (heads ${tied.map((c) => c.file.car.head.slice(0, 12)).join(", ")}); one of them must change first`;
	return newest;
}
const toldRefusals = (found: CarView, ticket: string, state: CarState): string[] => {
	const status = noticeStatus(found.notice, state);
	if (status.kind !== "pending") return [];
	const tried = `${status.attempts} attempt${status.attempts === 1 ? "" : "s"}${status.last ? `, last: ${status.last}` : ""}`;
	return [`sb: waits for sb to tell ${found.file.coordinator} that car ${ticket} is ${state} (${tried})`];
};

/** A car file with its notice record: what the server answers for a car (`cars-read`). */
export interface CarView { file: CarFile; notice?: NoticeRecord }

/** The `received` notice of a car (by app and head) is told, and the car was received by the train `train` when given: what the integrator's `train` todo waits for (§5.5, §7.4). Empty when it holds. */
export function receivedTold(cars: readonly CarView[], car: { app: string; head: string; ticket: string }): string[] {
	const found = cars.find((c) => c.file.app === car.app && c.file.car.head === car.head);
	if (!found) return [`sb: car ${car.ticket} was never received: set it received with train_car first`];
	const entry = found.file.states.find((s) => s.state === "received");
	if (!entry) return [`sb: car ${car.ticket} is not received (${found.file.states.at(-1)?.state ?? "no state"}): set it received with train_car first`];
	return toldRefusals(found, car.ticket, "received");
}

// ---- a tower's forward (§5.5): who sent the car slip, read from the header the code wrote

/** One message of a session's branch that a tower forwarded as a car slip: the event it came in (`fwd`), the session that sent it there (`from`), the sender the broker named for this message (`sender`), and the slip text under the header. */
export interface Forward { fwd: string; from: string; sender?: string; role?: string; text: string }

const textOfMessage = (details: Record<string, unknown>): string | undefined => {
	const message = details.message as { content?: { text?: unknown } } | undefined;
	if (typeof message?.content?.text === "string") return message.content.text;
	return typeof details.bodyText === "string" ? details.bodyText : undefined;
};

/** The forwarded messages on a branch: intercom messages whose first header carries `fwd` and `fwd-from`. The header must name the same session the broker said sent it (`id=` equals the message's sender) and a tower; anything else is no forward. */
export function forwardsOf(entries: readonly unknown[], fields: (text: string) => Record<string, string> | undefined): Forward[] {
	const out: Forward[] = [];
	for (const entry of entries) {
		const e = entry as { type?: unknown; customType?: unknown; details?: unknown };
		if (e?.type !== "custom_message" || e.customType !== "intercom_message" || !isObject(e.details)) continue;
		const text = textOfMessage(e.details), sender = isObject(e.details.from) && typeof e.details.from.id === "string" ? e.details.from.id : undefined;
		if (text === undefined) continue;
		const f = fields(text);
		if (!f?.fwd || !f["fwd-from"] || f.role !== "tower" || (f.kind !== "tower_send" && f.kind !== "tower_reply")) continue;
		if (sender === undefined || f.id !== sender) continue;
		out.push({ fwd: f.fwd, from: f["fwd-from"], sender, role: f.role, text });
	}
	return out;
}

/** The forwards whose slip carries this head as a `head:` field. */
export const forwardsFor = (forwards: readonly Forward[], head: string): Forward[] => forwards.filter((f) => new RegExp(`(?:^|[\\s|])head:\\s*${head}(?![0-9a-f])`, "im").test(f.text));

/** The heads a text carries as `head: <40 hex>` fields: what the server registers a forward under. */
export const headsIn = (text: string): string[] => [...new Set([...text.matchAll(/(?:^|[\s|])head:\s*([0-9a-f]{40})(?![0-9a-f])/gim)].map((m) => m[1]!))];

/** One slip of a forwarded text, as the server reads it: the car's app, tickets, branch and head, and the coordinator the slip names. */
export interface SlipFacts { app: string; tickets: string[]; branch: string; head: string; coordinator?: string }

/** The slips a forwarded text carries: a `car: <app> | tickets: …` that follows the tower's own words starts a block of its own line. Only a slip that parses and names app, tickets, branch and a 40-hex head is returned. */
export function slipsInText(body: string): SlipFacts[] {
	const lines = body.replace(/(\S)[ \t]+(car:[ \t]*[A-Za-z0-9._-]+[ \t]*\|[ \t]*tickets:)/gi, "$1\n$2");
	return slipBlocks(lines).blocks.flatMap((block) => {
		const parsed = parseSlip(block), f = parsed.fields;
		if (!f.car || !isName(f.car) || !parsed.tickets.length || !f.branch || !SHA_RE.test(f.head ?? "")) return [];
		return [{ app: f.car, tickets: parsed.tickets, branch: f.branch, head: f.head!, ...(f.coordinator ? { coordinator: f.coordinator } : {}) }];
	});
}

/** The word for a slip whose `coordinator` is not the session that sent it (§5.5). */
export const coordinatorWord = (ticket: string, coordinator: string, sender: string) => `sb: car ${ticket} names coordinator ${coordinator}, but ${sender} sent it; the slip is refused`;
